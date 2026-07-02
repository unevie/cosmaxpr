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
// 구조: { name: '언론사명', type: '언론사유형' }
// type 값 (네이버 뉴스스탠드 CP사 분류 기준):
//   '종합일간지' | '방송/통신' | '경제/IT' | '인터넷신문' | '스포츠/연예' | '지역지' | '매거진/전문지'
const PUBLISHER_DOMAINS = {
  // ── 종합일간지 ────────────────────────────────────────────────────────────
  'chosun.com':             { name:'조선일보',     type:'종합일간지' },
  'joongang.co.kr':         { name:'중앙일보',     type:'종합일간지' },
  'joins.com':              { name:'중앙일보',     type:'종합일간지' },
  'donga.com':              { name:'동아일보',     type:'종합일간지' },
  'hani.co.kr':             { name:'한겨레',       type:'종합일간지' },
  'khan.co.kr':             { name:'경향신문',     type:'종합일간지' },
  'kyunghyang.com':         { name:'경향신문',     type:'종합일간지' },
  'seoul.co.kr':            { name:'서울신문',     type:'종합일간지' },
  'kukinews.com':           { name:'국민일보',     type:'종합일간지' },
  'munhwa.com':             { name:'문화일보',     type:'종합일간지' },
  'hankookilbo.com':        { name:'한국일보',     type:'종합일간지' },
  // ── 방송/통신 ────────────────────────────────────────────────────────────
  'yonhapnews.co.kr':       { name:'연합뉴스',     type:'방송/통신' },
  'yna.co.kr':              { name:'연합뉴스',     type:'방송/통신' },
  'newsis.com':             { name:'뉴시스',       type:'방송/통신' },
  'news1.kr':               { name:'뉴스1',        type:'방송/통신' },
  'kbs.co.kr':              { name:'KBS',          type:'방송/통신' },
  'mbc.co.kr':              { name:'MBC',          type:'방송/통신' },
  'sbs.co.kr':              { name:'SBS',          type:'방송/통신' },
  'ytn.co.kr':              { name:'YTN',          type:'방송/통신' },
  'mbn.co.kr':              { name:'MBN',          type:'방송/통신' },
  'jtbc.co.kr':             { name:'JTBC',         type:'방송/통신' },
  'channel.or.kr':          { name:'채널A',        type:'방송/통신' },
  'tvchosun.com':           { name:'TV조선',       type:'방송/통신' },
  // ── 경제/IT ──────────────────────────────────────────────────────────────
  'hankyung.com':           { name:'한국경제',     type:'경제/IT' },
  'mk.co.kr':               { name:'매일경제',     type:'경제/IT' },
  'edaily.co.kr':           { name:'이데일리',     type:'경제/IT' },
  'mt.co.kr':               { name:'머니투데이',   type:'경제/IT' },
  'moneys.mt.co.kr':        { name:'머니S',        type:'경제/IT' },
  'sedaily.com':            { name:'서울경제',     type:'경제/IT' },
  'fnnews.com':             { name:'파이낸셜뉴스', type:'경제/IT' },
  'asiae.co.kr':            { name:'아시아경제',   type:'경제/IT' },
  'ajunews.com':            { name:'아주경제',     type:'경제/IT' },
  'heraldcorp.com':         { name:'헤럴드경제',   type:'경제/IT' },
  'heraldbiz.com':          { name:'헤럴드경제',   type:'경제/IT' },
  'biz.heraldkorea.co.kr':  { name:'헤럴드경제',   type:'경제/IT' },
  'newspim.com':            { name:'뉴스핌',       type:'경제/IT' },
  'segyebiz.com':           { name:'세계비즈',     type:'경제/IT' },
  'naeil.com':              { name:'내일신문',     type:'경제/IT' },
  'it.chosun.com':          { name:'조선비즈',     type:'경제/IT' },
  'biz.chosun.com':         { name:'조선비즈',     type:'경제/IT' },
  'chosunbiz.com':          { name:'조선비즈',     type:'경제/IT' },
  'etnews.com':             { name:'전자신문',     type:'경제/IT' },
  'zdnet.co.kr':            { name:'ZDNet코리아',  type:'경제/IT' },
  'inews24.com':            { name:'아이뉴스24',   type:'경제/IT' },
  'dt.co.kr':               { name:'디지털타임스', type:'경제/IT' },
  'ddaily.co.kr':           { name:'디지털데일리', type:'경제/IT' },
  'bloter.net':             { name:'블로터',       type:'경제/IT' },
  'itbiznews.com':          { name:'IT비즈뉴스',   type:'경제/IT' },
  'ekn.kr':                 { name:'에너지경제',   type:'경제/IT' },
  'eknnews.com':            { name:'에너지경제',   type:'경제/IT' },
  'ekn.co.kr':              { name:'에너지경제',   type:'경제/IT' },
  'ebn.co.kr':              { name:'EBN산업뉴스',  type:'경제/IT' },
  'global-economic.co.kr':  { name:'글로벌이코노믹',type:'경제/IT' },
  'getnews.co.kr':          { name:'글로벌이코노믹',type:'경제/IT' },
  'joseilbo.com':           { name:'조세일보',     type:'경제/IT' },
  'fetv.co.kr':             { name:'FETV',         type:'경제/IT' },
  'm-i.kr':                 { name:'마켓인사이트', type:'경제/IT' },
  // ── 인터넷신문 ───────────────────────────────────────────────────────────
  'ohmynews.com':           { name:'오마이뉴스',   type:'인터넷신문' },
  'mediatoday.co.kr':       { name:'미디어오늘',   type:'인터넷신문' },
  'nocutnews.co.kr':        { name:'노컷뉴스',     type:'인터넷신문' },
  'newstomato.com':         { name:'뉴스토마토',   type:'인터넷신문' },
  'dailian.co.kr':          { name:'데일리안',     type:'인터넷신문' },
  'newdaily.co.kr':         { name:'뉴데일리',     type:'인터넷신문' },
  'bizwatch.co.kr':         { name:'비즈워치',     type:'인터넷신문' },
  'businesspost.co.kr':     { name:'비즈니스포스트',type:'인터넷신문' },
  'newsway.co.kr':          { name:'뉴스웨이',     type:'인터넷신문' },
  'thebell.co.kr':          { name:'더벨',         type:'인터넷신문' },
  'sisajournal.com':        { name:'시사저널',     type:'인터넷신문' },
  'sisain.co.kr':           { name:'시사인',       type:'인터넷신문' },
  'weekly.khan.co.kr':      { name:'주간경향',     type:'인터넷신문' },
  'mediapen.com':           { name:'미디어펜',     type:'인터넷신문' },
  'straightnews.co.kr':     { name:'스트레이트뉴스',type:'인터넷신문' },
  'newscj.com':             { name:'천지일보',     type:'인터넷신문' },
  'news2day.co.kr':         { name:'뉴스투데이',   type:'인터넷신문' },
  'newstoday.co.kr':        { name:'뉴스투데이',   type:'인터넷신문' },
  'pinpointnews.co.kr':     { name:'핀포인트뉴스', type:'인터넷신문' },
  'newsworks.co.kr':        { name:'뉴스웍스',     type:'인터넷신문' },
  'econovill.com':          { name:'이코노빌',     type:'인터넷신문' },
  'leader.co.kr':           { name:'리더스경제',   type:'인터넷신문' },
  'ttimes.co.kr':           { name:'T타임스',      type:'인터넷신문' },
  'nbnnews.co.kr':          { name:'NBN뉴스',      type:'인터넷신문' },
  'cnbnews.com':            { name:'CNB뉴스',      type:'인터넷신문' },
  'greenpost.kr':           { name:'그린포스트코리아',type:'인터넷신문' },
  'industry.co.kr':         { name:'Industry뉴스', type:'인터넷신문' },
  'globaltimes.kr':         { name:'글로벌타임스', type:'인터넷신문' },
  'ine.co.kr':              { name:'이뉴스투데이', type:'인터넷신문' },
  'enewstoday.co.kr':       { name:'이뉴스투데이', type:'인터넷신문' },
  'shinailbo.co.kr':        { name:'신아일보',     type:'인터넷신문' },
  'thefirstmedia.co.kr':    { name:'더퍼스트미디어',type:'인터넷신문' },
  'meconomynews.com':       { name:'시장경제',     type:'인터넷신문' },
  'econonews.co.kr':        { name:'이코노뉴스',   type:'인터넷신문' },
  'dailyimpact.co.kr':      { name:'데일리임팩트', type:'인터넷신문' },
  'dhnews.co.kr':           { name:'동화뉴스',     type:'인터넷신문' },
  'mhns.co.kr':             { name:'문화뉴스',     type:'인터넷신문' },
  'pennews.net':            { name:'펜뉴스',       type:'인터넷신문' },
  'anewsa.com':             { name:'아시아뉴스통신',type:'인터넷신문' },
  'kspnews.com':            { name:'KSP뉴스',      type:'인터넷신문' },
  'wikileaks-kr.org':       { name:'위키리크스한국',type:'인터넷신문' },
  'startuptoday.co.kr':     { name:'스타트업투데이',type:'인터넷신문' },
  'theguru.co.kr':          { name:'더구루',       type:'인터넷신문' },
  'impacton.co':            { name:'임팩트온',     type:'인터넷신문' },
  'ceoscoredaily.com':      { name:'CEO스코어데일리',type:'인터넷신문' },
  // ── 지역지 ───────────────────────────────────────────────────────────────
  'imaeil.com':             { name:'매일신문',     type:'지역지' },
  'busan.com':              { name:'부산일보',     type:'지역지' },
  'kookje.co.kr':           { name:'국제신문',     type:'지역지' },
  'kyeonggi.com':           { name:'경기일보',     type:'지역지' },
  'jejunews.com':           { name:'제주뉴스',     type:'지역지' },
  // ── 매거진/전문지 ─────────────────────────────────────────────────────────
  'cosinkorea.com':         { name:'코스인코리아', type:'매거진/전문지' },
  'cncnews.co.kr':          { name:'CNC뉴스',      type:'매거진/전문지' },
  'cosmorning.com':         { name:'코스모닝',     type:'매거진/전문지' },
  'beautymecca.co.kr':      { name:'뷰티메카',     type:'매거진/전문지' },
  'beautyhankook.com':      { name:'뷰티한국',     type:'매거진/전문지' },
  'beautytimes.co.kr':      { name:'뷰티타임스',   type:'매거진/전문지' },
  'cosmobeauty.kr':         { name:'코스모뷰티',   type:'매거진/전문지' },
  'apparelnews.co.kr':      { name:'어패럴뉴스',   type:'매거진/전문지' },
  'fashionbiz.co.kr':       { name:'패션비즈',     type:'매거진/전문지' },
  'thebk.co.kr':            { name:'뷰티경제',     type:'매거진/전문지' },
  'safetimes.co.kr':        { name:'안전저널',     type:'매거진/전문지' },
  'klnews.co.kr':           { name:'한국물류신문', type:'매거진/전문지' },
  'kdfnews.com':            { name:'한국면세뉴스', type:'매거진/전문지' },
  'pharmnews.com':          { name:'팜뉴스',       type:'매거진/전문지' },
  'rapportian.com':         { name:'라포르시안',   type:'매거진/전문지' },
  'vitanews.co.kr':         { name:'비타뉴스',     type:'매거진/전문지' },
  'consumernews.co.kr':     { name:'소비자가만드는신문',type:'매거진/전문지' },
  'medicalworldnews.co.kr': { name:'메디컬월드뉴스',type:'매거진/전문지' },
  'ifs.or.kr':              { name:'미래경제연구원',type:'매거진/전문지' },

  // ── 소급 수집에서 발견된 추가 언론사 ──────────────────────────────────────
  'etoday.co.kr':           { name:'이투데이',      type:'경제/IT' },
  'digitaltoday.co.kr':     { name:'디지털투데이',  type:'경제/IT' },
  'dealsite.co.kr':         { name:'딜사이트',      type:'경제/IT' },
  'catchnews.co.kr':        { name:'캐치뉴스',      type:'인터넷신문' },
  'dnews.co.kr':            { name:'대한경제',      type:'경제/IT' },
  'biztribune.co.kr':       { name:'비즈트리뷴',    type:'인터넷신문' },
  'megaeconomy.co.kr':      { name:'메가이코노미',  type:'인터넷신문' },
  'youthdaily.co.kr':       { name:'청년일보',      type:'인터넷신문' },
  'bokuennews.com':         { name:'보건뉴스',      type:'매거진/전문지' },
  'globalepic.co.kr':       { name:'글로벌에픽',    type:'인터넷신문' },
  'thefirstmedia.co.kr':    { name:'더퍼스트미디어',type:'인터넷신문' },
  'newsdream.co.kr':        { name:'뉴스드림',      type:'인터넷신문' },
  'hansbiz.co.kr':          { name:'한스경제',      type:'경제/IT' },
  'theviewers.co.kr':       { name:'더뷰어스',      type:'인터넷신문' },
  'businesskorea.co.kr':    { name:'비즈니스코리아',type:'인터넷신문' },
  'koreaherald.com':        { name:'코리아헤럴드',  type:'종합일간지' },
  'joongangenews.com':      { name:'중앙경제뉴스',  type:'인터넷신문' },
  'k-health.com':           { name:'헬스경향',      type:'매거진/전문지' },
  'greened.kr':             { name:'녹색경제',      type:'인터넷신문' },
  'daily.co.kr':            { name:'데일리한국',    type:'인터넷신문' },
  'weekly.co.kr':           { name:'위클리',        type:'인터넷신문' },
  'khealth.co.kr':          { name:'헬스경향',      type:'매거진/전문지' },
  'handmk.com':             { name:'한국섬유신문',  type:'매거진/전문지' },
  'seoulfn.com':            { name:'서울파이낸스',  type:'경제/IT' },
  'businessplus.co.kr':     { name:'비즈니스플러스',type:'인터넷신문' },
  'dailypop.kr':            { name:'데일리팝',      type:'인터넷신문' },
  'finomy.com':             { name:'파이노미',      type:'경제/IT' },
  'newsprime.co.kr':        { name:'뉴스프라임',    type:'인터넷신문' },
  'sidae.co.kr':            { name:'시대일보',      type:'인터넷신문' },
  'weekly.hankooki.com':    { name:'주간한국',      type:'인터넷신문' },
  'ttimes.co.kr':           { name:'T타임스',       type:'인터넷신문' },

  // ── 3차 추가 ──────────────────────────────────────────────────────────────
  'widedaily.com':          { name:'와이드데일리',  type:'인터넷신문' },
  'economist.co.kr':        { name:'이코노미스트',  type:'매거진/전문지' },
  'yakup.com':              { name:'약업신문',      type:'매거진/전문지' },
  'sentv.co.kr':            { name:'서울경제TV',   type:'방송/통신' },
  'viva100.com':            { name:'브릿지경제',    type:'경제/IT' },
  'newsroad.co.kr':         { name:'뉴스로드',      type:'인터넷신문' },
  'mstoday.co.kr':          { name:'MS투데이',      type:'인터넷신문' },
  'choicenews.co.kr':       { name:'초이스경제',    type:'경제/IT' },
  'newsian.co.kr':          { name:'뉴시안',        type:'인터넷신문' },
  'seoulwire.com':          { name:'서울와이어',    type:'인터넷신문' },
  'hbnpress.com':           { name:'HBN뉴스',       type:'인터넷신문' },
  'mydaily.co.kr':          { name:'마이데일리',    type:'스포츠/연예' },
  'thetracker.co.kr':       { name:'더트래커',      type:'경제/IT' },
  'sisacast.com':           { name:'시사캐스트',    type:'인터넷신문' },
  'topdaily.kr':            { name:'탑데일리',      type:'인터넷신문' },
  'newsquest.co.kr':        { name:'뉴스퀘스트',   type:'경제/IT' },
  'newspost.kr':            { name:'뉴스포스트',    type:'인터넷신문' },
  'smartbizn.com':          { name:'스마트경제',    type:'경제/IT' },
  'socialvalue.kr':         { name:'소셜밸류',      type:'인터넷신문' },
  'wowtv.co.kr':            { name:'한국경제TV',    type:'방송/통신' },
  'bizwnews.com':           { name:'비즈월드',      type:'인터넷신문' },
  'segye.com':              { name:'세계일보',      type:'종합일간지' },
  'insightkorea.co.kr':     { name:'인사이트코리아',type:'인터넷신문' },
  'mdtoday.co.kr':          { name:'메디컬투데이',  type:'매거진/전문지' },
  'kpenews.com':            { name:'한국정경신문',  type:'인터넷신문' },
  'pointdaily.co.kr':       { name:'포인트데일리',  type:'인터넷신문' },
  'yonhapnewstv.co.kr':     { name:'연합뉴스TV',   type:'방송/통신' },
  'financialreview.co.kr':  { name:'파이낸셜리뷰',  type:'경제/IT' },
  'thevaluenews.co.kr':     { name:'더밸류뉴스',    type:'경제/IT' },
  'asiatoday.co.kr':        { name:'아시아투데이',  type:'인터넷신문' },
  'hitnews.co.kr':          { name:'히트뉴스',      type:'매거진/전문지' },
  'paxtv.kr':               { name:'팍스TV',        type:'방송/통신' },
  'the-biz.co.kr':          { name:'더비즈',        type:'경제/IT' },
  'medipana.com':           { name:'메디파나뉴스',  type:'매거진/전문지' },
  'financialpost.co.kr':    { name:'파이낸셜포스트',type:'경제/IT' },
  'livesnews.com':          { name:'라이브스뉴스',  type:'인터넷신문' },
  'pressman.co.kr':         { name:'프레스맨',      type:'인터넷신문' },
  'newsworker.co.kr':       { name:'뉴스워커',      type:'인터넷신문' },
  'asiatime.co.kr':         { name:'아시아타임',    type:'인터넷신문' },
  'datasom.co.kr':          { name:'데이터솜',      type:'인터넷신문' },
  'sisaon.co.kr':           { name:'시사온',        type:'인터넷신문' },
  'itooza.com':             { name:'이투자',        type:'경제/IT' },
  'koreatimes.co.kr':       { name:'코리아타임스',  type:'종합일간지' },
  'enetnews.co.kr':         { name:'이넷뉴스',      type:'인터넷신문' },
  'lawissue.co.kr':         { name:'법률이슈',      type:'인터넷신문' },
  'koreaherald.com':        { name:'코리아헤럴드',  type:'종합일간지' },
  'fntimes.com':            { name:'한국금융신문',  type:'경제/IT' },
  'fortunekorea.co.kr':     { name:'포춘코리아',    type:'매거진/전문지' },
  'industrynews.co.kr':     { name:'인더스트리뉴스',type:'인터넷신문' },
  'breaknews.com':          { name:'브레이크뉴스',  type:'인터넷신문' },
  'byline.network':         { name:'바이라인네트워크',type:'경제/IT' },
  'biotimes.co.kr':         { name:'바이오타임즈',  type:'매거진/전문지' },
  'tokenpost.kr':           { name:'토큰포스트',    type:'경제/IT' },
  'huffingtonpost.kr':      { name:'허핑턴포스트',  type:'인터넷신문' },
  'topstarnews.com':        { name:'톱스타뉴스',    type:'스포츠/연예' },
  'seouleconews.com':       { name:'서울이코노미뉴스',type:'경제/IT' },
};

