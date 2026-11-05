import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve } from 'node:path';

const hashPassword = promisify(scrypt);
const MB = 1024 * 1024;
const day = 86_400_000;
const emojis = new Set(['👍', '❤️', '😂', '🔥', '🎮', '👀', '💀', '🤘', '🎉', '😎', '🫡', '💚']);
const accents = new Set(['lime', 'mint', 'lilac', 'amber', 'ice']);
const userFields = 'id, handle, name, bio, accent, avatar, banner';
const maxFile = 100 * MB;
const maxImage = 2 * MB;
const fileLimit = Number(process.env.FILE_QUOTA_MB || 4096) * MB;
if (!Number.isSafeInteger(fileLimit) || fileLimit < maxFile) throw Error('FILE_QUOTA_MB deve ser um inteiro ≥ 100.');

const directory = resolve(process.env.DATA_DIR || 'data');
const blobDirectory = resolve(directory, 'files');
mkdirSync(blobDirectory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(directory, 'frequencia.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
if (db.prepare('PRAGMA user_version').get().user_version === 0) {
  transaction(() => db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')));
}
if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('Versão do banco incompatível.');
const sql = new Map();
function statement(query) {
  if (!sql.has(query)) sql.set(query, db.prepare(query));
  return sql.get(query);
}
const get = (query, ...args) => statement(query).get(...args);
const all = (query, ...args) => statement(query).all(...args);
const run = (query, ...args) => statement(query).run(...args);
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

let usedBytes = get('SELECT COALESCE(sum(size), 0) AS n FROM files').n;
let reservedBytes = 0;
const stored = new Set(all('SELECT id FROM files').map(file => file.id));
for (const entry of readdirSync(blobDirectory, { withFileTypes: true })) {
  if (entry.isFile() && /^(?:[a-f0-9-]{36})(?:\.part)?$/.test(entry.name) && !stored.has(entry.name)) {
    rmSync(resolve(blobDirectory, entry.name), { force: true });
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fail(status, message) { throw new HttpError(status, message); }
function text(value, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || value.includes('\0')) {
    fail(400, 'Confira o tamanho do texto.');
  }
  return value.trim();
}
const sha = value => createHash('sha256').update(value).digest('hex');
const opaque = bytes => randomBytes(bytes).toString('base64url');
const pair = (a, b) => [a, b].sort();
function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) fail(415, 'Envie JSON.');
  const chunks = [];
  let size = 0;
  // Keep the request available to send an HTTP error when a body exceeds the limit.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) fail(413, 'Pedido grande demais.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch {
    fail(400, 'Pedido inválido.');
  }
}

const rates = new Map();
function limit(bucket, key, max, ttl) {
  const now = Date.now();
  const id = bucket + '/' + key;
  let current = rates.get(id);
  if (!current || current.until <= now) {
    if (rates.size >= 20_000) fail(503, 'Servidor ocupado. Tente novamente.');
    current = { count: 0, until: now + ttl };
    rates.set(id, current);
  }
  if (++current.count > max) fail(429, 'Muitas tentativas. Aguarde um pouco.');
}
setInterval(() => {
  const now = Date.now();
  for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
  run('DELETE FROM sessions WHERE expires <= ?', now);
  run('DELETE FROM invites WHERE expires <= ?', now);
}, 60_000).unref();

function user(id) { return get('SELECT ' + userFields + ' FROM users WHERE id = ?', id); }
function auth(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
  if (!match) fail(401, 'Entre na sua conta.');
  const token = sha(match[1]);
  const row = get('SELECT user_id FROM sessions WHERE token_hash=? AND expires>?', token, Date.now());
  if (!row) fail(401, 'Sua sessão expirou. Entre novamente.');
  return { id: row.user_id, token };
}
function session(id) {
  const token = opaque(32);
  run('INSERT INTO sessions VALUES (?, ?, ?)', sha(token), id, Date.now() + 30 * day);
  return { token, me: user(id) };
}
function handle(value) {
  const h = text(value, 24, 3).replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,23}$/.test(h)) fail(400, 'Use de 3 a 23 letras, números ou _ no usuário.');
  return h;
}
let passwordJobs = 0;
async function credentials(req, register) {
  const ip = req.socket.remoteAddress || 'unknown';
  const forwarded = process.env.TRUST_PROXY === '1' ? req.headers['x-real-ip'] : null;
  limit('auth', typeof forwarded === 'string' ? forwarded : ip, 20, 60_000);
  const data = await body(req);
  const h = handle(data.handle);
  limit('handle', h, 8, 60_000);
  const password = data.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    fail(400, 'Use uma senha de 8 a 128 caracteres.');
  }
  if (register && process.env.REGISTRATION_KEY &&
      !timingSafeEqual(Buffer.from(sha(String(data.key || '')), 'hex'), Buffer.from(sha(process.env.REGISTRATION_KEY), 'hex'))) {
    fail(403, 'Código de cadastro inválido.');
  }
  const row = get('SELECT id, password_hash FROM users WHERE handle = ?', h);
  if (register && row) fail(409, 'Esse @usuário já existe.');
  const name = register ? text(data.name, 32) : '';
  const [salt, expected] = row?.password_hash.split(':') ?? [opaque(16), ''];
  if (passwordJobs >= 4) fail(503, 'Tente novamente em alguns segundos.');
  passwordJobs++;
  let derived;
  try { derived = await hashPassword(password, salt, 64); } finally { passwordJobs--; }
  if (!register) {
    if (!row || !timingSafeEqual(derived, Buffer.from(expected, 'hex'))) fail(401, 'Usuário ou senha incorretos.');
    return session(row.id);
  }
  if (get('SELECT id FROM users WHERE handle = ?', h)) fail(409, 'Esse @usuário já existe.');
  const id = randomUUID();
  return transaction(() => {
    run('INSERT INTO users(id, handle, name, password_hash) VALUES (?, ?, ?, ?)', id, h, name, salt + ':' + derived.toString('hex'));
    return session(id);
  });
}

