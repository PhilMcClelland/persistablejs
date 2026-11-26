#!/usr/bin/env node
// Choosing a store, and what the client does for a store that cannot push changes: it asks, and says which collection.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = { console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error('no network here')) };
ctx.globalThis = ctx; ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(path.join(here, '..', 'persistable.js'), 'utf8'), ctx);
const { Persistable } = ctx, wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(what + ': got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b)); };
// a store kept in memory, with a pulse and no push
const memory = () => { const rows = {}; let n = 0; const stamp = () => ++n;
  return { rows, calls: [], make(opt, kit) { const self = this; return {
    me: async () => ({ id: 'me-in-' + kit.space }), list: async name => Object.values(rows[name] || {}),
    get: async (name, id) => (rows[name] || {})[id] || null,
    create: async (name, body) => { const o = { id: body.id || 'o' + stamp(), owner: 'me', parent: body.parent || null, created: stamp(), updated: n, data: body.data, open: body.open || {} }; (rows[name] = rows[name] || {})[o.id] = o; return o; },
    patch: async (name, id, parts) => { const o = rows[name][id]; Object.assign(o.data, parts.data || {}); Object.assign(o.open, parts.open || {}); o.updated = stamp(); return o; },
    remove: async (name, id) => { delete rows[name][id]; stamp(); },
    pulse: async () => { self.calls.push('pulse'); if (self.down) throw new Error('down'); const out = {}; for (const c of Object.keys(rows)) out[c] = Object.keys(rows[c]).length + ':' + Math.max(0, ...Object.values(rows[c]).map(o => o.updated)); return out; }
  }; } }; };

await step('every file says which version it is, and it is the one the changelog starts with', async () => {
  const root = path.join(here, '..'), first = f => fs.readFileSync(path.join(root, f), 'utf8').split('\n')[0];
  const latest = (/^## (\d+\.\d+\.\d+)/m.exec(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')) || [])[1];
  if (!latest) throw new Error('the changelog has no version heading');
  for (const f of ['persistable.js', 'worker.js', 'stores/supabase.js', 'stores/session.js', 'stores/supabase.sql']) if (!first(f).includes('Persistable.js ' + latest + ' ')) throw new Error(f + ' does not say ' + latest + ' in its first line: ' + first(f).slice(0, 60));
  eq(Persistable.version, latest, 'Persistable.version');
});
await step('with no store named, the Worker is used, and it wants a url', async () => { let why = null; try { Persistable({}); } catch (e) { why = e.message; } if (!/url is required/.test(why || '')) throw new Error('got: ' + why); });
await step('a store that is not loaded is refused by name', async () => { for (const name of ['supabase', 'constructor', 'toString']) { let why = null; try { Persistable({ store: name, url: 'https://x.example' }); } catch (e) { why = e.message; } if (!/no store named/.test(why || '')) throw new Error(name + ' got: ' + why); } });
await step('a store can be a function, and the client checks names and ids before asking it', async () => {
  const m = memory(), db = Persistable({ store: (o, k) => m.make(o, k), space: 'here' }), things = db.collection('things');
  eq(await db.me(), { id: 'me-in-here' }, 'me');
  const made = await things.create({ label: 'one' }); eq((await things.get(made.id)).data, { label: 'one' }, 'get');
  let why = null; try { await things.get('../x'); } catch (e) { why = e.message; } if (!/an id is up to 80/.test(why || '')) throw new Error('a bad id reached the store: ' + why);
  why = null; try { db.collection('Bad Name'); } catch (e) { why = e.message; } if (!/collection name/.test(why || '')) throw new Error('a bad name was taken: ' + why);
  eq([db.key, db.readOnly, db.link(), db.adopt(), db.fresh(), await db.readKey()], [null, false, null, false, null, null], 'a store with no keys');
});
await step('a store with a pulse: watchers hear which collection changed, subscribers are told to read again, and only then', async () => {
  const m = memory(), db = Persistable({ store: (o, k) => m.make(o, k), space: 'here', poll: 250 }), things = db.collection('things'), other = db.collection('other');
  const heard = [], states = [], resyncs = [], otherResyncs = [];
  const stop = db.watch((name, what) => heard.push([name, what === undefined ? 'no detail' : what]), up => states.push(up));
  const stopA = things.subscribe({ onResync: () => resyncs.push(1), onCreate: () => { throw new Error('onCreate from a store that cannot say what changed'); } });
  const stopB = other.subscribe({ onResync: () => otherResyncs.push(1) });
  await wait(400); eq([heard, states, resyncs], [[], [true], []], 'nothing has changed yet');
  const made = await things.create({ a: 1 }); await wait(400);
  eq([heard, resyncs.length, otherResyncs.length], [[['things', 'no detail']], 1, 0], 'after a create');
  await things.setOpen(made.id, { b: 2 }); await wait(400); eq([heard.length, resyncs.length], [2, 2], 'after a change');
  await wait(600); eq(heard.length, 2, 'quiet when nothing changes');
  m.down = true; await wait(400); eq(states, [true, false], 'the store stopped answering');
  m.down = false; await wait(400); eq([states, heard[heard.length - 1]], [[true, false, true], [null, 'no detail']], 'back: anything may have been missed');
  stop(); stopA(); stopB(); const asked = m.calls.length; await wait(600); eq(m.calls.length, asked, 'no asking once nobody is watching');
});
await step('a store with neither a pulse nor a push: watching does nothing, and says so by doing nothing', async () => {
  const db = Persistable({ store: () => ({ me: async () => ({ id: 'x' }) }), space: 'here' }); const stop = db.watch(() => { throw new Error('heard something'); }); stop();
});
await step('the session store: kept for the tab, one person, children go with their parent, and changes are told', async () => {
  vm.runInNewContext(fs.readFileSync(path.join(here, '..', 'stores', 'session.js'), 'utf8'), ctx);
  const kept = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })();
  const db = Persistable({ store: 'session', space: 'here', storage: kept }), things = db.collection('things'), heard = [];
  const stop = things.subscribe({ onCreate: o => heard.push('create ' + o.data.a), onUpdate: o => heard.push('update ' + o.open.b), onDelete: () => heard.push('delete') });
  const made = await things.create({ a: 1 }, { id: 'constructor' }), kid = await things.create({ a: 2 }, { parent: made.id });
  eq((await things.setOpen(made.id, { b: 2 })).open, { b: 2 }, 'open'); eq((await things.update(made.id, { a: null, c: 3 })).data, { c: 3 }, 'null removes');
  let why = null; try { await things.create({}, { id: 'constructor' }); } catch (e) { why = e.status; } eq(why, 409, 'an id twice');
  why = null; try { await things.create({}, { parent: 'toString' }); } catch (e) { why = e.status; } eq(why, 400, 'a parent that is only on the prototype');
  eq(await things.get('hasOwnProperty'), null, 'get of a name every object has');
  const again = Persistable({ store: 'session', space: 'here', storage: kept });
  eq([(await again.collection('things').list()).length, (await again.me()).id === (await db.me()).id, (await Persistable({ store: 'session', space: 'there', storage: kept }).collection('things').list()).length], [2, true, 0], 'kept, same person, another space empty');
  await things.remove(made.id); eq((await things.list()).length, 0, 'the child went too'); await wait(20); stop();
  eq(heard, ['create 1', 'create 2', 'update 2', 'update 2', 'delete', 'delete'], 'what the subscriber heard'); void kid;
});
await step('the session store: a collection named after something every object has is only a collection; a bad blob is a fresh start; a failed write is not a lost one', async () => {
  const kept = (() => { const m = {}; return { m, full: false, getItem: k => (k in m ? m[k] : null), setItem(k, v) { if (this.full) throw new Error('full'); m[k] = String(v); } }; })();
  const db = Persistable({ store: 'session', space: 'odd', storage: kept }), odd = db.collection('constructor');
  eq([await odd.get('keys'), (await odd.list()).length], [null, 0], 'nothing is there');
  let why = null; try { await odd.patch('prototype', { data: { x: 1 } }); } catch (e) { why = e.status; } eq([why, 'updated' in {}], [404, false], 'a patch of Object.prototype');
  why = null; try { await odd.remove('assign'); } catch (e) { why = e.status; } eq([why, typeof Object.assign], [404, 'function'], 'a remove of Object.assign');
  why = null; try { await odd.create('words'); } catch (e) { why = e.status; } eq(why, 400, 'data that is not an object');
  const made = await odd.create({ a: 1 }); eq((await odd.get(made.id)).data, { a: 1 }, 'a real object in it');
  for (const junk of ['[]', '{}', '{"rows":null}', '{"me":"x","n":0,"rows":{"constructor":7}}', 'not json']) { kept.m['persistable.session.odd'] = junk; eq((await Persistable({ store: 'session', space: 'odd', storage: kept }).collection('constructor').list()).length, 0, 'after ' + junk); }
  const tight = Persistable({ store: 'session', space: 'tight', storage: kept }), t = tight.collection('things');
  await t.create({ n: 1 }); kept.full = true; const second = await t.create({ n: 2 });
  eq([(await t.list()).length, (await t.get(second.id)).data], [2, { n: 2 }], 'what could not be stored is still here');
  kept.full = false; await t.create({ n: 3 }); eq(JSON.parse(kept.m['persistable.session.tight']).rows.things && Object.keys(JSON.parse(kept.m['persistable.session.tight']).rows.things).length, 3, 'and is stored once storing works again');
});
await step('the session store: what it hands out is a copy, and a damaged object is not there', async () => {
  const none = { getItem() { return null; }, setItem() { throw new Error('no'); } };   // nothing can be stored: it runs from memory
  const t = Persistable({ store: 'session', space: 'mem', storage: none }).collection('things'), made = await t.create({ deep: { n: 1 } }, { id: 'a' });
  const got = await t.get('a'); got.owner = 'forged'; got.data.deep.n = 99; (await t.list())[0].id = 'renamed'; made.data.deep.n = 7;
  eq([(await t.get('a')).data, (await t.get('a')).owner === 'forged', (await t.list())[0].id], [{ deep: { n: 1 } }, false, 'a'], 'the store is untouched');
  const kept = (() => { const m = {}; return { m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })();
  kept.m['persistable.session.bad'] = JSON.stringify({ me: 'm', n: 0, rows: { c: { a: null, b: 'words', c: [], d: {}, e: { id: 'e', owner: 'm', parent: null, created: 1, updated: 1, data: null, open: {} }, f: { id: 'other', owner: 'm', parent: null, created: 1, updated: 1, data: {}, open: {} }, g: { id: 'g', owner: 'm', parent: null, created: 1, updated: 1, data: { ok: 1 }, open: {} } } } });
  const c = Persistable({ store: 'session', space: 'bad', storage: kept }).collection('c');
  eq((await c.list()).map(o => o.id), ['g'], 'only the whole object is there');
  for (const id of ['a', 'e', 'f']) { let why = null; try { await c.setOpen(id, { x: 1 }); } catch (e) { why = e.status; } eq(why, 404, 'a change to the damaged ' + id); }
  let why = 'threw'; try { why = await Persistable({ store: 'session', space: 'mem2', storage: none }).collection('c').create({ n: 1n }).then(() => 'stored', () => 'rejected'); } catch (_) { /* a throw, not a rejection */ } eq(why, 'rejected', 'data that cannot be stored');
  why = null; try { await c.update('g', JSON.parse('{"__proto__":{"x":1}}')); } catch (e) { why = e.status; } eq(why, 400, 'a __proto__ key');
});
await step('the Supabase store signs a browser in once: two clients on one storage, a lock that misbehaves, a stored session that is not one', async () => {
  const project = (await import('./mock-supabase.mjs')).default;
  const run = async (locks, seed) => {
    const c2 = { console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, navigator: locks ? { locks } : undefined }; c2.globalThis = c2; c2.window = c2;
    for (const f of ['persistable.js', 'stores/supabase.js']) vm.runInNewContext(fs.readFileSync(path.join(here, '..', f), 'utf8'), c2);
    let signups = 0; const m = Object.assign({}, seed), storage = { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
    const counted = (u, i) => { if (/\/auth\/v1\/signup/.test(u)) signups++; return project(u, i); };
    const make = () => c2.Persistable({ store: 'supabase', url: 'https://mock.supabase.co', apiKey: 'k', space: 'signin', storage, fetch: counted });
    const [a, b] = await Promise.all([make().me(), make().me()]), again = await make().me();
    return { signups, same: a.id === b.id && b.id === again.id };
  };
  eq(await run(null), { signups: 1, same: true }, 'no locks');
  eq(await run({ request: (name, fn) => fn() }), { signups: 1, same: true }, 'a lock that works');
  eq(await run({ request: () => Promise.resolve(undefined) }), { signups: 1, same: true }, 'a lock that never runs what it was given');
  eq(await run({ request: (name, fn) => Promise.resolve(fn()).then(() => ({ access: 'someone-else', refresh: 'x', until: 9e15 })) }), { signups: 1, same: true }, 'a lock that hands back something else');
  eq(await run({ request: () => { throw new Error('SecurityError'); } }), { signups: 1, same: true }, 'a lock that is refused');
  for (const junk of ['{"access":{"x":1},"refresh":["x"],"until":"9e15"}', '{"access":"line\\nbreak","refresh":"r","until":9e15}', '[]', 'not json']) eq(await run(null, { 'persistable.supabase.https://mock.supabase.co': junk }), { signups: 1, same: true }, 'stored ' + junk);
});
await step('the Supabase store reads a big collection a page at a time, and hands over all of it', async () => {
  const project = (await import('./mock-supabase.mjs')).default; let lists = 0;
  const c2 = { console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, AbortController }; c2.globalThis = c2; c2.window = c2;
  for (const f of ['persistable.js', 'stores/supabase.js']) vm.runInNewContext(fs.readFileSync(path.join(here, '..', f), 'utf8'), c2);
  const m = {}, t = c2.Persistable({ store: 'supabase', url: 'https://mock.supabase.co', apiKey: 'k', space: 'pages', storage: { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } },
    fetch: (u, i) => { if (/persistable_list/.test(u)) lists++; return project(u, i); } }).collection('big');
  for (let i = 0; i < 40; i++) await t.create({ n: i, pad: 'x'.repeat(90000) });
  const all = await t.list();
  eq([all.length, all.map(o => o.data.n).join() === [...Array(40).keys()].join(), lists > 3 && lists < 8], [40, true, true], 'forty objects of 90 KB, in order, over a few pages (' + lists + ')');
});
await step('the Supabase store does not take a wrong answer for an empty collection', async () => {
  const project = (await import('./mock-supabase.mjs')).default;
  const withList = answer => { const c2 = { console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, AbortController }; c2.globalThis = c2; c2.window = c2;
    for (const f of ['persistable.js', 'stores/supabase.js']) vm.runInNewContext(fs.readFileSync(path.join(here, '..', f), 'utf8'), c2);
    const m = {}; let n = 0;
    return c2.Persistable({ store: 'supabase', url: 'https://mock.supabase.co', apiKey: 'k', space: 'odd-lists', storage: { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } },
      fetch: (u, i) => /persistable_list/.test(u) ? Promise.resolve(new Response(typeof answer === 'function' ? answer(++n) : answer, { status: 200 })) : project(u, i) }).collection('c').list().then(r => 'listed ' + r.length, e => 'refused: ' + e.message.replace(/^persistable: list failed: /, '').slice(0, 34)); };
  eq(await withList('[{"id":"a"}]'), 'refused: the project did not answer with a ', 'a bare array, as an older version answered');
  eq(await withList('<html>gateway</html>'), 'refused: the project did not answer with a ', 'an answer that is not JSON');
  eq(await withList('{"rows":[{"id":"a"}],"next":[1,"a"]}'), 'refused: the project sent the same page aga', 'a next that never moves on');
  eq(await withList(n => n === 1 ? '{"rows":[{"id":"a"}],"next":[1,"a"]}' : 'oops'), 'refused: the project did not answer with a ', 'a second page that is not a page');
  eq(await withList(n => n === 1 ? '{"rows":[{"id":"a"}],"next":[1,"a"]}' : '{"rows":[{"id":"b"}],"next":null}'), 'listed 2', 'two honest pages');
  eq(await withList('{"rows":[{"id":"a"}],"next":"more"}'), 'refused: the project did not answer with a ', 'a next that is not a place to go on from');
});
await step('a key is refused by a store that has none, and create keeps the data it was given', async () => {
  for (const more of [{ key: 'link' }, { read: 'a-read-key-0123456789' }]) { let why = null; try { Persistable(Object.assign({ store: 'session', space: 'k' }, more)); } catch (e) { why = e.message; } if (!/no link keys/.test(why || '')) throw new Error('accepted: ' + JSON.stringify(more)); }
  let why = null; try { Persistable({ store: () => ({ me: async () => ({ id: 'x' }) }), key: 'link', space: 'k' }); } catch (e) { why = e.message; } if (!/no link keys/.test(why || '')) throw new Error('a store of the page\'s own took a key it does not keep');
  const m = memory(), things = Persistable({ store: (o, k) => m.make(o, k), space: 'here' }).collection('things');
  eq((await things.create({ mine: 1 }, { data: { theirs: 1 } })).data, { mine: 1 }, 'data');
  why = null; try { await things.create({}, { parent: '../x' }); } catch (e) { why = e.message; } if (!/an id is up to 80/.test(why || '')) throw new Error('a bad parent reached the store');
});
console.log(failed ? '\n' + failed + ' check(s) failed.' : '\nAll store checks passed.');
process.exit(failed ? 1 : 0);
