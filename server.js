require('dotenv').config();
const express  = require('express');
const webpush  = require('web-push');
const cron    = require('node-cron');
const axios   = require('axios');
const path    = require('path');

const app  = express();
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
const articlesMap = new Map();
let sseClients    = [];
let lastPollTime  = null;
let pollCount     = 0;
const DEMO_MODE   = !process.env.NAVER_CLIENT_ID;

// ─── Web Push VAPID 설정 ───────────────────────────────────────────────────────
const subscriptions = new Map(); // endpoint → subscription object
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@cosmax.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('✅ Web Push VAPID 설정 완료');
}

// ─── Publisher domain mapping ─────────────────────────────────────────────────
const PUBLISHER_DOMAINS = {
  'hankyung.com':       '한국경제',
  'mk.co.kr':           '매일경제',
  'chosun.com':         '조선일보',
  'joongang.co.kr':     '중앙일보',
  'joins.com':          '중앙일보',
  'donga.com':          '동아일보',
  'hani.co.kr':         '한겨레',
  'khan.co.kr':         '경향신문',
  'kyunghyang.com':     '경향신문',
  'ohmynews.com':       '오마이뉴스',
  'yonhapnews.co.kr':   '연합뉴스',
  'yna.co.kr':          '연합뉴스',
  'newsis.com':         '뉴시스',
  'news1.kr':           '뉴스1',
  'newspim.com':        '뉴스핌',
  'edaily.co.kr':       '이데일리',
  'mt.co.kr':           '머니투데이',
  'moneys.mt.co.kr':    '머니S',
  'sedaily.com':        '서울경제',
  'fnnews.com':         '파이낸셜뉴스',
  'etnews.com':         '전자신문',
  'zdnet.co.kr':        'ZDNet',
  'inews24.com':        '아이뉴스24',
  'dt.co.kr':           '디지털타임스',
  'ddaily.co.kr':       '디지털데일리',
  'asiae.co.kr':        '아시아경제',
  'ajunews.com':        '아주경제',
  'bizwatch.co.kr':     '비즈워치',
  'businesspost.co.kr': '비즈니스포스트',
  'dailian.co.kr':      '데일리안',
  'newdaily.co.kr':     '뉴데일리',
  'seoul.co.kr':        '서울신문',
  'kukinews.com':       '국민일보',
  'munhwa.com':         '문화일보',
  'hankookilbo.com':    '한국일보',
  'thebell.co.kr':      '더벨',
  'bloter.net':         '블로터',
  'mediatoday.co.kr':   '미디어오늘',
  'cosinkorea.com':     '코스인코리아',
  'cncnews.co.kr':      'CNC뉴스',
  'cosmorning.com':     '코스모닝',
  'beautymecca.co.kr':  '뷰티메카',
  'apparelnews.co.kr':  '어패럴뉴스',
  'fashionbiz.co.kr':   '패션비즈',
  'imaeil.com':         '매일신문',
  'busan.com':          '부산일보',
};

