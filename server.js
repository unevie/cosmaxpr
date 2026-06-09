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
const subscriptions = new Map();
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
  // ── 주요 일간지 ───────────────────────────────────────────────────────────
  'hankyung.com':           '한국경제',
  'mk.co.kr':               '매일경제',
  'chosun.com':             '조선일보',
  'joongang.co.kr':         '중앙일보',
  'joins.com':              '중앙일보',
  'donga.com':              '동아일보',
  'hani.co.kr':             '한겨레',
  'khan.co.kr':             '경향신문',
  'kyunghyang.com':         '경향신문',
  'seoul.co.kr':            '서울신문',
  'kukinews.com':           '국민일보',
  'munhwa.com':             '문화일보',
  'hankookilbo.com':        '한국일보',
  'imaeil.com':             '매일신문',
  'busan.com':              '부산일보',
  'kookje.co.kr':           '국제신문',
  'kyeonggi.com':           '경기일보',
  // ── 경제·통신 ────────────────────────────────────────────────────────────
  'yonhapnews.co.kr':       '연합뉴스',
  'yna.co.kr':              '연합뉴스',
  'newsis.com':             '뉴시스',
  'news1.kr':               '뉴스1',
  'newspim.com':            '뉴스핌',
  'edaily.co.kr':           '이데일리',
  'mt.co.kr':               '머니투데이',
  'moneys.mt.co.kr':        '머니S',
  'sedaily.com':            '서울경제',
  'fnnews.com':             '파이낸셜뉴스',
  'asiae.co.kr':            '아시아경제',
  'ajunews.com':            '아주경제',
  'heraldcorp.com':         '헤럴드경제',
  'heraldbiz.com':          '헤럴드경제',
  'biz.heraldkorea.co.kr':  '헤럴드경제',
  'segyebiz.com':           '세계비즈',
  'naeil.com':              '내일신문',
  // ── 방송·IT ──────────────────────────────────────────────────────────────
  'etnews.com':             '전자신문',
  'zdnet.co.kr':            'ZDNet코리아',
  'inews24.com':            '아이뉴스24',
  'dt.co.kr':               '디지털타임스',
  'ddaily.co.kr':           '디지털데일리',
  'bloter.net':             '블로터',
  'itbiznews.com':          'IT비즈뉴스',
  // ── 온라인 매체 ──────────────────────────────────────────────────────────
  'ohmynews.com':           '오마이뉴스',
  'mediatoday.co.kr':       '미디어오늘',
  'nocutnews.co.kr':        '노컷뉴스',
  'newstomato.com':         '뉴스토마토',
  'dailian.co.kr':          '데일리안',
  'newdaily.co.kr':         '뉴데일리',
  'bizwatch.co.kr':         '비즈워치',
  'businesspost.co.kr':     '비즈니스포스트',
  'newsway.co.kr':          '뉴스웨이',
  'thebell.co.kr':          '더벨',
  'sisajournal.com':        '시사저널',
  'sisain.co.kr':           '시사인',
  'weekly.khan.co.kr':      '주간경향',
  'mediapen.com':           '미디어펜',
  'straightnews.co.kr':     '스트레이트뉴스',
  'newscj.com':             '천지일보',
  'joseilbo.com':           '조세일보',
  'fetv.co.kr':             'FETV',
  'news2day.co.kr':         '뉴스투데이',
  'newstoday.co.kr':        '뉴스투데이',
  'pinpointnews.co.kr':     '핀포인트뉴스',
  'newsworks.co.kr':        '뉴스웍스',
  'econovill.com':          '이코노빌',
  'leader.co.kr':           '리더스경제',
  'ttimes.co.kr':           'T타임스',
  // ── 조선비즈 계열 ────────────────────────────────────────────────────────
  'it.chosun.com':          '조선비즈',
  'biz.chosun.com':         '조선비즈',
  'chosunbiz.com':          '조선비즈',
  // ── 뷰티·화장품 전문지 ────────────────────────────────────────────────────
  'cosinkorea.com':         '코스인코리아',
  'cncnews.co.kr':          'CNC뉴스',
  'cosmorning.com':         '코스모닝',
  'beautymecca.co.kr':      '뷰티메카',
  'beautyhankook.com':      '뷰티한국',
  'beautytimes.co.kr':      '뷰티타임스',
  'cosmobeauty.kr':         '코스모뷰티',
  'apparelnews.co.kr':      '어패럴뉴스',
  'fashionbiz.co.kr':       '패션비즈',
  // ── 스타트업·기업 ────────────────────────────────────────────────────────
  'startuptoday.co.kr':     '스타트업투데이',
  'thebk.co.kr':            '뷰티경제',
  'theguru.co.kr':          '더구루',
  'impacton.co':            '임팩트온',
  'ceoscoredaily.com':      'CEO스코어데일리',
  // ── 에너지·산업 ──────────────────────────────────────────────────────────
  'ekn.kr':                 '에너지경제',
  'eknnews.com':            '에너지경제',
  'ekn.co.kr':              '에너지경제',
  'ebn.co.kr':              'EBN산업뉴스',
  'nbnnews.co.kr':          'NBN뉴스',
  'cnbnews.com':            'CNB뉴스',
  'greenpost.kr':           '그린포스트코리아',
  'industry.co.kr':         'Industry뉴스',
  // ── 글로벌·이코노믹 계열 ────────────────────────────────────────────────
  'global-economic.co.kr':  '글로벌이코노믹',
  'getnews.co.kr':          '글로벌이코노믹',
  'globaltimes.kr':         '글로벌타임스',
  // ── 기타 온라인 ──────────────────────────────────────────────────────────
  'ine.co.kr':              '이뉴스투데이',
  'enewstoday.co.kr':       '이뉴스투데이',
  'shinailbo.co.kr':        '신아일보',
  'thefirstmedia.co.kr':    '더퍼스트미디어',
  'medicalworldnews.co.kr': '메디컬월드뉴스',
  'meconomynews.com':       '시장경제',
  'econonews.co.kr':        '이코노뉴스',
  'dailyimpact.co.kr':      '데일리임팩트',
  'safetimes.co.kr':        '안전저널',
  'klnews.co.kr':           '한국물류신문',
  'dhnews.co.kr':           '동화뉴스',
  'mhns.co.kr':             '문화뉴스',
  'kdfnews.com':            '한국면세뉴스',
  'pennews.net':            '펜뉴스',
  'pharmnews.com':          '팜뉴스',
  'rapportian.com':         '라포르시안',
  'vitanews.co.kr':         '비타뉴스',
  'jejunews.com':           '제주뉴스',
  'consumernews.co.kr':     '소비자가만드는신문',
  'anewsa.com':             '아시아뉴스통신',
  'm-i.kr':                 '마켓인사이트',
  'kspnews.com':            'KSP뉴스',
  'ifs.or.kr':              '미래경제연구원',
  'wikileaks-kr.org':       '위키리크스한국',
};


// ─── 카테고리 색상 매핑 ────────────────────────────────────────────────────────
const CATEGORY_COLORS = {
  '혁신 기술':    'cat-tech',
  '경영/IR/ESG':  'cat-mgmt',
  '글로벌 확장':  'cat-global',
  '공동 연구':    'cat-research',
  '대외 수상/행사':'cat-award',
  '파트너십/MOU': 'cat-partner',
  '인증/규제/표준':'cat-cert',
  '생산 인프라':  'cat-infra',
  'M&A':          'cat-ma',
};