// 언론사명에서 유형을 역조회하는 맵 (publisher 문자열 → type)
const PUBLISHER_TYPE_MAP = (() => {
  const m = {};
  for (const v of Object.values(PUBLISHER_DOMAINS)) {
    if (!m[v.name]) m[v.name] = v.type;
  }
  return m;
})();


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
    for (const [domain, info] of Object.entries(PUBLISHER_DOMAINS)) {
      if (hostname === domain || hostname.endsWith('.' + domain) || hostname.includes(domain)) {
        return info.name;
      }
    }
    // 서브도메인 제거 후 재시도 (예: news.mt.co.kr → mt.co.kr)
    const parts = hostname.split('.');
    if (parts.length > 2) {
      const rootDomain = parts.slice(1).join('.');
      for (const [domain, info] of Object.entries(PUBLISHER_DOMAINS)) {
        if (rootDomain === domain || rootDomain.endsWith('.' + domain) || rootDomain.includes(domain)) {
          return info.name;
        }
      }
    }
    // 매핑 실패 시 '미상' 반환 (NEWS, SPORTS 같은 의미없는 값 방지)
    const GENERIC = ['news', 'www', 'sports', 'media', 'press', 'tv', 'web'];
    const first = parts[0];
    if (GENERIC.includes(first)) return '미상';
    return first.toUpperCase() || '미상';
  } catch {
    return '미상';
  }
}