function extractPublisher(url) {
  if (!url) return '미상';
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const [domain, name] of Object.entries(PUBLISHER_DOMAINS)) {
      if (hostname === domain || hostname.endsWith('.' + domain) || hostname.includes(domain)) {
        return name;
      }
    }
    const parts = hostname.split('.');
    return parts[0].toUpperCase() || '미상';
  } catch {
    return '미상';
  }
}

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
      .map(a => `*${a.title}*\n${(a.description || '').slice(0, 80)}...\n${a.naverLink}`)
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
      params: { query: process.env.SEARCH_QUERY || '코스맥스', display: 100, sort: 'date' },
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      },
      timeout: 10000,
    });
    return res.data.items || [];
  } catch (err) {
    const s = err.response?.status;
    if (s === 401) log('❌ 네이버 API 인증 실패');
    else if (s === 429) log('⚠️  API 호출 한도 초과');
    else log(`❌ 네이버 API 오류: ${err.message}`);
    return [];
  }
}

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
        id:          row.id,
        title:       row.title,
        link:        row.link,
        naverLink:   row.naver_link,
        description: row.description,
        publisher:   row.publisher || extractPublisher(row.link),
        pubDate:     new Date(row.pub_date),
        isNew:       row.is_new,
        createdAt:   new Date(row.created_at),
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
        publisher:   article.publisher,
        pub_date:    article.pubDate.toISOString(),
        is_new:      true,
      },
      { onConflict: 'link', ignoreDuplicates: true }
    );
  } catch (_) {}
}

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
      publisher:   extractPublisher(item.originallink || item.link),
      pubDate:     new Date(item.pubDate),
      isNew:       true,
      createdAt:   new Date(),
    };
    articlesMap.set(link, article);
    newArticles.push(article);
    await saveToSupabase(article);
  }
  if (newArticles.length > 0) {
    log(`🆕 신규 기사 ${newArticles.length}건 (누적: ${articlesMap.size}건)`);
    broadcast({ type: 'new_articles', articles: newArticles });
    notifySlack(newArticles);
    sendPushNotifications(newArticles);
  } else {
    log(`변동 없음 (누적: ${articlesMap.size}건)`);
  }
  broadcast({ type: 'heartbeat', time: lastPollTime.toISOString(), total: articlesMap.size });
}

// ─── Web Push 발송 ────────────────────────────────────────────────────────────
async function sendPushNotifications(articles) {
  if (!subscriptions.size || !process.env.VAPID_PUBLIC_KEY) return;
  const first   = articles[0];
  const payload = JSON.stringify({
    title: `📰 코스맥스 뉴스 ${articles.length}건 신규`,
    body:  first.title,
    url:   first.naverLink || '/',
    tag:   'cosmax-' + Date.now(),
  });
  const dead = [];
  for (const [ep, sub] of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(ep);
      else log('Push send error: ' + e.message);
    }
  }
  dead.forEach(ep => subscriptions.delete(ep));
  if (dead.length) log(`🗑️  만료 구독 ${dead.length}개 정리`);
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(c => !c.res.destroyed);
  sseClients.forEach(c => c.res.write(payload));
}