// ─── 카테고리 키워드 분류기 ────────────────────────────────────────────────────
const PR_CATEGORY_HISTORY = {
  '대세는 인디브랜드 & 맞춤형': '경영/IR/ESG',
  '아프리카도 반했다': '글로벌 확장',
  '코스메위크': '글로벌 확장',
  '평택 2공장 준공': '생산 인프라',
  '피부 마이크로바이옴 넘어 바이오': '경영/IR/ESG',
  '할랄 향수 시장': '글로벌 확장',
  'CDP 기후변화': '경영/IR/ESG',
  '할랄 건기식': '글로벌 확장',
  '2024년 상반기 신입사원': '경영/IR/ESG',
  '캐비아 추출물': '혁신 기술',
  '코스메위크 혁신기술상': '혁신 기술',
  '심상배 부회장': '경영/IR/ESG',
  '단국대': '공동 연구',
  '생물다양성 보전활동': '경영/IR/ESG',
  '셀룰로오스 코팅': '혁신 기술',
  '美 아마존 입접': '글로벌 확장',
  '모발·모낭 오가노이드': '혁신 기술',
  'TWK10': '혁신 기술',
  'AI 메이크업': '혁신 기술',
  '中 상하이 뷰티 박람회': '대외 수상/행사',
  '3중 케어 숙취해소제': '혁신 기술',
  '초소형 기술': '혁신 기술',
  '3자간 MOU': '공동 연구',
  '아쉬아간다': '혁신 기술',
  'GS칼텍스': '공동 연구',
  'HNC 2024': '글로벌 확장',
  '신규 CI 공개': '경영/IR/ESG',
  '글로벌 플랫폼과 수출': '파트너십/MOU',
  '오픈 R&I 심포지엄': '대외 수상/행사',
  '보스맥스': '인증/규제/표준',
  '동반성장 간담회': '파트너십/MOU',
  'K-인디브랜드 올어라운드': '파트너십/MOU',
  '멀티 컬러 클렌징': '혁신 기술',
  '출산장려금': '경영/IR/ESG',
  '반기 ODM 매출': '경영/IR/ESG',
  'AEO 인증': '인증/규제/표준',
  'FAPAS 인증': '인증/규제/표준',
  '강남대': '공동 연구',
  '토타락신': '혁신 기술',
  '아담 MINI': '혁신 기술',
  '2024년 하반기 신입사원': '경영/IR/ESG',
  '하버드대': '공동 연구',
  '수국 추출물': '인증/규제/표준',
  '코스챗': '경영/IR/ESG',
  '이노베이션 라이브러리': '대외 수상/행사',
  '中 진출 20주년': '글로벌 확장',
  'NSF cGMP': '인증/규제/표준',
  '코스맥스패키지닷컴': '생산 인프라',
  '中 대표 병원': '공동 연구',
  '코인셀': '혁신 기술',
  '컬쳐 테크놀로지': '공동 연구',
  '야누스 소재': '혁신 기술',
  '아담 기술 돌파상': '혁신 기술',
  '에코바디스 골드': '경영/IR/ESG',
  '특허청': '인증/규제/표준',
  '젤릭스': '생산 인프라',
  '아트랩 인수': 'M&A',
  'POSTECH 선케어': '공동 연구',
  '2억불 수출탑': '대외 수상/행사',
  '코스맥스바이오 창립 40주년': '경영/IR/ESG',
  '서스틴베스트': '경영/IR/ESG',
  '2025년 정기 임원': '경영/IR/ESG',
  'K뷰티 세계화 가속도': '경영/IR/ESG',
  '싱가포르 국립대': '공동 연구',
  '일본 최대 전시회': '글로벌 확장',
  'FDA OTC': '인증/규제/표준',
  '베이징공상대': '공동 연구',
  '화이트 플러스좀': '인증/규제/표준',
  '印尼 뷰티-웰니스': '글로벌 확장',
  '화장품 ODM 매출 2조': '경영/IR/ESG',
  '남극 마이크로바이옴': '혁신 기술',
  '허민호 부회장': '경영/IR/ESG',
  'SSG닷컴': '파트너십/MOU',
  '2025 전략 협력사': '경영/IR/ESG',
  '이베이재팬': '파트너십/MOU',
  '코스맥스펫 인체용': '공동 연구',
  '2025년 상반기 신입사원': '경영/IR/ESG',
  '비듬 개선': '혁신 기술',
  '이병만': '경영/IR/ESG',
  '태국법인 신공장': '생산 인프라',
  '손상모': '공동 연구',
  '생합성 레티놀': '혁신 기술',
  '베르티스': '공동 연구',
  'WEPs': '경영/IR/ESG',
  '혁신용기': '혁신 기술',
  '인니 수출길': '인증/규제/표준',
  '메쉬 쿠션': '대외 수상/행사',
  '솜탭': '혁신 기술',
  '피부장벽 기능성 마스크시트': '인증/규제/표준',
  '바이오 점착제': '혁신 기술',
  '쇼피': '파트너십/MOU',
  '경기도사회적경제원': '파트너십/MOU',
  'HNC 2025': '대외 수상/행사',
  '밀배유 추출물': '인증/규제/표준',
  '생물다양성 공원': '경영/IR/ESG',
  '펜슬로 K-메이크업': '대외 수상/행사',
  '유로핀즈': '파트너십/MOU',
  '에스티 로더': '파트너십/MOU',
  '한국인 피부 마이크로바이옴': '혁신 기술',
  '브론치': '인증/규제/표준',
  '윈난성': '파트너십/MOU',
  '소셜아이어워드 2025': '대외 수상/행사',
  '식약처와 K뷰티 미래 전략': '인증/규제/표준',
  '극한환경 항산화 효소': '글로벌 확장',
  '고려대와 AI-마이크로바이옴': '공동 연구',
  '미백 기능성 파우더': '인증/규제/표준',
  '티몰글로벌': '파트너십/MOU',
  '궁궐 향수': '파트너십/MOU',
  '2025년 하반기 신입사원': '경영/IR/ESG',
  'CJ제일제당': '공동 연구',
  'IFSCC 본상': '혁신 기술',
  '같이 꿈을 꾸고 싶다': '경영/IR/ESG',
  '듀얼팩': '혁신 기술',
  '원료 협력사 간담회': '파트너십/MOU',
  '곱슬머리 시장': '글로벌 확장',
  '한국생명공학연구원': '공동 연구',
  '상하이 공장 인니 할랄': '인증/규제/표준',
  'PDRN': '혁신 기술',
  '블루메이지': '공동 연구',
  '국가생산성대회': '대외 수상/행사',
  'CES 2026': '혁신 기술',
  '항노화 마이크로바이옴': '혁신 기술',
  '한국ESG기준원': '경영/IR/ESG',
  'AI 향기 예측': '혁신 기술',
  'K건기식 수출탑': '대외 수상/행사',
  '에코바디스 2년 연속 골드': '경영/IR/ESG',
  '지질 나노 전달체': '인증/규제/표준',
  '대한민국 인적자원개발': '대외 수상/행사',
  '북 콘서트': '경영/IR/ESG',
  '공식 웹사이트 개편': '경영/IR/ESG',
  '2026년 정기 임원': '경영/IR/ESG',
  '신년사': '경영/IR/ESG',
  'POSTECH 화장품 효능성분': '공동 연구',
  '타임핏 비타': '혁신 기술',
  '맞춤형 컬러 솔루션': '글로벌 확장',
  '도쿄대·서울대': '공동 연구',
  '타임지 선정': '대외 수상/행사',
  'ISO 23675': '인증/규제/표준',
  '테올림': '혁신 기술',
  '케미노바 인수': 'M&A',
  '印尼 생애주기별': '글로벌 확장',
  'KSAI 지속가능혁신상': '대외 수상/행사',
  '인도네시아 국가연구혁신청': '공동 연구',
  'CDP·에코바디스': '경영/IR/ESG',
  '크런치탭': '혁신 기술',
  '식약처-코스맥스 K뷰티': '인증/규제/표준',
  '씨티씨바이오': '공동 연구',
  '2026년 상반기 신입사원': '경영/IR/ESG',
  '화장품 ODM 업계 최초 고배당': '경영/IR/ESG',
  '세계 최대 뷰티 박람회 스킨케어': '혁신 기술',
  '상하이 다국적 기업 지역본부': '인증/규제/표준',
  '레몬버베나': '혁신 기술',
  '플러셔블 토너 패드': '혁신 기술',
  '이온헬스': '공동 연구',
  '코덕즈': '경영/IR/ESG',
  '亞 최대 뷰티 박람회 뷰티-웰니스': '대외 수상/행사',
  '한화솔루션 태양광': '경영/IR/ESG',
  '발명의날': '대외 수상/행사',
  '뉴욕 K-뷰티 비전': '대외 수상/행사',
  '이노베이션 라이브러리 확대': '혁신 기술',
  '파트너사 원료 제안': '파트너십/MOU',
};