function getPublisherType(publisherName) {
  return PUBLISHER_TYPE_MAP[publisherName] || '기타';
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
  {date:'2026-06-15',entity:'Cosmax Group',title:'코스맥스 스낵형 건기식에 베팅…젤리·액상스틱 CAPA 2배 키웠다',cat:'생산 인프라'},
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
    // 보도자료 핵심 단어가 기사 제목에 직접 2개 이상 → 즉시 매칭
    const titleMatchCount = prWords.filter(w => aTitle.includes(w)).length;
    if (titleMatchCount >= 2) return { prTitle: pr.title, prDate: pr.date, cat: pr.cat };
    // 기사 제목+부제 전체에서 3개 이상 매칭
    if (prWords.filter(w => searchText.includes(w)).length >= 3)
      return { prTitle: pr.title, prDate: pr.date, cat: pr.cat };
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

// ─── CORS (prdash.netlify.app 대시보드용) ────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://prdash.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
];
app.use('/api/dashboard', (req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

    // 신규 보도자료가 추가됐으면 최근 7일 기사 전체 재매칭
    if (added > 0) {
      const cutoff = new Date(Date.now() - 7 * 86400000);
      let reMatched = 0;
      for (const [link, article] of articlesMap) {
        if (new Date(article.pubDate) < cutoff) continue; // 7일 이전 기사 스킵
        if (article.isPR) continue; // 이미 라벨된 기사 스킵
        const matched = matchPR(article);
        if (matched) {
          article.isPR = true;
          reMatched++;
        }
      }
      if (reMatched > 0) log(`🔄 기사 재매칭 완료 — ${reMatched}건 라벨 갱신`);
    }

  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    log('PR Claude 오류: ' + detail);
  }
}

