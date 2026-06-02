-- ═══════════════════════════════════════════════════════════════
--  코스맥스 뉴스 모니터 — Supabase 스키마
--  Supabase Dashboard → SQL Editor에서 실행
-- ═══════════════════════════════════════════════════════════════

-- 뉴스 기사 테이블
CREATE TABLE IF NOT EXISTS news_articles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  link        TEXT        NOT NULL UNIQUE,   -- 중복 방지 키
  naver_link  TEXT,
  description TEXT,
  pub_date    TIMESTAMPTZ NOT NULL,
  is_new      BOOLEAN     DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_news_pub_date   ON news_articles (pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_news_is_new     ON news_articles (is_new) WHERE is_new = TRUE;
CREATE INDEX IF NOT EXISTS idx_news_created_at ON news_articles (created_at DESC);

-- is_new 자동 만료: 24시간 후 FALSE로 변경
-- (Supabase의 pg_cron 또는 별도 크론 태스크에서 실행)
-- SELECT cron.schedule('reset-is-new', '0 * * * *',
--   $$ UPDATE news_articles SET is_new = FALSE
--      WHERE is_new = TRUE AND pub_date < NOW() - INTERVAL '24 hours' $$
-- );

-- Row Level Security (공개 읽기 허용)
ALTER TABLE news_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_read" ON news_articles
  FOR SELECT USING (true);

CREATE POLICY "allow_insert" ON news_articles
  FOR INSERT WITH CHECK (true);

CREATE POLICY "allow_update" ON news_articles
  FOR UPDATE USING (true);

-- 수집 로그 테이블 (선택)
CREATE TABLE IF NOT EXISTS poll_logs (
  id         BIGSERIAL   PRIMARY KEY,
  polled_at  TIMESTAMPTZ DEFAULT NOW(),
  new_count  INTEGER     DEFAULT 0,
  total      INTEGER     DEFAULT 0,
  error      TEXT
);

-- Realtime 활성화 (Supabase Dashboard에서도 가능)
-- ALTER PUBLICATION supabase_realtime ADD TABLE news_articles;
