CREATE TABLE IF NOT EXISTS lights_users (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  open_code text NOT NULL,
  nickname text NOT NULL,
  completed_rounds integer NOT NULL DEFAULT 0,
  total_moves integer NOT NULL DEFAULT 0,
  UNIQUE(app_id, open_code)
);
-- 为已有数据库幂等补充头像，不改变用户标识或历史成绩。
ALTER TABLE lights_users ADD COLUMN IF NOT EXISTS avatar_url text;
CREATE TABLE IF NOT EXISTS lights_sessions (
  hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lights_users(id),
  expires_at bigint NOT NULL,
  instance_id text
);
CREATE INDEX IF NOT EXISTS lights_sessions_expiry ON lights_sessions(expires_at);
CREATE TABLE IF NOT EXISTS lights_call_logs (
  id uuid PRIMARY KEY,
  started_at bigint NOT NULL,
  kind text NOT NULL,
  method text NOT NULL,
  endpoint text NOT NULL,
  status integer,
  ok boolean NOT NULL,
  request_id text NOT NULL,
  entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS lights_call_logs_time ON lights_call_logs(started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS lights_call_logs_kind_time ON lights_call_logs(kind,started_at DESC);
CREATE TABLE IF NOT EXISTS lights_rounds (
  round_id uuid PRIMARY KEY,
  room_id text NOT NULL,
  finished_at bigint NOT NULL,
  moves integer NOT NULL,
  contributions jsonb NOT NULL
);