// ─── 보도자료 API ─────────────────────────────────────────────────────────────
app.post('/api/pr-refresh', async (req, res) => {
  const before = pressReleases.length;
  await fetchPRsWithClaude();
  const added = pressReleases.length - before;
  res.json({ ok: true, total: pressReleases.length, added });
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


// ══════════════════════════════════════════════════════════════════════════════
// 대시보드 통계 API — Supabase 직접 쿼리 (전체 기간 지원)
// ══════════════════════════════════════════════════════════════════════════════

// 언론사명 정규화 (DB에 잘못 저장된 값 보정)
const GENERIC_PUBLISHERS = new Set(['NEWS','SPORTS','MEDIA','PRESS','TV','WEB','BLOG','MOBILE','M','N']);
function normalizePublisher(name, link) {
  if (!name || GENERIC_PUBLISHERS.has(name.toUpperCase())) {
    return link ? extractPublisher(link) : '미상';
  }
  return name;
}

// ─── GET /api/dashboard/timeline ─────────────────────────────────────────────
app.get('/api/dashboard/timeline', async (req, res) => {
  const { period = 'daily', dateFrom, dateTo } = req.query;

  const from = dateFrom || new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10);
  const to   = dateTo   || new Date().toISOString().slice(0,10);

  try {
    // Supabase에서 해당 기간 전체 조회
    let query = supabase
      .from('news_articles')
      .select('pub_date, is_pr')
      .gte('pub_date', from + 'T00:00:00')
      .lte('pub_date', to   + 'T23:59:59')
      .order('pub_date', { ascending: true })
      .limit(10000); // 기본 1000건 limit 제거

    const { data, error } = await query;
    if (error) throw error;

    const buckets = {};
    (data || []).forEach(row => {
      const d = new Date(row.pub_date);
      let key;
      if (period === 'monthly') {
        key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      } else if (period === 'weekly') {
        const mon = new Date(d);
        mon.setDate(d.getDate() - ((d.getDay()+6)%7));
        key = mon.toISOString().slice(0,10);
      } else {
        key = d.toISOString().slice(0,10);
      }
      if (!buckets[key]) buckets[key] = { period: key, total: 0, pr: 0 };
      buckets[key].total++;
      if (row.is_pr) buckets[key].pr++;
    });

    res.json(Object.values(buckets).sort((a,b) => a.period.localeCompare(b.period)));
  } catch (e) {
    // Supabase 오류 시 메모리 폴백
    const all = Array.from(articlesMap.values());
    const fromD = new Date(from); fromD.setHours(0,0,0,0);
    const toD   = new Date(to);   toD.setHours(23,59,59,999);
    const filtered = all.filter(a => { const d=new Date(a.pubDate); return d>=fromD && d<=toD; });
    const buckets = {};
    filtered.forEach(a => {
      const d = new Date(a.pubDate);
      const key = d.toISOString().slice(0,10);
      if (!buckets[key]) buckets[key] = { period:key, total:0, pr:0 };
      buckets[key].total++;
      if (a.isPR) buckets[key].pr++;
    });
    res.json(Object.values(buckets).sort((a,b) => a.period.localeCompare(b.period)));
  }
});

// ─── GET /api/dashboard/publishers ───────────────────────────────────────────
app.get('/api/dashboard/publishers', async (req, res) => {
  const { dateFrom, dateTo, limit = 30 } = req.query;

  const from = dateFrom || new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10);
  const to   = dateTo   || new Date().toISOString().slice(0,10);

  try {
    const { data, error } = await supabase
      .from('news_articles')
      .select('publisher, link, is_pr')
      .gte('pub_date', from + 'T00:00:00')
      .lte('pub_date', to   + 'T23:59:59')
      .limit(10000);
    if (error) throw error;

    const pubMap = {};
    (data || []).forEach(row => {
      const name = normalizePublisher(row.publisher, row.link);
      const type = getPublisherType(name);
      if (!pubMap[name]) pubMap[name] = { name, type, count:0, prCount:0 };
      pubMap[name].count++;
      if (row.is_pr) pubMap[name].prCount++;
    });

    const typeMap = {};
    Object.values(pubMap).forEach(p => {
      if (!typeMap[p.type]) typeMap[p.type] = { type:p.type, count:0 };
      typeMap[p.type].count += p.count;
    });

    res.json({
      byPublisher: Object.values(pubMap).filter(p=>p.name!=='미상').sort((a,b)=>b.count-a.count).slice(0, parseInt(limit)),
      byType:      Object.values(typeMap).sort((a,b)=>b.count-a.count),
    });
  } catch (e) {
    // 폴백: 메모리
    const all = Array.from(articlesMap.values());
    const fromD = new Date(from); fromD.setHours(0,0,0,0);
    const toD   = new Date(to);   toD.setHours(23,59,59,999);
    const filtered = all.filter(a => { const d=new Date(a.pubDate); return d>=fromD && d<=toD; });
    const pubMap = {};
    filtered.forEach(a => {
      const name = normalizePublisher(a.publisher, a.link);
      const type = getPublisherType(name);
      if (!pubMap[name]) pubMap[name] = { name, type, count:0, prCount:0 };
      pubMap[name].count++;
      if (a.isPR) pubMap[name].prCount++;
    });
    const typeMap = {};
    Object.values(pubMap).forEach(p => {
      if (!typeMap[p.type]) typeMap[p.type] = { type:p.type, count:0 };
      typeMap[p.type].count += p.count;
    });
    res.json({
      byPublisher: Object.values(pubMap).filter(p=>p.name!=='미상').sort((a,b)=>b.count-a.count).slice(0,parseInt(limit)),
      byType:      Object.values(typeMap).sort((a,b)=>b.count-a.count),
    });
  }
});




