// The client's own behaviour, run in Node with stand-ins for the page: its hashing, what it does to the address bar,
// how a browser changes circles, that every watcher on a page shares one connection, what its errors carry, and how it
// hears the store go and come back.
//   node tests/client.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import mock from './mock.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), source = fs.readFileSync(path.join(here, '..', 'persistable.js'), 'utf8');
const PAGE = 'https://proto.example/page';
/* a page: an address, a history that records what the client writes to the address bar, and sockets that can be driven */
/* `held: true` holds the client's timers back, to be run one at a time with p.run(); `origin` is the page's, as its browser reports it */
function page(hash = '', { held = false, origin = 'https://proto.example' } = {}) {
  const sockets = [], bar = [], hears = {}, timers = [], p = { sockets, bar, timers, reloads: 0 };
  class Socket { constructor(url) { this.url = url; this.closed = false; sockets.push(this); } send() {} close() { this.closed = true; if (this.onclose) this.onclose(); } }
  const ctx = { fetch: mock, console, crypto: webcrypto, TextEncoder, setInterval: () => 0, clearInterval() {},
    setTimeout: held ? (fn, ms) => timers.push({ fn, ms }) : setTimeout, clearTimeout: held ? id => { if (timers[id - 1]) timers[id - 1].fn = null; } : clearTimeout,
    addEventListener(type, fn) { (hears[type] = hears[type] || []).push(fn); },
    location: { origin, href: PAGE + hash, hash, reload() { p.reloads++; } }, history: { state: null, replaceState(s, t, to) { bar.push(to); } } };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  p.open = (opt, kept) => ctx.Persistable(Object.assign({ url: 'https://store.example', space: 'client-test', fetch: mock, WebSocket: Socket, storage: kept === null ? { getItem: () => null, setItem() {} } : { getItem: k => kept[k] ?? null, setItem: (k, v) => { kept[k] = v; } } }, opt));
  /* the address bar now ends with this; say so the way a browser does */
  p.go = to => { ctx.location.hash = to; ctx.location.href = PAGE + to; (hears.hashchange || []).forEach(fn => fn()); };
  p.waiting = () => timers.filter(t => t.fn);
  p.run = async () => { const t = p.waiting()[0], fn = t.fn; t.fn = null; fn(); await soon(); return t.ms; };
  return p;
}
const soon = () => new Promise(r => setTimeout(r, 5));
const readKeyOf = k => createHash('sha256').update('persistable read key\n' + k).digest('hex').slice(0, 40);
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const KEY = 'a-key-for-the-circle-0123456789', READ = readKeyOf(KEY), OTHER = 'another-circle-key-9876543210';