// ─── Demo data ────────────────────────────────────────────────────────────────
function loadDemoData() {
  const items = [
    { title: '코스맥스, 2026년 1분기 역대 최대 실적 달성…매출 5,200억원', desc: '코스맥스가 글로벌 ODM 사업 확대에 힘입어 1분기 매출 5,200억원을 기록했다. 전년 동기 대비 23% 증가한 수치로 창사 이래 분기 최대 실적이다.', pub: '한국경제', min: 5 },
    { title: '코스맥스BTI, 2대주주 지분 거래 공시…경영권 변동 없어', desc: '코스맥스 그룹의 지주회사인 코스맥스BTI가 2대주주의 지분 일부 처분 사실을 공시했다. 회사 측은 경영권에는 영향이 없다고 밝혔다.', pub: '매일경제', min: 42 },
    { title: 'K-뷰티 ODM 1위 코스맥스, 미국 오하이오 신규 생산라인 가동', desc: '코스맥스가 미국 오하이오주 생산법인에 신규 라인을 증설하며 북미 시장 공략을 강화한다고 밝혔다. 현지 고용 300명 규모다.', pub: '조선일보', min: 118 },
    { title: '코스맥스, 헬로바이옴 공동개발 마이크로바이옴 원료 5종 공개', desc: '코스맥스는 헬로바이옴과 공동 개발한 마이크로바이옴 화장품 원료 5종을 공개했다. 해당 원료는 2026년 하반기 양산 예정이다.', pub: '연합뉴스', min: 235 },
    { title: '코스맥스 M2C 전략 성과…국내 뷰티 브랜드 20개사 신규 계약', desc: '코스맥스의 M2C(Manufacturer to Consumer) 디지털 전략이 중소 뷰티 브랜드들 사이에서 반향을 일으키며 신규 계약이 빠르게 증가하고 있다.', pub: '코스인코리아', min: 360 },
    { title: '코스맥스 중국법인, 광저우 제2공장 증설 완료…생산능력 40% 확대', desc: '코스맥스 중국 법인이 광저우 제2공장 증설 공사를 완료하고 본격 가동에 들어갔다. 연간 생산 능력이 기존 대비 40% 증가할 전망이다.', pub: '이데일리', min: 720 },
    { title: '이경수 코스맥스 회장, K-뷰티 글로벌 포럼 기조연설', desc: '코스맥스 이경수 회장이 서울에서 열린 K-뷰티 글로벌 포럼에서 한국 화장품 ODM 산업의 미래 전략을 주제로 기조연설을 했다.', pub: '뉴스1', min: 1440 },
    { title: '코스맥스, ESG 경영보고서 발간…탄소중립 2040 선언', desc: '코스맥스가 2025년 ESG 경영보고서를 발간하고 2040년 탄소 중립 달성을 선언했다. 친환경 패키징 전환율은 현재 45%다.', pub: '서울경제', min: 2100 },
  ];
  items.forEach((d, i) => {
    const link = `https://demo.cosmax-monitor.local/article-${i + 1}`;
    articlesMap.set(link, {
      id:          `demo-${i}`,
      title:       d.title,
      link,
      naverLink:   link,
      description: d.desc,
      publisher:   d.pub,
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
  const { page = 1, limit = 30, q = '', range = 'all', dateFrom = '', dateTo = '' } = req.query;
  let articles = Array.from(articlesMap.values()).sort(
    (a, b) => new Date(b.pubDate) - new Date(a.pubDate)
  );

  // Custom date range (takes priority over range preset)
  if (dateFrom || dateTo) {
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      articles = articles.filter(a => new Date(a.pubDate) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      articles = articles.filter(a => new Date(a.pubDate) <= to);
    }
  } else if (range !== 'all') {
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
        (a.description || '').toLowerCase().includes(qLower) ||
        (a.publisher || '').toLowerCase().includes(qLower)
    );
  }

  const total   = articles.length;
  const p       = parseInt(page);
  const lim     = parseInt(limit);
  const items   = articles.slice((p - 1) * lim, p * lim);
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

// ─── POST /api/analyze ────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { title, description, publisher } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    // Demo fallback
    const demoScore = Math.floor(Math.random() * 3) + 2; // 2~4 for demo
    const labels = ['', '매우부정', '부정', '중립', '긍정', '매우긍정'];
    return res.json({
      score:     demoScore,
      sentiment: labels[demoScore],
      comment:   `[데모 모드] Render 환경변수에 ANTHROPIC_API_KEY를 추가하면 실제 AI 분석이 제공됩니다.\n\n[핵심 메시지]\n기사 제목 "${title}"에 대한 분석입니다. 실제 분석을 위해 API 키를 설정해주세요.\n\n[홍보 관점 체크포인트]\n• 기사 논조 및 코스맥스 언급 맥락 확인 필요\n• 경쟁사 대비 포지셔닝 검토 필요\n\n[대응 권고]\nAPI 키 설정 후 정확한 분석 내용을 확인하세요.`,
    });
  }

  try {
    const prompt = `당신은 코스맥스 홍보팀의 시니어 PR 전문가입니다. 아래 뉴스 기사를 코스맥스 기업 PR 관점에서 심층 분석하세요.

기사 정보:
- 제목: ${title}
- 언론사: ${publisher || '미상'}
- 내용 요약: ${description || '(내용 없음)'}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON만):
{"score":숫자,"sentiment":"레이블","comment":"분석내용"}

- score: 1~5 정수 (1=매우부정, 2=부정, 3=중립, 4=긍정, 5=매우긍정)
- sentiment: "매우부정"|"부정"|"중립"|"긍정"|"매우긍정"
- comment: 400자 내외. 아래 구조로 작성하되 줄바꿈은 \\n 사용:
  [핵심 메시지] 기사가 코스맥스에 미치는 영향과 핵심 내용
  [홍보 관점 체크포인트] 주목해야 할 사항 2~3가지 (불릿 포인트)
  [대응 권고] 홍보팀이 취해야 할 액션 아이템`;

    // 모델 우선순위
    const MODELS = ['claude-haiku-4-5-20251001'];
    let lastErr = '';
    for (const model of MODELS) {
      try {
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] },
          {
            headers: {
              'x-api-key':         ANTHROPIC_API_KEY.trim(),
              'anthropic-version': '2023-06-01',
              'content-type':      'application/json',
            },
            timeout: 30000,
          }
        );
        const text   = response.data.content[0].text;
        const clean  = text.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);
        log('Analyze 성공 (' + model + ')');
        return res.json(result);
      } catch (e) {
        const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log('Analyze error (' + model + '): ' + body);
        lastErr = body;
      }
    }
    res.json({ score: 3, sentiment: '중립', comment: '분석 오류: ' + lastErr });
  } catch (e) {
    log('Analyze outer error: ' + e.message);
    res.json({ score: 3, sentiment: '중립', comment: '분석 중 오류가 발생했습니다.' });
  }
});

