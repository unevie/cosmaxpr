require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase (optional) ──────────────────────────────────────────────────────
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('✅ Supabase 연결됨');
  }
} catch (e) {
  console.log('ℹ️  Supabase 미사용 → in-memory 모드');
}

// ─── In-memory store ──────────────────────────────────────────────────────────
const articlesMap = new Map();  // link → article object
let sseClients    = [];         // active SSE connections
let lastPollTime  = null;
let pollCount     = 0;
const DEMO_MODE   = !process.env.NAVER_CLIENT_ID;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function stripHtml(str = '') {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function log(msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─── Slack 알람 (optional) ────────────────────────────────────────────────────
async function notifySlack(articles) {
  if (!process.env.SLACK_WEBHOOK_URL || !articles.length) return;
  try {
    const text = articles
      .map(a => `*${a.title}*\n${a.description?.slice(0, 80)}...\n${a.naverLink}`)
      .join('\n\n');
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `📰 코스맥스 뉴스 ${articles.length}건 신규\n\n${text}`,
    });
  } catch (e) {
    log(`Slack 알람 실패: ${e.message}`);
  }
}

// ─── Naver API ────────────────────────────────────────────────────────────────
async function fetchNaverNews() {
  try {
    const res = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: {
        query: process.env.SEARCH_QUERY || '코스맥스',
        display: 100,
        sort: 'date',
      },
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      },
      timeout: 10000,
    });
    return res.data.items || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) log('❌ 네이버 API 인증 실패 - API 키를 확인하세요');
    else if (status === 429) log('⚠️  API 호출 한도 초과 - 잠시 후 재시도');
    else log(`❌ 네이버 API 오류: ${err.message}`);
    return [];
  }
}

// ─── Supabase: load existing articles on startup ──────────────────────────────
async function loadFromSupabase() {
  if (!supabase) return;
  try {
    const { data } = await supabase
      .from('news_articles')
      .select('*')
      .order('pub_date', { ascending: false })
      .limit(500);
    (data || []).forEach(row => {
      articlesMap.set(row.link, {
        id: row.id,
        title: row.title,
        link: row.link,
        naverLink: row.naver_link,
        description: row.description,
        pubDate: new Date(row.pub_date),
        isNew: row.is_new,
        createdAt: new Date(row.created_at),
      });
    });
    log(`📦 Supabase에서 기존 기사 ${articlesMap.size}건 로드`);
  } catch (e) {
    log(`Supabase 로드 오류: ${e.message}`);
  }
}

async function saveToSupabase(article) {
  if (!supabase) return;
  try {
    await supabase.from('news_articles').upsert(
      {
        title:       article.title,
        link:        article.link,
        naver_link:  article.naverLink,
        description: article.description,
        pub_date:    article.pubDate.toISOString(),
        is_new:      true,
      },
      { onConflict: 'link', ignoreDuplicates: true }
    );
  } catch (_) {/* silent */}
}

// ─── Poll & process ───────────────────────────────────────────────────────────
async function pollAndProcess() {
  const items = await fetchNaverNews();
  pollCount++;
  lastPollTime = new Date();

  const newArticles = [];

  for (const item of items) {
    const link = item.originallink || item.link;
    if (articlesMap.has(link)) continue;

    const article = {
      id:          `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title:       stripHtml(item.title),
      link,
      naverLink:   item.link,
      description: stripHtml(item.description),
      pubDate:     new Date(item.pubDate),
      isNew:       true,
      createdAt:   new Date(),
    };

    articlesMap.set(link, article);
    newArticles.push(article);
    await saveToSupabase(article);
  }

  if (newArticles.length > 0) {
    log(`🆕 신규 기사 ${newArticles.length}건 발견 (누적: ${articlesMap.size}건)`);
    broadcast({ type: 'new_articles', articles: newArticles });
    notifySlack(newArticles);
  } else {
    log(`변동 없음 (누적: ${articlesMap.size}건)`);
  }

  // heartbeat regardless
  broadcast({
    type:  'heartbeat',
    time:  lastPollTime.toISOString(),
    total: articlesMap.size,
  });
}

// ─── SSE broadcast ────────────────────────────────────────────────────────────
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(c => !c.res.destroyed);
  sseClients.forEach(c => c.res.write(payload));
}

// ─── Demo data ────────────────────────────────────────────────────────────────
function loadDemoData() {
  const items = [
    { title: '코스맥스, 2026년 1분기 역대 최대 실적 달성…매출 5,200억원', desc: '코스맥스가 글로벌 ODM 사업 확대에 힘입어 1분기 매출 5,200억원을 기록했다. 이는 전년 동기 대비 23% 증가한 수치로 창사 이래 분기 최대 실적이다.', min: 5 },
    { title: '코스맥스BTI, 2대주주 지분 거래 공시…경영권 변동 없어', desc: '코스맥스 그룹의 지주회사인 코스맥스BTI가 2대주주의 지분 일부 처분 사실을 공시했다. 회사 측은 경영권에는 영향이 없다고 밝혔다.', min: 42 },
    { title: 'K-뷰티 ODM 1위 코스맥스, 미국 오하이오 신규 생산라인 가동', desc: '코스맥스가 미국 오하이오주 생산법인에 신규 라인을 증설하며 북미 시장 공략을 강화한다고 밝혔다. 현지 고용 300명 규모다.', min: 118 },
    { title: '코스맥스, 헬로바이옴 공동개발 마이크로바이옴 원료 5종 공개', desc: '코스맥스는 헬로바이옴과 공동 개발한 마이크로바이옴 화장품 원료 5종을 공개했다. 해당 원료는 2026년 하반기 양산 예정이다.', min: 235 },
    { title: '코스맥스 M2C 전략 성과…국내 뷰티 브랜드 20개사 신규 계약', desc: '코스맥스의 M2C(Manufacturer to Consumer) 디지털 전략이 중소 뷰티 브랜드들 사이에서 반향을 일으키며 신규 계약이 빠르게 증가하고 있다.', min: 360 },
    { title: '코스맥스 중국법인, 광저우 제2공장 증설 완료…생산능력 40% 확대', desc: '코스맥스 중국 법인이 광저우 제2공장 증설 공사를 완료하고 본격 가동에 들어갔다. 연간 생산 능력이 기존 대비 40% 증가할 전망이다.', min: 720 },
    { title: '이경수 코스맥스 회장, K-뷰티 글로벌 포럼 기조연설', desc: '코스맥스 이경수 회장이 서울에서 열린 K-뷰티 글로벌 포럼에서 한국 화장품 ODM 산업의 미래 전략을 주제로 기조연설을 했다.', min: 1440 },
    { title: '코스맥스, ESG 경영보고서 발간…탄소중립 2040 선언', desc: '코스맥스가 2025년 ESG 경영보고서를 발간하고 2040년 탄소 중립 달성을 선언했다. 친환경 패키징 전환율은 현재 45%다.', min: 2100 },
  ];

  items.forEach((d, i) => {
    const link = `https://demo.cosmax-monitor.local/article-${i + 1}`;
    articlesMap.set(link, {
      id:          `demo-${i}`,
      title:       d.title,
      link,
      naverLink:   link,
      description: d.desc,
      pubDate:     new Date(Date.now() - d.min * 60000),
      isNew:       d.min < 60,
      createdAt:   new Date(),
    });
  });

  log(`📦 데모 데이터 ${items.length}건 로드`);
}

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE endpoint ─────────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', total: articlesMap.size })}\n\n`);

  const client = { id: Date.now(), res };
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

