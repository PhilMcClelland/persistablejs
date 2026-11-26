// The Worker's limits, run in Node against the real Worker code (tests/mock.mjs). What the happy-path verify does not cover:
// sizes are bytes, the open part has a limit of its own, a long family deletes, a full collection refuses.
//   node tests/limits.mjs
import mock, { env } from './mock.mjs';
const base = 'https://mock.invalid/v1/s/' + encodeURIComponent('limits-' + Date.now()) + '/';
const as = who => ({ Authorization: 'Bearer ' + who.padEnd(16, 'x'), 'Content-Type': 'application/json' });
const call = async (who, method, path, body) => { const r = await mock(base + path, { method, headers: as(who), body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }; };
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const want = (got, status, what) => { if (got.status !== status) throw new Error(what + ': expected ' + status + ', got ' + got.status + ' ' + JSON.stringify(got.body)); };

await step('a size is bytes as stored, not characters', async () => {
  want(await call('ada', 'POST', 'big', { data: { text: 'é'.repeat(60000) } }), 413, '60,000 two-byte characters (120 KB)');
  want(await call('ada', 'POST', 'big', { data: { text: 'e'.repeat(60000) } }), 201, '60,000 one-byte characters');
});
await step('the open part has a small limit of its own, at create and at change', async () => {
  want(await call('ada', 'POST', 'pad', { id: 'a', data: { text: 'mine' } }), 201, 'create');
  want(await call('ben', 'PATCH', 'pad/a', { open: { junk: 'x'.repeat(9000) } }), 413, 'a stranger padding open past 8 KB');
  want(await call('ben', 'PATCH', 'pad/a', { open: { tick: true } }), 200, 'a small change to open');
  want(await call('ben', 'POST', 'pad', { data: {}, open: { junk: 'x'.repeat(9000) } }), 413, 'creating with a large open part');
});
await step('padding open cannot lock the author out of their own words', async () => {
  want(await call('ben', 'PATCH', 'pad/a', { open: { junk: 'x'.repeat(7000) } }), 200, 'a stranger filling open to its limit');
  want(await call('ada', 'PATCH', 'pad/a', { data: { text: 'y'.repeat(90000) } }), 200, 'the author writing 90 KB of their own');
});
await step('a note with 300 replies deletes, replies and all', async () => {
  want(await call('ada', 'POST', 'fam', { id: 'root', data: {} }), 201, 'create');
  for (let i = 0; i < 300; i++) want(await call('ben', 'POST', 'fam', { id: 'c' + i, parent: 'root', data: {} }), 201, 'reply ' + i);
  want(await call('ada', 'DELETE', 'fam/root'), 204, 'delete');
  const left = await call('ada', 'GET', 'fam'); if (left.body.length) throw new Error(left.body.length + ' objects left behind');
});
await step('a full collection refuses the next object', async () => {
  for (let i = 0; i < 2000; i++) { const r = await call('ada', 'POST', 'full', { id: 'n' + i, data: {} }); if (r.status !== 201) throw new Error('object ' + i + ': ' + r.status); }
  want(await call('ada', 'POST', 'full', { data: {} }), 409, 'object 2001');
});
await step('a size is measured as stored: a short body that stands for a long value is refused', async () => {
  want(await call('ada', 'POST', 'num', { data: { n: Array(15000).fill(1e20) } }), 413, 'numbers that are longer stored than sent');
});
await step('a body that does not say how long it is is still cut off at the limit', async () => {
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10000))); c.close(); } });
  const r = await mock(base + 'stream', { method: 'POST', headers: as('ada'), body: stream, duplex: 'half' });
  if (r.status !== 413) throw new Error('expected 413, got ' + r.status);
});
await step('data nested too deep, or with a __proto__ key, is refused, and what is there stays readable', async () => {
  let deep = 1; for (let i = 0; i < 200; i++) deep = [deep];
  want(await call('ada', 'POST', 'shape', { data: { deep } }), 400, 'nested 200 deep');
  const r = await mock(base + 'shape', { method: 'POST', headers: as('ada'), body: '{"data":{"__proto__":{"admin":true}}}' });
  if (r.status !== 400) throw new Error('__proto__: expected 400, got ' + r.status);
  want(await call('ada', 'POST', 'shape', { data: { ok: [[[1]]] } }), 201, 'ordinary nesting');
  want(await call('ada', 'GET', 'shape'), 200, 'list');
});
await step('data and open nest at most 32 deep, counting the part itself as the first level', async () => {
  /* levels(n): n objects one inside the next, the innermost holding a plain value */
  const levels = n => { let v = { leaf: 1 }; for (let i = 1; i < n; i++) v = { in: v }; return v; };
  want(await call('ada', 'POST', 'depth', { id: 'a', data: levels(32) }), 201, 'data 32 deep');
  want(await call('ada', 'POST', 'depth', { data: levels(33) }), 400, 'data 33 deep');
  want(await call('ada', 'PATCH', 'depth/a', { open: levels(32) }), 200, 'open 32 deep');
  want(await call('ada', 'PATCH', 'depth/a', { open: levels(33) }), 400, 'open 33 deep');
  want(await call('ada', 'PATCH', 'depth/a', { data: { list: levels(31) } }), 200, 'a value 31 deep inside data');
  want(await call('ada', 'PATCH', 'depth/a', { data: { list: levels(32) } }), 400, 'a value 32 deep inside data');
});
await step('a collection has a size in bytes, and refuses what would pass it', async () => {
  const blob = 'y'.repeat(95000);
  for (let i = 0; i < 176; i++) { const r = await call('ada', 'POST', 'heavy', { id: 'h' + i, data: { blob } }); if (r.status !== 201) throw new Error('object ' + i + ': ' + r.status); }
  want(await call('ada', 'POST', 'heavy', { data: { blob } }), 409, 'the object that passes 16 MB');
  want(await call('ada', 'DELETE', 'heavy/h0'), 204, 'delete one');
  want(await call('ada', 'POST', 'heavy', { data: { blob } }), 201, 'there is room again');
});
await step('a space takes a limited number of collections', async () => {
  const other = base.replace('limits-', 'cols-');
  const post = async name => (await mock(other + name, { method: 'POST', headers: as('ada'), body: '{"data":{}}' })).status;
  for (let i = 0; i < 50; i++) { const s = await post('c' + i); if (s !== 201) throw new Error('collection ' + i + ': ' + s); }
  if (await post('one-too-many') !== 409) throw new Error('collection 51 was allowed');
  if (await post('c3') !== 201) throw new Error('an existing collection stopped taking objects');
});
await step('the owner, with ADMIN_SECRET, can delete a stranger\'s object, list collections and clear one; nobody else can', async () => {
  env.ADMIN_SECRET = 'an-admin-secret-of-24-chars-or-more';
  const admin = { Authorization: 'Bearer ' + env.ADMIN_SECRET, 'Content-Type': 'application/json' };
  want(await call('ben', 'POST', 'abuse', { id: 'spam', data: { text: 'spam' } }), 201, 'a stranger adds');
  want(await call('ada', 'DELETE', 'abuse/spam'), 403, 'someone else deleting it');
  want(await call('ada', 'DELETE', 'abuse'), 403, 'someone else clearing the collection');
  want(await call('ada', 'GET', '_collections'), 403, 'someone else listing collections');
  const forged = await mock(base + 'abuse/spam', { method: 'DELETE', headers: Object.assign({ 'X-Persistable-Admin': '1' }, as('ada')) });
  if (forged.status !== 403) throw new Error('a forged admin header was believed: ' + forged.status);
  const gone = await mock(base + 'abuse/spam', { method: 'DELETE', headers: admin }); if (gone.status !== 204) throw new Error('the owner could not delete: ' + gone.status);
  const cols = await (await mock(base + '_collections', { headers: admin })).json(); if (!cols.includes('heavy')) throw new Error('collections: ' + JSON.stringify(cols));
  const unsaid = await mock(base + 'heavy', { method: 'DELETE', headers: admin }); if (unsaid.status !== 400) throw new Error('clearing without ?all=1: ' + unsaid.status);
  if (!(await call('ada', 'GET', 'heavy')).body.length) throw new Error('the collection was cleared without ?all=1');
  const clear = await mock(base + 'heavy?all=1', { method: 'DELETE', headers: admin }); if (clear.status !== 204) throw new Error('clear: ' + clear.status);
  const left = await call('ada', 'GET', 'heavy'); if (left.body.length) throw new Error(left.body.length + ' left after clearing');
  delete env.ADMIN_SECRET;
  const after = await mock(base + 'abuse', { method: 'DELETE', headers: admin }); if (after.status !== 403) throw new Error('with no ADMIN_SECRET set, the old one still worked');
});
await step('an emptied collection gives its place back, so nobody can use the places up and leave', async () => {
  const other = base.replace('limits-', 'churn-');
  const go = async (method, path, body) => (await mock(other + path, { method, headers: as('eve'), body })).status;
  for (let i = 0; i < 60; i++) { if (await go('POST', 'c' + i, '{"id":"x","data":{}}') !== 201) throw new Error('collection ' + i + ' was refused'); if (await go('DELETE', 'c' + i + '/x') !== 204) throw new Error('delete ' + i); }
  if (await go('POST', 'votes', '{"data":{}}') !== 201) throw new Error('the space stayed full after being emptied');
});
await step('each part has its own limit: nearly-full data with a nearly-full open part is accepted', async () => {
  want(await call('ada', 'POST', 'parts', { data: { text: 'd'.repeat(99000) }, open: { text: 'o'.repeat(7900) } }), 201, '99 KB of data with 7.9 KB open');
});
await step('an id is a string or nothing; a change says what it changes', async () => {
  const none = await call('ada', 'POST', 'ids', { id: null, data: {} }); want(none, 201, 'id: null'); if (none.body.id === 'null') throw new Error('null became the id "null"');
  want(await call('ada', 'POST', 'ids', { id: ['a'], data: {} }), 400, 'an array as an id');
  want(await call('ada', 'POST', 'ids', { id: 'a', data: {} }), 201, 'create');
  const before = (await call('ada', 'GET', 'ids/a')).body.updated;
  want(await call('ben', 'PATCH', 'ids/a', {}), 400, 'a change that changes nothing');
  if ((await call('ada', 'GET', 'ids/a')).body.updated !== before) throw new Error('an empty change moved the time');
});
await step('the owner\'s secret can be long, and the owner can remove a whole space', async () => {
  env.ADMIN_SECRET = 's'.repeat(256);
  const admin = { Authorization: 'Bearer ' + env.ADMIN_SECRET, 'Content-Type': 'application/json' }, space = base.slice(0, -1);
  want(await call('ben', 'POST', 'long', { id: 'spam', data: {} }), 201, 'a stranger adds');
  const one = await mock(base + 'long/spam', { method: 'DELETE', headers: admin }); if (one.status !== 204) throw new Error('the owner could not delete with a long secret: ' + one.status);
  const stranger = await mock(space, { method: 'DELETE', headers: as('ben') }); if (stranger.status !== 403) throw new Error('a stranger removing the space: ' + stranger.status);
  const looked = await mock(space); if (looked.status !== 405) throw new Error('reading a bare space address: ' + looked.status);
  const unsaid = await mock(space, { method: 'DELETE', headers: admin }); if (unsaid.status !== 400) throw new Error('removing the space without ?all=1: ' + unsaid.status);
  if (!(await call('ada', 'GET', 'pad')).body.length) throw new Error('the space was removed without ?all=1');
  const all = await mock(space + '?all=1', { method: 'DELETE', headers: admin }); if (all.status !== 204) throw new Error('the owner removing the space: ' + all.status);
  for (const c of ['pad', 'full', 'ids']) { const left = await call('ada', 'GET', c); if (left.body.length) throw new Error(c + ' still holds ' + left.body.length); }
  want(await call('ada', 'POST', 'pad', { data: {} }), 201, 'the space takes objects again');
  delete env.ADMIN_SECRET;
});
console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll limit checks passed.');
process.exit(failed ? 1 : 0);