function membership(server, id) {
  const row = get('SELECT role FROM members WHERE server_id=? AND user_id=?', server, id);
  if (!row) fail(404, 'Servidor indisponível.');
  return row.role;
}
function manager(role) { return role === 'owner' || role === 'admin'; }
function channel(id, viewer) {
  const room = get('SELECT * FROM channels WHERE id=?', id);
  if (!room) fail(404, 'Canal indisponível.');
  if (room.kind === 'dm') {
    if ((room.first !== viewer && room.second !== viewer) ||
        !get("SELECT 1 FROM friends WHERE first=? AND second=? AND status='accepted'", room.first, room.second)) {
      fail(404, 'Conversa indisponível.');
    }
    return { ...room, role: 'member' };
  }
  return { ...room, role: membership(room.server_id, viewer) };
}
function serverSummary(id, viewer) {
  const role = membership(id, viewer);
  const server = get('SELECT id, name FROM servers WHERE id=?', id);
  const channels = all('SELECT id, name, kind FROM channels WHERE server_id=? ORDER BY rowid', id);
  return { ...server, role, channels };
}
function addServer(viewer, name) {
  const id = randomUUID();
  return transaction(() => {
    if (get("SELECT count(*) AS n FROM members WHERE user_id=? AND role='owner'", viewer).n >= 20) fail(409, 'Limite de 20 servidores criados.');
    run('INSERT INTO servers VALUES (?, ?)', id, name);
    run("INSERT INTO members VALUES (?, ?, 'owner')", id, viewer);
    for (const [label, kind] of [['geral', 'text'], ['clipes', 'text'], ['Call da noite', 'voice']]) {
      run('INSERT INTO channels(id, server_id, name, kind) VALUES (?, ?, ?, ?)', randomUUID(), id, label, kind);
    }
    return serverSummary(id, viewer);
  });
}
function friends(viewer) {
  return all(`SELECT f.first, f.second, f.requester, f.status,
    u.id, u.handle, u.name, u.bio, u.accent, u.avatar, u.banner, c.id AS channel_id
    FROM friends f JOIN users u ON u.id=CASE WHEN f.first=? THEN f.second ELSE f.first END
    LEFT JOIN channels c ON c.first=f.first AND c.second=f.second
    WHERE f.first=? OR f.second=? ORDER BY u.name COLLATE NOCASE`, viewer, viewer, viewer);
}
function openDm(viewer, peer) {
  const [a, b] = pair(viewer, peer);
  if (!get("SELECT 1 FROM friends WHERE first=? AND second=? AND status='accepted'", a, b)) fail(404, 'Aceite a amizade para conversar.');
  run("INSERT INTO channels(id, name, kind, first, second) VALUES (?, 'Direta', 'dm', ?, ?) ON CONFLICT(first, second) DO NOTHING", randomUUID(), a, b);
  return { ...get('SELECT id, kind FROM channels WHERE first=? AND second=?', a, b), name: user(peer).name };
}

const messageFields = `m.id, m.body, m.created_at, m.edited, m.pinned, m.user_id,
  u.name, u.handle, u.avatar, u.accent, f.id AS file_id, f.name AS file_name, f.size AS file_size`;
