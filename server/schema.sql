CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT 'lime',
  avatar TEXT,
  banner TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX member_user ON members(user_id);
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX invites_expiry ON invites(expires);
CREATE TABLE friends (
  first TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  second TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted')),
  CHECK (first < second),
  PRIMARY KEY (first, second)
);
CREATE INDEX friends_second ON friends(second);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text', 'voice', 'dm')),
  first TEXT,
  second TEXT,
  UNIQUE(first, second),
  CHECK ((kind = 'dm' AND server_id IS NULL AND first < second) OR
         (kind != 'dm' AND server_id IS NOT NULL AND first IS NULL AND second IS NULL))
);
CREATE INDEX channel_server ON channels(server_id);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  file_id TEXT REFERENCES files(id),
  created_at INTEGER NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  CHECK (length(body) > 0 OR file_id IS NOT NULL)
);
CREATE INDEX message_channel ON messages(channel_id, id DESC);
CREATE UNIQUE INDEX message_file ON messages(file_id) WHERE file_id IS NOT NULL;
CREATE TABLE reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
PRAGMA user_version = 1;
