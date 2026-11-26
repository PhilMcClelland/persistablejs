#!/usr/bin/env node
// Proves a deployed Persistable.js store works, using the real client against the real address.
//   node verify.mjs https://persistable.YOUR-SUBDOMAIN.workers.dev
//   node verify.mjs --store supabase https://YOUR-PROJECT.supabase.co YOUR_PUBLISHABLE_KEY
// The checks every store must pass come first; the ones only the Worker has (addresses, link keys, a live connection) are marked.
// Two made-up people write to a throwaway space; it checks who may do what, that changes are pushed, and deletes the objects it made.
// Exit code 0 means a prototype pointed at this address can keep shared data in it.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), store = args[0] === '--store' ? args.splice(0, 2)[1] : 'worker', worker = store === 'worker';
const [url, apiKey] = args;
if (!url || !['worker', 'supabase'].includes(store) || (!worker && !apiKey)) { console.error('usage: node verify.mjs <store address>\n       node verify.mjs --store supabase <project url> <publishable key>'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
// PERSISTABLE_VERIFY_MOCK=1 runs the same checks against tests/mock.mjs (the Worker's code in Node; no account needed)
const mock = !!process.env.PERSISTABLE_VERIFY_MOCK;
const stand = mock ? await import(path.join(here, 'tests', worker ? 'mock.mjs' : 'mock-supabase.mjs')) : null, fetch = mock ? stand.default : globalThis.fetch;
const ctx = { fetch, console, crypto: globalThis.crypto, WebSocket: mock ? stand.Socket : globalThis.WebSocket, setTimeout, clearTimeout, setInterval, clearInterval };
ctx.globalThis = ctx; ctx.window = ctx;
for (const file of worker ? ['persistable.js'] : ['persistable.js', 'stores/' + store + '.js']) vm.runInNewContext(fs.readFileSync(path.join(here, file), 'utf8'), ctx);
const memory = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
const space = 'persistable-verify-' + Date.now().toString(36);
const person = more => ctx.Persistable(Object.assign({ url, space, storage: memory(), fetch }, worker ? {} : { store, apiKey, poll: mock ? 250 : 1000 }, more));
const ada = person(), ben = person(), things = db => db.collection('things');
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
// a refusal only counts if the store said no with the expected status; failing to reach it is not a refusal
const refuses = async (what, status, fn) => { let why = null; try { await fn(); } catch (e) { why = e || {}; } if (why === null) throw new Error(what + ' was allowed, and should not be'); if (why.status !== status) throw new Error(what + ' failed for the wrong reason: ' + why.message); };
const wait = ms => new Promise(r => setTimeout(r, ms)), lag = worker ? (mock ? 50 : 1500) : (mock ? 700 : 3000);   // how long a change is given to arrive: pushed by the Worker, asked for elsewhere
const at = path => url.replace(/\/+$/, '') + '/v1/s/' + encodeURIComponent(space) + '/' + path;

console.log('Persistable.js (' + store + '): ' + url + '\nspace: ' + space);
if (worker) await step('the address answers as Persistable.js', async () => { const r = await fetch(url.replace(/\/+$/, '') + '/'); const j = await r.json(); if (j.service !== 'persistable') throw new Error('unexpected answer: ' + JSON.stringify(j)); });
else await step('the project answers, and the functions from stores/supabase.sql are there', async () => { const me = await person().me(); if (!me || !/^[0-9a-f]{32}$/.test(me.id)) throw new Error('unexpected answer: ' + JSON.stringify(me)); });
if (failed && !worker) { console.log('\nThe project has to answer before anything else can be checked. Is the address right, has stores/supabase.sql been run in it, and are anonymous sign-ins turned on? See stores/SUPABASE.md.'); process.exit(1); }
if (failed) { console.log('\nThe address has to answer before anything else can be checked. Is the Worker deployed, and is this its address?\nA first deploy can take up to a minute to start answering.'); process.exit(1); }
await step('two browsers are two different people', async () => { const a = await ada.me(), b = await ben.me(); if (!a.id || !b.id || a.id === b.id) throw new Error('expected two distinct ids'); });
await step('the same secret is a different person in another space', async () => { const kept = memory(), a = await person({ storage: kept }).me(), b = await person({ storage: kept }).me(), c = await person({ storage: kept, space: space + '-other' }).me(); if (a.id !== b.id) throw new Error('one browser was two people in one space'); if (a.id === c.id) throw new Error('the same id in two spaces'); });
const pushed = [], large = [], stop = ben.watch((name, what) => pushed.push(what || { collection: name })), stopLarge = things(ben).subscribe({ onUpdate: o => large.push(o) });
await wait(lag);
let made;
await step('a person can add an object', async () => { made = await things(ada).create({ label: 'one' }, { open: { votes: 0 } }); if (!made.id || made.data.label !== 'one' || made.open.votes !== 0) throw new Error('unexpected: ' + JSON.stringify(made)); });
await step(worker ? 'the change is pushed to someone watching' : 'someone watching hears that the collection changed', async () => { await wait(lag); const got = pushed.find(p => p.collection === 'things'); if (!got) throw new Error(worker ? 'nothing arrived over the WebSocket' : 'nothing was heard'); if (worker && (got.op !== 'create' || got.id !== made.id || !got.object || got.object.data.label !== 'one')) throw new Error('the change arrived without saying what changed: ' + JSON.stringify(got)); });
if (worker) await step('a large object is pushed without its contents, and the client fetches them', async () => {
  await things(ada).update(made.id, { pad: 'x'.repeat(20000) }); await wait(lag);
  const got = pushed.find(p => p.op === 'update' && p.id === made.id); if (!got) throw new Error('nothing arrived over the WebSocket'); if (got.object) throw new Error('a 20 KB object was sent to every listener');
  if (large.length !== 1 || large[0].data.pad.length !== 20000) throw new Error('subscribe did not hand over the whole object: ' + JSON.stringify(large).slice(0, 200));
  await things(ada).update(made.id, { pad: null });
});
stop(); stopLarge();
if (worker) await step('a listener only listens: its ping is answered, and anything else it says ends the call', async () => {
  const ws = new ctx.WebSocket(at('_watch').replace(/^http/, 'ws')), heard = [];
  const code = await new Promise((done, fail) => { ws.onopen = () => { ws.send('ping'); setTimeout(() => ws.send('hello'), lag / 5); }; ws.onmessage = e => heard.push(String(e.data)); ws.onclose = e => done(e.code); setTimeout(() => fail(new Error('still open after 5 seconds')), 5000); });
  if (heard.join() !== 'pong' || code !== 1008) throw new Error('heard ' + JSON.stringify(heard) + ', closed with ' + code);
});
await step('someone else can read it, and an object that is not there reads as null', async () => { const all = await things(ben).list(), one = await things(ben).get(made.id), none = await things(ben).get('no-such-object'); if (all.length !== 1 || one.data.label !== 'one' || one.owner !== (await ada.me()).id || none !== null) throw new Error('unexpected: ' + JSON.stringify([all, none])); });
if (worker) await step('an address with a slash on the end, or an empty part, is no address', async () => { for (const path of ['things/', 'things//' + made.id]) { const r = await fetch(at(path)); if (r.status !== 404) throw new Error(path + ': expected 404, got ' + r.status); } });
await step('someone else can change its open part', async () => { const got = await things(ben).setOpen(made.id, { votes: 1 }); if (got.open.votes !== 1 || got.data.label !== 'one') throw new Error('unexpected: ' + JSON.stringify(got)); });
await step('someone else cannot change its data', () => refuses('changing another person\'s data', 403, () => things(ben).update(made.id, { label: 'hijacked' })));
await step('someone else cannot delete it', () => refuses('deleting another person\'s object', 403, () => things(ben).remove(made.id)));
await step('its creator can change its data, and null removes a key', async () => { const got = await things(ada).update(made.id, { label: 'two', extra: 1 }); const cut = await things(ada).update(made.id, { extra: null }); if (got.data.label !== 'two' || 'extra' in cut.data) throw new Error('unexpected: ' + JSON.stringify(cut)); });
await step('an id cannot be used twice', () => refuses('a second object with the same id', 409, () => things(ben).create({}, { id: made.id })));
await step('a child needs a parent that exists', () => refuses('a child of nothing', 400, () => things(ben).create({}, { parent: 'no-such-object' })));
await step('someone else can add a child', async () => { const kid = await things(ben).create({ label: 'child' }, { parent: made.id }); if (kid.parent !== made.id) throw new Error('unexpected: ' + JSON.stringify(kid)); });
await step('another collection and another space see nothing', async () => { const a = await ada.collection('other').list(), b = await things(person({ space: space + '-other' })).list(); if (a.length || b.length) throw new Error('data leaked'); });
await step('a page on another site cannot use a space named after a site', async () => {
  if (!worker) { const from = (u, init) => fetch(u, Object.assign({}, init, { headers: Object.assign({}, init.headers, { Origin: 'https://other.example' }) })); return refuses('another site\'s page', 403, () => things(person({ space: 'https://mine.example', fetch: from })).list()); }
  const r = await fetch(url.replace(/\/+$/, '') + '/v1/s/' + encodeURIComponent('https://mine.example') + '/things', { headers: { Origin: 'https://other.example' } }); if (r.status !== 403) throw new Error('expected 403, got ' + r.status); });
await step('its creator can delete it, and the child goes with it', async () => { await things(ada).remove(made.id); const all = await things(ben).list(); if (all.length) throw new Error('still there: ' + JSON.stringify(all)); });
await step('the limits hold: an open part over 8 KB is refused', async () => { const o = await things(ada).create({}); await refuses('an oversized open part', 413, () => things(ben).setOpen(o.id, { pad: 'x'.repeat(9000) })); await things(ada).remove(o.id); });
if (!worker) {
  await step('this store has no link keys, and says so', async () => { let why = null; try { person({ key: 'link' }); } catch (e) { why = e; } if (!why) throw new Error('a key was accepted'); });
  console.log(failed ? '\n' + failed + ' check(s) failed. See stores/SUPABASE.md.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}
// a circle of trust: a key in the address makes a separate space, where everyone who has the key may change anything
const key = 'verify-key-' + Date.now().toString(36) + '-0123456789', cat = person({ key }), dan = person({ key });
let shared;
await step('with a key, people who have it share a space', async () => { shared = await things(cat).create({ label: 'ours' }); const all = await things(dan).list(); if (all.length !== 1 || all[0].id !== shared.id) throw new Error('unexpected: ' + JSON.stringify(all)); });
await step('without the key, or with another, there is nothing to see', async () => { const a = await things(person()).list(), b = await things(person({ key: key + 'x' })).list(); if (a.length || b.length) throw new Error('a keyed space leaked'); });
await step('with the key, someone else can change its data', async () => { const got = await things(dan).update(shared.id, { label: 'edited' }); if (got.data.label !== 'edited' || got.owner !== (await cat.me()).id) throw new Error('unexpected: ' + JSON.stringify(got)); });
await step('with the key, someone else can delete it', async () => { await things(dan).remove(shared.id); if ((await things(cat).list()).length) throw new Error('still there'); });
await step('a short key is refused', async () => { const r = await fetch(url.replace(/\/+$/, '') + '/v1/s/' + encodeURIComponent(space) + '/things?k=short'); if (r.status !== 400) throw new Error('expected 400, got ' + r.status); });
console.log(failed ? '\n' + failed + ' check(s) failed. See SETUP.md.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
