// A stand-in for a Supabase project with stores/supabase.sql run in it: the sign-in endpoints and the functions, in
// Node, with the same rules. It lets the Supabase store be checked with no project (PERSISTABLE_VERIFY_MOCK=1). It
// cannot catch a mistake in the SQL itself: for that, run verify.mjs against a real project.
import crypto from 'node:crypto';
const rows = new Map(), people = new Map();   // "space\ncollection\nid" -> object;  access token -> uid
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
class No extends Error { constructor(status, message) { super(message); this.status = status; } }
const no = (status, message) => { throw new No(status, message); };
const size = v => Buffer.byteLength(JSON.stringify(v)), plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const deep = (v, d) => !!v && typeof v === 'object' && (d > 32 || Object.values(v).some(k => deep(k, d + 1)));
const part = p => { if (!plain(p)) no(400, 'data and open must be objects'); if (deep(p, 1)) no(400, 'data and open can be nested at most 32 deep'); if (JSON.stringify(p).includes('"__proto__":')) no(400, 'a key cannot be named __proto__'); };
const merge = (into, patch) => { const out = { ...into }; for (const k of Object.keys(patch)) { if (patch[k] === null) delete out[k]; else out[k] = patch[k]; } return out; };
const name = c => { if (typeof c !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(c)) no(400, 'a collection name is up to 40 lower-case letters, digits, - and _, starting with a letter or digit'); };
const ident = i => { if (typeof i !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(i)) no(400, 'an id is up to 80 letters, digits, . - and _, starting with a letter or digit'); };
const inColl = (s, c) => [...rows.entries()].filter(([k]) => k.startsWith(s + '\n' + c + '\n')).map(([, o]) => o);
function who(uid, space, origin) {
  if (!uid) no(401, 'sign in first (an anonymous sign-in counts)');
  if (typeof space !== 'string' || !space || space.length > 200 || /[\u0001-\u001f]/.test(space)) no(404, 'no such address');
  if (origin && /^https?:\/\//.test(space) && space !== origin) no(403, 'this space belongs to another site');
  return crypto.createHash('sha256').update(uid + '\n' + space).digest('hex').slice(0, 32);
}
const fns = {
  me: (me) => ({ id: me }),
  // a page at a time, about a megabyte, as the SQL does
  list: (me, a) => { name(a.collection);
    const all = inColl(a.space, a.collection).sort((x, y) => x.created - y.created || (x.id < y.id ? -1 : 1)), after = a.after;
    if (after != null && !(Array.isArray(after) && /^[0-9]{1,18}$/.test(String(after[0])) && typeof after[1] === 'string')) no(400, 'after is the next from the page before');
    const rest = after ? all.filter(o => o.created > after[0] || (o.created === after[0] && o.id > after[1])) : all, rows = []; let run = 0;
    for (const o of rest) { if (run >= 1048576) break; rows.push(o); run += size(o.data) + size(o.open) + 300; }
    return { rows, next: rows.length < rest.length ? [rows[rows.length - 1].created, rows[rows.length - 1].id] : null }; },
  get: (me, a) => { name(a.collection); ident(a.id); return rows.get([a.space, a.collection, a.id].join('\n')) || null; },
  create: (me, a) => {
    name(a.collection); const b = a.body;
    if (!plain(b)) no(400, 'data and open must be objects');
    if ((b.id != null && typeof b.id !== 'string') || (b.parent != null && typeof b.parent !== 'string')) no(400, 'id and parent are strings');
    const id = b.id == null ? crypto.randomUUID() : b.id, parent = b.parent == null ? null : b.parent; ident(id);
    const data = 'data' in b ? b.data : {}, open = 'open' in b ? b.open : {}; part(data); part(open);
    if (size(open) > 8192) no(413, 'the open part can be at most 8192 bytes');
    if (size(data) > 102400) no(413, 'an object\'s data can be at most 102400 bytes');
    const key = [a.space, a.collection, id].join('\n'), held = inColl(a.space, a.collection);
    if (rows.has(key)) no(409, 'that id is taken');
    if (parent !== null && !rows.has([a.space, a.collection, parent].join('\n'))) no(400, 'no such parent');
    if (held.length >= 2000 || held.reduce((n, o) => n + size(o.data) + size(o.open), 0) + size(data) + size(open) > 16777216) no(409, 'this collection is full');
    if (!held.length && new Set([...rows.keys()].filter(k => k.startsWith(a.space + '\n')).map(k => k.split('\n')[1])).size >= 50) no(409, 'this space has all the collections it can take');
    const now = Date.now(), made = { id, owner: me, parent, created: now, updated: now, data, open };
    rows.set(key, made); return made;
  },
  patch: (me, a) => {
    name(a.collection); ident(a.id); const p = a.parts;
    if (!plain(p)) no(400, 'data and open must be objects');
    if ('data' in p) part(p.data); if ('open' in p) part(p.open);
    const key = [a.space, a.collection, a.id].join('\n'), was = rows.get(key);
    if (!was) no(404, 'missing');
    if (!('data' in p) && !('open' in p)) no(400, 'send data, open or both');
    if ('data' in p && was.owner !== me) no(403, 'only whoever created this can change its data');
    const next = { ...was, updated: Math.max(Date.now(), was.updated + 1) };
    if ('data' in p) next.data = merge(was.data, p.data); if ('open' in p) next.open = merge(was.open, p.open);
    if ('open' in p && size(next.open) > 8192) no(413, 'the open part can be at most 8192 bytes');
    if ('data' in p && size(next.data) > 102400) no(413, 'an object\'s data can be at most 102400 bytes');
    rows.set(key, next); return next;
  },
  remove: (me, a) => {
    name(a.collection); ident(a.id);
    const was = rows.get([a.space, a.collection, a.id].join('\n'));
    if (!was) no(404, 'missing');
    if (was.owner !== me) no(403, 'only whoever created this can delete it');
    const gone = [a.id], all = inColl(a.space, a.collection);
    for (let i = 0; i < gone.length; i++) for (const o of all) if (o.parent === gone[i] && !gone.includes(o.id)) gone.push(o.id);
    for (const g of gone) rows.delete([a.space, a.collection, g].join('\n'));
  },
  pulse: (me, a) => { const out = {}; for (const [k, o] of rows) { const [s, c] = k.split('\n'); if (s !== a.space) continue; const [n, latest, total] = (out[c] || '0:0:0').split(':').map(Number); out[c] = (n + 1) + ':' + Math.max(latest, o.updated) + ':' + (total + o.updated); } return out; }
};
export default async function fetch(address, init = {}) {
  const url = new URL(address), headers = new Headers(init.headers), body = init.body ? JSON.parse(init.body) : {};
  if (!headers.get('apikey')) return reply(401, { message: 'No API key found in request' });
  if (url.pathname === '/auth/v1/signup' || url.pathname === '/auth/v1/token') {
    const uid = crypto.randomUUID(), access = 'access-' + crypto.randomUUID();
    people.set(access, uid);
    return reply(200, { access_token: access, refresh_token: 'refresh-' + crypto.randomUUID(), expires_in: 3600, user: { id: uid } });
  }
  const fn = (/^\/rest\/v1\/rpc\/persistable_([a-z]+)$/.exec(url.pathname) || [])[1];
  if (!fn || !fns[fn]) return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
  const most = fn === 'create' || fn === 'patch' ? 131072 : 4096;
  if (init.body && Buffer.byteLength(init.body) > most) return reply(413, { code: 'PT413', message: 'a request can be at most ' + most + ' bytes' });
  try {
    const uid = people.get((headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
    const out = fns[fn](who(uid, body.space, headers.get('Origin')), body);
    return out === undefined ? reply(204) : reply(200, out);
  } catch (e) { if (e instanceof No) return reply(e.status, { code: 'PT' + e.status, message: e.message }); throw e; }
}
