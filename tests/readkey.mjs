// The read key, run in Node against the real Worker code (tests/mock.mjs) through the real client (persistable.js).
// A key writes; its read key reads the same space and nothing else; neither can stand in for the other.
//   node tests/readkey.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import mock from './mock.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const client = (opt, hash, m = {}, noRandom = false) => {
  const ctx = { fetch: mock, console, crypto: noRandom ? undefined : webcrypto, TextEncoder, Uint8Array, Math, JSON, Promise, Error, String, Array, Object, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { origin: 'https://proto.example', href: 'https://proto.example/' + (hash || ''), hash: hash || '' }, history: { state: null, replaceState() {} } };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(here, '..', 'persistable.js'), 'utf8'), ctx);
  return ctx.Persistable(Object.assign({ url: 'https://store.example', space: 'readkey-test', fetch: mock, WebSocket: null, storage: { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } } }, opt));
};
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const refused = async (what, fn, code) => { let why = null; try { await fn(); } catch (e) { why = e; } if (why === null) throw new Error(what + ' was allowed'); if (why.status !== code) throw new Error(what + ' failed for the wrong reason: ' + why.message); };
const KEY = 'a-key-for-the-circle-0123456789';

const writer = client({ key: KEY }), read = await writer.readKey();
const reader = client({ read }), notes = writer.collection('notes'), seen = reader.collection('notes');
await step('the read key is 40 hex characters, and not the key', async () => { if (!/^[0-9a-f]{40}$/.test(read) || read === KEY) throw new Error('got ' + read); });
await step('someone with the key writes', async () => { await notes.create({ text: 'from the circle' }, { id: 'n1' }); });
await step('someone with the read key sees it', async () => { const all = await seen.list(); if (all.length !== 1 || all[0].data.text !== 'from the circle') throw new Error(JSON.stringify(all)); if (!reader.readOnly || writer.readOnly) throw new Error('readOnly is wrong'); });
await step('and cannot add, change, tick or delete', async () => {
  await refused('adding', () => seen.create({ text: 'from a stranger' }), 403);
  await refused('changing the words', () => seen.update('n1', { text: 'defaced' }), 403);
  await refused('changing the open part', () => seen.setOpen('n1', { hidden: true }), 403);
  await refused('deleting', () => seen.remove('n1'), 403);
  const all = await notes.list(); if (all.length !== 1 || all[0].data.text !== 'from the circle' || all[0].open.hidden) throw new Error('something got through: ' + JSON.stringify(all));
});
await step('the read key used as a key reaches a different, empty space', async () => { const all = await client({ key: read }).collection('notes').list(); if (all.length) throw new Error('reached the circle: ' + JSON.stringify(all)); });
await step('the key used as a read key reaches a different, empty space', async () => { const all = await client({ read: KEY }).collection('notes').list(); if (all.length) throw new Error('reached the circle: ' + JSON.stringify(all)); });
await step('no key at all reaches a different, empty space', async () => { const all = await client({}).collection('notes').list(); if (all.length) throw new Error('reached the circle: ' + JSON.stringify(all)); });
await step('both at once is refused', async () => { const r = await mock('https://store.example/v1/s/readkey-test/notes?k=' + KEY + '&r=' + read); if (r.status !== 400) throw new Error('status ' + r.status); });
await step('a page with a read key: a visitor with no link reads, and starts no circle', async () => { const v = client({ key: 'link', read }); if (!v.readOnly || v.key !== null || v.link() !== null) throw new Error('readOnly ' + v.readOnly + ', key ' + v.key); if ((await v.collection('notes').list()).length !== 1) throw new Error('did not see the circle'); });
await step('the same page: a visitor whose link carries the key writes', async () => { const v = client({ key: 'link', read }, '#k=' + KEY); if (v.readOnly || v.key !== KEY) throw new Error('readOnly ' + v.readOnly); await v.collection('notes').create({ text: 'second' }, { id: 'n2' }); if ((await seen.list()).length !== 2) throw new Error('the reader did not see it'); });
await step('the same page: a link carrying someone else\'s key is not followed; the visitor reads the real notes', async () => {
  const other = 'another-circle-key-9876543210', mine = {};
  await client({ key: other }).collection('notes').create({ text: 'ATTACKER' }, { id: 'x' });
  const v = client({ key: 'link', read }, '#k=' + other, mine);
  const all = await v.collection('notes').list();
  if (!v.readOnly || v.key !== null || all.some(o => o.data.text === 'ATTACKER') || all.length !== 2) throw new Error('readOnly ' + v.readOnly + ', saw ' + JSON.stringify(all.map(o => o.data.text)));
  const again = client({ key: 'link', read }, '', mine); if (!again.readOnly) throw new Error('the other key was remembered');
});
await step('a plain keyed page: someone else\'s link is used for that visit and does not replace the circle already remembered', async () => {
  const mine = {}, first = client({ key: 'link' }, '', mine), own = first.key;
  const visit = client({ key: 'link' }, '#k=another-circle-key-9876543210', mine); if (visit.key !== 'another-circle-key-9876543210') throw new Error('the link was not followed for this visit');
  const back = client({ key: 'link' }, '', mine); if (back.key !== own) throw new Error('the remembered circle was replaced: ' + back.key);
});
await step('with no secure random numbers the client stops, and makes no guessable key', async () => { let threw = false; try { client({ key: 'link' }, '', {}, true); } catch (e) { threw = /secure random/.test(e.message); } if (!threw) throw new Error('a key was made anyway'); });
console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll read key checks passed.');
process.exit(failed ? 1 : 0);