function classifyPressRelease(title) {
  for (const [keyword, cat] of Object.entries(PR_CATEGORY_HISTORY)) {
    if (title.includes(keyword)) return cat;
  }
  const scores = {};
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = keywords.filter(k => title.includes(k)).length;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : '경영/IR/ESG';
}

// ─── 보도자료 캐시 ────────────────────────────────────────────────────────────
let prCache = { items: [], lastFetch: null };

const MONTHS = {
  January:1, February:2, March:3, April:4, May:5, June:6,
  July:7, August:8, September:9, October:10, November:11, December:12,
};

function parsePRDate(str) {
  const m = str.match(/(\w+)\s+(\d+)(?:st|nd|rd|th),?\s*(\d{4})/);
  if (!m) return new Date();
  return new Date(parseInt(m[3]), (MONTHS[m[1]] || 1) - 1, parseInt(m[2]));
}

async function fetchPressReleases() {
  try {
    const res = await axios.get('https://www.cosmax.com/ko-KR/media/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 15000,
    });
    const html = res.data;
    const items = [];
    const entities = ['Cosmax BTI', 'Cosmax Group', 'Cosmax NBT', 'Cosmax BIO', 'Cosmax'];
    const monthPat = Object.keys(MONTHS).join('|');
    const hrefRe = /href="(\/media\/[^"]+)"/g;
    const seen = new Set();
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
      const slug = m[1];
      if (seen.has(slug) || slug === '/media/') continue;
      seen.add(slug);
      const start = Math.max(0, m.index - 300);
      const chunk = html.substring(start, m.index + 400);
      const koreanRe = /[가-힣][가-힣\s\w'",…·\-()&]+/g;
      const korMatches = chunk.match(koreanRe) || [];
      const title = korMatches
        .filter(t => t.length > 10 && !t.includes('Find out'))
        .sort((a, b) => b.length - a.length)[0] || '';
      if (!title) continue;
      const dateMatch = chunk.match(new RegExp(`(${monthPat})\\s+\\d+(?:st|nd|rd|th),?\\s*\\d{4}`));
      const dateStr = dateMatch ? dateMatch[0] : '';
      const pubDate = parsePRDate(dateStr);
      let entity = 'Cosmax';
      for (const e of entities) {
        if (chunk.includes(e)) { entity = e; break; }
      }
      const category = classifyPressRelease(title);
      items.push({
        id:       slug.replace('/media/', '').replace(/\//g, ''),
        title,
        url:      'https://www.cosmax.com' + slug,
        entity,
        pubDate,
        dateStr,
        category,
        catClass: CATEGORY_COLORS[category] || 'cat-mgmt',
      });
    }
    items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    if (items.length > 0) {
      prCache = { items, lastFetch: new Date() };
      log(`📋 보도자료 ${items.length}건 로드`);
    }
    return items;
  } catch (e) {
    log(`PR fetch error: ${e.message}`);
    return prCache.items;
  }
}

function matchArticleToPR(article) {
  if (!prCache.items.length) return false;
  const aTitle = article.title.replace(/[\[\]()]/g, '');
  const aPubDate = new Date(article.pubDate);
  for (const pr of prCache.items) {
    const prDate = new Date(pr.pubDate);
    const dayDiff = Math.abs((aPubDate - prDate) / 86400000);
    if (dayDiff > 7) continue;
    const prWords = pr.title.split(/\s+/).filter(w => w.length > 3);
    const overlap = prWords.filter(w => aTitle.includes(w)).length;
    if (overlap >= 2) return true;
  }
  return false;
}

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
      isPR:        false,
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

// ══════════════════════════════════════════════════════════════════════════════
// 보도자료 시스템
// ══════════════════════════════════════════════════════════════════════════════

const PR_CATEGORIES = {
  '혁신 기술':     '#3B82F6',
  '경영/IR/ESG':  '#10B981',
  '글로벌 확장':   '#8B5CF6',
  '공동 연구':     '#06B6D4',
  '생산 인프라':   '#F97316',
  '대외 수상/행사':'#EAB308',
  '파트너십/MOU': '#EC4899',
  '인증/규제/표준':'#94A3B8',
  'M&A':          '#EF4444',
};

const CATEGORY_KEYWORDS = {
  '혁신 기술':     ['개발','기술','소재','추출물','제형','알고리즘','AI','인공지능','바이오','연구','발견','특허','신규','세계최초','최초','혁신','평가법','전달체','나노'],
  '경영/IR/ESG':  ['매출','실적','ESG','채용','임원인사','대표','회장','지속가능','탄소','친환경','등급','신입','공개채용','창립','경영','IR','배당'],
  '글로벌 확장':   ['중국','미국','일본','인도네시아','인니','동남아','유럽','글로벌','해외','수출','진출','현지화','법인','공장해외'],
  '공동 연구':     ['대학교','대학원','연구원','연구소','산학','공동연구','협약체결','맞손','연구개발','공동개발','연구협력','연구센터'],
  '생산 인프라':   ['공장','준공','생산','라인','설비','인프라','패키지','용기','제조'],
  '대외 수상/행사':['수상','상','박람회','전시','행사','심포지엄','포럼','대회','어워드','영예','수상쾌거','출간','콘서트'],
  '파트너십/MOU': ['MOU','파트너십','제휴','협력협약','간담회','세미나','전략적','플랫폼협력','동반성장'],
  '인증/규제/표준':['인증','허가','승인','규제','ISO','FDA','GMP','식약처','KFDA','특허청','공인','적합'],
  'M&A':          ['인수','합병','M&A','지분','취득','바이아웃'],
};