// ─── GET /api/news ────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  const { page = 1, limit = 30, q = '', range = 'all' } = req.query;

  let articles = Array.from(articlesMap.values()).sort(
    (a, b) => new Date(b.pubDate) - new Date(a.pubDate)
  );

  // Date range filter
  if (range !== 'all') {
    const cutoffDays = { today: 1, week: 7, month: 30 };
    const days = cutoffDays[range];
    if (days) {
      const cutoff = new Date(Date.now() - days * 86400000);
      articles = articles.filter(a => new Date(a.pubDate) >= cutoff);
    }
  }

  // Keyword search
  if (q) {
    const qLower = q.toLowerCase();
    articles = articles.filter(
      a =>
        a.title.toLowerCase().includes(qLower) ||
        (a.description || '').toLowerCase().includes(qLower)
    );
  }

  const total  = articles.length;
  const p      = parseInt(page);
  const lim    = parseInt(limit);
  const items  = articles.slice((p - 1) * lim, p * lim);
  const hasMore = p * lim < total;

  res.json({ items, total, page: p, limit: lim, hasMore });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const all   = Array.from(articlesMap.values());

  res.json({
    total:             all.length,
    today:             all.filter(a => new Date(a.pubDate) >= today).length,
    lastPoll:          lastPollTime?.toISOString() || null,
    pollCount,
    activeConnections: sseClients.length,
    keyword:           process.env.SEARCH_QUERY || '코스맥스',
    demoMode:          DEMO_MODE,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  코스맥스 뉴스 모니터 v1.0');
  console.log(`  http://localhost:${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (DEMO_MODE) {
    console.log('⚠️  NAVER_CLIENT_ID 없음 → 데모 모드로 실행');
    console.log('   .env에 API 키 설정 후 재시작하면 실제 뉴스 연동됩니다.\n');
    loadDemoData();

    // Simulate live article every 30 seconds in demo mode
    setInterval(() => {
      const titles = [
        '코스맥스, 신규 파트너십 계약 체결 발표',
        '코스맥스BTI 실적 발표…시장 예상치 상회',
        '글로벌 뷰티 ODM 시장 코스맥스 점유율 확대',
        '코스맥스 R&D 센터, 신소재 개발 성공',
        '코스맥스 인도네시아 법인 신규 클라이언트 확보',
      ];
      const t = titles[Math.floor(Math.random() * titles.length)];
      const link = `https://demo.cosmax-monitor.local/live-${Date.now()}`;
      const article = {
        id:          `live-${Date.now()}`,
        title:       `[실시간] ${t}`,
        link,
        naverLink:   link,
        description: `데모 모드 실시간 생성 기사 — ${new Date().toLocaleString('ko-KR')}`,
        pubDate:     new Date(),
        isNew:       true,
        createdAt:   new Date(),
      };
      articlesMap.set(link, article);
      broadcast({ type: 'new_articles', articles: [article] });
      broadcast({ type: 'heartbeat', time: new Date().toISOString(), total: articlesMap.size });
      log(`🟢 데모 신규 기사 시뮬레이션: ${t}`);
    }, 30000);

  } else {
    console.log(`📰 검색 키워드: "${process.env.SEARCH_QUERY || '코스맥스'}"`);
    await loadFromSupabase();
    await pollAndProcess();
    cron.schedule('* * * * *', pollAndProcess);
    console.log('🕐 1분 간격 자동 폴링 활성화\n');
  }
});
