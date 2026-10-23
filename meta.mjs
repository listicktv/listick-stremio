// Title details and search from TMDB, TheTVDB and Kitsu, with the ids stream addons look up: <IMDb id>:<season>:<episode>,
// and kitsu:<id>:<episode> for anime where Fribb maps a Kitsu entry.
import { animeVideoId, releaseInfo, tvdbOrder } from './lib.mjs';

const env = (k) => (process.env[k] || '').trim();
export const metaOn = () => !!env('TMDB_ACCESS_TOKEN');
const HOUR = 3600000, IMG = 'https://image.tmdb.org/t/p/';
const UA = 'listick-stremio (https://github.com/listicktv/listick-stremio)';

// caches promises: concurrent asks share one request; failures aren't kept
function cache(ttl, max = 2000) {
  const m = new Map();
  return (k, fn) => {
    const hit = m.get(k);
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = Promise.resolve().then(fn);
    m.delete(k); m.set(k, { at: Date.now(), v });
    if (m.size > max) m.delete(m.keys().next().value);
    v.catch(() => { if (m.get(k)?.v === v) m.delete(k); });
    return v;
  };
}
async function getJSON(url, headers = {}, timeout = 15000) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) { const e = new Error(`${url.split('?')[0]} -> ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const tmdbCache = cache(6 * HOUR, 5000);
const tmdb = (path) => tmdbCache(path, () => getJSON(`https://api.themoviedb.org/3${path}`, { authorization: `Bearer ${env('TMDB_ACCESS_TOKEN')}` }));
const kitsuCache = cache(6 * HOUR, 3000);
const kitsu = (path) => kitsuCache(path, () => getJSON(`https://kitsu.io/api/edge${path.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`, { accept: 'application/vnd.api+json' }));

// the token lasts a month: renewed after 20 days or on a 401
let tvdbAuth = { token: null, at: 0 }, tvdbLogin = null;
async function tvdbToken() {
  if (tvdbAuth.token && Date.now() - tvdbAuth.at < 20 * 24 * HOUR) return tvdbAuth.token;
  tvdbLogin ||= (async () => {
    const r = await fetch('https://api4.thetvdb.com/v4/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ apikey: env('TVDB_API_KEY') }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`tvdb login -> ${r.status}`);
    tvdbAuth = { token: (await r.json()).data?.token, at: Date.now() };
    return tvdbAuth.token;
  })().finally(() => { tvdbLogin = null; });
  return tvdbLogin;
}
async function tvdb(path, again = true) {
  try { return await getJSON(`https://api4.thetvdb.com/v4${path}`, { authorization: `Bearer ${await tvdbToken()}` }); }
  catch (e) { if (again && e.status === 401) { tvdbAuth.token = null; return tvdb(path, false); } throw e; }
}
const tvdbImg = (x) => (x ? (/^https?:/.test(x) ? x : `https://artworks.thetvdb.com${x.startsWith('/') ? '' : '/'}${x}`) : undefined);
const tvdbEpCache = cache(12 * HOUR, 500);
const tvdbEpisodes = (id) => tvdbEpCache(id, async () => {
  const eps = [];
  for (let page = 0; page < 20; page++) {
    const d = await tvdb(`/series/${id}/episodes/default/eng?page=${page}`);
    eps.push(...(d.data?.episodes || []));
    if (!d.links?.next) break;
  }
  return eps.filter((e) => Number.isInteger(e.seasonNumber) && Number.isInteger(e.number));
});
// TMDB sometimes splits an anthology into one show per season; TheTVDB follows IMDb (e.g. Monster, tt13207736)
const tvdbByImdbCache = cache(24 * HOUR, 5000);
const tvdbByImdb = (imdb) => tvdbByImdbCache(imdb, async () =>
  (await tvdb(`/search/remoteid/${imdb}`).catch(() => null))?.data?.find((x) => x.series)?.series?.id || null);

// Fribb's anime-lists, refreshed daily
let fribb = { at: 0, byTmdb: new Map(), byMovie: new Map() }, fribbLoading = null;
async function loadFribb() {
  if (Date.now() - fribb.at <= 24 * HOUR) return fribb;
  fribbLoading ||= (async () => {
    try {
      const byTmdb = new Map(), byMovie = new Map(), whole = new Map();
      for (const e of await getJSON('https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json', {}, 60000)) {
        if (!e.kitsu_id) continue;
        const films = [].concat(e.themoviedb_id?.movie ?? []);
        for (const f of films) if (!byMovie.has(f)) byMovie.set(f, e.kitsu_id);
        const tv = e.themoviedb_id?.tv, se = e.season?.tmdb;
        if (films.length || !tv) continue;
        if (Number.isInteger(se)) (byTmdb.get(tv) || byTmdb.set(tv, []).get(tv)).push({ kitsu: e.kitsu_id, season: se, offset: e.episode_offset?.tmdb || 0 });
        else if (e.type === 'TV') { whole.set(tv, (whole.get(tv) || 0) + 1); (byTmdb.get(tv) || byTmdb.set(tv, []).get(tv)).push({ kitsu: e.kitsu_id, season: null, offset: 0 }); }
      }
      // two season-less entries on one show are ambiguous: neither is used
      for (const [tv, n] of whole) if (n > 1) byTmdb.set(tv, byTmdb.get(tv).filter((x) => x.season != null));
      fribb = { at: Date.now(), byTmdb, byMovie };
    } catch (err) {
      console.error(`fribb: ${err.message}`);
      fribb = { ...fribb, at: Date.now() - 23 * HOUR };   // try again in an hour
    }
  })().finally(() => { fribbLoading = null; });
  await fribbLoading;
  return fribb;
}
// null while airing
const kitsuCountCache = cache(24 * HOUR, 5000);
const kitsuCount = (id) => kitsuCountCache(id, async () => (await kitsu(`/anime/${id}?fields[anime]=episodeCount`).catch(() => null))?.data?.attributes?.episodeCount ?? null);

const iso = (x) => (x ? new Date(x).toISOString() : undefined);
const hhmm = (min) => (min ? (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`) : undefined);
const isAnime = (d) => (d.genres || []).some((g) => g.id === 16) && ((d.origin_country || []).includes('JP') || d.original_language === 'ja');
const logoOf = (d) => {
  const l = (d.images?.logos || []).sort((a, b) => Number(b.iso_639_1 === 'en') - Number(a.iso_639_1 === 'en') || (b.vote_average || 0) - (a.vote_average || 0))[0];
  return l ? `${IMG}w500${l.file_path}` : undefined;
};
const trailerOf = (d) => (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer')?.key;
const seasonOf = (id, n) => tmdb(`/tv/${id}/season/${n}`).then((s) => s.episodes || []).catch(() => []);
const seasonsOf = (id, ns) => Promise.all(ns.map(async (n) => [n, await seasonOf(id, n)]));

const findCache = cache(24 * HOUR, 5000);
async function resolve(type, id) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  let m = id.match(/^tmdb:(\d+)$/);
  if (m) return { kind, id: Number(m[1]) };
  m = id.match(/^kitsu:(\d+)$/);
  if (m) return { kitsu: Number(m[1]) };
  if (!/^tt\d+$/.test(id)) return null;
  return findCache(`${kind}|${id}`, async () => {
    const d = await tmdb(`/find/${id}?external_source=imdb_id`);
    const hit = (kind === 'movie' ? d.movie_results : d.tv_results)?.[0];
    return hit ? { kind, id: hit.id } : null;
  });
}

async function tvdbMeta(id, tvdbId) {
  const d = (await tvdb(`/series/${tvdbId}/extended?short=true`))?.data;
  if (!d) return null;
  const y0 = (d.firstAired || '').slice(0, 4), y1 = (d.lastAired || '').slice(0, 4), ended = /ended/i.test(d.status?.name || '');
  const eps = await tvdbEpisodes(tvdbId).catch(() => []);
  return {
    id, type: 'series', name: d.name, poster: tvdbImg(d.image), posterShape: 'poster', description: d.overview || undefined,
    releaseInfo: y0 ? (ended && y1 && y1 !== y0 ? `${y0}–${y1}` : ended ? y0 : `${y0}–`) : undefined, released: iso(d.firstAired),
    genres: (d.genres || []).map((g) => g.name), runtime: hhmm(d.averageRuntime),
    links: [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${id}/` }], behaviorHints: {},
    videos: eps.map((e) => ({ id: `${id}:${e.seasonNumber}:${e.number}`, title: e.name || `Episode ${e.number}`, season: e.seasonNumber, episode: e.number,
      released: iso(e.aired), overview: e.overview || undefined, thumbnail: tvdbImg(e.image) || tvdbImg(d.image) })),
  };
}
async function episodes(d, imdb) {
  const base = imdb || `tmdb:${d.id}`, tvdbId = d.external_ids?.tvdb_id;
  const video = (se, ep, x) => ({ id: `${base}:${se}:${ep}`, season: se, episode: ep, ...x });
  if (isAnime(d)) {
    const entries = await Promise.all(((await loadFribb()).byTmdb.get(d.id) || []).map(async (e) => ({ ...e, count: await kitsuCount(e.kitsu) })));
    const all = [];
    for (const [sn, eps] of await seasonsOf(d.id, (d.seasons || []).map((s) => s.season_number))) for (const e of eps) all.push({ season: sn, episode: e.episode_number, air: e.air_date, e });
    // seasons as TheTVDB (and Cinemeta) split them, where every episode can be placed
    const order = tvdbId && env('TVDB_API_KEY') ? tvdbOrder(all, await tvdbEpisodes(tvdbId).catch(() => [])) : null;
    const out = [];
    let abs = 0;
    for (const { season: sn, episode: ep, e } of all) {
      if (sn > 0) abs++;
      const p = order?.get(`${sn}:${ep}`), se = p?.season ?? sn, en = p?.episode ?? ep;
      let id = animeVideoId(entries, sn, ep, abs, base);
      if (p && id.startsWith(`${base}:`)) id = `${base}:${se}:${en}`;
      out.push({ id, title: e.name || `Episode ${ep}`, season: se, episode: en,
        released: iso(e.air_date), overview: e.overview || undefined, thumbnail: e.still_path ? `${IMG}w500${e.still_path}` : bg(d) });
    }
    return out;
  }
  if (tvdbId && env('TVDB_API_KEY')) {
    try {
      const eps = await tvdbEpisodes(tvdbId);
      if (eps.length) {
        const stills = new Map();
        for (const [sn, xs] of await seasonsOf(d.id, [...new Set(eps.filter((e) => !e.image).map((e) => e.seasonNumber))]))
          for (const x of xs) if (x.still_path) stills.set(`${sn}:${x.episode_number}`, `${IMG}w500${x.still_path}`);
        return eps.map((e) => video(e.seasonNumber, e.number, { title: e.name || `Episode ${e.number}`, released: iso(e.aired), overview: e.overview || undefined,
          thumbnail: tvdbImg(e.image) || stills.get(`${e.seasonNumber}:${e.number}`) || bg(d) }));
      }
    } catch (e) { console.error(`tvdb ${tvdbId}: ${e.message}`); }
  }
  const out = [];
  for (const [sn, eps] of await seasonsOf(d.id, (d.seasons || []).map((s) => s.season_number))) for (const e of eps)
    out.push(video(sn, e.episode_number, { title: e.name || `Episode ${e.episode_number}`, released: iso(e.air_date), overview: e.overview || undefined,
      thumbnail: e.still_path ? `${IMG}w500${e.still_path}` : bg(d) }));
  return out;
}
const bg = (d) => (d.backdrop_path ? `${IMG}w780${d.backdrop_path}` : undefined);

async function kitsuMeta(type, id, kid) {
  const a = (await kitsu(`/anime/${kid}`))?.data?.attributes;
  if (!a) return null;
  const film = a.subtype === 'movie' || type === 'movie';
  const meta = {
    id, type, name: a.titles?.en || a.canonicalTitle, poster: a.posterImage?.large || a.posterImage?.original, posterShape: 'poster',
    background: a.coverImage?.original || undefined, description: a.synopsis || undefined, releaseInfo: (a.startDate || '').slice(0, 4) || undefined,
    released: iso(a.startDate), runtime: hhmm(a.episodeLength), imdbRating: a.averageRating ? (Number(a.averageRating) / 10).toFixed(1) : undefined,
    country: 'JP', trailers: a.youtubeVideoId ? [{ source: a.youtubeVideoId, type: 'Trailer' }] : undefined,
    behaviorHints: film ? { defaultVideoId: `kitsu:${kid}` } : {},
  };
  if (!film) {
    const eps = [];
    // 20 per page: the rest are fetched 8 at a time
    const page = (offset) => kitsu(`/anime/${kid}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`).catch(() => null);
    const first = await page(0), count = Math.min(Number(first?.meta?.count) || 0, 3000);
    eps.push(...(first?.data || []));
    const rest = [];
    for (let offset = 20; offset < count; offset += 20) rest.push(offset);
    for (let i = 0; i < rest.length; i += 8) for (const p of await Promise.all(rest.slice(i, i + 8).map(page))) eps.push(...(p?.data || []));
    meta.videos = eps.filter((e) => Number.isInteger(e.attributes?.number)).map((e) => ({ id: `kitsu:${kid}:${e.attributes.number}`,
      title: e.attributes.canonicalTitle || `Episode ${e.attributes.number}`, season: 1, episode: e.attributes.number, released: iso(e.attributes.airdate),
      overview: e.attributes.synopsis || undefined, thumbnail: e.attributes.thumbnail?.original || meta.background }));
  }
  return meta;
}

const metaCache = cache(6 * HOUR, 2000);
export async function stremioMeta(type, id) {
  // TMDB matched a different show than TheTVDB: use TheTVDB's
  const target = await resolve(type, id);
  if (type === 'series' && /^tt\d+$/.test(id) && env('TVDB_API_KEY')) {
    const tv = await tvdbByImdb(id).catch(() => null);
    const tvdbOfMatch = target?.id ? (await tmdb(`/tv/${target.id}/external_ids`).catch(() => null))?.tvdb_id : null;
    if (tv && Number(tvdbOfMatch) !== Number(tv)) return metaCache(`tvdb|${tv}|${id}`, () => tvdbMeta(id, tv));
  }
  if (!target) return null;
  if (target.kitsu) return metaCache(`kitsu|${target.kitsu}|${type}|${id}`, () => kitsuMeta(type, id, target.kitsu));
  return metaCache(`${target.kind}|${target.id}|${id}`, async () => {
    const d = await tmdb(`/${target.kind}/${target.id}?append_to_response=credits,videos,external_ids,images&include_image_language=en,null`);
    const movie = target.kind === 'movie', imdb = /^tt\d+$/.test(d.external_ids?.imdb_id || d.imdb_id || '') ? d.external_ids?.imdb_id || d.imdb_id : null;
    const kitsuFilm = movie && isAnime(d) ? (await loadFribb()).byMovie.get(d.id) ?? null : null;
    const trailer = trailerOf(d), crew = d.credits?.crew || [];
    const meta = {
      // keep the requested id; streams are asked for by IMDb id
      id, type, name: d.title || d.name, poster: d.poster_path ? `${IMG}w500${d.poster_path}` : undefined, posterShape: 'poster', background: bg(d),
      logo: logoOf(d), description: [d.tagline, d.overview].filter(Boolean).join(' ') || undefined,
      releaseInfo: releaseInfo(movie, d), released: iso(d.release_date || d.first_air_date), runtime: hhmm(d.runtime || d.episode_run_time?.[0]),
      genres: (d.genres || []).map((g) => g.name), cast: (d.credits?.cast || []).slice(0, 10).map((c) => c.name),
      director: movie ? crew.filter((c) => c.job === 'Director').map((c) => c.name) : (d.created_by || []).map((c) => c.name),
      writer: crew.filter((c) => c.department === 'Writing').map((c) => c.name).slice(0, 5),
      country: (d.production_countries || []).map((c) => c.iso_3166_1).join(', ') || (d.origin_country || []).join(', ') || undefined,
      trailers: trailer ? [{ source: trailer, type: 'Trailer' }] : undefined, trailerStreams: trailer ? [{ ytId: trailer, title: d.title || d.name }] : undefined,
      links: imdb ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${imdb}/` }] : undefined,
      behaviorHints: movie ? { defaultVideoId: kitsuFilm ? `kitsu:${kitsuFilm}` : imdb || `tmdb:${d.id}` } : {},
    };
    if (!movie) meta.videos = await episodes(d, imdb);
    return meta;
  });
}

export async function stremioSearch(type, text) {
  if (type === 'anime') {
    const find = async (subtype, as) => ((await kitsu(`/anime?filter[text]=${encodeURIComponent(text)}&filter[subtype]=${subtype}&page[limit]=20`).catch(() => null))?.data || [])
      .filter((x) => x.attributes.posterImage).map((x) => ({ id: `kitsu:${x.id}`, type: as, name: x.attributes.titles?.en || x.attributes.canonicalTitle,
        poster: x.attributes.posterImage.medium || x.attributes.posterImage.original, releaseInfo: (x.attributes.startDate || '').slice(0, 4) || undefined }));
    return [...await find('TV,ONA,OVA', 'series'), ...await find('movie', 'movie')];
  }
  const kind = type === 'movie' ? 'movie' : 'tv';
  const d = await tmdb(`/search/${kind}?query=${encodeURIComponent(text)}&include_adult=false`);
  const rs = (d.results || []).filter((r) => r.poster_path).slice(0, 30);
  const ids = await Promise.all(rs.map((r) => tmdb(`/${kind}/${r.id}/external_ids`).then((x) => (/^tt\d+$/.test(x?.imdb_id || '') ? x.imdb_id : null)).catch(() => null)));
  return rs.map((r, i) => ({ id: ids[i] || `tmdb:${r.id}`, type, name: r.title || r.name,
    poster: `${IMG}w342${r.poster_path}`, releaseInfo: (r.release_date || r.first_air_date || '').slice(0, 4) || undefined, description: r.overview || undefined }));
}