// 구글시트 기반 161개 보도자료 이력
const PR_HISTORY = [
  {date:'2024-01-04',entity:'Cosmax Group',title:'대세는 인디브랜드 & 맞춤형…코스맥스그룹 글로벌 스탠다드로 거듭날 것',cat:'경영/IR/ESG'},
  {date:'2024-01-11',entity:'Cosmax Group',title:'아프리카도 반했다 코스맥스 신흥국 TF K뷰티 전도사 역할 톡톡',cat:'글로벌 확장'},
  {date:'2024-01-23',entity:'Cosmax Group',title:'코스맥스 2년 연속 코스메위크 참가 글로컬 전략으로 日 시장 공략',cat:'글로벌 확장'},
  {date:'2024-01-29',entity:'Cosmax',title:'코스맥스 평택 2공장 준공 글로벌 색조 시장 확대 선제 대응',cat:'생산 인프라'},
  {date:'2024-02-05',entity:'Cosmax Group',title:'코스맥스그룹 피부 마이크로바이옴 넘어 바이오 초격차 역량 확보한다',cat:'경영/IR/ESG'},
  {date:'2024-02-07',entity:'Cosmax Group',title:'코스맥스 印尼서 취향 저격 나선다 할랄 향수 시장 공략',cat:'글로벌 확장'},
  {date:'2024-03-13',entity:'Cosmax',title:'코스맥스 CDP 기후변화 대응 리더십 등급 획득',cat:'경영/IR/ESG'},
  {date:'2024-03-15',entity:'Cosmax NBT',title:'코스맥스엔비티 할랄 건기식 시장 공략 본격화 K뷰티 열풍 K건기식으로',cat:'글로벌 확장'},
  {date:'2024-03-19',entity:'Cosmax Group',title:'코스맥스그룹 2024년 상반기 신입사원 공개 채용',cat:'경영/IR/ESG'},
  {date:'2024-03-21',entity:'Cosmax BIO',title:'코스맥스바이오 세계 최초 4중 효능 캐비아 추출물 개발 광범위 피부 개선',cat:'혁신 기술'},
  {date:'2024-03-26',entity:'Cosmax Group',title:'코스맥스 伊 세계 최대 뷰티 박람회서 혁신기술상 수상',cat:'혁신 기술'},
  {date:'2024-03-28',entity:'Cosmax Group',title:'코스맥스차이나 신임 대표에 심상배 부회장 코스맥스 대표에 최경 부회장',cat:'경영/IR/ESG'},
  {date:'2024-04-05',entity:'Cosmax Group',title:'코스맥스그룹 단국대와 코스메슈티컬 분야 연구 맞손',cat:'공동 연구'},
  {date:'2024-04-16',entity:'Cosmax',title:'코스맥스 생물다양성 보전활동 보고서 발간 발안천 수질 개선',cat:'경영/IR/ESG'},
  {date:'2024-04-22',entity:'Cosmax',title:'코스맥스 셀룰로오스 코팅 기술로 신개념 세라마이드 화장품 개발',cat:'혁신 기술'},
  {date:'2024-04-25',entity:'Cosmax BIO',title:'K건기식 수출 열기에 코스맥스바이오 美 아마존 입접 세미나 성료',cat:'글로벌 확장'},
  {date:'2024-05-07',entity:'Cosmax',title:'코스맥스 국내 최초 모발 모낭 오가노이드 활용 남성형 탈모 평가법 개발',cat:'혁신 기술'},
  {date:'2024-05-16',entity:'Cosmax NBT',title:'코스맥스엔비티 헬스 유산균 TWK10 이중 기능성 연구 돌입',cat:'혁신 기술'},
  {date:'2024-05-22',entity:'Cosmax',title:'코스맥스 AI 메이크업 개발 시대 연다 스마트 조색 AI 시스템 구축',cat:'혁신 기술'},
  {date:'2024-05-30',entity:'Cosmax Group',title:'코스맥스 中 상하이 뷰티 박람회서 다기능 메이크업 제형 선봬',cat:'대외 수상/행사'},
  {date:'2024-06-03',entity:'Cosmax NBT',title:'코스맥스엔비티 위 간 장 건강 모두 잡은 3중 케어 숙취해소제 개발',cat:'혁신 기술'},
  {date:'2024-06-11',entity:'Cosmax NBT',title:'작지만 강력하다 코스맥스엔비티 초소형 기술 아담 개발',cat:'혁신 기술'},
  {date:'2024-06-14',entity:'Cosmax BIO',title:'코스맥스바이오 3자간 MOU로 맞춤형 건기식 원스톱 솔루션 개발',cat:'공동 연구'},
  {date:'2024-06-17',entity:'Cosmax NBT',title:'코스맥스엔비티 아쉬아간다 허브류 신제품 개발 수면 효율 극대화',cat:'혁신 기술'},
  {date:'2024-06-18',entity:'Cosmax',title:'코스맥스 GS칼텍스와 차세대 K-쿠션 용기 개발 맞손',cat:'공동 연구'},
  {date:'2024-06-25',entity:'Cosmax Group',title:'코스맥스그룹 中 HNC 2024 참가 초소형 혁신 기술로 글로벌 공략 확대',cat:'글로벌 확장'},
  {date:'2024-07-10',entity:'Cosmax Group',title:'코스맥스그룹 신규 CI 공개 글로벌 시장 초격차로',cat:'경영/IR/ESG'},
  {date:'2024-07-12',entity:'Cosmax NBT',title:'건기식 수출 강자 코스맥스NBT 美 中 글로벌 플랫폼과 수출 세미나 개최',cat:'파트너십/MOU'},
  {date:'2024-07-16',entity:'Cosmax Group',title:'코스맥스 오픈 R&I 심포지엄 개최 초격차 연구기술력 확보 박차',cat:'대외 수상/행사'},
  {date:'2024-07-18',entity:'Cosmax BIO',title:'코스맥스바이오 관절 기능성 보스맥스 개별인정형 허가 업계 최대 유효 성분',cat:'인증/규제/표준'},
  {date:'2024-07-25',entity:'Cosmax Group',title:'코스맥스 우수 협력사 대상 2024년 동반성장 간담회 개최',cat:'파트너십/MOU'},
  {date:'2024-07-30',entity:'Cosmax',title:'개발부터 수출까지 코스맥스 K-인디브랜드 올어라운드 시스템 구축한다',cat:'파트너십/MOU'},
  {date:'2024-08-02',entity:'Cosmax',title:'코스맥스 돌려 쓰고 바꿔 쓰는 멀티 컬러 클렌징 밤 개발',cat:'혁신 기술'},
  {date:'2024-08-05',entity:'Cosmax Group',title:'코스맥스 업계 최대 규모 출산장려금 제도 신설 양육 고민 해결 앞장',cat:'경영/IR/ESG'},
  {date:'2024-08-12',entity:'Cosmax Group',title:'코스맥스 글로벌 업계 최초 반기 ODM 매출 1조 돌파 세계 1위 공고',cat:'경영/IR/ESG'},
  {date:'2024-08-14',entity:'Cosmax Group',title:'코스맥스 수출입에 날개 단다 관세청 공인 AEO 인증 동시 획득',cat:'인증/규제/표준'},
  {date:'2024-08-19',entity:'Cosmax NBT',title:'코스맥스NBT 英 FAPAS 인증 획득 국가 공인 수준 분석 기술 확보',cat:'인증/규제/표준'},
  {date:'2024-08-22',entity:'Cosmax Group',title:'코스맥스 中 현지화 연구 박차 강남대와 인재 육성 및 연구 개발 맞손',cat:'공동 연구'},
  {date:'2024-09-02',entity:'Cosmax',title:'코스맥스 여드름 완화 비고시 원료 토타락신 개발 살리실산 대체',cat:'혁신 기술'},
  {date:'2024-09-06',entity:'Cosmax NBT',title:'코스맥스NBT 씹는 즐거움 살린 초소형 제형 아담 MINI 개발',cat:'혁신 기술'},
  {date:'2024-09-19',entity:'Cosmax Group',title:'코스맥스그룹 2024년 하반기 신입사원 공개 채용',cat:'경영/IR/ESG'},
  {date:'2024-09-23',entity:'Cosmax Group',title:'코스맥스그룹 美 하버드대와 글로벌 피부 마이크로바이옴 지도 그린다',cat:'공동 연구'},
  {date:'2024-09-27',entity:'Cosmax BIO',title:'코스맥스바이오 수국 추출물로 美 NDI 인증 획득',cat:'인증/규제/표준'},
  {date:'2024-10-02',entity:'Cosmax Group',title:'코스맥스그룹 생성형 AI 코스챗 도입 업무 효율성 극대화',cat:'경영/IR/ESG'},
  {date:'2024-10-10',entity:'Cosmax Group',title:'코스맥스 혁신 제품 전시공간 이노베이션 라이브러리 오픈',cat:'대외 수상/행사'},
  {date:'2024-10-15',entity:'Cosmax Group',title:'코스맥스 中 진출 20주년 현지화로 화장품 시장 기준 정립',cat:'글로벌 확장'},
  {date:'2024-10-18',entity:'Cosmax BIO',title:'코스맥스바이오 美 NSF cGMP 인증 획득 수출 경쟁력 강화',cat:'인증/규제/표준'},
  {date:'2024-10-21',entity:'Cosmax Group',title:'코스맥스 온라인서 국내외 부자재 한눈에 코스맥스패키지닷컴 오픈',cat:'생산 인프라'},
  {date:'2024-10-25',entity:'Cosmax Group',title:'코스맥스 피부 마이크로바이옴 연구 영토 확장 中 대표 병원과 맞손',cat:'공동 연구'},
  {date:'2024-10-29',entity:'Cosmax',title:'코스맥스 피부 침투력 높인 신규 전달체 코인셀 개발 아누아 제품 적용',cat:'혁신 기술'},
  {date:'2024-10-30',entity:'Cosmax Group',title:'1위가 뭉쳤다 코스맥스-서울대 K뷰티 선도할 컬쳐 테크놀로지 개발',cat:'공동 연구'},
  {date:'2024-11-01',entity:'Cosmax',title:'코스맥스 자외선 차단 혁신 이어간다 끈적임 없앤 야누스 소재 개발',cat:'혁신 기술'},
  {date:'2024-11-07',entity:'Cosmax NBT',title:'코스맥스NBT 초소형 기술 아담 中 기술 박람회서 기술 돌파상 수상',cat:'혁신 기술'},
  {date:'2024-11-20',entity:'Cosmax',title:'코스맥스 글로벌 ESG 평가 에코바디스 골드 등급 획득',cat:'경영/IR/ESG'},
  {date:'2024-11-27',entity:'Cosmax Group',title:'화장품 ODM 특허 1위 코스맥스 특허청과 K뷰티 경쟁력 제고 방안 논의',cat:'인증/규제/표준'},
  {date:'2024-11-28',entity:'Cosmax BIO',title:'코스맥스바이오 젤리 특화 라인 젤릭스 구축 연간 젤리 1.2억포 생산',cat:'생산 인프라'},
  {date:'2024-11-29',entity:'Cosmax Group',title:'코스맥스 AI 스타트업 아트랩 인수 연구 생산 막론 AI 혁신 꾀한다',cat:'M&A'},
  {date:'2024-12-02',entity:'Cosmax Group',title:'코스맥스-POSTECH 선케어 전문 연구센터 설립 포항시와 지역상생 구축',cat:'공동 연구'},
  {date:'2024-12-06',entity:'Cosmax Group',title:'코스맥스 화장품 ODM 최초 2억불 수출탑 수상 K뷰티 세계화 일조',cat:'대외 수상/행사'},
  {date:'2024-12-09',entity:'Cosmax Group',title:'코스맥스바이오 창립 40주년 소재 제형 혁신으로 제 2의 도약',cat:'경영/IR/ESG'},
  {date:'2024-12-16',entity:'Cosmax Group',title:'코스맥스 서스틴베스트 ESG 평가 최고 등급 AA 획득',cat:'경영/IR/ESG'},
  {date:'2024-12-26',entity:'Cosmax Group',title:'코스맥스그룹 2025년 정기 임원 인사 단행 미래 경쟁력 역동성 확대',cat:'경영/IR/ESG'},
  {date:'2025-01-03',entity:'Cosmax Group',title:'코스맥스그룹 K뷰티 세계화 가속도 뷰티 중심 거듭날 것',cat:'경영/IR/ESG'},
  {date:'2025-01-14',entity:'Cosmax Group',title:'코스맥스 亞 1위 싱가포르 국립대와 마이크로바이옴 혁신 이어간다',cat:'공동 연구'},
  {date:'2025-01-21',entity:'Cosmax',title:'코스맥스 日 스킨케어 시장도 정조준 일본 최대 전시회서 주목',cat:'글로벌 확장'},
  {date:'2025-02-04',entity:'Cosmax',title:'코스맥스 美 FDA OTC 제조소 적합 승인 자외선 차단제 생산 3배 키운다',cat:'인증/규제/표준'},
  {date:'2025-02-07',entity:'Cosmax',title:'코스맥스 中 베이징공상대와 맞손 기후별 맞춤형 화장품 연구 고도화',cat:'공동 연구'},
  {date:'2025-02-17',entity:'Cosmax',title:'코스맥스 미백 효능 전달 45배 화이트 플러스좀 비고시 허가 획득',cat:'인증/규제/표준'},
  {date:'2025-02-20',entity:'Cosmax',title:'코스맥스 印尼서 뷰티-웰니스 잇는 포괄적 뷰티 전략 선봬 현지화 박차',cat:'글로벌 확장'},
  {date:'2025-02-24',entity:'Cosmax Group',title:'코스맥스 2024년 화장품 ODM 매출 2조 원 돌파 글로벌 1위 굳힌다',cat:'경영/IR/ESG'},
  {date:'2025-02-27',entity:'Cosmax Group',title:'코스맥스 극한 생존력 남극 마이크로바이옴 화장품 만든다',cat:'혁신 기술'},
  {date:'2025-03-05',entity:'Cosmax Group',title:'코스맥스그룹 지주사 대표에 올리브영 신화 허민호 부회장 영입',cat:'경영/IR/ESG'},
  {date:'2025-03-06',entity:'Cosmax',title:'코스맥스-SSG닷컴 세계로 세계로 유망 뷰티 인디社 육성 나선다',cat:'파트너십/MOU'},
  {date:'2025-03-11',entity:'Cosmax Group',title:'코스맥스 협력사와 ESG 경쟁력 확대 2025 전략 협력사 간담회 개최',cat:'경영/IR/ESG'},
  {date:'2025-03-14',entity:'Cosmax Group',title:'코스맥스 日 시장서 K-뷰티 뉴 챕터 연다 이베이재팬 맞손',cat:'파트너십/MOU'},
  {date:'2025-03-19',entity:'Cosmax Group',title:'사람과 펫 건강 잇는다 코스맥스펫 인체용 건기식 반려동물 적용 연구',cat:'공동 연구'},
  {date:'2025-03-20',entity:'Cosmax Group',title:'코스맥스그룹 2025년 상반기 신입사원 공개 채용',cat:'경영/IR/ESG'},
  {date:'2025-03-24',entity:'Cosmax Group',title:'코스맥스 환절기 대표 두피 고민 비듬 개선 마이크로바이옴 소재 개발',cat:'혁신 기술'},
  {date:'2025-03-27',entity:'Cosmax Group',title:'코스맥스 신임 대표에 이병만 선임 지주사 이병주 대표와 미래 경쟁력 확보',cat:'경영/IR/ESG'},
  {date:'2025-04-02',entity:'Cosmax',title:'코스맥스 태국법인 신공장 착공 동남아 화장품 ODM 중심지로 거듭날 것',cat:'생산 인프라'},
  {date:'2025-04-07',entity:'Cosmax',title:'코스맥스 서울대와 손상모 고민 해결하는 세계 최초 소재 선봬',cat:'공동 연구'},
  {date:'2025-04-11',entity:'Cosmax',title:'코스맥스 친환경 생합성 레티놀로 안티에이징 화장품 패러다임 혁신',cat:'혁신 기술'},
  {date:'2025-04-15',entity:'Cosmax Group',title:'코스맥스 항노화 판 바꾼다 베르티스와 단백체 맞춤형 화장품 개발 착수',cat:'공동 연구'},
  {date:'2025-04-21',entity:'Cosmax',title:'코스맥스 UN 여성역량강화원칙 WEPs 지지 선언 차세대 K뷰티 리더십 육성',cat:'경영/IR/ESG'},
  {date:'2025-04-24',entity:'Cosmax Group',title:'필요한만큼 딸깍 코스맥스네오 지속가능성도 잡은 혁신용기 개발',cat:'혁신 기술'},
  {date:'2025-04-28',entity:'Cosmax BIO',title:'코스맥스바이오 인니 수출길 열렸다 제천공장 KMF 할랄 재인증',cat:'인증/규제/표준'},
  {date:'2025-05-16',entity:'Cosmax',title:'코스맥스 中 메쉬 쿠션 아시아 최대 박람회서 호평',cat:'대외 수상/행사'},
  {date:'2025-05-21',entity:'Cosmax BIO',title:'솜사탕처럼 사르르 코스맥스바이오 구강붕해정 건기식 솜탭 개발',cat:'혁신 기술'},
  {date:'2025-05-22',entity:'Cosmax',title:'코스맥스 국내 최초 피부장벽 기능성 마스크시트 허가 기능성 뷰티 연구 확대',cat:'인증/규제/표준'},
  {date:'2025-05-28',entity:'Cosmax',title:'코스맥스-동성케미컬 업계 최초 바이오 점착제 상용화 지속가능 패키징 확대',cat:'혁신 기술'},
  {date:'2025-06-10',entity:'Cosmax',title:'코스맥스 쇼피와 손잡고 K뷰티 동남아 진출 No.1 파트너 거듭난다',cat:'파트너십/MOU'},
  {date:'2025-06-12',entity:'Cosmax',title:'코스맥스 경기도사회적경제원과 사회환경 문제 해결 앞장 개방형 혁신 확대',cat:'파트너십/MOU'},
  {date:'2025-06-18',entity:'Cosmax Group',title:'코스맥스그룹 中 HNC 2025 참가 글로벌 이너뷰티 시장 공략 확대',cat:'대외 수상/행사'},
  {date:'2025-06-20',entity:'Cosmax NBT',title:'코스맥스엔비티 2중 피부 건강 기능성 밀배유 추출물 개별인정 허가',cat:'인증/규제/표준'},
  {date:'2025-06-23',entity:'Cosmax',title:'코스맥스 멸종위기 보전 생물다양성 공원 조성 미래세대 위한 자원확보 나선다',cat:'경영/IR/ESG'},
  {date:'2025-06-26',entity:'Cosmax',title:'코스맥스 뷰티 본고장 파리서 인정 펜슬로 K-메이크업 열풍 잇는다',cat:'대외 수상/행사'},
  {date:'2025-07-02',entity:'Cosmax',title:'코스맥스 글로벌 최대 임상기관 유로핀즈와 전략적 임상 파트너십 체결',cat:'파트너십/MOU'},
  {date:'2025-07-10',entity:'Cosmax Group',title:'코스맥스 에스티 로더 최고 품질 파트너 선정 13년 파트너십 빛났다',cat:'파트너십/MOU'},
  {date:'2025-07-16',entity:'Cosmax Group',title:'코스맥스 한국인 피부 마이크로바이옴 연구 집대성 다음 무대는 글로벌',cat:'혁신 기술'},
  {date:'2025-07-21',entity:'Cosmax NBT',title:'코스맥스엔비티 호흡기 건강 개선 소재 브론치 개발 NET 인증 획득',cat:'인증/규제/표준'},
  {date:'2025-07-23',entity:'Cosmax',title:'코스맥스 中 약재로 현지 맞춤형 소재 개발 윈난성과 공급망 구축 MOU',cat:'파트너십/MOU'},
  {date:'2025-07-28',entity:'Cosmax Group',title:'코스맥스 뷰티업계 소통왕 등극 소셜아이어워드 2025 최고대상 1위 영예',cat:'대외 수상/행사'},
  {date:'2025-07-31',entity:'Cosmax Group',title:'코스맥스 식약처와 K뷰티 미래 전략 논의 AI 대전환 해법 물색',cat:'인증/규제/표준'},
  {date:'2025-08-06',entity:'Cosmax',title:'코스맥스 中서 극한환경 항산화 효소 개발 고기능 화장품 시장 공략 본격화',cat:'글로벌 확장'},
  {date:'2025-08-21',entity:'Cosmax Group',title:'코스맥스 고려대와 AI-마이크로바이옴 융합 기후 맞춤 화장품 개발 맞손',cat:'공동 연구'},
  {date:'2025-08-28',entity:'Cosmax',title:'코스맥스 하이브리드 뷰티 강화 미백 기능성 파우더 식약처 신규 허가 획득',cat:'인증/규제/표준'},
  {date:'2025-09-03',entity:'Cosmax BIO',title:'코스맥스바이오 中 티몰글로벌과 MOU 국내 고객사 판로 확대',cat:'파트너십/MOU'},
  {date:'2025-09-11',entity:'Cosmax',title:'코스맥스 국가유산진흥원과 조선 왕실 정취 담은 궁궐 향수 개발',cat:'파트너십/MOU'},
  {date:'2025-09-16',entity:'Cosmax Group',title:'코스맥스그룹 2025년 하반기 신입사원 공개 채용',cat:'경영/IR/ESG'},
  {date:'2025-09-17',entity:'Cosmax',title:'코스맥스 CJ제일제당과 PHA 적용 패키지 개발 맞손 친환경 소재 적용 확대',cat:'공동 연구'},
  {date:'2025-09-23',entity:'Cosmax Group',title:'코스맥스 한국 최초 화장품 올림픽 IFSCC 본상 수상 쾌거 월드클래스 연구 경쟁력 입증',cat:'혁신 기술'},
  {date:'2025-09-26',entity:'Cosmax Group',title:'이경수 코스맥스그룹 회장 33년 성공 혁신 담은 같이 꿈을 꾸고 싶다 출간',cat:'경영/IR/ESG'},
  {date:'2025-09-30',entity:'Cosmax BIO',title:'원터치로 액상 정제 한번에 코스맥스바이오 혁신 이중 제형 듀얼팩 개발',cat:'혁신 기술'},
  {date:'2025-10-15',entity:'Cosmax',title:'코스맥스 원료 협력사 간담회 개최 공동 연구 등 상생 혁신 파트너십 강화',cat:'파트너십/MOU'},
  {date:'2025-10-21',entity:'Cosmax',title:'헤어 시장도 세분화 코스맥스 글로벌 17조 곱슬머리 시장 공략 강화',cat:'글로벌 확장'},
  {date:'2025-10-24',entity:'Cosmax',title:'코스맥스-한국생명공학연구원 맞손 印尼 자생식물 기반 기능성 소재 개발 나서',cat:'공동 연구'},
  {date:'2025-10-28',entity:'Cosmax BIO',title:'코스맥스바이오 상하이 공장 인니 할랄 인증 획득 무슬림 시장 공략 확대',cat:'인증/규제/표준'},
  {date:'2025-10-30',entity:'Cosmax',title:'코스맥스 맞춤형 기능성 뷰티 시대 연다 비건 생합성 등 PDRN 생산 경로 다각화',cat:'혁신 기술'},
  {date:'2025-10-31',entity:'Cosmax NBT',title:'코스맥스엔비티 블루메이지와 바이오 기반 항노화 소재 공동개발 MOU',cat:'공동 연구'},
  {date:'2025-11-05',entity:'Cosmax NBT',title:'코스맥스엔비티 국가생산성대회 대통령 표창 수상 글로벌 경쟁력 입증',cat:'대외 수상/행사'},
  {date:'2025-11-06',entity:'Cosmax',title:'코스맥스 CES 2026 혁신상 수상 맞춤형 디바이스 뷰티테크의 새 기준 제시',cat:'혁신 기술'},
  {date:'2025-11-19',entity:'Cosmax',title:'코스맥스 中 현지 식물서 항노화 마이크로바이옴 발견 미생물 뱅크 확대 가속',cat:'혁신 기술'},
  {date:'2025-11-20',entity:'Cosmax Group',title:'코스맥스그룹 한국ESG기준원 평가서 통합 A등급 획득',cat:'경영/IR/ESG'},
  {date:'2025-12-03',entity:'Cosmax',title:'분자 구조만으로 향 예측 코스맥스 AI 향기 예측 알고리즘 모델 개발',cat:'혁신 기술'},
  {date:'2025-12-08',entity:'Cosmax Group',title:'K건기식 수출 견인 코스맥스엔비티 바이오 나란히 수출탑 수상',cat:'대외 수상/행사'},
  {date:'2025-12-10',entity:'Cosmax',title:'코스맥스 글로벌 ESG 평가 에코바디스 2년 연속 골드 획득',cat:'경영/IR/ESG'},
  {date:'2025-12-11',entity:'Cosmax Group',title:'코스맥스 유효 성분 전달 극대화한 지질 나노 전달체로 NET 인증 획득',cat:'인증/규제/표준'},
  {date:'2025-12-12',entity:'Cosmax Group',title:'코스맥스 대한민국 인적자원개발 종합대상 수상 AI DT 기반 인재육성',cat:'대외 수상/행사'},
  {date:'2025-12-15',entity:'Cosmax Group',title:'같이 꿈을 꾸고 싶다 이경수 코스맥스 회장 서울대서 출간 북 콘서트 성료',cat:'경영/IR/ESG'},
  {date:'2025-12-17',entity:'Cosmax Group',title:'코스맥스 공식 웹사이트 개편 전 세계 소비자와 파트너 연결하는 디지털 허브로',cat:'경영/IR/ESG'},
  {date:'2025-12-29',entity:'Cosmax Group',title:'코스맥스그룹 2026년 정기 임원 인사 단행 글로벌 뷰티 시장 선제 대응',cat:'경영/IR/ESG'},
  {date:'2026-01-06',entity:'Cosmax Group',title:'신년사 코스맥스그룹 고객 가치에 프리미엄 더해 K-뷰티 고급화 선도',cat:'경영/IR/ESG'},
  {date:'2026-01-13',entity:'Cosmax Group',title:'코스맥스-POSTECH 화장품 효능성분 방출속도 제어기술 개발',cat:'공동 연구'},
  {date:'2026-01-16',entity:'Cosmax BIO',title:'코스맥스바이오 9시간 지속성 제형 타임핏 비타 개발',cat:'혁신 기술'},
  {date:'2026-01-20',entity:'Cosmax Group',title:'코스맥스 맞춤형 컬러 솔루션으로 日 베이스 메이크업 시장 흔든다',cat:'글로벌 확장'},
  {date:'2026-01-22',entity:'Cosmax Group',title:'코스맥스 도쿄대 서울대와 차세대 스마트 전달체 개발 글로벌 뷰티 디바이스 판 키운다',cat:'공동 연구'},
  {date:'2026-01-29',entity:'Cosmax Group',title:'코스맥스 美 타임지 선정 2026 세계 최고 지속가능 성장기업 등극',cat:'대외 수상/행사'},
  {date:'2026-02-11',entity:'Cosmax',title:'코스맥스 차세대 자외선 차단 평가법 ISO 23675 도입 유럽 선케어 시장 정조준',cat:'인증/규제/표준'},
  {date:'2026-02-13',entity:'Cosmax BIO',title:'코스맥스바이오 체지방 줄이고 근육 지키는 신소재 테올림 개발',cat:'혁신 기술'},
  {date:'2026-02-23',entity:'Cosmax Group',title:'코스맥스 첫 유럽 생산기지 구축 伊 케미노바 인수로 글로벌 영향력 확대',cat:'M&A'},
  {date:'2026-02-26',entity:'Cosmax Group',title:'코스맥스 印尼서 생애주기별 웰니스 솔루션 제시 서남아 중동 공략 본격화',cat:'글로벌 확장'},
  {date:'2026-03-04',entity:'Cosmax',title:'코스맥스 지역사회 동행 환경 보전 활동으로 KSAI 지속가능혁신상 수상',cat:'대외 수상/행사'},
  {date:'2026-03-10',entity:'Cosmax Group',title:'코스맥스 印尼서 마이크로바이옴 맵 구축 국가연구혁신청과 공동 연구',cat:'공동 연구'},
  {date:'2026-03-11',entity:'Cosmax',title:'코스맥스 글로벌 ESG 평가 CDP 에코바디스서 잇달아 최고 등급',cat:'경영/IR/ESG'},
  {date:'2026-03-18',entity:'Cosmax BIO',title:'코스맥스바이오 겉바속사 씹어 먹는 신제형 크런치탭 개발',cat:'혁신 기술'},
  {date:'2026-03-20',entity:'Cosmax',title:'식약처-코스맥스 K뷰티 글로벌 경쟁력 강화 위해 규제 대응 머리 맞대',cat:'인증/규제/표준'},
  {date:'2026-03-23',entity:'Cosmax Group',title:'코스맥스펫 씨티씨바이오와 MOU체결 프리미엄 펫 유산균 시장 정조준',cat:'공동 연구'},
  {date:'2026-03-25',entity:'Cosmax Group',title:'코스맥스그룹 2026년 상반기 신입사원 공개 채용',cat:'경영/IR/ESG'},
  {date:'2026-03-27',entity:'Cosmax Group',title:'코스맥스 화장품 ODM 업계 최초 고배당기업',cat:'경영/IR/ESG'},
  {date:'2026-03-30',entity:'Cosmax',title:'코스맥스 세계 최대 뷰티 박람회서 스킨케어 제형 부문 대상 수상',cat:'혁신 기술'},
  {date:'2026-04-03',entity:'Cosmax Group',title:'코스맥스 상하이 다국적 기업 지역본부 인증 획득 현지 공략 날개 달아',cat:'인증/규제/표준'},
  {date:'2026-04-16',entity:'Cosmax BIO',title:'잠깐 자도 딥슬립 코스맥스바이오 수면 기능성 레몬버베나 추출물 개발',cat:'혁신 기술'},
  {date:'2026-04-21',entity:'Cosmax Group',title:'코스맥스 2단계 생분해 플러셔블 토너 패드 개발 글로벌 클린뷰티 시장 공략',cat:'혁신 기술'},
  {date:'2026-04-24',entity:'Cosmax Group',title:'코스맥스-이온헬스 개인 건강 맞춤형 뷰티 큐레이션 플랫폼 개발 협력',cat:'공동 연구'},
  {date:'2026-04-30',entity:'Cosmax Group',title:'코스맥스 대학생 서포터즈 코덕즈 1기 모집 Z세대와 M2C 소통 강화',cat:'경영/IR/ESG'},
  {date:'2026-05-15',entity:'Cosmax Group',title:'코스맥스 亞 최대 뷰티 박람회서 뷰티-웰니스 시너지 강조 글로벌 기술 총망라',cat:'대외 수상/행사'},
  {date:'2026-05-19',entity:'Cosmax',title:'코스맥스-한화솔루션 태양광 직접 PPA 체결 2050 탄소중립 여정 본격화',cat:'경영/IR/ESG'},
  {date:'2026-05-20',entity:'Cosmax Group',title:'코스맥스 발명의날 산업부 장관 표창 수상 K뷰티 바이오 기술 혁신',cat:'대외 수상/행사'},
  {date:'2026-05-26',entity:'Cosmax Group',title:'코스맥스 뉴욕 한복판서 K-뷰티 비전 제시 차세대 스킨케어 효능 원료 주목',cat:'대외 수상/행사'},
  {date:'2026-05-28',entity:'Cosmax',title:'코스맥스 이노베이션 라이브러리 글로벌 혁신 성과로 확대 개편',cat:'혁신 기술'},
  {date:'2026-06-05',entity:'Cosmax Group',title:'코스맥스 파트너사 원료 제안 프로세스 디지털화 공급망 다변화 속도',cat:'파트너십/MOU'},
  {date:'2026-06-09',entity:'Cosmax Group',title:'코스맥스 가톨릭대와 코스메디컬·뷰티AI 인재 양성 맞손',cat:'공동 연구'},
];