// ─── Push API ─────────────────────────────────────────────────────────────────

// VAPID 공개키 제공
app.get('/api/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// 구독 등록
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid' });
  subscriptions.set(sub.endpoint, sub);
  log(`📲 푸시 구독 등록 (총 ${subscriptions.size}개)`);
  res.json({ ok: true });
});

// 구독 해제
app.delete('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) subscriptions.delete(endpoint);
  log(`🔕 푸시 구독 해제 (총 ${subscriptions.size}개)`);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  코스맥스 뉴스 모니터 v2.0');
  console.log(`  http://localhost:${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (DEMO_MODE) {
    console.log('⚠️  NAVER_CLIENT_ID 없음 → 데모 모드\n');
    loadDemoData();
    setInterval(() => {
      const titles = [
        '코스맥스, 신규 파트너십 계약 체결 발표',
        '코스맥스BTI 실적 발표…시장 예상치 상회',
        '글로벌 뷰티 ODM 시장 코스맥스 점유율 확대',
        '코스맥스 R&D 센터, 신소재 개발 성공',
        '코스맥스 인도네시아 법인 신규 클라이언트 확보',
      ];
      const pubs = ['한국경제', '매일경제', '연합뉴스', '코스인코리아', '이데일리'];
      const i    = Math.floor(Math.random() * titles.length);
      const link = `https://demo.cosmax-monitor.local/live-${Date.now()}`;
      const article = {
        id:          `live-${Date.now()}`,
        title:       `[실시간] ${titles[i]}`,
        link,
        naverLink:   link,
        description: `데모 모드 실시간 생성 기사 — ${new Date().toLocaleString('ko-KR')}`,
        publisher:   pubs[i],
        pubDate:     new Date(),
        isNew:       true,
        createdAt:   new Date(),
      };
      articlesMap.set(link, article);
      broadcast({ type: 'new_articles', articles: [article] });
      broadcast({ type: 'heartbeat', time: new Date().toISOString(), total: articlesMap.size });
      log(`🟢 데모 신규: ${titles[i]}`);
    }, 30000);
  } else {
    console.log(`📰 검색 키워드: "${process.env.SEARCH_QUERY || '코스맥스'}"`);
    await loadFromSupabase();
    await pollAndProcess();
    cron.schedule('* * * * *', pollAndProcess);
    console.log('🕐 1분 간격 자동 폴링 활성화\n');
  }
});
