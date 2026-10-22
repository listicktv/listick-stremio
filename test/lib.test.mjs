// What the addon makes of Listick's lists: catalogs, settings, the manifest and what a catalog asks Listick for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animeVideoId, clientIp, extraOf, listQuery, manifest, meta, readConfig, releaseInfo, tvdbOrder, variantsOf } from '../lib.mjs';

const KINDS = { name: 'Type', options: ['Movies', 'Series', 'Anime'] };
// a Listick account's lists as /api/v1/lists gives them (a smart list is one of the owner's own lists)
const ALL = [
  { src: 'upnext', type: 'For You', name: 'Up Next', group: 'Your lists', filter: { name: 'Type', options: ['Anime', 'Series'] } },
  { src: 'plan', type: 'For You', name: 'Plan To Watch', group: 'Your lists', filter: KINDS },
  { src: 'list.k3x9q2', type: 'For You', name: 'Top 250 Movies', group: 'Your lists', filter: KINDS },
  { src: 'row.movie-trending', type: 'movie', name: 'Trending Movies', group: 'Discover', filter: { name: 'Genre', options: ['Action', 'Drama'] },
    genres: ['Action', 'Drama'], years: ['2026', '2010s'], ratings: ['8+', '7+'] },
  { src: 'svc.tv-streaming', type: 'series', name: 'Streaming Shows', group: 'Streaming', filter: { name: 'Service', options: ['Netflix', 'Hulu'] } },
];
const link = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
const KEY = 'k'.repeat(24);

