// Listick lists -> Stremio catalogs, install-link settings and the manifest. No I/O, so it's unit-tested.
// Stremio gives a catalog one filter dropdown, so a list can have extra catalogs (variants), each with one kind of filter.
// Catalog key: <list key>#<variant>[~<n>].

export const PAGE = 100;
export const DAYS = [30, 60, 90];
const ALL = 'All';

export const keyOf = (s) => `${s.src}:${s.type}`;
// only first letters change, so "Apple TV+" stays
export const titleCase = (t) => t.replace(/(^|[\s·(/-])(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());

const GROUP_RANK = { 'Your lists': 0, Discover: 1, Streaming: 2, 'For you': 3 }, OWN = ['upnext', 'plan'];
export const byDefault = (list) => list.map((s, i) => ({ s, i })).sort((a, b) => (GROUP_RANK[a.s.group] ?? 1) - (GROUP_RANK[b.s.group] ?? 1)
  || ((OWN.indexOf(a.s.src) + 1) || 9) - ((OWN.indexOf(b.s.src) + 1) || 9) || a.i - b.i).map((x) => x.s);

const KIND_TYPE = { Movies: 'movie', Series: 'series', Anime: 'anime' };
const KIND_NAME = { Movies: 'Movies', Series: 'Shows', Anime: 'Anime' };
const genresFor = (all, type) => all.find((x) => x.type === type && x.filter?.name === 'Genre')?.filter.options || [];
const own = (s) => s.group === 'Your lists' || s.group === 'For you';
export function variantsOf(s, all) {
  const k = keyOf(s), byPick = true;
  if (s.src === 'upnext' || s.src === 'plan') return [{ v: 'mixed', label: null, parts: [{ key: `${k}#mixed`, name: s.name, type: s.type, id: `media.${s.src}`, options: [], byPick }] }];
  if (own(s)) return [
    { v: 'mixed', label: 'Mixed', parts: [{ key: `${k}#mixed`, name: s.name, type: s.type, id: `media.${s.src}`, options: s.filter.options, byPick }] },
    { v: 'type', label: 'By type', parts: s.filter.options.filter((x) => KIND_TYPE[x]).map((kind, i) => ({ key: `${k}#type~${i}`, name: `${s.name} · ${KIND_NAME[kind]}`,
      type: KIND_TYPE[kind], id: `media.${s.src}@type~${i}`, options: genresFor(all, KIND_TYPE[kind]), fixed: kind })) },
  ];
  if (s.group === 'Streaming') return [
    { v: 'service', label: 'Service', parts: [{ key: `${k}#service`, name: s.name, type: s.type, id: `media.${s.src}`, options: s.filter.options, byPick }] },
    { v: 'each', label: 'Each service', parts: s.filter.options.map((svc, i) => ({ key: `${k}#each~${i}`, name: `${svc} · ${s.name.replace(/^Streaming /i, '')}`,
      type: s.type, id: `media.${s.src}@each~${i}`, options: genresFor(all, s.type), fixed: svc })) },
  ];
  const extra = [['genre', 'Genre', s.genres], ['year', 'Year', s.years], ['rating', 'Rating', s.ratings]].filter(([, , o]) => o?.length);
  return [
    { v: 'none', label: 'List', parts: [{ key: `${k}#none`, name: s.name, type: s.type, id: `media.${s.src}`, options: [], byPick }] },
    ...extra.map(([v, label, options]) => ({ v, label: `By ${label.toLowerCase()}`, parts: [{ key: `${k}#${v}`, name: `${s.name} · By ${label}`, type: s.type, id: `media.${s.src}@${v}`, options, byPick }] })),
  ];
}
export const defaultVariants = (s, all) => [variantsOf(s, all)[0].v];
export const defaultOn = (s) => own(s);
export const defaultHome = (s, v) => s.group !== 'Streaming' && v !== 'year' && v !== 'type';

// { k: API key, v: { list: [variants] }, lists: { catalog: { on, name, home } }, order, days }, only what differs from defaults
export function readConfig(seg, all) {
  let c = {};
  try { if (seg) c = JSON.parse(Buffer.from(seg, 'base64url').toString()); } catch { c = {}; }
  const key = typeof c.k === 'string' && /^[\w-]{10,128}$/.test(c.k) ? c.k : null;
  const chosen = {}, lists = {};
  for (const s of all) {
    const vs = variantsOf(s, all), have = vs.map((x) => x.v);
    const want = Array.isArray(c.v?.[keyOf(s)]) ? c.v[keyOf(s)].filter((x) => have.includes(x)) : defaultVariants(s, all);
    chosen[keyOf(s)] = want.length ? want : defaultVariants(s, all);
    for (const vr of vs) for (const pt of vr.parts) {
      const w = c.lists?.[pt.key];
      // variants after the first are Discover only
      const sub = vr !== vs[0];
      lists[pt.key] = { on: w?.on ?? defaultOn(s), name: String(w?.name || pt.name).slice(0, 40), home: sub ? false : w?.home ?? defaultHome(s, vr.v) };
    }
  }
  const order = Array.isArray(c.order) ? c.order.filter((k) => lists[k]) : [];
  return { key, chosen, lists, order, days: DAYS.includes(c.days) ? c.days : 60 };
}
export function entries(cfg, all) {
  const out = [];
  for (const s of all) for (const vr of variantsOf(s, all)) if (cfg.chosen[keyOf(s)].includes(vr.v)) for (const pt of vr.parts) out.push({ ...pt, s, v: vr.v });
  return out;
}
const ordered = (cfg, all) => {
  const at = new Map(cfg.order.map((k, i) => [k, i]));
  return entries(cfg, all).map((e, i) => ({ e, i })).sort((a, b) => (at.get(a.e.key) ?? 1e6 + a.i) - (at.get(b.e.key) ?? 1e6 + b.i)).map((x) => x.e);
};
// Discover-only catalogs mark their filter required: Stremio's Home skips catalogs that need a choice
const IDS = ['tt', 'tmdb:', 'kitsu:'];
const SEARCH = ['movie', 'series', 'anime'].map((type) => ({ type, id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] }));
export const manifest = (cfg, all, version, details = false) => ({
  id: 'tv.listick.stremio', version, name: 'Catalogs',
  description: 'Your Listick lists as Stremio catalogs: Plan to watch, Up next, your own and smart lists, For you and Listick\'s rows, with details and search for movies, shows and anime',
  resources: details ? ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: IDS }] : ['catalog'],
  types: ['movie', 'series', 'anime', 'For You'], ...(details ? { idPrefixes: IDS } : {}),
  catalogs: [...ordered(cfg, all).filter((e) => cfg.lists[e.key].on).map((e) => {
    const home = cfg.lists[e.key].home, options = home ? e.options : [ALL, ...e.options];
    return { type: e.type, id: e.id, name: titleCase(cfg.lists[e.key].name), genres: options,
      extra: [...(options.length ? [{ name: 'genre', options, isRequired: !home }] : []), { name: 'skip' }] };
  }), ...(details ? SEARCH : [])],
  behaviorHints: { configurable: true },
});
export const meta = (x) => ({ id: x.id, type: x.type, name: x.title, poster: x.poster || undefined,
  releaseInfo: x.year ? String(x.year) : undefined, description: x.next ? `Next: ${x.next}` : undefined });
