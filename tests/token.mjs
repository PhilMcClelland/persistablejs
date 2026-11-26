// Tokens, run in Node against the real Worker code (tests/mock.mjs) through the real client (persistable.js) and the
// real helper (token.mjs). A site's token puts a visitor in a space and says who they are; nothing else gets in.
//   node tests/token.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { webcrypto, createHmac } from 'node:crypto';
import mock, { env, Socket, listen, stored } from './mock.mjs';
import { token, tokenResponse } from '../token.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
/* made up for the test: the store and the site are both this file */
const SECRET = 'made-up-for-this-test-' + 'x'.repeat(24), OTHER = 'y'.repeat(44), S = 'https://store.example', SPACE = 'review/acme';
const A_KEY = 'k'.repeat(24), BROWSER = 'Bearer ' + 'b'.repeat(24);
env.TOKEN_SECRET = SECRET;
const client = (opt, clock = Date) => {
  const ctx = { fetch: mock, console, crypto: webcrypto, atob, TextEncoder, Uint8Array, Math, JSON, Promise, Error, String, Array, Object, Date: clock, setTimeout, clearTimeout, setInterval, clearInterval, decodeURIComponent, encodeURIComponent,
    location: { origin: 'https://proto.example', href: 'https://proto.example/', hash: '' }, history: { state: null, replaceState() {} } };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(here, '..', 'persistable.js'), 'utf8'), ctx);
  return ctx.Persistable(Object.assign({ url: S, fetch: mock, WebSocket: null, storage: { getItem: () => null, setItem() {} } }, opt));
};
const as = (person, more) => client({ token: () => token(SECRET, Object.assign({ space: SPACE, person }, more)) });
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const refused = async (what, fn, code) => { let why = null; try { await fn(); } catch (e) { why = e; } if (why === null) throw new Error(what + ' was allowed'); if (why.status !== code) throw new Error(what + ' failed for the wrong reason: ' + why.message); };
const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
/* a token made by hand, so a test can get every part of it wrong */
const forge = (claim, { secret = SECRET, head = { alg: 'HS256', typ: 'JWT' }, sign = true } = {}) => {
  const body = b64(head) + '.' + b64(claim);
  return body + '.' + (sign ? createHmac('sha256', secret).update(body).digest('base64url') : '');
};
const now = () => Math.floor(Date.now() / 1000), pause = ms => new Promise(r => setTimeout(r, ms));
const good = more => Object.assign({ space: SPACE, sub: 'mallory', exp: now() + 300 }, more);
const at = (path, t, space = SPACE) => S + '/v1/s/' + encodeURIComponent(space) + '/' + path + (t == null ? '' : '?token=' + t);
const status = async (t, path = 'notes', space) => (await mock(at(path, t, space))).status;

