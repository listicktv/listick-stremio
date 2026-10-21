// listick-stremio: Stremio catalogs from a Listick account, plus details and search when TMDB_ACCESS_TOKEN is set.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID, scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { DAYS, PAGE, byDefault, clientIp, defaultHome, defaultOn, defaultVariants, extraOf, keyOf, listQuery, manifest, meta, readConfig, titleCase, variantsOf } from './lib.mjs';
import { metaOn, stremioMeta, stremioSearch } from './meta.mjs';

const env = (k, d = '') => (process.env[k] || d).trim();
const LISTICK = env('LISTICK_URL').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+/.test(LISTICK)) {
  console.error('LISTICK_URL is required: the address of your Listick, for example https://listick.example.com');
  process.exit(1);
}
const PORT = Number(env('PORT', '8080'));
const PROXIES = Math.max(1, Math.floor(Number(env('LISTICK_TRUSTED_PROXIES'))) || 1);
const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));

const db = new DatabaseSync(env('DB_PATH', '/data/listick-stremio.db'));
db.exec(`create table if not exists configs (uuid text primary key, pass text not null, config text not null,
  created_at integer not null, updated_at integer not null)`);
const getSaved = db.prepare('select pass, config from configs where uuid = ?');
const addSaved = db.prepare('insert into configs (uuid, pass, config, created_at, updated_at) values (?, ?, ?, ?, ?)');
const putSaved = db.prepare('update configs set config = ?, updated_at = ? where uuid = ?');
const delSaved = db.prepare('delete from configs where uuid = ?');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// async scrypt, so a burst of password tries doesn't block other requests
const scryptA = promisify(scrypt);
const hashPass = async (pw) => { const salt = randomBytes(16); return `${salt.toString('hex')}:${(await scryptA(pw, salt, 32)).toString('hex')}`; };
const passOk = async (pw, stored) => {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const a = await scryptA(pw, Buffer.from(salt, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
function limiter(max, ms) {
  const seen = new Map();
  const recent = (req) => {
    const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, PROXIES), now = Date.now();
    for (const [k, t] of seen) if (now - t.at(-1) > ms) seen.delete(k);
    return [ip, (seen.get(ip) || []).filter((x) => now - x < ms)];
  };
  return {
    blocked: (req) => recent(req)[1].length >= max,
    hit: (req) => { const [ip, t] = recent(req); t.push(Date.now()); seen.set(ip, t); },
  };
}
const wrongPass = limiter(10, 600000);   // wrong UUID or password
const wrongKey = limiter(10, 600000);    // keys Listick doesn't know, so the page can't be used to guess them
const newSaves = limiter(20, 3600000);   // new saved settings
const TOO_MANY = 'Too many tries: wait a few minutes.';
// a link's settings: a saved UUID or base64url JSON
const configSeg = (seg) => {
  if (seg && UUID.test(seg)) { const row = getSaved.get(seg); return row ? Buffer.from(row.config).toString('base64url') : ''; }
  return seg;
};

async function fromListick(p, key) {
  const r = await fetch(`${LISTICK}/api/v1${p}`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { const e = new Error(`${p.split('?')[0]} -> ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const offered = new Map();
async function sources(key) {
  if (!key) return [];
  const now = Date.now(), had = offered.get(key);
  if (had && now - had.at <= 300000 && had.list.length) return had.list;
  for (const [x, v] of offered) if (now - v.at > 300000) offered.delete(x);
  const list = byDefault((await fromListick('/lists', key)).lists.map((s) => ({ ...s, name: titleCase(s.name) })));
  offered.set(key, { at: now, list });
  return list;
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
// Stremio Web needs CORS
const sendStremio = (res, code, obj, cache = 'no-store') => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': code === 200 ? cache : 'no-store' });
  res.end(JSON.stringify(obj));
};
const PUBLIC_CACHE = 'public, max-age=3600, stale-while-revalidate=86400', LIST_CACHE = 'private, max-age=60';
const MAX_BODY = 32768;
const body = (req) => new Promise((ok) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > MAX_BODY) { req.destroy(); ok({}); } });
  req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } });
});
const PUBLIC = path.join(import.meta.dirname, 'public');
const TYPES = { '/logo.svg': 'image/svg+xml', '/logo.png': 'image/png', '/stremio.svg': 'image/svg+xml', '/fonts/manrope.woff2': 'font/woff2', '/fonts/jetbrains-mono.woff2': 'font/woff2' };
const STATIC = Object.fromEntries(await Promise.all(Object.entries(TYPES).map(async ([p, type]) => [p, { type, data: await readFile(path.join(PUBLIC, p.slice(1))) }])));
const PAGE_HTML = await readFile(path.join(PUBLIC, 'index.html'));
const keyError = (e) => (e.status === 401 ? [401, 'Listick doesn\'t know this key: copy it again from Settings › API access.']
  : e.status === 429 ? [429, TOO_MANY] : e.status === 404 ? [404, 'not found'] : [502, 'Listick can\'t be reached right now.']);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (/^\/(?:[\w-]+\/)?(?:configure)?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return res.end(PAGE_HTML);
    }
    const file = STATIC[url.pathname];
    if (file) {
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(file.data);
    }
    // POST keeps the key out of URLs and logs
    if (url.pathname === '/check' && req.method === 'POST') {
      if (wrongKey.blocked(req)) return send(res, 429, { error: TOO_MANY });
      const { key } = await body(req);
      if (typeof key !== 'string' || !/^[\w-]{10,128}$/.test(key.trim())) return send(res, 400, { error: 'That doesn\'t look like a Listick API key.' });
      try {
        const me = await fromListick('/me', key.trim()), all = await sources(key.trim());
        return send(res, 200, { name: me.name, days: DAYS, defaultDays: 60, sources: all.map((s) => ({ key: keyOf(s), name: s.name, group: s.group, on: defaultOn(s),
          defaults: defaultVariants(s, all), variants: variantsOf(s, all).map((vr) => ({ v: vr.v, label: vr.label, home: defaultHome(s, vr.v),
            parts: vr.parts.map((pt) => ({ key: pt.key, name: pt.name })) })) })) });
      } catch (e) {
        if (e.status === 401) wrongKey.hit(req);
        const [code, error] = keyError(e); return send(res, code, { error });
      }
    }
    if (url.pathname === '/save' && req.method === 'POST') {
      const b = await body(req), cfg = b.config;
      if (!cfg || typeof cfg !== 'object' || JSON.stringify(cfg).length > 16000) return send(res, 400, { error: 'Nothing to save.' });
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) return send(res, 400, { error: 'The password needs 8 to 200 characters.' });
      const now = Date.now();
      if (b.uuid) {
        if (wrongPass.blocked(req)) return send(res, 429, { error: TOO_MANY });
        const row = typeof b.uuid === 'string' && UUID.test(b.uuid) ? getSaved.get(b.uuid) : null;
        if (!row || !await passOk(b.password, row.pass)) { wrongPass.hit(req); return send(res, 403, { error: 'Wrong UUID or password.' }); }
        putSaved.run(JSON.stringify(cfg), now, b.uuid);
        return send(res, 200, { uuid: b.uuid });
      }
      if (newSaves.blocked(req)) return send(res, 429, { error: TOO_MANY });
      newSaves.hit(req);
      const uuid = randomUUID();
      addSaved.run(uuid, await hashPass(b.password), JSON.stringify(cfg), now, now);
      return send(res, 200, { uuid });
    }
    if ((url.pathname === '/load' || url.pathname === '/delete') && req.method === 'POST') {
      if (wrongPass.blocked(req)) return send(res, 429, { error: TOO_MANY });
      const b = await body(req), uuid = typeof b.uuid === 'string' ? b.uuid.trim() : '', row = UUID.test(uuid) ? getSaved.get(uuid) : null;
      if (!row || typeof b.password !== 'string' || b.password.length > 200 || !await passOk(b.password, row.pass)) {
        wrongPass.hit(req); return send(res, 403, { error: 'Wrong UUID or password.' });
      }
      if (url.pathname === '/delete') { delSaved.run(uuid); return send(res, 200, { ok: true }); }
      return send(res, 200, { config: JSON.parse(row.config) });
    }
    const mm = url.pathname.match(/^\/(?:[\w-]+\/)?meta\/(movie|series)\/([^/]+)\.json$/);
    if (mm) {
      const id = decodeURIComponent(mm[2]);
      if (!metaOn() || !/^(tt\d+|tmdb:\d+|kitsu:\d+)$/.test(id)) return sendStremio(res, 404, { error: 'not found' });
      const out = await stremioMeta(mm[1], id).catch((e) => { console.error(`meta ${id}: ${e.message}`); return null; });
      return out ? sendStremio(res, 200, { meta: out }, PUBLIC_CACHE) : sendStremio(res, 404, { error: 'not found' });
    }
    const m = url.pathname.match(/^\/(?:([\w-]+)\/)?(manifest\.json|catalog\/(movie|series|anime|For%20You)\/([\w.~@-]+)(?:\/([^/]+))?\.json)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    if (m[4] === 'search') {
      const q = extraOf(m[5] && decodeURIComponent(m[5])).get('search');
      return sendStremio(res, 200, { metas: metaOn() && q ? await stremioSearch(decodeURIComponent(m[3]), q.slice(0, 100)).catch(() => []) : [] }, PUBLIC_CACHE);
    }
    const seg = configSeg(m[1]), key = readConfig(seg, []).key;
    let all;
    try { all = await sources(key); } catch (e) { return sendStremio(res, keyError(e)[0], { error: keyError(e)[1] }); }
    const cfg = readConfig(seg, all);
    if (m[2] === 'manifest.json') {
      const host = req.headers['x-forwarded-host'] || req.headers.host, proto = req.headers['x-forwarded-proto'] || 'http';
      return sendStremio(res, 200, { ...manifest(cfg, all, version, metaOn()), logo: `${proto}://${host}/logo.png` });
    }
    const lq = listQuery(cfg, all, decodeURIComponent(m[3]), m[4], m[5] && decodeURIComponent(m[5]));
    if (!lq) return sendStremio(res, 404, { error: 'no such catalog' });
    const { items } = await fromListick(`/lists/${encodeURIComponent(lq.src)}?${lq.query}`, cfg.key);
    return sendStremio(res, 200, { metas: items.slice(lq.skip, lq.skip + PAGE).map(meta) }, LIST_CACHE);
  } catch (e) {
    // the first path segment can hold the API key
    console.error(`${req.method} ${url.pathname.replace(/^\/[\w-]{20,}\//, '/<settings>/')}: ${e.message}`);
    const [code, error] = e instanceof URIError ? [400, 'bad address'] : e.status ? keyError(e) : [502, 'Listick can\'t be reached right now.'];
    if (!res.headersSent) sendStremio(res, code, { error });
  }
}).listen(PORT, () => console.log(`listick-stremio ${version} on :${PORT}, lists from ${LISTICK}, details ${metaOn() ? 'on' : 'off (no TMDB_ACCESS_TOKEN)'}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