let pressReleases = [...PR_HISTORY];

function classifyPR(title) {
  const t = title.replace(/[^가-힣a-zA-Z0-9 ]/g, ' ');
  const scores = {};
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = kws.filter(kw => t.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a,b) => b[1]-a[1])[0];
  return best[1] > 0 ? best[0] : '경영/IR/ESG';
}

function matchPR(article) {
  const aDate  = new Date(article.pubDate);
  const aTitle = (article.title||'').replace(/<[^>]+>/g,'');
  const aDesc  = (article.description||'').replace(/<[^>]+>/g,'');
  // 제목 또는 부제에 "코스맥스" 없으면 제외
  if (!aTitle.includes('코스맥스') && !aDesc.includes('코스맥스')) return null;
  const searchText = aTitle + ' ' + aDesc;
  for (const pr of pressReleases) {
    const prDate = new Date(pr.date);
    const diffDays = Math.abs((aDate - prDate) / 86400000);
    if (diffDays > 7) continue;
    const prWords = pr.title.match(/[가-힣]{3,}|[A-Za-z]{3,}/g) || [];
    const matches = prWords.filter(w => searchText.includes(w));
    if (matches.length >= 3) return { prTitle: pr.title, prDate: pr.date, cat: pr.cat };
  }
  return null;
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
    { title: '코스맥스, 2026년 1분기 역대 최대 실적 달성…매출 5,200억원', desc: '코스맥스가 글로벌 ODM 사업 확대에 힘입어 1분기 매출 5,200억원을 기록했다.', pub: '한국경제', min: 5 },
    { title: '코스맥스BTI, 2대주주 지분 거래 공시…경영권 변동 없어', desc: '코스맥스 그룹의 지주회사인 코스맥스BTI가 2대주주의 지분 일부 처분 사실을 공시했다.', pub: '매일경제', min: 42 },
    { title: 'K-뷰티 ODM 1위 코스맥스, 미국 오하이오 신규 생산라인 가동', desc: '코스맥스가 미국 오하이오주 생산법인에 신규 라인을 증설하며 북미 시장 공략을 강화한다.', pub: '조선일보', min: 118 },
    { title: '코스맥스, 헬로바이옴 공동개발 마이크로바이옴 원료 5종 공개', desc: '코스맥스는 헬로바이옴과 공동 개발한 마이크로바이옴 화장품 원료 5종을 공개했다.', pub: '연합뉴스', min: 235 },
    { title: '코스맥스 M2C 전략 성과…국내 뷰티 브랜드 20개사 신규 계약', desc: '코스맥스의 M2C 디지털 전략이 중소 뷰티 브랜드들 사이에서 반향을 일으키고 있다.', pub: '코스인코리아', min: 360 },
    { title: '코스맥스 중국법인, 광저우 제2공장 증설 완료…생산능력 40% 확대', desc: '코스맥스 중국 법인이 광저우 제2공장 증설 공사를 완료하고 본격 가동에 들어갔다.', pub: '이데일리', min: 720 },
    { title: '이경수 코스맥스 회장, K-뷰티 글로벌 포럼 기조연설', desc: '코스맥스 이경수 회장이 서울에서 열린 K-뷰티 글로벌 포럼에서 기조연설을 했다.', pub: '뉴스1', min: 1440 },
    { title: '코스맥스, ESG 경영보고서 발간…탄소중립 2040 선언', desc: '코스맥스가 2025년 ESG 경영보고서를 발간하고 2040년 탄소 중립 달성을 선언했다.', pub: '서울경제', min: 2100 },
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
    const now = new Date();
    if (range === 'today') {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      articles = articles.filter(a => new Date(a.pubDate) >= todayStart);
    } else if (range === 'week') {
      const cutoff = new Date(Date.now() - 7 * 86400000);
      articles = articles.filter(a => new Date(a.pubDate) >= cutoff);
    } else if (range === 'month') {
      // 이번달 1일~오늘 (서버 측 보조 처리 - 클라이언트에서 custom으로 전환하지만 혹시 직접 호출 시 대비)
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      articles = articles.filter(a => new Date(a.pubDate) >= monthStart);
    }
  }

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
    const demoScore = Math.floor(Math.random() * 3) + 2;
    const labels = ['', '매우부정', '부정', '중립', '긍정', '매우긍정'];
    return res.json({
      score:     demoScore,
      sentiment: labels[demoScore],
      comment:   `[데모 모드] Render 환경변수에 ANTHROPIC_API_KEY를 추가하면 실제 AI 분석이 제공됩니다.\n\n[핵심 메시지]\n기사 제목 "${title}"에 대한 분석입니다.\n\n[홍보 관점 체크포인트]\n• 기사 논조 및 코스맥스 언급 맥락 확인 필요\n• 경쟁사 대비 포지셔닝 검토 필요\n\n[대응 권고]\nAPI 키 설정 후 정확한 분석 내용을 확인하세요.`,
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

// ─── Claude web_search로 신규 보도자료 수집 ──────────────────────────────────
async function fetchPRsWithClaude() {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) { log('PR 검색: ANTHROPIC_API_KEY 없음'); return; }
  log('🤖 Claude로 보도자료 검색 중...');

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `코스맥스 보도자료를 웹 검색으로 찾아줘. 검색어: "코스맥스 보도자료 2026 site:cosmax.com" 또는 "코스맥스 신제품 개발 2026". 찾은 결과를 아래 JSON으로만 응답 (다른 텍스트 없이):
[{"date":"YYYY-MM-DD","entity":"Cosmax","title":"보도자료 제목"}]
entity: Cosmax/Cosmax Group/Cosmax NBT/Cosmax BIO 중 하나. 최신순 10개.`
        }]
      },
      {
        headers: {
          'x-api-key':         ANTHROPIC_API_KEY.trim(),
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 40000,
      }
    );

    const blocks = res.data.content || [];
    const text   = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const match  = text.match(/\[[\s\S]*?\]/);
    if (!match) { log('PR Claude: JSON 없음 → ' + text.substring(0, 200)); return; }

    const items = JSON.parse(match[0]);
    let added = 0;

    for (const item of items) {
      if (!item.title || !item.date) continue;
      const key = item.title.replace(/\s/g, '').substring(0, 15);
      const dup = pressReleases.some(p =>
        p.title.replace(/\s/g, '').substring(0, 15) === key
      );
      if (dup) continue;

      const cat = classifyPR(item.title);
      pressReleases.unshift({
        date:   item.date,
        entity: item.entity || 'Cosmax',
        title:  item.title,
        cat,
        color:  PR_CATEGORIES[cat] || '#6B7280',
        source: 'claude',
      });
      added++;
    }

    log('📋 보도자료 검색 완료 — 신규 ' + added + '건 (총 ' + pressReleases.length + '건)');

  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    log('PR Claude 오류: ' + detail);
  }
}