const messageTables = `FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN files f ON f.id=m.file_id`;
function messageOutput(row, viewer) {
  return {
    ...row,
    reactions: all('SELECT emoji, count(*) AS count, max(user_id=?) AS mine FROM reactions WHERE message_id=? GROUP BY emoji ORDER BY emoji', viewer, row.id),
  };
}
function message(id, viewer) {
  const row = get('SELECT ' + messageFields + ' ' + messageTables + ' WHERE m.id=?', id);
  if (!row) fail(404, 'Mensagem indisponível.');
  return messageOutput(row, viewer);
}
function listMessages(room, viewer, params) {
  const before = Number(params.get('before') || Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1) fail(400, 'Página inválida.');
  const q = text(params.get('q') || '', 120, 0);
  const pins = params.get('pins') === '1' ? 1 : 0;
  const rows = all('SELECT ' + messageFields + ' ' + messageTables +
    " WHERE m.channel_id=? AND m.id<? AND (?=0 OR m.pinned=1) AND (?='' OR instr(lower(m.body), lower(?))>0 OR instr(lower(COALESCE(f.name,'')), lower(?))>0) ORDER BY m.id DESC LIMIT 41",
    room, before, pins, q, q, q);
  return { items: rows.slice(0, 40).reverse().map(row => messageOutput(row, viewer)), more: rows.length > 40 };
}
function writeMessage(room, viewer, value, file = null) {
  const result = run('INSERT INTO messages(channel_id,user_id,body,file_id,created_at) VALUES (?,?,?,?,?)',
    room, viewer, value, file, Date.now());
  return message(Number(result.lastInsertRowid), viewer);
}
function removeFile(id) {
  if (!id) return;
  const file = get('SELECT size FROM files WHERE id=?', id);
  if (!file) return;
  run('DELETE FROM files WHERE id=?', id);
  usedBytes -= file.size;
  try { rmSync(resolve(blobDirectory, id), { force: true }); } catch (error) { console.error('Arquivo órfão', error.code); }
}
function photoType(head) {
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) return 'image/gif';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  fail(415, 'Use PNG, JPEG, GIF ou WebP.');
}
async function upload(req, name, photo, attach) {
  const max = photo ? maxImage : maxFile;
  const declared = req.headers['content-length'] === undefined ? max : Number(req.headers['content-length']);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > max) fail(413, photo ? 'A imagem pode ter até 2 MiB.' : 'O anexo pode ter até 100 MiB.');
  if (usedBytes + reservedBytes + declared > fileLimit) fail(507, 'O armazenamento do servidor está cheio.');
  reservedBytes += declared;
  const id = randomUUID();
  const final = resolve(blobDirectory, id);
  const temporary = final + '.part';
  let size = 0;
  let head = Buffer.alloc(0);
  let published = false;
  const stream = new Transform({
    transform(chunk, _, callback) {
      size += chunk.length;
      if (size > declared) return callback(new HttpError(413, 'Arquivo grande demais.'));
      if (photo && head.length < 12) head = Buffer.concat([head, chunk.subarray(0, 12 - head.length)]);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req.iterator({ destroyOnReturn: false }), stream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!size) fail(400, 'Arquivo vazio.');
    const type = photo ? photoType(head) : 'application/octet-stream';
    renameSync(temporary, final);
    const result = transaction(() => {
      run('INSERT INTO files VALUES (?, ?, ?, ?)', id, name, size, type);
      return attach(id);
    });
    published = true;
    usedBytes += size;
    return result;
  } finally {
    reservedBytes -= declared;
    rmSync(temporary, { force: true });
    if (!published) rmSync(final, { force: true });
  }
}

const mediaUrl = process.env.LIVEKIT_URL;
const mediaKey = process.env.LIVEKIT_API_KEY;
const mediaSecret = process.env.LIVEKIT_API_SECRET;
const hasMedia = Boolean(mediaUrl && mediaKey && mediaSecret);
function mediaToken(id, room) {
  if (!hasMedia) fail(503, 'Este servidor ainda precisa configurar as chamadas.');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: mediaKey, sub: id, name: user(id).name, nbf: now - 5, exp: now + 300,
    video: { roomJoin: true, room: 'frequencia-' + room, canSubscribe: true, canPublish: true, canPublishData: false },
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims);
  return { url: mediaUrl, token: unsigned + '.' + createHmac('sha256', mediaSecret).update(unsigned).digest('base64url') };
}

