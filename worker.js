/*! Persistable.js 0.1.0 store · MIT · (c) 2026 Phil McClelland · https://github.com/PhilMcClelland/persistablejs */
/* Persistable.js: a small JSON object store for prototypes, in one file, for a Cloudflare Worker.
   Deploy it once to your own account (see SETUP.md) and any number of prototypes can keep shared data in it
   with a script tag and no API keys. There is nothing to keep running: the Worker sleeps when nobody is using it.

   Shape. Data is split into spaces (by default one per prototype address). A space holds collections; a collection
   holds objects:
     { id, owner, parent, created, updated, data: {…}, open: {…} }
   `data` can be changed only by whoever created the object; `open` can be changed by anyone. That one rule covers
   most prototypes: a comment's words are the author's, its "resolved" tick is everyone's.
   Deleting an object deletes the objects that name it as `parent`.

   Who is who. Each browser sends a random secret it made up; the store only ever keeps a fingerprint of it, as
   `owner`. The fingerprint is keyed with a random value each space makes up once and keeps, so the same secret is a
   different `owner` in every space, and a guess at a secret cannot be checked against an `owner` without asking the store.
   No accounts, no sign-in. Anyone who can reach the address can read and add; treat it like a shared doc with link
   access, not like a vault.

   A circle of trust. Add ?k=<key> to any address and the key becomes part of which space is meant: the same
   space name with another key, or with none, is a different and separate space. The store keeps no list of keys;
   a key works because nobody can guess it, so whoever was given it (in the prototype's link) is in. Inside a keyed
   space everyone is trusted: anyone may change `data` or delete, whoever created the object. `owner` is still
   recorded, so an app can go on showing who wrote what.

   Open to read, closed to write. Every key has a read key, a one-way hash of it. ?r=<read key> reaches the same
   space as ?k=<key> and may only GET and listen; anything else is refused. A keyed space is named after its read
   key, so the store still keeps no list, and the read key cannot be turned back into the key.

   The owner. Set ADMIN_SECRET (`npx wrangler@4 secret put ADMIN_SECRET`, 24 characters or more) and send it as the
   Bearer token: that caller may read, change and delete anything in the space an address reaches, list its
   collections, clear one, or remove the space whole. It is how abuse is taken down. A keyed space is still reached
   only with its key or read key in the address, and the store keeps no list of spaces, so the owner has to know which
   space is meant. Without ADMIN_SECRET set, nobody has this.

   Limits. An object's data is at most 100 KB as stored and its open part 8 KB; each nests at most 32 deep, counting
   the part itself as the first level; a collection holds at most 2000 objects and 16 MB; a space has at most 50
   collections and 200 listeners. The number of spaces has no limit.

   Addresses (all under /v1/s/<space>/):
     GET    <collection>            every object, oldest first
     POST   <collection>            add one         body { id?, parent?, data, open? }
     GET    <collection>/<id>       one object
     PATCH  <collection>/<id>       change one      body { data?, open? }   (keys set to null are removed)
     DELETE <collection>/<id>       remove one, and its children
     GET    _me                     { id } for the caller's secret, in this space
     GET    _collections            the collections in this space (the owner only; see below)
     DELETE <collection>?all=1      clear a whole collection (the owner only)
     GET    _watch                  WebSocket; sends the collection's name whenever something in it changes.
                                    With ?feed=2 it sends JSON instead: { collection, op, id, object? }, where op is
                                    create, update, delete or clear (the owner emptied the collection; no id), and
                                    object is the new state (absent for delete and clear, and for an object over
                                    8 KB as stored: GET it). Listeners only listen: one that sends anything but
                                    a keep-alive "ping" is closed.
   and, with nothing after the space:
     DELETE /v1/s/<space>?all=1     remove everything in the space and drop its listeners (the owner only)
   The two wide deletes are refused (400) without ?all=1, and an address with an empty part or a slash on the end is
   no address (404): an address that lost its last part on the way must not come to mean something wider. A method
   an address does not take is answered 405.

   Settings (optional): ALLOW_ORIGINS, a comma-separated list of page origins that may use this store. Without it
   any page may. With it, a page on this machine (http://localhost:8000) is turned away like any other until its
   origin is listed, and so is a page opened from a file, which says its origin is `null`. In wrangler.jsonc "vars",
   or as a secret. */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, KEY = /^[A-Za-z0-9_-]{16,200}$/;