const ada = as('ada', { name: 'Ada L.' }), ben = as('ben'), notes = db => db.collection('notes');
let made;
await step('before the first token nothing is known; after ready() the space and the name are', async () => {
  if (ada.readOnly !== false) throw new Error('readOnly before');
  await ada.ready(); const me = await ada.me(), again = await as('ada').me(), other = await ben.me();
  if (ada.space !== SPACE || me.name !== 'Ada L.' || ada.name !== 'Ada L.' || (await ben.ready()).name !== null || !/^[0-9a-f]{32}$/.test(me.id)) throw new Error(JSON.stringify({ space: ada.space, me }));
  if (again.id !== me.id || other.id === me.id || 'name' in other) throw new Error('the same person should be the same id, and another person another');
});
await step('a person writes, and another reads it', async () => { made = await notes(ada).create({ text: 'hello' }, { open: { done: false } }); const all = await notes(ben).list(); if (all.length !== 1 || all[0].owner !== (await ada.me()).id) throw new Error(JSON.stringify(all)); });
await step('the one rule holds: another person changes the open part, and not the words, and cannot delete', async () => {
  await notes(ben).setOpen(made.id, { done: true });
  await refused('changing the words', () => notes(ben).update(made.id, { text: 'defaced' }), 403);
  await refused('deleting', () => notes(ben).remove(made.id), 403);
  const one = await notes(ada).update(made.id, { text: 'hello again' }); if (one.data.text !== 'hello again' || one.open.done !== true) throw new Error(JSON.stringify(one));
});
await step('a Bearer secret sent along does not change who the person is', async () => {
  const t = await token(SECRET, { space: SPACE, person: 'ada' });
  const me = await (await mock(at('_me', t), { headers: { Authorization: BROWSER } })).json();
  if (me.id !== (await ada.me()).id) throw new Error('a different person');
});
await step('the space is its own: the same name with no token, a key or a read key is empty, and stores apart', async () => {
  for (const q of ['', '?k=' + A_KEY, '?r=' + A_KEY]) { const r = await mock(S + '/v1/s/' + encodeURIComponent(SPACE) + '/notes' + q), all = await r.json(); if (r.status !== 200 || all.length) throw new Error(q.slice(0, 2) + ' reached it: ' + JSON.stringify(all)); }
  if (!stored(SPACE + '\ntoken').some(k => k.startsWith('o:notes:'))) throw new Error('the notes are not where they should be');
  if (stored(SPACE).length) throw new Error('the open space of the same name holds something');
});
await step('headers a caller sends cannot stand in for a token', async () => {
  const h = { 'X-Persistable-Person': 'ada', 'X-Persistable-Admin': '1', 'X-Persistable-Until': String(now() + 300), 'X-Persistable-Read': '1', Authorization: BROWSER };
  const r = await mock(at('_collections'), { headers: h }); if (r.status !== 403) throw new Error('became the owner: ' + r.status);
  const w = await mock(at('probe'), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: '{"data":{}}' }); if (w.status !== 201) throw new Error('a made-up read header stopped a write in the open space: ' + w.status);
  const t = await token(SECRET, { space: SPACE, person: 'ben' });
  const me = await (await mock(at('_me', t), { headers: h })).json(); if (me.id !== (await ben.me()).id) throw new Error('a header changed who ben is');
  const r2 = await mock(at('notes/' + made.id, t), { method: 'DELETE', headers: h }); if (r2.status !== 403) throw new Error('a header made ben the owner: ' + r2.status);
});
await step('a token that is not the site\'s is refused, whatever it says', async () => {
  const broken = b64({ alg: 'HS256' }) + '.' + b64('{');
  const cases = {
    'another secret': forge(good(), { secret: OTHER }),
    'no signature': forge(good(), { sign: false }) + 'AAAA',
    'alg none': forge(good(), { head: { alg: 'none' }, sign: false }),
    'alg none, signed': forge(good(), { head: { alg: 'none' } }),
    'alg HS512': forge(good(), { head: { alg: 'HS512' } }),
    'alg in other letters': forge(good(), { head: { alg: 'hs256' } }),
    'a changed payload': (t => { const p = t.split('.'); p[1] = b64(good({ sub: 'ada' })); return p.join('.'); })(forge(good())),
    'not a token': 'hello', 'two parts': 'a.b', 'four parts': forge(good()) + '.x', 'empty': '', 'very long': forge(good({ pad: 'x'.repeat(3000) })),
    'a payload that is not an object': forge([1, 2]), 'a payload that is not JSON': broken + '.' + createHmac('sha256', SECRET).update(broken).digest('base64url')
  };
  for (const [name, t] of Object.entries(cases)) { const s = await status(t); if (s !== 401) throw new Error(name + ': ' + s); }
});
await step('a token has to say when it ends, and soon', async () => {
  const cases = { 'no exp': good({ exp: undefined }), 'exp as text': good({ exp: String(now() + 300) }), 'run out': good({ exp: now() - 1 }), 'two hours': good({ exp: now() + 7200 }), 'not yet good': good({ nbf: now() + 600 }), 'no person': good({ sub: undefined }), 'an empty person': good({ sub: '' }),
    'a person that is not text': good({ sub: 7 }), 'a very long person': good({ sub: 'p'.repeat(201) }), 'read as text': good({ read: 'true' }), 'owner as a number': good({ owner: 1 }) };
  for (const [name, c] of Object.entries(cases)) { const s = await status(forge(c)); if (s !== 401) throw new Error(name + ': ' + s); }
  const half = b64({ alg: 'HS256' }) + '.' + b64('{"space":"' + SPACE + '","exp":' + (now() + 300) + ',"sub":"a\\ud800"}');
  if (await status(half + '.' + createHmac('sha256', SECRET).update(half).digest('base64url')) !== 401) throw new Error('half a character was taken as a person');
  if (await status(forge(good({ exp: now() + 3600 }))) !== 200) throw new Error('an hour was refused');
});
await step('a token for one space does not open another', async () => {
  const t = await token(SECRET, { space: 'review/other', person: 'ada' });
  if (await status(t) !== 403) throw new Error('reached ' + SPACE);
  if (await status(forge(good({ space: undefined }))) !== 403 || await status(forge(good({ space: [SPACE] }))) !== 403) throw new Error('a token with no space was taken');
  const all = await (await mock(at('notes', t, 'review/other'))).json(); if (all.length) throw new Error('the other space is not empty');
});
await step('a token and a key together, or two tokens, are refused', async () => {
  const t = await token(SECRET, { space: SPACE, person: 'ada' });
  for (const more of ['&k=' + A_KEY, '&r=' + A_KEY, '&token=' + t]) { const r = await mock(at('notes', t) + more); if (r.status !== 400) throw new Error(more.slice(0, 6) + ': ' + r.status); }
});
await step('a token that only reads: sees everything, changes nothing', async () => {
  const reader = as('rita', { read: true }); await reader.ready(); if (!reader.readOnly) throw new Error('readOnly is false');
  if ((await notes(reader).list()).length !== 1) throw new Error('could not read');
  await refused('adding', () => notes(reader).create({ text: 'x' }), 403);
  await refused('changing the open part', () => notes(reader).setOpen(made.id, { done: false }), 403);
  await refused('deleting', () => notes(reader).remove(made.id), 403);
});
await step('the owner\'s token: lists collections, deletes anyone\'s object, needs no person', async () => {
  const t = await token(SECRET, { space: SPACE, owner: true });
  const cols = await (await mock(at('_collections', t))).json(); if (cols.join() !== 'notes') throw new Error(JSON.stringify(cols));
  const extra = await notes(ben).create({ text: 'to go' });
  const r = await mock(at('notes/' + extra.id, t), { method: 'DELETE' }); if (r.status !== 204) throw new Error('delete: ' + r.status);
  if ((await mock(at('_collections', await token(SECRET, { space: SPACE, person: 'ben' })))).status !== 403) throw new Error('a visitor listed collections');
});
await step('a listener that came with a token hears nothing once it has run out, and gives its place back', async () => {
  const short = forge(good({ sub: 'lena', exp: now() + 2 })), ws = await listen(at('_watch', short) + '&feed=2');
  if (ws.refused) throw new Error('refused: ' + ws.refused);
  await notes(ada).setOpen(made.id, { n: 1 }); await pause(20);
  if (ws.heard.length !== 1) throw new Error('heard ' + ws.heard.length + ' while the token was good');
  await pause(2100);
  await notes(ada).setOpen(made.id, { n: 2 }); await pause(20);
  if (ws.heard.length !== 1 || !ws.closed || ws.closed.code !== 4001) throw new Error('heard ' + ws.heard.length + ', closed ' + JSON.stringify(ws.closed));
});
await step('the client watches through its token, and hears a change', async () => {
  const eve = client({ WebSocket: Socket, token: () => token(SECRET, { space: SPACE, person: 'eve' }) }), heard = [];
  const stop = eve.collection('notes').subscribe({ onUpdate: o => heard.push(o) });
  await pause(30); await notes(ada).setOpen(made.id, { n: 3 }); await pause(30); stop();
  if (heard.length !== 1 || heard[0].open.n !== 3) throw new Error(JSON.stringify(heard));
});
await step('the client asks for a new token when the old one is nearly out, and once more when the store says 401', async () => {
  let asked = 0;
  const db = client({ token: () => { asked++; return forge(good({ sub: 'una', iat: now() - 590, exp: now() + (asked === 1 ? 10 : 300) })); } });
  await db.me(); await db.me(); await db.me(); if (asked !== 1) throw new Error('asked ' + asked + ' times; a token is kept until shortly before it runs out');
  const brief = client({ token: () => { asked++; return forge(good({ sub: 'una', iat: now(), exp: now() + 6 })); } }); asked = 0;
  await brief.me(); await pause(4700); await brief.me(); if (asked !== 2) throw new Error('asked ' + asked + ' times; a token in its last quarter should be renewed');
  let n = 0; const stale = client({ token: () => (++n === 1 ? forge(good(), { secret: OTHER }) : forge(good())) });
  await stale.me(); if (n !== 2) throw new Error('asked ' + n);
  let m = 0; const never = client({ token: () => { m++; return forge(good(), { secret: OTHER }); } });
  await refused('a token the store will not take', () => never.me(), 401); if (m !== 2) throw new Error('asked ' + m + ' times, expected 2');
});
await step('a browser whose clock is ten minutes fast still keeps a token for as long as it is good', async () => {
  class Fast extends Date { static now() { return Date.now() + 600000; } }
  let asked = 0; const db = client({ token: () => { asked++; return token(SECRET, { space: SPACE, person: 'vic' }); } }, Fast);
  for (let i = 0; i < 5; i++) await db.me(); if (asked !== 1) throw new Error('asked ' + asked + ' times for five calls');
  let short = 0; const quick = client({ token: () => { short++; return token(SECRET, { space: SPACE, person: 'vic', seconds: 60 }); } });
  for (let i = 0; i < 5; i++) await quick.collection('notes').list(); if (short !== 1) throw new Error('a one-minute token was asked for ' + short + ' times in five calls');
});
await step('a token for another space is never used: the one in hand serves while it is good, then calls fail until the site says the first space again', async () => {
  let n = 0; const db = client({ token: () => { n++; return forge(good({ space: n === 2 || n === 3 ? 'review/other' : SPACE, iat: now(), exp: now() + 6 })); } });
  await db.me(); await pause(4700);
  await db.me(); if (n !== 2) throw new Error('asked ' + n + ' times; a token in its last quarter should be renewed');
  await pause(2300);   // the first token has run out, and the site has had its rest
  let why = null; try { await db.me(); } catch (e) { why = e; } if (!why || !/another space/.test(why.message) || n !== 3) throw new Error('expected a refusal on the third token, asked ' + n);
  await pause(4200); await db.me(); if (n !== 4) throw new Error('asked ' + n + ' times; the site was not asked again');
});
await step('a site that keeps saying no is asked less and less often, however often the page calls', async () => {
  let n = 0; const out = client({ token: () => { n++; return Promise.reject(Object.assign(new Error('signed out'), { status: 401 })); } });
  for (let i = 0; i < 30; i++) { await out.me().catch(() => {}); await pause(100); }
  if (n > 2) throw new Error('asked ' + n + ' times in three seconds');
  let m = 0; const once = client({ token: () => (++m === 1 ? forge(good(), { secret: OTHER }) : forge(good())) });
  await Promise.all([once.me(), once.me(), once.me(), once.me(), once.me()]); if (m !== 2) throw new Error('five calls refused together asked for ' + m + ' tokens');
});
await step('what the site hands back goes into an address only if it is a token, and a site that never answers is not waited on', async () => {
  const tail = client({ token: async () => (await token(SECRET, { space: SPACE, person: 'wes' })) + '&all=1#x' }); let why = null;
  try { await tail.me(); } catch (e) { why = e; } if (!why || !/did not return a token/.test(why.message)) throw new Error('sent something after the token');
  if ((await mock(at('notes') + '?token=123')).status !== 401 || (await mock(at('notes') + '?t=123')).status !== 200 || (await status(forge(good({ nbf: 'later' })))) !== 401) throw new Error('a token that is not one (or a plain ?t= was no longer let by), or an nbf that is not a number, was let by');
});
await step('a renewal that fails leaves every waiting call the token in hand, while it is good', async () => {
  let n = 0; const db = client({ token: () => (++n === 1 ? forge(good({ iat: now(), exp: now() + 8 })) : Promise.reject(new Error('site hiccup'))) });
  await db.me(); await pause(6300);
  const got = await Promise.allSettled([db.me(), db.me(), db.ready(), db.collection('notes').list()]);
  if (got.some(g => g.status !== 'fulfilled')) throw new Error(JSON.stringify(got.map(g => g.status)));
});
await step('a store that refuses the site\'s tokens is not asked, nor the site, for every call', async () => {
  let n = 0; const db = client({ token: () => { n++; return forge(good(), { secret: OTHER }); } });
  for (let i = 0; i < 80; i++) { await db.me().catch(() => {}); await pause(100); }
  if (n > 6) throw new Error('the site was asked ' + n + ' times in eight seconds: twice at 0, 2 and 6 seconds is the most, as the rest grows');
  const one = forge(good({ exp: now() + 3000 }), { secret: OTHER }); let k = 0; const same = client({ token: () => { k++; return one; } });
  for (let i = 0; i < 80; i++) { await same.me().catch(() => {}); await pause(100); }
  if (k > 6) throw new Error('a site that hands back the same refused token was asked ' + k + ' times in eight seconds');
  let m = 0, right = false; const six = client({ token: () => { m++; return forge(good(), right ? {} : { secret: OTHER }); } });
  await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => six.collection('notes').list())); right = true; await pause(2300);
  await six.me();   // six calls refused together are one refusal: the rest is the short first one
});
await step('what the page is told follows the latest token, and a token option with nothing in it is refused', async () => {
  let n = 0; const db = client({ token: () => (++n === 1 ? forge(good({ name: 'Ada', iat: now(), exp: now() + 6 })) : forge(good({ read: true }))) });
  if (db.name !== null || db.readOnly !== false) throw new Error('before: ' + db.name + ' ' + db.readOnly);
  await db.ready(); if (db.name !== 'Ada' || db.readOnly || db.space !== SPACE) throw new Error('first: ' + db.name + ' ' + db.readOnly);
  await pause(4700); await db.me(); if (db.name !== null || db.readOnly !== true) throw new Error('later: ' + db.name + ' ' + db.readOnly);
  env.TOKEN_SECRET = OTHER; await pause(200); await db.me().catch(() => {}); env.TOKEN_SECRET = SECRET;
  if (db.readOnly !== true || db.space !== SPACE) throw new Error('after the store refused: readOnly ' + db.readOnly);
  let why = null; try { client({ token: undefined }); } catch (e) { why = e; } if (!why) throw new Error('token: undefined made an open client');
});
await step('a page waiting to hear the store is back does hear, after a time with no token to ask with', async () => {
  let ok = false, n = 0; const db = client({ token: () => { n++; return ok ? forge(good()) : Promise.reject(new Error('offline')); }, fetch: (u, i) => (ok ? mock(u, i) : Promise.reject(new Error('offline'))) }), heard = [];
  ok = true; await db.me(); ok = false; const stop = db.onStatus(up => heard.push(up));
  await db.collection('notes').list().catch(() => {});
  await db.me().catch(() => {});
  ok = true; await pause(11500); stop();
  if (heard[heard.length - 1] !== true) throw new Error('heard ' + JSON.stringify(heard) + ' after ' + n + ' token requests');
});
await step('many calls at once share one request for a token', async () => {
  let asked = 0; const db = client({ token: async () => { asked++; await pause(10); return forge(good()); } });
  await Promise.all([db.me(), db.collection('notes').list(), db.ready(), db.me()]); if (asked !== 1) throw new Error('asked ' + asked + ' times');
});
await step('when the site says no, every call says so and keeps the site\'s status', async () => {
  const out = client({ token: () => Promise.reject(Object.assign(new Error('not let in'), { status: 403 })) });
  await refused('reading', () => out.collection('notes').list(), 403);
  let why = null; try { await out.ready(); } catch (e) { why = e; } if (!why || why.status !== 403) throw new Error('ready() resolved');
  const junk = client({ token: () => '<html>sign in</html>' }); why = null; try { await junk.me(); } catch (e) { why = e; } if (!why || !/did not return a token/.test(why.message)) throw new Error('took a page for a token');
});
await step('the option is refused where it cannot be kept', async () => {
  const bad = fn => { try { fn(); } catch (e) { return e.message; } throw new Error('allowed'); };
  bad(() => client({ token: 'abc' })); bad(() => client({ token: () => '', key: 'link' })); bad(() => client({ token: () => '', read: A_KEY })); bad(() => client({ token: () => '', space: 'mine' }));
  if (!/takes no tokens/.test(bad(() => client({ token: () => '', store: () => ({ me() {}, list() {}, get() {}, create() {}, patch() {}, remove() {} }) })))) throw new Error('a store with no tokens took one');
});
await step('the helper: refuses what the store would, and its answer is not to be kept by any cache', async () => {
  const no = async c => { try { await token(SECRET, c); } catch (_) { return; } throw new Error('made a token for ' + JSON.stringify(c)); };
  await no({ space: SPACE }); await no({ person: 'a' }); await no({ space: SPACE, person: 'a', seconds: 7200 }); await no({ space: SPACE, person: '' });
  await no({ space: SPACE, owner: true, read: true }); try { await token(SECRET, null); throw new Error('made a token from nothing'); } catch (e) { if (!/^token: /.test(e.message)) throw e; }
  await no({ space: '..', person: 'a' }); await no({ space: SPACE, person: 'a', readOnly: true }); await no({ space: 'https://app.example/group', person: 'a' }); await no({ space: SPACE, person: 'a', name: { a: 1 } });
  if (/\ud83d$/.test(JSON.parse(Buffer.from((await token(SECRET, { space: SPACE, person: 'a', name: 'a' + '😀'.repeat(90) })).split('.')[1], 'base64url')).name)) throw new Error('a name was cut through a character');
  await no({ space: SPACE, person: 'a', seconds: 0.5 }); await no({ space: SPACE, person: 'a', seconds: 30 }); await no({ space: SPACE, person: 'a', owner: 'false' }); await no({ space: SPACE, person: 'a', read: 1 }); await no({ space: SPACE, person: 'a\ud800' });
  if ((await status(await token(SECRET, { space: SPACE, person: '好'.repeat(200), name: '好'.repeat(200) }))) !== 200) throw new Error('the longest token the helper makes is refused by the store');
  try { await token('short', { space: SPACE, person: 'a' }); throw new Error('took a short secret'); } catch (e) { if (!/32 characters/.test(e.message)) throw e; }
  const r = await tokenResponse(SECRET, { space: SPACE, person: 'a' }); if (!/no-store/.test(r.headers.get('Cache-Control')) || (await status(await r.text())) !== 200) throw new Error('bad answer');
  const named = await tokenResponse(SECRET, { space: SPACE, person: 'zoë', name: 'Zoë 好' }), z = client({ token: () => named.clone().text() });
  if ((await z.me()).name !== 'Zoë 好') throw new Error('a name outside plain letters did not survive');
});
await step('a store with no TOKEN_SECRET, or a short one, takes no token', async () => {
  const t = await token(SECRET, { space: SPACE, person: 'ada' });
  for (const v of [undefined, '', 'too-short']) { env.TOKEN_SECRET = v; const s = await status(v ? forge(good(), { secret: v }) : t); if (s !== 403) throw new Error(JSON.stringify(v) + ': ' + s); }
  env.TOKEN_SECRET = SECRET;
});
console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