async function route(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const method = req.method;
  const path = pathname.split('/').slice(1);
  const [, section, id, action, target, operation] = path;
  if (path[0] !== 'api' || path.length > 6) fail(404, 'Rota indisponível.');
  if (method === 'GET' && pathname === '/api/health') return json(res, { app: 'frequencia', version: 1, media: hasMedia });
  if (method === 'POST' && ['/api/register', '/api/login'].includes(pathname)) {
    return json(res, await credentials(req, section === 'register'));
  }

  const viewer = auth(req);
  const uid = viewer.id;
  if (method !== 'GET') limit('write', uid, 120, 60_000);
  if (method === 'POST' && pathname === '/api/logout') {
    run('DELETE FROM sessions WHERE token_hash=?', viewer.token);
    return json(res, {});
  }
  if (method === 'GET' && pathname === '/api/state') {
    const servers = all('SELECT server_id FROM members WHERE user_id=? ORDER BY rowid', uid);
    return json(res, { me: user(uid), servers: servers.map(row => serverSummary(row.server_id, uid)), friends: friends(uid), media: hasMedia });
  }
  if (method === 'PATCH' && pathname === '/api/me') {
    const data = await body(req);
    if (!accents.has(data.accent)) fail(400, 'Cor inválida.');
    run('UPDATE users SET name=?, bio=?, accent=? WHERE id=?', text(data.name, 32), text(data.bio, 160, 0), data.accent, uid);
    return json(res, user(uid));
  }
  if (section === 'me' && ['avatar', 'banner'].includes(id) && !action && ['POST', 'DELETE'].includes(method)) {
    limit('photo', uid, 12, 60_000);
    if (method === 'DELETE') {
      const old = user(uid)[id];
      run('UPDATE users SET ' + id + '=NULL WHERE id=?', uid);
      removeFile(old);
      return json(res, user(uid));
    }
    let old;
    const result = await upload(req, id, true, file => {
      old = user(uid)[id];
      run('UPDATE users SET ' + id + '=? WHERE id=?', file, uid);
      return user(uid);
    });
    removeFile(old);
    return json(res, result);
  }
  if (method === 'POST' && pathname === '/api/servers') return json(res, addServer(uid, text((await body(req)).name, 40)));
  if (method === 'POST' && pathname === '/api/join') {
    const code = text((await body(req)).code, 30);
    const invite = get('SELECT server_id FROM invites WHERE code_hash=? AND expires>?', sha(code), Date.now());
    if (!invite) fail(404, 'Convite inválido ou expirado.');
    if (!get('SELECT 1 FROM members WHERE user_id=? AND server_id=?', uid, invite.server_id) &&
        get('SELECT count(*) AS n FROM members WHERE user_id=?', uid).n >= 50) fail(409, 'Limite de 50 servidores.');
    run("INSERT INTO members VALUES (?, ?, 'member') ON CONFLICT DO NOTHING", invite.server_id, uid);
    return json(res, serverSummary(invite.server_id, uid));
  }
  if (section === 'servers' && id && action && !operation) {
    if (action === 'members' && method === 'GET' && !target) {
      membership(id, uid);
      return json(res, { items: all('SELECT u.id, u.handle, u.name, u.avatar, u.accent, m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY u.name LIMIT 250', id) });
    }
    const data = method === 'PATCH' || (method === 'POST' && action === 'channels') ? await body(req) : {};
    const role = membership(id, uid);
    if (!manager(role)) fail(403, 'Esta ação é de administração.');
    if (method === 'POST' && action === 'channels' && !target) {
      if (get('SELECT count(*) AS n FROM channels WHERE server_id=?', id).n >= 60) fail(409, 'Limite de 60 canais.');
      const kind = data.kind;
      if (kind !== 'text' && kind !== 'voice') fail(400, 'Tipo de canal inválido.');
      const channelId = randomUUID();
      run('INSERT INTO channels(id,server_id,name,kind) VALUES (?,?,?,?)', channelId, id, text(data.name, 32), kind);
      return json(res, serverSummary(id, uid));
    }
    if (method === 'POST' && action === 'invites' && !target) {
      const code = opaque(12);
      run('INSERT INTO invites VALUES (?,?,?)', sha(code), id, Date.now() + 7 * day);
      return json(res, { code });
    }
    if (method === 'PATCH' && action === 'members' && target && role === 'owner' && ['admin', 'member'].includes(data.role)) {
      if (!run("UPDATE members SET role=? WHERE server_id=? AND user_id=? AND role!='owner'", data.role, id, target).changes) fail(404, 'Membro indisponível.');
      return json(res, {});
    }
  }
  if (method === 'POST' && pathname === '/api/friends') {
    const peer = get('SELECT id FROM users WHERE handle=?', handle((await body(req)).handle))?.id;
    if (!peer || peer === uid) fail(404, 'Usuário indisponível.');
    if (get('SELECT count(*) AS n FROM friends WHERE first=? OR second=?', uid, uid).n >= 250 ||
        get('SELECT count(*) AS n FROM friends WHERE first=? OR second=?', peer, peer).n >= 250) fail(409, 'Limite de amizades e pedidos atingido.');
    run("INSERT INTO friends VALUES (?, ?, ?, 'pending') ON CONFLICT DO NOTHING", ...pair(uid, peer), uid);
    return json(res, { items: friends(uid) });
  }
  if (section === 'friends' && id && !target) {
    if (method === 'POST' && action === 'accept') {
      if (!run("UPDATE friends SET status='accepted' WHERE first=? AND second=? AND requester!=? AND status='pending'", ...pair(uid, id), uid).changes) {
        fail(404, 'Pedido indisponível.');
      }
      return json(res, { items: friends(uid) });
    }
    if (method === 'DELETE' && !action) {
      run('DELETE FROM friends WHERE first=? AND second=?', ...pair(uid, id));
      return json(res, { items: friends(uid) });
    }
    if (method === 'POST' && action === 'dm') return json(res, openDm(uid, id));
  }
  if (section === 'channels' && id && action) {
    let room = channel(id, uid);
    if (method === 'POST' && action === 'call' && !target && room.kind !== 'text') {
      limit('media', uid, 16, 60_000);
      return json(res, mediaToken(uid, id));
    }
    if (room.kind === 'voice') fail(400, 'Este canal é de voz.');
    if (method === 'POST' && action === 'files' && !target) {
      limit('files', uid, 8, 60_000);
      const name = text((searchParams.get('name') || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_'), 140);
      return json(res, await upload(req, name, false, file => {
        channel(id, uid);
        return writeMessage(id, uid, '', file);
      }));
    }
    if (action !== 'messages') fail(404, 'Rota indisponível.');
    if (method === 'GET' && !target) return json(res, listMessages(id, uid, searchParams));
    const data = method === 'POST' || method === 'PATCH' ? await body(req) : {};
    room = channel(id, uid);
    if (method === 'POST' && !target) return json(res, writeMessage(id, uid, text(data.body, 4000)));
    const msg = get('SELECT id,user_id,file_id FROM messages WHERE id=? AND channel_id=?', Number(target), id);
    if (!msg) fail(404, 'Mensagem indisponível.');
    const own = msg.user_id === uid;
    if (method === 'DELETE' && !operation && (own || manager(room.role))) {
      run('DELETE FROM messages WHERE id=?', msg.id);
      removeFile(msg.file_id);
      return json(res, {});
    }
    if (method === 'PATCH' && !operation && own) {
      run('UPDATE messages SET body=?, edited=1 WHERE id=?', text(data.body, 4000), msg.id);
      return json(res, message(msg.id, uid));
    }
    if (method === 'POST' && operation === 'pin' && (manager(room.role) || room.kind === 'dm')) {
      if (typeof data.pinned !== 'boolean') fail(400, 'Estado do destaque inválido.');
      run('UPDATE messages SET pinned=? WHERE id=?', Number(data.pinned), msg.id);
      return json(res, message(msg.id, uid));
    }
    if (method === 'POST' && operation === 'reaction' && emojis.has(data.emoji)) {
      if (!run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', msg.id, uid, data.emoji).changes) {
        run('INSERT INTO reactions VALUES (?,?,?)', msg.id, uid, data.emoji);
      }
      return json(res, message(msg.id, uid));
    }
    fail(403, 'Ação indisponível para sua conta.');
  }
  if (method === 'GET' && section === 'files' && id && !action) {
    const file = get('SELECT * FROM files WHERE id=?', id);
    if (!file) fail(404, 'Arquivo indisponível.');
    const msg = get('SELECT channel_id FROM messages WHERE file_id=?', id);
    if (msg) channel(msg.channel_id, uid);
    else if (!get('SELECT 1 FROM users WHERE avatar=? OR banner=?', id, id)) fail(404, 'Arquivo indisponível.');
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.size });
    return pipeline(createReadStream(resolve(blobDirectory, file.id)), res);
  }
  fail(404, 'Rota indisponível.');
}

const server = createServer({ requestTimeout: 180_000, headersTimeout: 15_000 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  try {
    await route(req, res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.destroy();
    if (!(error instanceof HttpError)) console.error(error);
    req.resume();
    json(res, { error: error instanceof HttpError ? error.message : 'Erro no servidor.' }, error.status || 500);
  }
});
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => {
  console.log('Frequência em ' + JSON.stringify(server.address()) + (hasMedia ? ' · voz configurada' : ' · somente chat'));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