// ─── 보도자료 API ─────────────────────────────────────────────────────────────
app.post('/api/pr-refresh', async (req, res) => {
  await fetchPRsWithClaude();
  res.json({ ok: true, total: pressReleases.length });
});

app.get('/api/press-releases', (req, res) => {
  const sorted = [...pressReleases].sort((a,b) => new Date(b.date) - new Date(a.date));
  res.json(sorted.map(p => ({
    ...p,
    color: PR_CATEGORIES[p.cat] || '#6B7280',
  })));
});

// ─── Push API ─────────────────────────────────────────────────────────────────
app.get('/api/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid' });
  subscriptions.set(sub.endpoint, sub);
  log(`📲 푸시 구독 등록 (총 ${subscriptions.size}개)`);
  res.json({ ok: true });
});

app.delete('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) subscriptions.delete(endpoint);
  log(`🔕 푸시 구독 해제 (총 ${subscriptions.size}개)`);
  res.json({ ok: true });
});

// ─── GET /api/pr-articles ─────────────────────────────────────────────────────
app.get('/api/pr-articles', (req, res) => {
  const matched = [];
  for (const article of articlesMap.values()) {
    if (matchArticleToPR(article)) {
      matched.push(article.id);
    }
  }
  res.json({ matched });
});

// ─── GET /ping ────────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  코스맥스 뉴스 모니터 v2.0');
  console.log(`  http://localhost:${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (DEMO_MODE) {
    console.log('⚠️  NAVER_CLIENT_ID 없음 → 데모 모드\n');
    loadDemoData();
    fetchPRsWithClaude();
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
    await fetchPRsWithClaude();
    cron.schedule('0 0,3,6,9 * * 1-5', fetchPRsWithClaude);
    await pollAndProcess();
    cron.schedule('* * * * *', pollAndProcess);
    console.log('🕐 1분 간격 자동 폴링 활성화\n');
  }
});
