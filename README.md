# 코스맥스 뉴스 모니터

네이버 뉴스에서 `코스맥스` 키워드를 실시간 모니터링하는 PR 대시보드.

## 기능

- 네이버 뉴스 API 1분 간격 자동 폴링
- 신규 기사 실시간 화면 갱신 (Server-Sent Events)
- 브라우저 푸시 알람 (Web Notifications API)
- Slack 채널 알람 (선택)
- 기사 DB 누적 저장 (Supabase, 선택)
- 날짜 필터 / 키워드 검색
- 데모 모드 내장 (API 키 없이 즉시 실행 가능)

## 빠른 시작

### 1. 설치

```bash
git clone <repo>
cd cosmax-news-monitor
npm install
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열고 네이버 API 키 입력:

```
NAVER_CLIENT_ID=발급받은_클라이언트_ID
NAVER_CLIENT_SECRET=발급받은_시크릿
```

### 3. 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000` 접속.

---

## 네이버 API 키 발급 방법

1. https://developers.naver.com 접속 → 로그인
2. **Application** → **애플리케이션 등록**
3. 사용 API: **검색** 선택
4. 서비스 URL: `http://localhost:3000` 입력
5. 등록 후 **Client ID / Client Secret** 복사 → `.env`에 붙여넣기

---

## Supabase 설정 (선택 — 영구 저장)

API 키만 설정하면 in-memory 모드로 동작합니다 (서버 재시작 시 초기화).
영구 저장이 필요한 경우:

1. https://supabase.com 에서 무료 프로젝트 생성
2. **SQL Editor** → `supabase_schema.sql` 내용 실행
3. **Project Settings → API**에서 URL과 anon key 복사
4. `.env`에 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 입력

---

## Slack 알람 설정 (선택)

1. Slack 워크스페이스 → **앱** → **Incoming Webhooks** 추가
2. 알람 받을 채널 선택 → Webhook URL 복사
3. `.env`에 `SLACK_WEBHOOK_URL` 입력

---

## 배포 (무료)

### Vercel (권장 — 서버리스 불가이므로 Railway 사용)

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set NAVER_CLIENT_ID=xxx NAVER_CLIENT_SECRET=yyy
```

### Render

1. https://render.com 에서 New → Web Service
2. GitHub 레포 연결
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment Variables 탭에서 키 입력

---

## 파일 구조

```
cosmax-news-monitor/
├── server.js            # Express 서버 + 폴링 스케줄러
├── public/
│   └── index.html       # 프론트엔드 (단일 파일)
├── supabase_schema.sql  # DB 스키마
├── package.json
├── .env.example
└── README.md
```

## 커스터마이징

| 항목 | 위치 | 방법 |
|------|------|------|
| 검색 키워드 | `.env` | `SEARCH_QUERY=코스맥스BTI` |
| 폴링 주기 | `server.js` | `cron.schedule('*/2 * * * *', ...)` (2분 간격) |
| 표시 건수 | `public/index.html` | `S.limit = 50` |
| 브랜드 컬러 | `public/index.html` | `--red: #EF1D26` CSS 변수 |
