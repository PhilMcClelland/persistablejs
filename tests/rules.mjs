// The Worker's rules about addresses, who is who, what listeners hear and which sites may call, run in Node against the
// real Worker code (tests/mock.mjs, which stands in for Cloudflare's storage and sockets).
//   node tests/rules.mjs
import { createHash } from 'node:crypto';
import mock, { env, listen, stored } from './mock.mjs';
const stamp = Date.now(), name = what => what + '-' + stamp, to = (space, path) => 'https://mock.invalid/v1/s/' + encodeURIComponent(space) + (path === undefined ? '' : '/' + path);
const SECRETS = { ada: 'ada-secret-0123456789', ben: 'ben-secret-0123456789' }, ADMIN = 'an-admin-secret-of-24-chars-or-more';
const as = who => ({ Authorization: 'Bearer ' + (SECRETS[who] || who), 'Content-Type': 'application/json' });
const call = async (who, method, url, body) => { const r = await mock(url, { method, headers: who ? as(who) : {}, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }; };
let failed = 0;
const step = async (title, fn) => { try { await fn(); console.log('  ok   ' + title); } catch (e) { failed++; console.log('  FAIL ' + title + '\n       ' + e.message); } };
const want = (got, status, what) => { if (got.status !== status) throw new Error(what + ': expected ' + status + ', got ' + got.status + ' ' + JSON.stringify(got.body)); };
const settle = () => new Promise(r => setTimeout(r, 5));   // what was sent down a socket has arrived
const said = s => s.heard.map(m => (m.charAt(0) === '{' ? JSON.parse(m) : m));
env.ADMIN_SECRET = ADMIN;

const paths = name('paths');
await step('an address with an empty part or a slash on the end is refused, so a lost id cannot widen a delete', async () => {
  for (const id of ['a', 'b']) want(await call('ada', 'POST', to(paths, 'votes'), { id, data: {} }), 201, 'create ' + id);
  const base = to(paths);
  for (const url of [base + '/votes/', base + '/votes/?all=1', base + '/', base + '//', base + '//?all=1', base + '/votes//a', base + '//votes', base + '/votes/a/', base + '/votes/..', base + '/votes/a/..', base + '/votes/a/..?all=1', 'https://mock.invalid//v1/s/' + paths + '/votes'])
    want(await call(ADMIN, 'DELETE', url), 404, 'the owner, DELETE ' + url);
  want(await call(null, 'GET', base + '/votes/'), 404, 'GET with a slash on the end');
  const left = await call(null, 'GET', to(paths, 'votes')); if (left.body.length !== 2) throw new Error('something was deleted: ' + JSON.stringify(left.body));
});
await step('the two wide deletes have to say ?all=1, whoever asks', async () => {
  want(await call(ADMIN, 'DELETE', to(paths, 'votes')), 400, 'the owner clearing a collection without it');
  want(await call(ADMIN, 'DELETE', to(paths, 'votes') + '?all=yes'), 400, 'all=yes');
  want(await call(ADMIN, 'DELETE', to(paths)), 400, 'the owner removing a space without it');
  want(await call('ada', 'DELETE', to(paths, 'votes') + '?all=1'), 403, 'a stranger clearing a collection with it');
  want(await call('ada', 'DELETE', to(paths) + '?all=1'), 403, 'a stranger removing a space with it');
  if ((await call(null, 'GET', to(paths, 'votes'))).body.length !== 2) throw new Error('something was deleted');
  want(await call(ADMIN, 'DELETE', to(paths, 'votes/a')), 204, 'the owner deleting one object, which needs no ?all=1');
  want(await call(ADMIN, 'DELETE', to(paths, 'votes') + '?all=1'), 204, 'the owner clearing a collection with it');
  if ((await call(null, 'GET', to(paths, 'votes'))).body.length) throw new Error('the collection was not cleared');
});
await step('a method an address does not take is answered 405, the same way everywhere', async () => {
  want(await call('ada', 'POST', to(paths, 'votes'), { id: 'a', data: {} }), 201, 'create');
  const tries = [['PUT', 'votes'], ['PATCH', 'votes'], ['PUT', 'votes/a'], ['POST', 'votes/a'], ['POST', 'votes/missing'], ['PUT', undefined], ['GET', undefined], ['POST', undefined], ['POST', '_me'], ['DELETE', '_me'], ['POST', '_collections'], ['DELETE', '_watch'], ['HEAD', 'votes']];
  const words = new Set();
  for (const [method, path] of tries) { const r = await call('ada', method, to(paths, path), method === 'HEAD' || method === 'GET' || method === 'DELETE' ? undefined : {}); want(r, 405, method + ' ' + (path || '(the space)')); if (method !== 'HEAD') words.add(r.body.message); }
  if (words.size !== 1) throw new Error('405 is said ' + words.size + ' ways: ' + [...words].join(' | '));
  want(await call(ADMIN, 'PUT', to(paths, 'votes'), {}), 405, 'the owner, PUT');
  want(await call('ada', 'GET', to(paths, '_me/extra')), 404, 'something after _me');
});

const who1 = name('who-1'), who2 = name('who-2');
await step('owner is a fingerprint keyed by the space: the same secret is someone else in another space', async () => {
  const a = (await call('ada', 'GET', to(who1, '_me'))).body.id, again = (await call('ada', 'GET', to(who1, '_me'))).body.id, b = (await call('ada', 'GET', to(who2, '_me'))).body.id;
  if (!/^[0-9a-f]{32}$/.test(a) || !/^[0-9a-f]{32}$/.test(b)) throw new Error('not 32 hex characters: ' + a + ' ' + b);
  if (a !== again) throw new Error('one secret was two people in one space');
  if (a === b) throw new Error('the same owner in two spaces');
  if (a === createHash('sha256').update(SECRETS.ada).digest('hex').slice(0, 32)) throw new Error('owner is the plain hash of the secret, which anyone can test guesses against');
  const made = (await call('ada', 'POST', to(who1, 'notes'), { id: 'n', data: {} })).body; if (made.owner !== a) throw new Error('owner on a new object is not what _me says');
  want(await call('ben', 'PATCH', to(who1, 'notes/n'), { data: { x: 1 } }), 403, 'someone else changing its data');
  want(await call('ada', 'PATCH', to(who1, 'notes/n'), { data: { x: 1 } }), 200, 'its creator changing its data');
  want(await call('ben', 'DELETE', to(who1, 'notes/n')), 403, 'someone else deleting it');
  if ((await call(ADMIN, 'GET', to(who1, '_me'))).body.id !== 'owner') throw new Error('the owner is not "owner"');
  want(await call('short', 'GET', to(who1, '_me')), 401, 'a secret under 16 characters');
});
await step('removing a space makes its people new: the value the fingerprint is keyed with goes with it', async () => {
  const before = (await call('ada', 'GET', to(who1, '_me'))).body.id;
  want(await call(ADMIN, 'DELETE', to(who1) + '?all=1'), 204, 'remove the space');
  if (stored(who1).length) throw new Error('left behind: ' + stored(who1));
  const after = (await call('ada', 'GET', to(who1, '_me'))).body.id; if (after === before) throw new Error('the same owner after the space was removed');
});
await step('reading keeps nothing, and nor does a refused request; a space emptied of its last collection keeps no list of them', async () => {
  const space = name('tidy');
  want(await call('ada', 'GET', to(space, 'notes')), 200, 'list'); want(await call('ada', 'GET', to(space, 'notes/x')), 404, 'get');
  if (stored(space).length) throw new Error('a read left something behind: ' + stored(space));
  /* nor does a request that is refused, or one that changes nothing */
  want(await call('ada', 'DELETE', to(space, 'notes') + '?all=1'), 403, 'a stranger clears'); want(await call('ada', 'DELETE', to(space) + '?all=1'), 403, 'a stranger removes the space');
  want(await call('ada', 'PATCH', to(space, 'notes/x'), { open: { a: 1 } }), 404, 'change nothing'); want(await call('ada', 'DELETE', to(space, 'notes/x')), 404, 'delete nothing'); want(await call('ada', 'POST', to(space, 'notes'), { id: 'kid', parent: 'none', data: {} }), 400, 'no such parent');
  want(await call(ADMIN, 'DELETE', to(space, 'notes') + '?all=1&all=0'), 400, 'all given twice');
  if (stored(space).length) throw new Error('a refused request left something behind: ' + stored(space));
  /* asking who you are does: it is what makes you the same person when you come back */
  const me1 = (await call('ada', 'GET', to(space, '_me'))).body.id, me2 = (await call('ada', 'GET', to(space, '_me'))).body.id;
  if (me1 !== me2 || stored(space).join() !== 'salt') throw new Error('_me: ' + me1 + ' ' + me2 + ' ' + stored(space));
  want(await call(ADMIN, 'DELETE', to(space) + '?all=1'), 204, 'start again');
  want(await call('ada', 'POST', to(space, 'notes'), { id: 'x', data: {} }), 201, 'create'); want(await call('ada', 'POST', to(space, 'other'), { id: 'y', data: {} }), 201, 'create');
  want(await call('ada', 'DELETE', to(space, 'notes/x')), 204, 'delete');
  if (stored(space).join() !== 'b:other,cols,n:other,o:other:y,salt') throw new Error('with one collection left: ' + stored(space));
  want(await call('ada', 'DELETE', to(space, 'other/y')), 204, 'delete');
  if (stored(space).join() !== 'salt') throw new Error('after the last collection went: ' + stored(space));
  if ((await call(ADMIN, 'GET', to(space, '_collections'))).body.length) throw new Error('collections are still listed');
});

const feed = name('feed'), ws = to(feed, '_watch').replace(/^http/, 'ws');
await step('a listener hears a create, an update and a delete, with the object while it is small', async () => {
  const full = await listen(ws + '?feed=2'), bare = await listen(ws);
  if (full.closed || bare.closed) throw new Error('refused: ' + full.refused + ' ' + bare.refused);
  want(await call('ada', 'POST', to(feed, 'notes'), { id: 'n', data: { text: 'hi' } }), 201, 'create');
  want(await call('ben', 'PATCH', to(feed, 'notes/n'), { open: { tick: true } }), 200, 'update');
  want(await call('ben', 'POST', to(feed, 'notes'), { id: 'kid', parent: 'n', data: {} }), 201, 'a child');
  want(await call('ada', 'DELETE', to(feed, 'notes/n')), 204, 'delete'); await settle();
  const got = said(full), ops = got.map(g => g.op + ' ' + g.id).join();
  if (ops !== 'create n,update n,create kid,delete kid,delete n') throw new Error('heard ' + ops);
  if (got[0].collection !== 'notes' || got[0].object.data.text !== 'hi' || got[1].object.open.tick !== true || 'object' in got[3]) throw new Error('wrong contents: ' + JSON.stringify(got));
  if (said(bare).join() !== 'notes,notes,notes,notes,notes') throw new Error('a plain listener heard ' + JSON.stringify(said(bare)));
  full.close(); bare.close();
});
await step('an object over 8 KB is left out of what listeners are sent, at create and at every change', async () => {
  const s = await listen(ws + '?feed=2');
  want(await call('ada', 'POST', to(feed, 'notes'), { id: 'small', data: { text: 'x'.repeat(7000) } }), 201, 'a 7 KB object');
  want(await call('ada', 'POST', to(feed, 'notes'), { id: 'big', data: { text: 'x'.repeat(90000) } }), 201, 'a 90 KB object');
  want(await call('ben', 'PATCH', to(feed, 'notes/big'), { open: { tick: true } }), 200, 'a 16-byte change to it'); await settle();
  const got = said(s);
  if (!got[0].object || got[0].object.data.text.length !== 7000) throw new Error('the small object was left out');
  if (got.length !== 3 || 'object' in got[1] || 'object' in got[2] || got[2].op !== 'update' || got[2].id !== 'big' || got[2].collection !== 'notes') throw new Error('heard ' + JSON.stringify(got).slice(0, 300));
  if (s.heard[2].length > 200) throw new Error('a small change sent ' + s.heard[2].length + ' bytes to each listener');
  s.close();
});
await step('a listener only listens: a ping is answered, anything else closes it', async () => {
  const s = await listen(ws + '?feed=2'), other = await listen(ws);
  s.send('ping'); await settle(); if (s.heard.join() !== 'pong' || s.closed) throw new Error('ping: heard ' + JSON.stringify(s.heard) + ', closed ' + JSON.stringify(s.closed));
  s.send('{"collection":"notes","op":"delete","id":"big"}'); await settle();
  if (!s.closed || s.closed.code !== 1008) throw new Error('still open after speaking: ' + JSON.stringify(s.closed));
  if (other.closed || other.heard.length) throw new Error('the other listener was touched: ' + JSON.stringify(other.heard));
  want(await call('ada', 'POST', to(feed, 'notes'), { id: 'after', data: {} }), 201, 'create'); await settle();
  if (s.heard.length !== 1 || other.heard.join() !== 'notes') throw new Error('after: ' + JSON.stringify([s.heard, other.heard]));
  other.close();
});
await step('a space takes 200 listeners and refuses the next; a place comes back when one leaves', async () => {
  const all = []; for (let i = 0; i < 200; i++) { const s = await listen(ws + '?feed=2'); if (s.closed) throw new Error('listener ' + i + ' was refused: ' + s.refused); all.push(s); }
  const extra = await listen(ws); if (extra.refused !== 429) throw new Error('listener 201: ' + extra.refused);
  want(await call('ada', 'POST', to(feed, 'notes'), { id: 'crowd', data: {} }), 201, 'create'); await settle();
  if (!all.every(s => s.heard.length === 1)) throw new Error('not every listener heard the change');
  all[0].close(); await settle();
  const next = await listen(ws); if (next.closed) throw new Error('no place after one left: ' + next.refused);
  want(await call('ada', 'POST', to(feed, '_watch'), {}), 405, 'POST to _watch'); want(await call('ada', 'GET', to(feed, '_watch')), 426, 'GET without a WebSocket');
  for (const s of all.slice(1).concat(next)) s.close();
});
await step('with the read key a listener hears the circle, and without the key hears nothing of it', async () => {
  const key = 'a-key-for-the-circle-0123456789', read = createHash('sha256').update('persistable read key\n' + key).digest('hex').slice(0, 40);
  const reader = await listen(ws + '?feed=2&r=' + read), outside = await listen(ws + '?feed=2');
  if (reader.closed) throw new Error('refused: ' + reader.refused);
  want(await call('ada', 'POST', to(feed, 'secret') + '?k=' + key, { id: 's', data: { text: 'ours' } }), 201, 'create'); await settle();
  const got = said(reader); if (got.length !== 1 || got[0].object.data.text !== 'ours') throw new Error('the reader heard ' + JSON.stringify(got));
  if (outside.heard.length) throw new Error('someone without the key heard ' + JSON.stringify(outside.heard));
  reader.send('anything'); await settle(); if (!reader.closed || reader.closed.code !== 1008) throw new Error('a reader that spoke stayed on');
  outside.close();
});
await step('the owner clearing a collection or removing the space is heard too', async () => {
  const s = await listen(ws + '?feed=2');
  want(await call(ADMIN, 'DELETE', to(feed, 'notes') + '?all=1'), 204, 'clear'); await settle();
  const got = said(s); if (got.length !== 1 || got[0].op !== 'clear' || got[0].collection !== 'notes') throw new Error('heard ' + JSON.stringify(got));
  want(await call(ADMIN, 'DELETE', to(feed) + '?all=1'), 204, 'remove the space'); await settle();
  if (!s.closed) throw new Error('the listener was left on a removed space');
});

await step('ALLOW_ORIGINS admits the origins it lists and a caller that names none; a file page says "null" and is turned away unless that is listed', async () => {
  const url = to(name('origins'), 'things'), from = async origin => (await mock(url, { headers: origin === undefined ? {} : { Origin: origin } })).status;
  const expect = async (origin, status, what) => { const got = await from(origin); if (got !== status) throw new Error(what + ': expected ' + status + ', got ' + got); };
  await expect('https://anyone.example', 200, 'with no list, any site');
  env.ALLOW_ORIGINS = 'https://proto.example, http://localhost:8000/';
  try {
    await expect('https://proto.example', 200, 'a listed origin');
    await expect('http://localhost:8000', 200, 'a listed origin written with a slash on the end');
    await expect('https://other.example', 403, 'an origin not listed');
    await expect('http://localhost:3000', 403, 'this machine on a port not listed');
    await expect('https://proto.example.evil.example', 403, 'an origin that starts like a listed one');
    await expect(undefined, 200, 'no Origin (a script or a command line)');
    await expect('null', 403, 'a file page or sandboxed frame');
    const post = await mock(url, { method: 'POST', headers: Object.assign({ Origin: 'https://other.example' }, as('ada')), body: '{"data":{}}' }); if (post.status !== 403) throw new Error('a write from an origin not listed: ' + post.status);
    env.ALLOW_ORIGINS = 'https://proto.example,null';
    await expect('null', 200, 'a file page once null is listed');
  } finally { delete env.ALLOW_ORIGINS; }
});
delete env.ADMIN_SECRET;
console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll rule checks passed.');
process.exit(failed ? 1 : 0);