// ══════════════════════════════════════════════════════════════════════════════
// 소급 수집 API v2 — 월별 분리 수집으로 커버리지 극대화
// GET /api/backfill?dryRun=true  → 실제 저장 없이 수집 건수만 확인
// GET /api/backfill               → 실제 Supabase 저장
// GET /api/backfill?month=1       → 특정 월만 재수집 (1~5)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/backfill', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase 미연결' });
  if (DEMO_MODE)  return res.status(503).json({ error: '데모 모드 — NAVER_CLIENT_ID 없음' });

  const dryRun     = req.query.dryRun === 'true';
  const onlyMonth  = req.query.month ? parseInt(req.query.month) : null; // 특정 월만

  // 월별 수집 설정 — 각 월마다 from/to + 특화 쿼리
  const MONTH_CONFIGS = [
    {
      month: 1,
      from: new Date('2026-01-01T00:00:00+09:00'),
      to:   new Date('2026-02-01T00:00:00+09:00'),
      queries: ['코스맥스', 'Cosmax', '코스맥스 ODM', '코스맥스 화장품',
                '코스맥스 실적', '코스맥스 연구', '코스맥스 신년',
                '코스맥스 CES', '코스맥스 1분기', '코스맥스바이오',
                '코스맥스 주가', '코스맥스 특허'],
    },
    {
      month: 2,
      from: new Date('2026-02-01T00:00:00+09:00'),
      to:   new Date('2026-03-01T00:00:00+09:00'),
      queries: ['코스맥스', 'Cosmax', '코스맥스 ODM', '코스맥스 화장품',
                '코스맥스 실적', '코스맥스 연구', '코스맥스 케미노바',
                '코스맥스 유럽', '코스맥스 인수', '코스맥스바이오',
                '코스맥스 주가', '코스맥스 인도네시아'],
    },
    {
      month: 3,
      from: new Date('2026-03-01T00:00:00+09:00'),
      to:   new Date('2026-04-01T00:00:00+09:00'),
      queries: ['코스맥스', 'Cosmax', '코스맥스 ODM', '코스맥스 화장품',
                '코스맥스 실적', '코스맥스 연구', '코스맥스 코스메틱',
                '코스맥스 박람회', '코스맥스 배당', '코스맥스바이오',
                '코스맥스 주가', '코스맥스 채용'],
    },
    {
      month: 4,
      from: new Date('2026-04-01T00:00:00+09:00'),
      to:   new Date('2026-05-01T00:00:00+09:00'),
      queries: ['코스맥스', 'Cosmax', '코스맥스 ODM', '코스맥스 화장품',
                '코스맥스 실적', '코스맥스 연구', '코스맥스 플러셔블',
                '코스맥스 이온헬스', '코스맥스 상하이', '코스맥스바이오',
                '코스맥스 주가', '코스맥스 1분기'],
    },
    {
      month: 5,
      from: new Date('2026-05-01T00:00:00+09:00'),
      to:   new Date('2026-06-01T00:00:00+09:00'), // 5월 말일까지
      queries: ['코스맥스', 'Cosmax', '코스맥스 ODM', '코스맥스 화장품',
                '코스맥스 실적', '코스맥스 뉴욕', '코스맥스 발명',
                '코스맥스바이오', '코스맥스 주가', '코스맥스 PPA',
                '코스맥스 박람회', '코스맥스 이노베이션'],
    },
  ];

  const CONFIGS = onlyMonth
    ? MONTH_CONFIGS.filter(c => c.month === onlyMonth)
    : MONTH_CONFIGS;

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const seen  = new Set(); // 중복 링크 방지 (전체 세션)
  const collected = [];
  const log_lines = [];
  const lg = msg => { log_lines.push(msg); console.log('[backfill]', msg); };

  lg(`소급 수집 v2 시작 | dryRun: ${dryRun} | 대상 월: ${onlyMonth || '1~5월 전체'}`);

  // 월별로 순차 수집
  for (const cfg of CONFIGS) {
    lg(`
━━ ${cfg.month}월 수집 시작 (${cfg.from.toISOString().slice(0,10)} ~ ${cfg.to.toISOString().slice(0,10)}) ━━`);
    let monthTotal = 0;

    for (const query of cfg.queries) {
      lg(`  ▶ 쿼리: "${query}"`);
      let queryHit  = 0;
      let consecSkip = 0; // 연속으로 기간 내 기사 없는 배치 수

      for (let start = 1; start <= 1000; start += 100) {
        try {
          const res2 = await axios.get('https://openapi.naver.com/v1/search/news.json', {
            params: { query, display: 100, start, sort: 'date' },
            headers: {
              'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
              'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
            },
            timeout: 15000,
          });

          const items = res2.data.items || [];
          if (items.length === 0) break;

          let batchInRange = 0;
          let tooNew = 0;
          let tooOld = 0;

          for (const item of items) {
            const pubDate = new Date(item.pubDate);
            const link    = item.originallink || item.link;

            if (pubDate >= cfg.to)   { tooNew++; continue; } // 이 월보다 최신
            if (pubDate < cfg.from)  { tooOld++; continue; } // 이 월보다 오래됨
            if (seen.has(link))      continue;

            seen.add(link);
            batchInRange++;
            queryHit++;
            monthTotal++;

            const article = {
              title:       stripHtml(item.title),
              link,
              naverLink:   item.link,
              description: stripHtml(item.description),
              publisher:   extractPublisher(link),
              pubDate,
            };
            collected.push(article);

            if (!dryRun) {
              await supabase.from('news_articles').upsert(
                {
                  title:       article.title,
                  link:        article.link,
                  naver_link:  article.naverLink,
                  description: article.description,
                  publisher:   article.publisher,
                  pub_date:    article.pubDate.toISOString(),
                  is_new:      false,
                  is_pr:       false,
                },
                { onConflict: 'link', ignoreDuplicates: true }
              );
            }
          }

          lg(`    start=${start} | 범위내: ${batchInRange} | 최신: ${tooNew} | 오래됨: ${tooOld}`);

          // 종료 조건
          if (tooOld > 50) { lg('    → 과거 기사 다수 → 종료'); break; }
          if (batchInRange === 0 && tooNew === 0) { consecSkip++; } else { consecSkip = 0; }
          if (consecSkip >= 3) { lg('    → 3배치 연속 0건 → 종료'); break; }

          await delay(250);

        } catch (err) {
          const s = err.response?.status;
          lg(`    ❌ 오류 start=${start}: ${s || err.message}`);
          if (s === 429) { await delay(3000); }
          break;
        } // end try-catch
      } // end start loop

      lg(`    → "${query}" 소계: ${queryHit}건`);
      await delay(400); // 쿼리 간 간격
    } // end query loop

    lg(`  ✓ ${cfg.month}월 완료: ${monthTotal}건`);
    await delay(500); // 월 간 간격
  } // end month loop

  // 월별 집계
  const byMonth = {};
  collected.forEach(a => {
    const key = `${a.pubDate.getFullYear()}-${String(a.pubDate.getMonth()+1).padStart(2,'0')}`;
    byMonth[key] = (byMonth[key] || 0) + 1;
  });

  lg(`\n✅ 완료 | 총 수집: ${collected.length}건 (중복 제거) | dryRun: ${dryRun}`);
  lg('월별 분포: ' + JSON.stringify(byMonth));

  res.json({
    success:   true,
    dryRun,
    total:     collected.length,
    byMonth,
    logs:      log_lines,
  });
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