const BAD_NAME = 'a collection name is up to 40 lower-case letters, digits, - and _, starting with a letter or digit';
const BAD_ID = 'an id is up to 80 letters, digits, . - and _, starting with a letter or digit';
const MAX_BYTES = 100 * 1024, MAX_OPEN = 8 * 1024, MAX_OBJECTS = 2000, MAX_SPACE_NAME = 200, DELETE_AT_ONCE = 128;
/* a request's body carries both parts and a little besides; each part is then measured on its own */
const MAX_BODY = MAX_BYTES + MAX_OPEN + 1024;
/* what one space may hold and carry, so a stranger cannot grow it past what the store can read back or the owner can afford */
const MAX_COLLECTION_BYTES = 16 * 1024 * 1024, MAX_COLLECTIONS = 50, MAX_LISTENERS = 200, MAX_DEPTH = 32;
/* a listener is sent a changed object only when it is small; a larger one it fetches, if it wants it */
const MAX_FEED_OBJECT = 8 * 1024;
/* sizes are bytes as stored (UTF-8), not characters: a limit in characters lets three times as much through */
const bytes = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' };
const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, CORS) });
const no = (status, message) => reply(status, { message });
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];
const wrong = () => no(405, 'this address does not take that method');
const NOBODY = '-';   // never an owner: an owner is 32 hex digits, or "owner"
const NO_SECRET = 'send a secret of 16 to 200 characters as a Bearer token';

/* the read key that goes with a key: the first 20 bytes of SHA-256 over a fixed label and the key, in hex.
   persistable.js computes the same thing, so a page can be given the read key and never the key. */