test('your own lists, smart ones included, are on by default; Listick\'s rows and streaming rows are off', () => {
  const cfg = readConfig(link({ k: KEY }), ALL), m = manifest(cfg, ALL, '1.2.3');
  assert.deepEqual(m.catalogs.map((c) => c.id), ['media.upnext', 'media.plan', 'media.list.k3x9q2']);
  assert.equal(m.catalogs[2].name, 'Top 250 Movies');
  assert.deepEqual(m.resources, ['catalog'], 'without a TMDB token: catalogs only');
  assert.equal(m.name, 'Catalogs');
  assert.equal(m.version, '1.2.3');
});
test('a list of your own can also be split by type, each part under its own type with the genres', () => {
  const vs = variantsOf(ALL[2], ALL);
  assert.deepEqual(vs.map((v) => v.v), ['mixed', 'type']);
  assert.deepEqual(vs[1].parts.map((p) => [p.type, p.fixed]), [['movie', 'Movies'], ['series', 'Series'], ['anime', 'Anime']]);
  assert.deepEqual(vs[1].parts[0].options, ['Action', 'Drama']);
});
test('a row offers its plain list and copies by genre, year and rating; a streaming row by service or each service', () => {
  assert.deepEqual(variantsOf(ALL[3], ALL).map((v) => v.v), ['none', 'genre', 'year', 'rating']);
  assert.deepEqual(variantsOf(ALL[4], ALL).map((v) => v.v), ['service', 'each']);
});
test('settings: renames, Discover only, order and the Up next window come back from the link; junk is ignored', () => {
  const cfg = readConfig(link({ k: KEY, lists: { 'plan:For You#mixed': { name: 'Watchlist' }, 'list.k3x9q2:For You#mixed': { home: false } },
    order: ['list.k3x9q2:For You#mixed', 'nope'], days: 90 }), ALL);
  const m = manifest(cfg, ALL, '0');
  assert.equal(m.catalogs[0].id, 'media.list.k3x9q2');
  assert.equal(m.catalogs.find((c) => c.id === 'media.plan').name, 'Watchlist');
  assert.deepEqual(m.catalogs[0].extra[0], { name: 'genre', options: ['All', 'Movies', 'Series', 'Anime'], isRequired: true }, 'Discover only: a required filter, All first');
  assert.equal(cfg.days, 90);
  assert.equal(readConfig('not base64 json', ALL).key, null);
  assert.equal(readConfig(link({ k: 'short' }), ALL).key, null);
});
test('a catalog asks Listick for its list with the picked filter; a fixed part asks for its kind and the picked genre', () => {
  const cfg = readConfig(link({ k: KEY, v: { 'list.k3x9q2:For You': ['mixed', 'type'] }, days: 30 }), ALL);
  assert.deepEqual(listQuery(cfg, ALL, 'For You', 'media.list.k3x9q2', 'genre=Series&skip=100'),
    { src: 'list.k3x9q2', skip: 100, query: 'type=For%20You&days=30&filter=Series&genre=' });
  assert.deepEqual(listQuery(cfg, ALL, 'movie', 'media.list.k3x9q2@type~0', 'genre=Drama'),
    { src: 'list.k3x9q2', skip: 0, query: 'type=For%20You&days=30&filter=Movies&genre=Drama' });
  assert.equal(listQuery(cfg, ALL, 'movie', 'media.row.movie-trending', ''), null, 'off by default');
});
test('Stremio\'s extra keeps a + as it is ("8+" is a rating, not "8 ")', () => {
  assert.equal(extraOf('genre=8+&skip=20').get('genre'), '8+');
});
test('a list item keeps the id Listick gives it, so Cinemeta, the Kitsu addon and stream addons find it', () => {
  assert.deepEqual(meta({ id: 'tt0133093', type: 'movie', title: 'The Matrix', year: 1999, poster: 'p' }),
    { id: 'tt0133093', type: 'movie', name: 'The Matrix', poster: 'p', releaseInfo: '1999', description: undefined });
  assert.equal(meta({ id: 'kitsu:46474', type: 'series', title: 'Frieren', next: 'E9' }).description, 'Next: E9');
});
test('the client address counts proxies from the right, so entries a client writes itself are ignored', () => {
  assert.equal(clientIp('6.6.6.6, 203.0.113.9', '10.0.0.1', 1), '203.0.113.9');
  assert.equal(clientIp('6.6.6.6, 203.0.113.9, 172.30.0.5', '10.0.0.1', 2), '203.0.113.9');
  assert.equal(clientIp('', '10.0.0.1', 1), '10.0.0.1');
});
test('with a TMDB token the addon also gives details for IMDb, TMDB and Kitsu ids, and three search catalogs off Home', () => {
  const m = manifest(readConfig(link({ k: KEY }), ALL), ALL, '1', true);
  assert.deepEqual(m.resources[1], { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:', 'kitsu:'] });
  assert.deepEqual(m.catalogs.filter((c) => c.id === 'search').map((c) => [c.type, c.extra[0].isRequired]), [['movie', true], ['series', true], ['anime', true]]);
});
test('an anime episode is asked for as the Kitsu entry Fribb places on it, else by IMDb season and episode', () => {
  // Frieren-like: season 1 is one Kitsu entry of 28 episodes; season 2 a second entry
  const entries = [{ kitsu: 46474, season: 1, offset: 0, count: 28 }, { kitsu: 49000, season: 2, offset: 0, count: null }];
  assert.equal(animeVideoId(entries, 1, 5, 5, 'tt22248376'), 'kitsu:46474:5');
  assert.equal(animeVideoId(entries, 1, 29, 29, 'tt22248376'), 'tt22248376:1:29', 'past the entry\'s count');
  assert.equal(animeVideoId(entries, 2, 3, 31, 'tt22248376'), 'kitsu:49000:3');
  // one season-less entry counted from the first episode (a long show TMDB splits into seasons)
  assert.equal(animeVideoId([{ kitsu: 12, season: null, offset: 0 }], 3, 2, 54, 'tt0388629'), 'kitsu:12:54');
  assert.equal(animeVideoId([{ kitsu: 12, season: null, offset: 0 }], 0, 1, 0, 'tt0388629'), 'tt0388629:0:1', 'specials stay on IMDb');
  // a split cour: the second entry starts at episode 13 of the same TMDB season
  assert.equal(animeVideoId([{ kitsu: 1, season: 1, offset: 0, count: 12 }, { kitsu: 2, season: 1, offset: 12, count: 12 }], 1, 15, 15, 'tt1'), 'kitsu:2:3');
});
test('release years: a film\'s year; a show\'s range once it ended, open while it returns', () => {
  assert.equal(releaseInfo(true, { release_date: '1999-03-31' }), '1999');
  assert.equal(releaseInfo(false, { first_air_date: '2008-01-20', last_air_date: '2013-09-29', status: 'Ended' }), '2008–2013');
  assert.equal(releaseInfo(false, { first_air_date: '2016-07-15', last_air_date: '2025-11-26', status: 'Returning Series' }), '2016–');
  assert.equal(releaseInfo(false, { first_air_date: '2024-01-01', last_air_date: '2024-03-01', status: 'Ended' }), '2024');
});
test('an anime in TheTVDB\'s seasons, matched by air date', () => {
  // TMDB: one season of 4; TheTVDB: two seasons of 2, the second part's first episode a day later there (time zones)
  const tmdb = [{ season: 1, episode: 1, air: '2023-09-29' }, { season: 1, episode: 2, air: '2023-10-06' }, { season: 1, episode: 3, air: '2024-01-05' },
    { season: 1, episode: 4, air: null }, { season: 0, episode: 1, air: '2023-12-01' }];
  const tvdb = [{ seasonNumber: 1, number: 1, aired: '2023-09-29' }, { seasonNumber: 1, number: 2, aired: '2023-10-06' }, { seasonNumber: 2, number: 1, aired: '2024-01-06' },
    { seasonNumber: 2, number: 2, aired: null }];
  const o = tvdbOrder(tmdb, tvdb);
  assert.deepEqual(o.get('1:3'), { season: 2, episode: 1 });
  assert.deepEqual(o.get('1:4'), { season: 2, episode: 2 }, 'no air date: after the one before');
  assert.equal(o.has('0:1'), false, 'specials keep TMDB\'s');
  assert.equal(tvdbOrder(tmdb.slice(0, 2), tvdb), null, 'the same order: nothing to change');
  assert.equal(tvdbOrder([{ season: 1, episode: 1, air: '2020-01-01' }], tvdb), null, 'an episode it can\'t place');
});