await step('the client\'s own SHA-256 agrees with the platform\'s at every key length', async () => {
  /* the label is 21 bytes, so keys of 16 to 200 characters cross every padding boundary of one to four blocks */
  for (let n = 16; n <= 200; n++) {
    const k = 'k' + String(n).padStart(3, '0') + '-Zq_'.repeat(50).slice(0, n - 4);
    const got = await page().open({ key: k }, {}).readKey();
    if (got !== readKeyOf(k)) throw new Error('mismatch at length ' + n);
  }
});
await step('a page with a read key: once the browser holds the key, it leaves the address bar', async () => {
  const kept = {}, p = page('#k=' + KEY), db = p.open({ key: 'link', read: READ }, kept);
  if (db.key !== KEY || db.readOnly) throw new Error('the link was not followed');
  if (p.bar.length !== 1 || p.bar[0] !== PAGE) throw new Error('address bar: ' + JSON.stringify(p.bar));
  if (db.link() !== PAGE + '#k=' + KEY) throw new Error('link() lost the key');
  const back = page().open({ key: 'link', read: READ }, kept); if (back.key !== KEY) throw new Error('the key was not remembered');
});
await step('the same page keeps the rest of the address: only the key goes', async () => {
  const p = page('#/screen/2&k=' + KEY); p.open({ key: 'link', read: READ }, {});
  if (p.bar[0] !== '#/screen/2') throw new Error('address bar: ' + JSON.stringify(p.bar));
});
await step('where nothing can be kept, the key stays in the address: it is all the visitor has', async () => {
  const p = page('#k=' + KEY), db = p.open({ key: 'link', read: READ }, null);
  if (db.key !== KEY || p.bar.length) throw new Error('address bar: ' + JSON.stringify(p.bar));
});
await step('a plain keyed page still makes the address bar the link to share', async () => {
  const p = page(), db = p.open({ key: 'link' }, {});
  if (p.bar.length !== 1 || p.bar[0] !== '#k=' + db.key) throw new Error('address bar: ' + JSON.stringify(p.bar));
});
await step('adopt() keeps a link\'s circle; without it the browser goes back to its own', async () => {
  const kept = {}, own = page().open({ key: 'link' }, kept).key;
  const visit = page('#k=' + OTHER).open({ key: 'link' }, kept);
  if (page().open({ key: 'link' }, kept).key !== own) throw new Error('the visit replaced the remembered circle');
  if (!visit.adopt()) throw new Error('adopt() said no');
  if (page().open({ key: 'link' }, kept).key !== OTHER) throw new Error('adopt() did not keep the circle');
});
await step('fresh() starts a new circle and returns its link; a page with a read key has none to start', async () => {
  const kept = {}, db = page().open({ key: 'link' }, kept), link = db.fresh();
  const made = /^https:\/\/proto\.example\/page#k=([0-9a-f]{48})$/.exec(link || '');
  if (!made || made[1] === db.key) throw new Error('link: ' + link);
  if (page().open({ key: 'link' }, kept).key !== made[1]) throw new Error('the new circle was not remembered');
  if (page('#k=' + KEY).open({ key: 'link', read: READ }, {}).fresh() !== null) throw new Error('a read-key page started a circle');
});
await step('every watcher on a page shares one connection, which closes with the last of them', async () => {
  const p = page(), db = p.open({}, {}), heard = { a: [], b: [], all: [], state: [] };
  const stops = [db.collection('a').subscribe({ onCreate: o => heard.a.push(o.id), onResync: () => heard.a.push('resync') }), db.collection('b').subscribe({ onDelete: id => heard.b.push(id) }), db.watch(name => heard.all.push(name), up => heard.state.push(up))];
  if (p.sockets.length !== 1) throw new Error(p.sockets.length + ' connections for three watchers');
  const ws = p.sockets[0]; ws.onopen();
  ws.onmessage({ data: JSON.stringify({ collection: 'a', op: 'create', id: 'x', object: { id: 'x' } }) });
  ws.onmessage({ data: JSON.stringify({ collection: 'b', op: 'delete', id: 'y' }) });
  if (heard.a.join() !== 'x' || heard.b.join() !== 'y' || heard.all.join() !== 'a,b' || heard.state.join() !== 'true') throw new Error(JSON.stringify(heard));
  stops[0](); stops[1]();
  if (ws.closed) throw new Error('the connection closed while someone was still watching');
  stops[2]();
  if (!ws.closed) throw new Error('the connection stayed open with nobody watching');
  db.watch(() => {}); if (p.sockets.length !== 2) throw new Error('a later watcher did not get a connection');
});
await step('one watcher\'s error does not keep the news from the rest', async () => {
  const p = page(), db = p.open({}, {}), got = [];
  process.once('uncaughtException', () => {});   // the error is thrown again on its own, where a console would show it
  db.watch(() => { throw new Error('a page bug'); }); db.watch(name => got.push(name));
  p.sockets[0].onopen(); p.sockets[0].onmessage({ data: 'things' });
  await new Promise(r => setTimeout(r, 10));
  if (got.join() !== 'things') throw new Error('the second watcher heard ' + JSON.stringify(got));
});
await step('when the address comes to carry the key this browser now keeps, the page is loaded again in that circle; someone else\'s key does nothing', async () => {
  const kept = {}, p = page(), db = p.open({ key: 'link' }, kept);
  p.go('#k=' + db.key); p.go('#/screen/2'); p.go('#k=tooshort'); p.go('');
  if (p.reloads) throw new Error('reloaded for an address that carries no other key');
  const link = db.fresh(); p.go(link.slice(link.indexOf('#')));
  if (p.reloads !== 1) throw new Error('location.href = db.fresh() did not reload: ' + p.reloads);
  const next = page(link.slice(link.indexOf('#'))), again = next.open({ key: 'link' }, kept);
  if (again.key === db.key || again.link() !== link) throw new Error('the reloaded page is not in the new circle');
  next.go('#k=' + again.key); if (next.reloads) throw new Error('reloaded for the key already in use');
  next.go('#/x&k=' + OTHER); if (next.reloads) throw new Error('someone else\'s link, clicked or pasted into this tab, moved the page to their circle');
});
await step('on a page with a read key only that page\'s key reloads it; a fixed key never does', async () => {
  const p = page(), reader = p.open({ key: 'link', read: READ }, {});
  p.go('#k=' + OTHER); if (p.reloads) throw new Error('a key from another circle reloaded a read-key page');
  p.go('#k=' + KEY); if (!reader.readOnly || p.reloads !== 1) throw new Error('a reader given the page\'s key was not reloaded as a writer');
  const w = page('#k=' + KEY); w.open({ key: 'link', read: READ }, {}); w.go(''); w.go('#k=' + KEY); if (w.reloads) throw new Error('a writer was reloaded for their own key');
  const f = page(); f.open({ key: KEY }, {}); f.go('#k=' + OTHER); if (f.reloads) throw new Error('a page with a fixed key followed a link');
});
await step('a refusal carries the store\'s status and its words; no answer carries neither', async () => {
  const p = page(), ada = p.open({}, {}), ben = p.open({}, {}), made = await ada.collection('errors').create({ text: 'mine' });
  let e = null; try { await ben.collection('errors').update(made.id, { text: 'yours' }); } catch (x) { e = x; }
  if (!e || e.status !== 403 || e.detail !== 'only whoever created this can change its data' || !/^persistable: update failed \(403\) only whoever/.test(e.message)) throw new Error('got ' + (e && JSON.stringify([e.status, e.detail, e.message])));
  e = null; try { await ada.collection('errors').create({}, { id: made.id }); } catch (x) { e = x; } if (!e || e.status !== 409) throw new Error('a taken id: ' + (e && e.status));
  e = null; try { await p.open({ fetch: () => Promise.reject(new TypeError('no network')) }, {}).me(); } catch (x) { e = x; }
  if (!e || 'status' in e || 'detail' in e) throw new Error('no answer: ' + (e && JSON.stringify([e.status, e.detail])));
});
await step('get() gives null for an object that is not there, and still throws for anything else', async () => {
  const p = page(), db = p.open({}, {}), c = db.collection('getting'), made = await c.create({ n: 1 });
  if ((await c.get(made.id)).data.n !== 1) throw new Error('get() lost the object');
  if (await c.get('no-such-object') !== null) throw new Error('a missing object was not null');
  await c.remove(made.id); if (await c.get(made.id) !== null) throw new Error('a removed object was not null');
  let e = null; try { await p.open({ fetch: () => Promise.resolve(new Response('{"message":"down"}', { status: 500 })) }, {}).collection('getting').get('x'); } catch (x) { e = x; } if (!e || e.status !== 500) throw new Error('a failing store read as null');
});
await step('a collection name or id the store would refuse is refused before any request is made', async () => {
  let asked = 0; const db = page().open({ fetch: (...a) => { asked++; return mock(...a); } }, {}), c = db.collection('naming');
  for (const bad of ['Votes', 'a/b', '..', '', '_me', 'a b', 'x'.repeat(41), undefined, 7]) { let threw = false; try { db.collection(bad); } catch (e) { threw = /collection name/.test(e.message); } if (!threw) throw new Error('collection(' + JSON.stringify(bad) + ') was allowed'); }
  for (const bad of ['../other', 'a/b', '', '.hidden', 'a?all=1', 'x'.repeat(81), undefined, null, 7]) {
    for (const go of [() => c.get(bad), () => c.update(bad, {}), () => c.setOpen(bad, {}), () => c.patch(bad, {}), () => c.remove(bad), () => c.create({}, { id: bad === undefined || bad === null ? 7 : bad })]) {
      let e = null, p = null; try { p = go(); } catch (x) { throw new Error('threw instead of rejecting for id ' + JSON.stringify(bad)); }
      try { await p; } catch (x) { e = x; } if (!e || !/an id is up to 80/.test(e.message)) throw new Error('id ' + JSON.stringify(bad) + ' was allowed: ' + (e && e.message));
    }
  }
  if (asked) throw new Error(asked + ' request(s) were made for names the client should refuse');
  const ok = await c.create({}, { id: 'A.b_c-1' }); if (ok.id !== 'A.b_c-1' || (await c.get('A.b_c-1')).id !== ok.id || asked !== 2) throw new Error('a good id was refused');
});
await step('a page with no real site uses the space "default", whatever its browser calls its origin', async () => {
  for (const origin of ['null', 'file://', null, '']) { const db = page('', { origin }).open({ space: undefined }, {}); if (db.space !== 'default') throw new Error('origin ' + origin + ' gave the space ' + db.space); }
  for (const origin of ['https://proto.example', 'http://localhost:8000']) { const db = page('', { origin }).open({ space: undefined }, {}); if (db.space !== origin) throw new Error('origin ' + origin + ' gave the space ' + db.space); }
});
await step('subscribe hands over the whole object when the store left it out, and keeps the order', async () => {
  const p = page(), db = p.open({}, {}), c = db.collection('large'), heard = [];
  await c.create({ text: 'big' }, { id: 'x' });
  c.subscribe({ onCreate: o => heard.push('create ' + o.id + ' ' + o.data.text), onUpdate: o => heard.push('update ' + o.id + ' ' + o.data.text), onDelete: id => heard.push('delete ' + id), onResync: () => heard.push('resync') });
  const all = []; db.watch((name, what) => all.push(what));
  const ws = p.sockets[0], say = what => ws.onmessage({ data: JSON.stringify(Object.assign({ collection: 'large' }, what)) }); ws.onopen();
  say({ op: 'update', id: 'x' }); say({ op: 'create', id: 'y', object: { id: 'y', data: { text: 'small' } } }); say({ op: 'delete', id: 'y' }); say({ op: 'create', id: 'never-there' });
  if (heard.length) throw new Error('something was handed over before the object was fetched: ' + heard);
  await soon();
  if (heard.join() !== 'update x big,create y small,delete y') throw new Error('heard ' + JSON.stringify(heard));
  if (all.length !== 4 || 'object' in all[0]) throw new Error('watch() should hear each change as the store sent it: ' + JSON.stringify(all));
  say({ op: 'delete', id: 'z' }); if (heard.length !== 4) throw new Error('with nothing waiting, a change should be handed over at once');
});
await step('subscribe fetches a large object once for a run of changes, and never hands over an older state after a newer one', async () => {
  let gets = 0; const p = page(), db = p.open({ fetch: (u, i) => { if ((!i || !i.method || i.method === 'GET') && /\/burst\/x/.test(String(u))) gets++; return mock(u, i); } }, {}), c = db.collection('burst'), heard = [];
  await c.create({ n: 3 }, { id: 'x' }); const now = (await c.get('x')).updated; gets = 0;
  c.subscribe({ onUpdate: o => heard.push(o.data.n) });
  const ws = p.sockets[0], say = what => ws.onmessage({ data: JSON.stringify(Object.assign({ collection: 'burst' }, what)) }); ws.onopen();
  for (let i = 0; i < 20; i++) say({ op: 'update', id: 'x' });
  say({ op: 'update', id: 'x', object: { id: 'x', updated: now - 5, data: { n: 2 } } });   // a small change sent before the store reached n: 3
  await soon(); await soon();
  if (gets > 2) throw new Error(gets + ' fetches for 20 changes to one object');
  if (!heard.length || heard.length > 2 || heard.some(n => n !== 3)) throw new Error('heard ' + JSON.stringify(heard) + ', wanted the present state and nothing older after it');
});
await step('subscribe says "read it again" when the object cannot be fetched', async () => {
  let down = false; const p = page(), db = p.open({ fetch: (...a) => (down ? Promise.reject(new TypeError('no network')) : mock(...a)) }, {}), heard = [];
  db.collection('large').subscribe({ onUpdate: o => heard.push('update'), onResync: () => heard.push('resync') });
  p.sockets[0].onopen(); down = true; p.sockets[0].onmessage({ data: '{"collection":"large","op":"update","id":"x"}' }); await soon();
  if (heard.join() !== 'resync') throw new Error('heard ' + JSON.stringify(heard));
});
await step('onStatus: while the store is down the client asks again, more slowly each time, and stops when it answers', async () => {
  let down = true, asked = 0; const p = page('', { held: true }), heard = [];
  const db = p.open({ fetch: (...a) => { asked++; return down ? Promise.reject(new TypeError('no network')) : mock(...a); } }, {});
  const stop = db.onStatus(up => heard.push(up));
  if (p.waiting().length) throw new Error('asked before anything was known to be wrong');
  await db.me().catch(() => {}); if (heard.join() !== 'false' || p.waiting().length !== 1) throw new Error('after a failed request: heard ' + heard + ', ' + p.waiting().length + ' timer(s)');
  const waits = [await p.run(), await p.run(), await p.run()];
  if (waits.join() !== '5000,10000,20000' || asked !== 4 || heard.join() !== 'false') throw new Error('waits ' + waits + ', asked ' + asked + ', heard ' + heard);
  down = false; await p.run();
  if (heard.join() !== 'false,true' || p.waiting().length) throw new Error('when it came back: heard ' + heard + ', ' + p.waiting().length + ' timer(s) still waiting');
  down = true; await db.me().catch(() => {}); if (p.waiting()[0].ms !== 5000) throw new Error('the wait did not start short again');
  stop(); if (p.waiting().length) throw new Error('went on asking with nobody hearing');
  await db.me().catch(() => {}); if (p.waiting().length) throw new Error('asked with nobody hearing');
  const late = []; db.onStatus(up => late.push(up)); if (late.join() !== 'false' || p.waiting().length !== 1) throw new Error('a hearer who arrives while it is down: ' + late + ', ' + p.waiting().length + ' timer(s)');
});
await step('onStatus: anything heard on the socket means the store is up', async () => {
  let down = false; const p = page('', { held: true }), heard = [];
  const db = p.open({ fetch: (...a) => (down ? Promise.reject(new TypeError('no network')) : mock(...a)) }, {});
  db.onStatus(up => heard.push(up)); db.watch(() => {}); p.sockets[0].onopen();
  down = true; await db.me().catch(() => {});
  p.sockets[0].onmessage({ data: 'things' });
  if (heard.join() !== 'true,false,true' || p.waiting().length) throw new Error('heard ' + heard + ', ' + p.waiting().length + ' timer(s) waiting');
});
console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll client checks passed.');
process.exit(failed ? 1 : 0);