async function readKeyOf(key) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('persistable read key\n' + key))).slice(0, 40);
}
/* a body is read with a running count and dropped the moment it is too big, whatever length it claimed */
async function readCapped(request, most) {
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) { try { await reader.cancel(); } catch (_) { /* already closed */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}
/* What is wrong with a value's shape, or null: too deep to read back safely, or a key that would reach an object's
   prototype. Only objects and arrays count as a level. The body is level 0, so `data` and `open` are level 1. */
function misshapen(v, depth) {
  if (!v || typeof v !== 'object') return null;
  if (depth > MAX_DEPTH) return 'data and open can be nested at most ' + MAX_DEPTH + ' deep';
  for (const k of Object.keys(v)) {
    if (k === '__proto__') return 'a key cannot be named __proto__';
    const bad = misshapen(v[k], depth + 1); if (bad) return bad;
  }
  return null;
}
/* the owner's way in: ADMIN_SECRET, set with `npx wrangler@4 secret put`, sent as the Bearer token. Compared as hashes, so the
   time taken says nothing about how much of a guess was right. */
async function isAdmin(request, env) {
  const set = env && typeof env.ADMIN_SECRET === 'string' ? env.ADMIN_SECRET : '';
  const sent = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (set.length < 24 || !sent) return false;
  const [a, b] = await Promise.all([set, sent].map(v => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function merge(into, patch) {
  const out = Object.assign({}, into);
  for (const k of Object.keys(patch)) { if (patch[k] === null) delete out[k]; else out[k] = patch[k]; }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    /* "is it up?" is often asked with HEAD */
    if (url.pathname === '/' && request.method === 'HEAD') return new Response(null, { status: 200, headers: CORS });
    if (!METHODS.includes(request.method)) return wrong();
    if (url.pathname === '/') return reply(200, { service: 'persistable', v: 1 });
    /* An empty part (`…/votes/`, `…//`) is refused, not dropped. Dropped, `DELETE …/votes/` with its id missing would
       clear the collection, and an address shortened on the way would mean something wider than was asked. */
    let parts = url.pathname.split('/').slice(1);
    if (parts.includes('')) return no(404, 'no such address');
    try { parts = parts.map(decodeURIComponent); } catch (_) { return no(400, 'bad address'); }
    const space = parts[2];
    if (parts[0] !== 'v1' || parts[1] !== 's' || !space || space.length > MAX_SPACE_NAME || /[\u0000-\u001f]/.test(space) || parts.length > 5) return no(404, 'no such address');
    if (parts.length === 3 && request.method !== 'DELETE') return wrong();
    const k = url.searchParams.get('k'), r = url.searchParams.get('r');
    if ((k !== null && !KEY.test(k)) || (r !== null && !KEY.test(r))) return no(400, 'a key is 16 to 200 letters, digits, - and _');
    if (k !== null && r !== null) return no(400, 'send the key or the read key, not both');
    /* when a browser says which page is asking (it does on every write, and on reads from another site), it cannot lie about it: keep other sites out of a space named
       after a site, and out of the store altogether when ALLOW_ORIGINS is set */
    const origin = request.headers.get('Origin');
    if (origin) {
      const allowed = String(env.ALLOW_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);   // an origin has no trailing slash; forgive one
      if (allowed.length && !allowed.includes(origin)) return no(403, 'this page may not use this store');
      if (/^https?:\/\//.test(space) && space !== origin) return no(403, 'this space belongs to another site');
    }
    /* A keyed space is named after its READ key, which is a one-way hash of the key (a line break cannot occur in a
       space name, so the two never collide). So the key finds the space by being hashed, the read key finds it as it
       is, and the read key cannot be turned back into the key. No list of keys is kept anywhere. */
    const circle = k !== null ? await readKeyOf(k) : r;
    /* the space is told whether this is the owner, in a header no caller can set for themselves */
    const headers = new Headers(request.headers); headers.delete('X-Persistable-Admin');
    if (await isAdmin(request, env)) headers.set('X-Persistable-Admin', '1');
    try {
      return await env.SPACES.get(env.SPACES.idFromName(circle === null ? space : space + '\n' + circle)).fetch(new Request(request, { headers }));
    } catch (e) { console.error(e); return no(500, 'the store could not do that'); }
  }
};

/* One of these per space. Cloudflare keeps its storage, wakes it for a request, and lets it sleep between them. */
export class Space {
  constructor(ctx, env) {
    this.ctx = ctx; this.store = ctx.storage; this.env = env;
    /* answer keep-alive pings without waking up */
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async all(collection) {
    const found = await this.store.list({ prefix: 'o:' + collection + ':' });
    return [...found.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  }
  /* Who a caller is in this space: a fingerprint of their secret, keyed (HMAC-SHA-256) with a random value the space
     makes up once and keeps. Unkeyed, anyone could test guesses at a secret against the `owner` every reader sees,
     and the same secret would be the same `owner` in every space. Removing the space removes the value with it.
     The owner is "owner" whatever the secret's length, and its fingerprint is never stored. */
  async who(request, admin, make) {
    if (admin) return 'owner';
    const secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), text = new TextEncoder();
    if (secret.length < 16 || secret.length > 200) return null;
    if (!this.salt) this.salt = await this.store.get('salt');
    /* A space with no value yet holds nothing anyone made, so until someone asks who they are (_me) or adds something,
       a caller is nobody in particular and nothing is made up: a read, or a request that is refused, must not be what
       makes a space start keeping something. The new value is kept by keepSalt(), along with the write it is for. */
    if (!this.salt) { if (!make) return NOBODY; this.salt = hex(crypto.getRandomValues(new Uint8Array(32))); this.unkept = true; }
    const key = await crypto.subtle.importKey('raw', text.encode(this.salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, text.encode(secret))).slice(0, 32);
  }
  keepSalt() { if (!this.unkept) return null; this.unkept = false; return this.store.put('salt', this.salt); }
  /* Listeners that asked for feed=2 get what changed; the rest get the collection's name. A large object is left out
     and the listener fetches it if it wants it: sent along, a 16-byte change to `open` would push 100 KB to every
     listener, and anyone may change `open`. */
  tell(collection, op, id, object) {
    const all = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
    if (!all.length) return;
    const full = JSON.stringify({ collection, op, id, object: object && bytes(object) <= MAX_FEED_OBJECT ? object : undefined }), wantFull = new Set(this.ctx.getWebSockets('feed2'));
    for (const ws of all) { try { ws.send(wantFull.has(ws) ? full : collection); } catch (_) { /* that listener has gone */ } }
  }
  /* nothing a caller sends should be able to take the store down with an unhandled error: say so in JSON, and leave
     the error where `npx wrangler@4 tail` shows it */
  async fetch(request) {
    try { return await this.handle(request); } catch (e) { console.error(e); return no(500, 'the store could not do that'); }
  }
  /* How many objects a collection holds, and how many bytes: kept in two counters, so adding an object does not mean
     reading them all. Counted from the objects when a counter is missing.
     The counters are read here and written back by the caller, which is only safe because every `await` between the
     read and the write is a storage call: Cloudflare lets no other request into the object while one of those is
     waiting. Put any other wait in between (a fetch, a hash, a timer) and two requests could count from the same
     number. */
  async tally(collection) {
    const n = await this.store.get('n:' + collection), b = await this.store.get('b:' + collection);
    if (typeof n === 'number' && typeof b === 'number') return { n, b };
    let count = 0, sum = 0;
    for (const o of (await this.store.list({ prefix: 'o:' + collection + ':' })).values()) { count++; sum += bytes(o); }
    return { n: count, b: sum };
  }
  /* an emptied collection gives its place in the space back, and the last one leaves no list behind */
  async forget(collection) {
    const cols = ((await this.store.get('cols')) || []).filter(c => c !== collection);
    return Promise.all([this.store.delete(['n:' + collection, 'b:' + collection]), cols.length ? this.store.put('cols', cols) : this.store.delete('cols')]);
  }
  async handle(request) {
    const url = new URL(request.url), parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    const collection = parts[3], id = parts[4], method = request.method;
    const admin = request.headers.get('X-Persistable-Admin') === '1';   // the owner (ADMIN_SECRET): may read, change and delete anything
    const trusted = admin || url.searchParams.has('k');   // a keyed space: everyone who got this far was given the key
    const reading = !admin && url.searchParams.has('r');   // came with the read key: may look and listen, nothing else
    const wide = url.searchParams.getAll('all').join() === '1';   // a delete of more than one object has to say it means it
    if (reading && method !== 'GET') return no(403, 'the read key only reads');
    if (collection === undefined) {   // the owner removes the space whole; its listeners reconnect and read again
      if (method !== 'DELETE') return wrong();
      if (!admin) return no(403, 'only the owner can remove a space');
      if (!wide) return no(400, 'to remove a whole space, add ?all=1 to the address');
      await this.store.deleteAll(); this.salt = null; this.unkept = false;
      if (this.ctx.getWebSockets) for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'cleared'); } catch (_) { /* already gone */ } }
      return reply(204, null);
    }
    if (collection === '_collections' || collection === '_watch' || collection === '_me') {
      if (id !== undefined) return no(404, 'no such address');
      if (method !== 'GET') return wrong();
    }
    if (collection === '_collections') return admin ? reply(200, (await this.store.get('cols')) || []) : no(403, 'only the owner can list collections');
    if (collection === '_watch') {
      if (request.headers.get('Upgrade') !== 'websocket' || typeof WebSocketPair === 'undefined') return no(426, 'open this address as a WebSocket');
      if (this.ctx.getWebSockets && this.ctx.getWebSockets().length >= MAX_LISTENERS) return no(429, 'this space has all the listeners it can take');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], url.searchParams.get('feed') === '2' ? ['feed2'] : []);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (collection === '_me') { const me = await this.who(request, admin, true); if (me) await this.keepSalt(); return me ? reply(200, { id: me }) : no(401, NO_SECRET); }
    if (!NAME.test(collection)) return no(400, BAD_NAME);
    if (id !== undefined && !ID.test(id)) return no(400, BAD_ID);
    if (!(id === undefined ? ['GET', 'POST', 'DELETE'] : ['GET', 'PATCH', 'DELETE']).includes(method)) return wrong();
    const key = 'o:' + collection + ':' + id;

    if (method === 'GET') {
      if (id === undefined) return reply(200, await this.all(collection));
      const one = await this.store.get(key);
      return one ? reply(200, one) : no(404, 'missing');
    }
    /* worked out only now: a read needs no name */
    let who = await this.who(request, admin, false);
    if (!who) return no(401, NO_SECRET);
    let body = {};
    if (method !== 'DELETE') {
      /* refuse on the stated length before reading, and stop reading at the limit whatever was stated */
      if (Number(request.headers.get('Content-Length')) > MAX_BODY) return no(413, 'a request can be at most ' + MAX_BODY + ' bytes');
      const text = await readCapped(request, MAX_BODY);
      if (text === null) return no(413, 'a request can be at most ' + MAX_BODY + ' bytes');
      try { body = JSON.parse(text || '{}'); } catch (_) { return no(400, 'the body must be JSON'); }
      if (!plain(body) || ('data' in body && !plain(body.data)) || ('open' in body && !plain(body.open))) return no(400, 'data and open must be objects');
      const bad = misshapen(body, 0); if (bad) return no(400, bad);
    }
    const now = Date.now();

    if (method === 'POST') {
      if ((body.id != null && typeof body.id !== 'string') || (body.parent != null && typeof body.parent !== 'string')) return no(400, 'id and parent are strings');
      const newId = body.id == null ? crypto.randomUUID() : body.id, parent = body.parent == null ? null : body.parent;
      if (!ID.test(newId)) return no(400, BAD_ID);
      /* asked again here, after the body has arrived: the space may have been removed while it was on its way, and
         the object must be owned by who its creator is now. From here to the write every wait is a storage call. */
      who = await this.who(request, admin, true);
      const at = 'o:' + collection + ':' + newId;
      if (await this.store.get(at)) return no(409, 'that id is taken');
      if (parent !== null && !(ID.test(parent) && await this.store.get('o:' + collection + ':' + parent))) return no(400, 'no such parent');
      const made = { id: newId, owner: who, parent, created: now, updated: now, data: body.data || {}, open: body.open || {} };
      if (bytes(made.open) > MAX_OPEN) return no(413, 'the open part can be at most ' + MAX_OPEN + ' bytes');
      /* measured as stored, not as sent: a short body can stand for a long value */
      if (bytes(made.data) > MAX_BYTES) return no(413, 'an object\'s data can be at most ' + MAX_BYTES + ' bytes');
      const held = await this.tally(collection), size = bytes(made);
      if (held.n >= MAX_OBJECTS || held.b + size > MAX_COLLECTION_BYTES) return no(409, 'this collection is full');
      const cols = (await this.store.get('cols')) || [], isNew = !cols.includes(collection);
      if (isNew && cols.length >= MAX_COLLECTIONS) return no(409, 'this space has all the collections it can take');
      /* started together, with no wait between, so the storage commits them as one write: the counters cannot part from the objects */
      await Promise.all([this.store.put('n:' + collection, held.n + 1), this.store.put('b:' + collection, held.b + size), this.store.put(at, made), isNew ? this.store.put('cols', cols.concat(collection)) : null, this.keepSalt()]);
      this.tell(collection, 'create', newId, made);
      return reply(201, made);
    }
    if (id === undefined) {   // DELETE: the owner clears a whole collection
      if (!admin) return no(403, 'only the owner can clear a collection');
      if (!wide) return no(400, 'to clear a whole collection, add ?all=1 to the address');
      const keys = [...(await this.store.list({ prefix: 'o:' + collection + ':' })).keys()];
      for (let i = 0; i < keys.length; i += DELETE_AT_ONCE) await this.store.delete(keys.slice(i, i + DELETE_AT_ONCE));
      await this.forget(collection);
      this.tell(collection, 'clear', null);
      return reply(204, null);
    }
    const was = await this.store.get(key);
    if (!was) return no(404, 'missing');

    if (method === 'PATCH') {
      if (!('data' in body) && !('open' in body)) return no(400, 'send data, open or both');
      if ('data' in body && was.owner !== who && !trusted) return no(403, 'only whoever created this can change its data');
      const next = Object.assign({}, was, { updated: now });
      if ('data' in body) next.data = merge(was.data, body.data);
      if ('open' in body) next.open = merge(was.open, body.open);
      /* the open part is anyone's to change, so it has a small limit of its own: nobody can pad it until the author's
         own words no longer fit */
      if ('open' in body && bytes(next.open) > MAX_OPEN) return no(413, 'the open part can be at most ' + MAX_OPEN + ' bytes');
      if ('data' in body && bytes(next.data) > MAX_BYTES) return no(413, 'an object\'s data can be at most ' + MAX_BYTES + ' bytes');
      const held = await this.tally(collection), grown = held.b + bytes(next) - bytes(was);
      if (grown > MAX_COLLECTION_BYTES && grown > held.b) return no(409, 'this collection is full');
      await Promise.all([this.store.put('n:' + collection, held.n), this.store.put('b:' + collection, Math.max(0, grown)), this.store.put(key, next)]);
      this.tell(collection, 'update', id, next);
      return reply(200, next);
    }
    /* what is left is DELETE of one object */
    if (was.owner !== who && !trusted) return no(403, 'only whoever created this can delete it');
    const everything = await this.all(collection), gone = [id];
    for (let i = 0; i < gone.length; i++) for (const o of everything) if (o.parent === gone[i] && !gone.includes(o.id)) gone.push(o.id);
    /* storage deletes a limited number of keys in one call, so a long family goes in batches, children first:
       if a batch fails part way, what is left is still a whole tree and can be deleted again. The counters are
       written last, from what is left, so they never say less than is there. */
    const keys = gone.slice().reverse().map(g => 'o:' + collection + ':' + g), left = everything.filter(o => !gone.includes(o.id));
    for (let i = 0; i < keys.length; i += DELETE_AT_ONCE) await this.store.delete(keys.slice(i, i + DELETE_AT_ONCE));
    if (left.length) await Promise.all([this.store.put('n:' + collection, left.length), this.store.put('b:' + collection, left.reduce((sum, o) => sum + bytes(o), 0))]);
    else await this.forget(collection);
    for (const g of gone.reverse()) this.tell(collection, 'delete', g);   // children first
    return reply(204, null);
  }
  /* listeners only listen, so one that speaks is let go; its keep-alive "ping" is answered above and never gets here */
  webSocketMessage(ws) { try { ws.close(1008, 'listeners only listen'); } catch (_) { /* already gone */ } }
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch (_) { /* already closed */ } }
  webSocketError() { /* the browser reconnects on its own */ }
}