// split by hand: URLSearchParams would turn the + in "8+" into a space
export const extraOf = (extra) => new Map(String(extra || '').split('&').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));
export function listQuery(cfg, all, type, id, extra) {
  const e = entries(cfg, all).find((x) => x.type === type && x.id === id);
  if (!e || !cfg.lists[e.key].on) return null;
  const q = extraOf(extra), pick = e.options.includes(q.get('genre')) ? q.get('genre') : '';
  // a part fixed to a kind or service sends that as the filter and the pick as the genre
  const [filter, genre] = e.byPick ? [pick, ''] : [e.fixed, pick];
  return { src: e.s.src, skip: Number(q.get('skip')) || 0,
    query: `type=${encodeURIComponent(e.s.type)}&days=${cfg.days}&filter=${encodeURIComponent(filter)}&genre=${encodeURIComponent(genre)}` };
}
// counted from the right: entries in front of the proxies' are written by the client
export function clientIp(forwardedFor, socketAddress, proxies) {
  const hops = String(forwardedFor || '').split(',').map((x) => x.trim()).filter(Boolean);
  return hops.length ? hops[Math.max(0, hops.length - proxies)] : socketAddress || 'local';
}

// the Kitsu entry Fribb places on this TMDB episode, else a season-less entry (absolute number), else <id>:<season>:<episode>
export function animeVideoId(entries, season, ep, abs, base) {
  const cover = entries.filter((x) => x.season === season && x.offset < ep && (x.count == null || ep - x.offset <= x.count)).sort((a, b) => b.offset - a.offset)[0];
  if (cover) return `kitsu:${cover.kitsu}:${ep - cover.offset}`;
  const whole = entries.find((x) => x.season == null);
  return whole && season > 0 ? `kitsu:${whole.kitsu}:${abs}` : `${base}:${season}:${ep}`;
}
// an anime's episodes (TMDB's: { season, episode, air }) in TheTVDB's order, matched by air date (a day either way for time
// zones); a season > 0 episode with no air date follows the one before it. null unless all are placed and the order differs
export function tvdbOrder(tmdbEps, tvdbEps) {
  const day = (s, d) => new Date(Date.parse(`${s}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const e of tvdbEps) if (e.seasonNumber > 0 && e.aired) (byDay.get(e.aired) || byDay.set(e.aired, []).get(e.aired)).push(e);
  const out = new Map();
  let last = null, moved = false;
  for (const e of tmdbEps) {
    if (e.season === 0) continue;
    const t = e.air ? [0, -1, 1].map((d) => byDay.get(day(e.air, d))).find((q) => q?.length)?.shift() : null;
    const p = t ? { season: t.seasonNumber, episode: t.number } : !e.air && last ? { season: last.season, episode: last.episode + 1 } : null;
    if (!p) return null;
    if (p.season !== e.season || p.episode !== e.episode) moved = true;
    out.set(`${e.season}:${e.episode}`, p);
    last = p;
  }
  return moved ? out : null;
}
export function releaseInfo(movie, d) {
  const year = (movie ? d.release_date : d.first_air_date)?.slice(0, 4);
  if (!year || movie) return year || undefined;
  const last = d.last_air_date?.slice(0, 4), status = d.status || '';
  if (/return/i.test(status)) return `${year}–`;
  return last && last !== year && !/production|planned/i.test(status) ? `${year}–${last}` : year;
}
