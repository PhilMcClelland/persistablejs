/*! Persistable.js 0.2.0 client · MIT · (c) 2026 Phil McClelland · https://github.com/PhilMcClelland/persistablejs */
/* Persistable.js: a shared JSON object store for prototypes, behind one script tag.
   This is the browser client: one interface, whichever store the objects are kept in. The store it comes with is
   worker.js in the same repo (PhilMcClelland/persistablejs), deployed once to the host's own Cloudflare account, with
   no API keys and no sign-in. Others are files loaded after this one (stores/supabase.js), chosen with the `store`
   option; docs/stores.md says what every store does and how to write one. What follows describes the Worker.
   This file is the source; copies of it in other projects are taken from here unchanged, so edit it here.

     <script src="persistable.js"></script>
     const db = Persistable({ url: 'the store address' });
     const votes = db.collection('votes');
     await votes.create({ choice: 'B' });          // -> { id, owner, parent, created, updated, data, open }
                                                   // create(data, { id, parent, open }): choose the id, hang it off another object
     await votes.list();                           // every object, oldest first
     await votes.get(id);                          // one object, or null if there is none
     await votes.update(id, { choice: 'C' });      // `data`: only whoever created it
     await votes.setOpen(id, { counted: true });   // `open`: anyone
     await votes.remove(id);                       // only its creator; takes anything created with { parent: id }
     db.watch((name, what) => { … }, up => { … }); // called when a collection changes (null: anything may have); returns a stop function.
                                                   // `what` is { collection, op: 'create'|'update'|'delete'|'clear', id, object? }
                                                   // ('clear': the owner emptied the collection). `object` is the new state;
                                                   // the store leaves it out of a delete, a clear, and any object over 8 KB
                                                   // (get(id) has it). The optional second function hears true and false as
                                                   // the connection comes and goes.
     votes.subscribe({ onCreate(o) {}, onUpdate(o) {}, onDelete(id) {}, onResync() {} });   // the same, sorted out per collection; returns a stop function.
                                                   // onCreate and onUpdate always get the object: a large one is fetched first.
                                                   // However many of these a page has, they share one connection.
                                                   // It hears changes from now on: call list() once for what is already there.
     await votes.patch(id, { data, open });        // both parts in one go
     db.onStatus(up => { … });                     // true or false each time the store starts or stops answering; returns a stop function.
                                                   // While it is down and someone is hearing, the client asks again by itself.
     await db.me();                                // { id }: this browser, as the store sees it in this space
     db.space                                      // the space in use
     await db.ready();                             // resolves when the store can be asked; only a store reached by token has anything to wait for

   Names and errors. A collection name is up to 40 lower-case letters, digits, - and _; an id is up to 80 letters,
   digits, . - and _; both start with a letter or digit. The client refuses any other before asking the store.
   When the store refuses something, the promise rejects with an Error that has `status` (the HTTP status, 403 say)
   and `detail` (the store's own message). When the store cannot be reached, the Error has neither.

   Who is who: each browser makes up a random secret once and keeps it in localStorage (under "persistable.<url>");
   the store only ever sees a fingerprint of it, which is the `owner` on what that browser creates. The fingerprint
   is made differently in every space, so the same browser is a different `owner` in each.

   Options: url (required by the Worker and by Supabase); store (which store: "worker" unless set); space (which set of data; defaults to the page's origin, so a prototype on a site of
   its own has its own with nothing to configure. Prototypes that share an origin, like two folders of one site or
   two projects on the same localhost port, share a space unless each passes its own. A page with no site, opened
   from a file, uses "default"); key and read (see below). For running outside a browser, or in a test: fetch,
   WebSocket (null for none) and storage (an object with getItem and setItem) stand in for the browser's own.

   A circle of trust. Without a key, anyone who finds the store can read and add, and only an object's creator can
   change its `data` or delete it. With one, the data is reachable only by people who have the key, and among them
   anyone may change or delete anything.
     key: 'link'   the key travels in the page's link, after the #. A browser never sends that part to the page's own server; this
                   client does send the key to the store, with every request, which is how the store knows the circle.
                   A visitor whose link has one joins that circle, and the browser remembers it. A visitor with none
                   starts a circle of their own, and the address bar becomes the link to share (db.link() returns it).
                   The first key a browser holds is the one it comes back to; a different link is followed for that
                   visit only, until the page calls db.adopt() to keep it. db.fresh() makes a new circle and returns
                   its link, which is how to leave people behind: nobody can be removed from the old one.
                   `location.href = db.fresh()` is all it takes to move there: when the address comes to carry
                   the key this browser now keeps, the client reloads the page, which starts again in that circle.
                   Someone else's link put into the same tab does nothing: open it in a new tab.
     key: '…'      a fixed key, 16+ letters, digits, - or _. Right when the page itself is behind a sign-in or a
                   password, since then only the people let in can read the page's source.
   db.key is the key in use (null without one).

   Open to read, closed to write. Every key has a read key: a one-way hash of it, which lets its holder read and
   listen and nothing else, and cannot be turned back into the key. Put the read key in a public page and send the
   key, in the link, only to the people who should write:
     read: '…'     the read key. With key: 'link', a visitor whose link carries the key writes as before; a visitor
                   without one reads, and starts no circle of their own. With no key option at all, everyone reads.
                   Once the browser holds the key it is taken out of the address bar, so the address a writer copies
                   to show the page around does not carry it; db.link() gives the link that does.
   Vouched for by your own site. When the page is on a site that already knows who its visitors are, its server can
   say so, and the store then takes the site's word for which space a visitor is in and who they are:
     token: () => fetch('/api/token').then(r => r.text())    a function that gets a token from your server
   The Worker only, and not with key, read or space: the token says all three. Your server signs the token with the
   secret it shares with the store (token.mjs in the persistablejs repo does it; docs/access.md has the whole of it).
   The client asks for a new one shortly before the old runs out. A space reached by token is its own: nobody reaches
   it without a token from your site, and inside it only an object's creator can change its `data` or delete it.
   await db.ready() waits for the first token; after it db.space is the token's space, db.readOnly says whether the
   token only reads, and db.name is the name your server gave, or null ((await db.me()).name has it too). All three
   follow the latest token. If the function fails (your server says this visitor is not let in), calls reject with
   that error, and one that has `status` keeps it; the server is then asked again less and less often, up to once a
   minute, so a visitor who signs in is noticed within that. While a token in hand is still good it goes on being used.
   db.readOnly says which this visitor is. await db.readKey() gives the read key for the key in use (to copy into a
   page); the same value comes from `node readkey.mjs -` in the persistablejs repo, which reads the key from
   standard input. */
(function (root) {
  'use strict';
  var hex = function (bytes) { return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); };
  /* a secret or a key is only as good as its randomness: with no real source of it, stop rather than make a guessable one */
  var random = function (n) {
    var bytes = new Uint8Array(n);
    if (!root.crypto || typeof root.crypto.getRandomValues !== 'function') throw new Error('persistable: this browser has no secure random numbers, so no key or secret can be made');
    root.crypto.getRandomValues(bytes);
    return hex(bytes);
  };
  /* What every store shares: the names, the checks made before a store is asked, who hears what, and whether the store
     is answering. The store itself (where the objects are kept, and how it is reached) is `opt.store`: the name of one
     that is loaded ("worker", the default, is in this file) or a function that makes one. docs/stores.md has the contract. */
  function make(opt) {
    opt = opt || {};
    var pick = opt.store == null ? 'worker' : opt.store;
    var build = typeof pick === 'function' ? pick : (typeof pick === 'string' && Object.prototype.hasOwnProperty.call(make.stores, pick)) ? make.stores[pick] : null;
    if (!build) throw new Error('persistable: no store named "' + pick + '" is loaded (its file goes after persistable.js)');
    /* a page with no real site (opened from a file, or in a sandboxed frame) has an origin of "null" in one browser and
       "file://" in another: anything that is not a web address counts as none */
    var origin = root.location && root.location.origin, space = String(opt.space || (/^http/.test(origin || '') ? origin : 'default'));
    var box = opt.storage;
    /* where storage is blocked, reading the property itself throws: go on with none, as a new person each visit */
    if (!box) { try { box = root.localStorage; } catch (_) { box = null; } }
    if (!box) box = { getItem: function () { return null; }, setItem: function () {} };
    /* Is the store answering? Every request says: an answer, even a refusal, means it is up; no answer, or the store's own
       failure (500 and over), means it is not. onStatus(fn) hears each change, and the last known state at once if there
       is one. What to do about it is the page's business.
       A page that has stopped asking would never hear the store come back, so while it is down and someone is hearing,
       the client asks the store who it is now and then, more slowly each time, and stops when an answer comes. */
    var up = null, hearers = [], probe = null, pause = 5000;
    function mark(now) {
      if (now) { clearTimeout(probe); probe = null; pause = 5000; }
      if (now !== up) { up = now; hearers.slice().forEach(function (fn) { try { fn(now); } catch (_) { /* a hearer's own trouble */ } }); }
      if (!now) ask();
    }
    function ask() {
      if (probe || up !== false || !hearers.length) return;
      probe = setTimeout(function () {
        probe = null; pause = Math.min(pause * 2, 60000);
        /* mark() hears a store that does not answer, and asks again. A call that never reached the store (no token to
           send, say) tells it nothing, so the next question is set here. */
        if (up === false && hearers.length) store.me().catch(function () { ask(); });
      }, pause);
    }
    function onStatus(fn) {
      hearers.push(fn); if (up !== null) { try { fn(up); } catch (_) { /* as above */ } }
      ask();
      return function () { hearers = hearers.filter(function (h) { return h !== fn; }); if (!hearers.length) { clearTimeout(probe); probe = null; pause = 5000; } };
    }
    var store = build(opt, { root: root, space: space, storage: box, fetch: opt.fetch || root.fetch.bind(root), random: random, hex: hex, mark: mark });
    /* the same for a token: a store that ignored it would put the visitor in the open space named after the page. And a
       token option that is there with nothing in it (a function that was never defined) is a mistake, not a choice. */
    if (Object.prototype.hasOwnProperty.call(opt, 'token') && typeof opt.token !== 'function') throw new Error('persistable: token is a function that returns a token from your server');
    if (opt.token != null && !store.token) throw new Error('persistable: this store takes no tokens');
    /* a key asked for and not kept would be a page that thinks its data is among friends when it is open to all */
    if ((opt.key || opt.read) && !store.key && !store.readOnly) throw new Error('persistable: this store has no link keys or read keys');
    /* The store's own patterns for a collection name and an id. They are checked here as well, before either becomes
       part of an address: "a/b" or ".." in an address would name some other address, not a wrong one. */
    var NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
    var BAD_ID = 'persistable: an id is up to 80 letters, digits, . - and _, starting with a letter or digit';
    function collection(name) {
      if (typeof name !== 'string' || !NAME.test(name)) throw new Error('persistable: a collection name is up to 40 lower-case letters, digits, - and _, starting with a letter or digit');
      var okId = function (id) { return typeof id === 'string' && ID.test(id); };
      var one = function (id, go) { return okId(id) ? go() : Promise.reject(new Error(BAD_ID)); };
      var get = function (id) { return one(id, function () { return store.get(name, id); }); };
      var patch = function (id, parts) { return one(id, function () { return store.patch(name, id, parts); }); };
      return {
        list: function () { return store.list(name); },
        get: get,   // null when there is no such object
        create: function (data, more) {
          if (more && ((more.id != null && !okId(more.id)) || (more.parent != null && !okId(more.parent)))) return Promise.reject(new Error(BAD_ID));
          return store.create(name, Object.assign({}, more || {}, { data: data || {} }));
        },
        update: function (id, data) { return patch(id, { data: data }); },
        setOpen: function (id, open) { return patch(id, { open: open }); },
        patch: patch,
        remove: function (id) { return one(id, function () { return store.remove(name, id); }); },
        /* What changed in this collection, as it happens. onResync: the connection came back, or the store can only
           say that something here changed, so read it again.
           The store leaves a large object out of what it sends, so that one is fetched first. While one is being
           fetched the changes behind it wait their turn, so they still arrive in order. */
        subscribe: function (on) {
          var line = null, off = false, due = Object.create(null), last = Object.create(null);   // keyed by ids, and "constructor" is an id
          /* never an older state after a newer one: a fetched object is the store's present state, and a small change
             queued behind the fetch still carries what the object was before */
          var give = function (fn, o) { if (off || (last[o.id] && o.updated < last[o.id])) return; last[o.id] = o.updated; fn.call(on, o); };
          var hand = function (what) {
            if (off) return null;
            if (!what || what.op === 'clear') { if (on.onResync) on.onResync(); return null; }   // reconnected, or the owner cleared the collection
            if (what.op === 'delete') { delete last[what.id]; if (on.onDelete) on.onDelete(what.id); return null; }
            /* A large object is left out of what is sent, and fetched. Many changes to one in a row are one fetch, made
               when the last of them comes up: anyone may change `open`, and a page must not be made to download 100 KB
               for each change they send. */
            if (!what.object && due[what.id]) { if (--due[what.id] > 0) return null; delete due[what.id]; }
            var fn = what.op === 'create' ? on.onCreate : what.op === 'update' ? on.onUpdate : null;
            if (!fn) return null;
            if (what.object) { give(fn, what.object); return null; }
            /* gone again already: its delete is on the way. No answer: say "read it again" rather than nothing */
            return get(what.id).then(function (o) { if (o) give(fn, o); }, function () { if (!off && on.onResync) on.onResync(); });
          };
          var stop = watch(function (changed, what) {
            if (changed !== null && changed !== name) return;
            if (!what) what = null;   // a store that cannot say what changed says only where: read it again
            if (what && !what.object && (what.op === 'create' || what.op === 'update')) due[what.id] = (due[what.id] || 0) + 1;
            var p = line ? line.then(function () { return hand(what); }) : hand(what);
            if (!p) return;
            var mine = line = p.then(null, function (e) { setTimeout(function () { throw e; }, 0); });   // a handler's error, where the console will show it
            mine.then(function () { if (line === mine) line = null; });
          });
          return function () { off = true; stop(); };
        }
      };
    }
    /* Hearing what changed. Every watch() and subscribe() on this db shares one line to the store: a store takes a
       limited number of listeners, and a page should count as one. It opens with the first watcher and closes with the
       last. A store that pushes changes says what changed, as { collection, op, id, object? }. One that cannot is asked
       every few seconds (opt.poll, 4000 ms unless set) which collections have changed, and says only their names. When
       the line comes back after a break, watchers hear "changed" with no name, since anything may have been missed. */
    var watchers = [], hang = null, live = false, before = false;
    /* one watcher's error must not keep the news from the rest; it is thrown again where the console will show it */
    function each(fn) { watchers.slice().forEach(function (w) { try { fn(w); } catch (e) { setTimeout(function () { throw e; }, 0); } }); }
    var ear = {
      state: function (on) {
        live = !!on;
        if (on) mark(true);
        each(function (w) { if (w.state) w.state(live); });
        if (on) { if (before) each(function (w) { w.change(null); }); before = true; }
      },
      change: function (name, what) { each(function (w) { w.change(name, what); }); }
    };
    function asking(ear) {
      var seen = null, off = false, busy = false, okay = false, asked = 0;
      function beat() {
        if (busy && Date.now() - asked > 30000) busy = false;   // an answer that never came must not be the last question
        if (off || busy || (root.document && root.document.hidden)) return;   // a page nobody is looking at asks nothing
        busy = true; asked = Date.now();
        store.pulse().then(function (now) {
          busy = false; if (off) return;
          now = now && typeof now === 'object' ? now : {};
          if (!okay) { okay = true; ear.state(true); }
          if (seen) Object.keys(Object.assign({}, seen, now)).forEach(function (name) { if (seen[name] !== now[name]) ear.change(name); });
          seen = now;
        }, function () { busy = false; if (!off && okay) { okay = false; ear.state(false); } });
      }
      var timer = setInterval(beat, Math.max(250, Number(opt.poll) || 4000)); beat();
      return function () { off = true; clearInterval(timer); };
    }
    var listen = typeof store.listen === 'function' ? function (e) { return store.listen(e); } : typeof store.pulse === 'function' ? asking : null;
    function watch(onChange, onState) {
      if (!listen) return function () {};
      var w = { change: onChange, state: onState };
      watchers.push(w);
      if (watchers.length === 1) hang = listen(ear);
      else if (live && onState) setTimeout(function () { if (live && watchers.indexOf(w) >= 0) onState(true); }, 0);   // the line is already up: say so
      return function () {
        watchers = watchers.filter(function (x) { return x !== w; });
        if (watchers.length) return;
        live = false; before = false;
        var stop = hang; hang = null;
        if (stop) stop();
      };
    }
    var no = function (v) { return function () { return v; }; };
    var db = { space: space, key: store.key || null, readOnly: !!store.readOnly, readKey: store.readKey || no(Promise.resolve(null)), link: store.link || no(null), adopt: store.adopt || no(false), fresh: store.fresh || no(null),
      collection: collection, watch: watch, onStatus: onStatus, me: function () { return store.me(); } };
    /* A store that learns its space and what the visitor may do only when it first asks (one reached by token) says so
       with told(): ready() waits for that, and the two properties then say what was learned. Any other store is ready at once. */
    db.name = null;
    db.ready = function () { return Promise.resolve(typeof store.told === 'function' ? store.told() : null).then(function () { return db; }); };
    /* such a store's space, and what the visitor may do, are whatever its latest token says: asked each time they are read */
    if (typeof store.says === 'function') {
      var say = function (key, before) { Object.defineProperty(db, key, { enumerable: true, get: function () { var now = store.says(); return now ? now[key] : before; } }); };
      say('space', space); say('readOnly', false); say('name', null);
    }
    return db;
  }

  /* The store that comes with this file: worker.js from the same repo, on the host's own Cloudflare account, reached
     over HTTP and a WebSocket. Options: url (required), key and read. */
  function worker(opt, kit) {
    var space = kit.space, box = kit.storage, mark = kit.mark, Socket = opt.WebSocket === undefined ? root.WebSocket : opt.WebSocket;
    var url = String(opt.url || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('persistable: url is required');
    if (opt.token != null) {
      if (typeof opt.token !== 'function') throw new Error('persistable: token is a function that returns a token from your server');
      if (opt.key || opt.read || opt.space) throw new Error('persistable: with a token, leave out key, read and space: the token says them');
      return byToken(opt, kit, url, Socket);
    }
    var base = url + '/v1/s/' + encodeURIComponent(space) + '/', SLOT = 'persistable.' + url;
    /* The read key that goes with a key: the first 20 bytes of SHA-256 over a fixed label and the key, in hex. worker.js
       and readkey.mjs compute the same thing. SHA-256 is written out here because the browser's own is asynchronous and
       unavailable on plain http pages, and which circle a visitor is in has to be known before anything else happens. */
    function sha256(text) {
      var i, H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
      var src = new TextEncoder().encode(text), len = src.length, total = ((len + 9 + 63) >> 6) << 6, msg = new Uint8Array(total), view = new DataView(msg.buffer);
      msg.set(src); msg[len] = 0x80; view.setUint32(total - 8, Math.floor(len / 536870912)); view.setUint32(total - 4, (len << 3) >>> 0);
      var w = new Int32Array(64), rot = function (x, r) { return (x >>> r) | (x << (32 - r)); };
      for (var at = 0; at < total; at += 64) {
        for (i = 0; i < 16; i++) w[i] = view.getInt32(at + i * 4);
        for (i = 16; i < 64; i++) { var a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) | 0; }
        var s = H.slice();
        for (i = 0; i < 64; i++) {
          var t1 = (s[7] + (rot(s[4], 6) ^ rot(s[4], 11) ^ rot(s[4], 25)) + ((s[4] & s[5]) ^ (~s[4] & s[6])) + K[i] + w[i]) | 0;
          var t2 = ((rot(s[0], 2) ^ rot(s[0], 13) ^ rot(s[0], 22)) + ((s[0] & s[1]) ^ (s[0] & s[2]) ^ (s[1] & s[2]))) | 0;
          s = [(t1 + t2) | 0, s[0], s[1], s[2], (s[3] + t1) | 0, s[4], s[5], s[6]];
        }
        for (i = 0; i < 8; i++) H[i] = (H[i] + s[i]) | 0;
      }
      var out = new Uint8Array(32), ov = new DataView(out.buffer);
      for (i = 0; i < 8; i++) ov.setInt32(i * 4, H[i]);
      return out;
    }
    var readKeyOf = function (k) { return hex(sha256('persistable read key\n' + k).slice(0, 20)); };

    /* the circle's key: from the link if it has one, else the one this browser used last, else a new circle */
    var key = opt.key ? String(opt.key) : null;
    var wanted = opt.read ? String(opt.read) : null;   // the page's read key, if it has one
    /* on a page with a read key, a key counts only if it is that page's key: any other would put the visitor in someone
       else's circle while the page still looked like this one */
    var fits = function (k) { return /^[A-Za-z0-9_-]{16,200}$/.test(k) && (!wanted || readKeyOf(k) === wanted); };
    var KSLOT = null, loc = root.location;
    var remember = function (k) { try { box.setItem(KSLOT, k); return box.getItem(KSLOT) === k; } catch (_) { return false; } };
    if (key === 'link') {
      KSLOT = 'persistable.key.' + url + '|' + space;
      var hash = (loc && loc.hash) || '', IN_LINK = /(^#|[&?\/])k=([A-Za-z0-9_-]{16,200})(?=$|[&\/])/;
      var inLink = IN_LINK.exec(hash), linked = inLink && fits(inLink[2]) ? inLink[2] : null, kept = null;
      try { kept = box.getItem(KSLOT); } catch (_) { kept = null; }
      if (kept && !fits(kept)) kept = null;
      /* A link's key is used for this visit. It is remembered only when nothing else is: someone else's link must not
         quietly replace the circle this browser already had, or its own notes would be out of reach from then on.
         db.adopt() is how a page says "this one from now on". */
      key = linked || kept;
      if (!key && !wanted) key = random(24);   // a page with a read key does not start a circle for a visitor who has no link: they read
      var held = !!key && (kept === key || (!kept && remember(key)));
      if (key && !wanted && loc && !hash) {
        /* make the address bar the link to share, unless the page uses the # for something of its own */
        try { root.history.replaceState(root.history.state, '', '#k=' + key); } catch (_) { /* not allowed here */ }
      } else if (linked && wanted && held && loc) {
        /* On a page with a read key the address bar is what people copy to show the page around, so once the browser
           holds the key, take it out of the address. Where nothing can be kept, it stays: it is all this visitor has. */
        var rest = hash.replace(IN_LINK, '$1').replace(/[&?\/]$/, '').replace(/^#&/, '#');
        try { root.history.replaceState(root.history.state, '', rest.length > 1 ? rest : String(loc.href).split('#')[0]); } catch (_) { /* not allowed here */ }
      }
      /* The link was read once, above, and everything made since belongs to that circle. So when the address under the
         page comes to carry the key this browser now keeps (`location.href = db.fresh()`, or after db.adopt() elsewhere),
         load the page again and let it start in that one. Only that key: a link to someone else's circle, clicked or
         pasted into this tab, must not throw away what is on the page and move it there. Open such a link in a new tab.
         (On a page with a read key the only key that counts is the page's own, so there it is followed: a reader
         handed the link becomes a writer.) */
      if (loc && typeof root.addEventListener === 'function') root.addEventListener('hashchange', function () {
        var now = IN_LINK.exec(String(loc.hash || '')), mine = null;
        try { mine = box.getItem(KSLOT); } catch (_) { mine = null; }
        if (now && now[2] !== key && fits(now[2]) && (wanted || now[2] === mine)) { try { loc.reload(); } catch (_) { /* not allowed here */ } }
      });
    } else if (key !== null && wanted && !fits(key)) throw new Error('persistable: this key does not go with this read key');
    if (key !== null && !/^[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error('persistable: a key is 16 to 200 letters, digits, - and _');
    /* without the key, a read key (if the page has one) is what this visitor holds */
    var read = !key && opt.read ? String(opt.read) : null;
    if (read !== null && !/^[A-Za-z0-9_-]{16,200}$/.test(read)) throw new Error('persistable: a read key is 16 to 200 letters, digits, - and _');
    var query = function (more) { var q = [].concat(key ? ['k=' + key] : read ? ['r=' + read] : [], more || []); return q.length ? '?' + q.join('&') : ''; };
    /* the read key for the key in use (the page's own, for a reader), as a promise */
    function readKey() { return Promise.resolve(read || (key ? readKeyOf(key) : null)); }
    var linkFor = function (k) { return loc ? String(loc.href).split('#')[0] + '#k=' + k : null; };
    function link() { return key ? linkFor(key) : null; }
    /* Changing circles, with key: 'link'. adopt() remembers the key in use in place of whichever was remembered, so this
       browser comes back to this circle. fresh() makes a new key, remembers it and returns its link; go to that link
       (the page reloads itself, see above) to be in the new, empty circle. Not on a page with a read key, whose circle
       is fixed by the page. */
    function adopt() { return !!(KSLOT && key) && remember(key); }
    function fresh() { if (!KSLOT || wanted || !loc) return null; var k = random(24); return remember(k) ? linkFor(k) : null; }

    /* this browser's secret: made up here, kept here; the store only keeps a fingerprint of it */
    var secret = null;
    try { secret = box.getItem(SLOT); } catch (_) { secret = null; }
    if (!secret) {
      secret = random(24);
      try { box.setItem(SLOT, secret); } catch (_) { /* a new identity each visit */ }
    }
    /* A refusal is thrown as an Error that also carries `status` (the HTTP status) and `detail` (the store's own words,
       or null), so a page can tell a 403 from a 409 without reading the message. No answer at all has neither. */
    function call(method, path, body, what) {
      var init = { method: method, headers: { Authorization: 'Bearer ' + secret } };
      if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      return kit.fetch(base + path + query(), init).then(function (r) { mark(r.status < 500); return r; }, function (e) { mark(false); throw e; }).then(function (r) {
        if (r.status === 204) return null;
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = null; }
          if (!r.ok) { var e = new Error('persistable: ' + what + ' failed (' + r.status + ') ' + ((j && j.message) || '')); e.status = r.status; e.detail = (j && j.message) || null; throw e; }
          return j;
        });
      });
    }
    /* The store says what changed. If the line drops, try again, more slowly each time. */
    function listen(ear) {
      var ws = null, wait = 2000, timer = null, beat = null, off = false;
      function open() {
        if (off) return;
        var mine;
        try { mine = ws = new Socket(base.replace(/^http/, 'ws') + '_watch' + query('feed=2')); } catch (_) { retry(); return; }
        /* `mine !== ws` means this socket was let go (the last watcher stopped) and has nothing more to say */
        mine.onopen = function () {
          if (mine !== ws) return;
          wait = 2000; ear.state(true);
          beat = setInterval(function () { try { mine.send('ping'); } catch (_) { /* closing */ } }, 30000);
        };
        mine.onmessage = function (e) {
          if (mine !== ws) return;
          var text = String(e.data), what = null;
          mark(true);   // anything heard on the line means the store is there
          if (text === 'pong') return;
          if (text.charAt(0) === '{') { try { what = JSON.parse(text); } catch (_) { what = null; } }
          if (what && what.collection) ear.change(what.collection, what); else ear.change(text);
        };
        mine.onclose = function () {
          if (mine !== ws) return;
          clearInterval(beat); ear.state(false);
          call('GET', '_me', undefined, 'whoami').catch(function () { /* mark() has heard */ });   // a dropped line is not proof: ask, and let the answer say
          retry();
        };
        mine.onerror = function () { try { mine.close(); } catch (_) { /* never opened */ } };
      }
      function retry() { if (off) return; clearTimeout(timer); timer = setTimeout(open, wait); wait = Math.min(wait * 2, 60000); }
      open();
      return function () {
        off = true; clearTimeout(timer); clearInterval(beat);
        var old = ws; ws = null;
        try { old.close(); } catch (_) { /* not open */ }
      };
    }
    var at = function (name, id) { return name + '/' + id; };
    return {
      key: key, readOnly: read !== null, readKey: readKey, link: link, adopt: adopt, fresh: fresh,
      me: function () { return call('GET', '_me', undefined, 'whoami'); },
      list: function (name) { return call('GET', name, undefined, 'list'); },
      /* null for the store's own "no such object", not for any 404 on the way */
      get: function (name, id) { return call('GET', at(name, id), undefined, 'get').catch(function (e) { if (e.status === 404 && e.detail === 'missing') return null; throw e; }); },
      create: function (name, body) { return call('POST', name, body, 'create'); },
      patch: function (name, id, parts) { return call('PATCH', at(name, id), parts, 'update'); },
      remove: function (name, id) { return call('DELETE', at(name, id), undefined, 'remove'); },
      listen: Socket ? listen : undefined
    };
  }

  /* The same store, reached by a token from the page's own site (see "Vouched for by your own site" at the top).
     Nothing is kept in the browser: who the visitor is, and which space they are in, is in the token, and the token is
     asked for again each visit. What the token says is read here only to know where to send it and when to renew it;
     whether it is true is the store's to check. */
  function byToken(opt, kit, url, Socket) {
    var mark = kit.mark, held = null, asking = null, first = null;
    /* A token is renewed a little before it runs out, so none is sent in its last moments: 30 seconds before, or a
       quarter of its life when that is less. How long it has is counted from when it arrived, by the token's own
       account of its life (exp less iat), so a browser whose clock is wrong still keeps it for as long as it is good.
       A token that does not say when it was made is timed by the browser's clock when that gives a believable answer,
       and otherwise kept for a minute. */
    var SOON = 30000, PATIENCE = 20000;   // and a site that does not answer is not waited on for ever
    function unpack(token) {
      var parts = typeof token === 'string' ? token.trim().split('.') : [], claim = null;
      try {
        var b = parts[1].replace(/-/g, '+').replace(/_/g, '/'), raw = kit.root.atob(b + '==='.slice((b.length + 3) % 4));
        claim = JSON.parse(decodeURIComponent(raw.replace(/[^]/g, function (c) { return '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2); })));
      } catch (_) { claim = null; }
      /* only the letters a token is made of go into an address: anything else would be read there as something more */
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.trim()) || !claim || typeof claim !== 'object' || typeof claim.space !== 'string' || !claim.space || typeof claim.exp !== 'number') throw new Error('persistable: the token function did not return a token (a JWT with space and exp)');
      var life = typeof claim.iat === 'number' && claim.exp > claim.iat ? (claim.exp - claim.iat) * 1000 : claim.exp * 1000 - Date.now();
      if (!(life >= 5000 && life <= 3660000)) life = 60000;
      return { token: token.trim(), space: claim.space, until: tick() + life, ahead: Math.min(SOON, life / 4), name: typeof claim.name === 'string' ? claim.name : null, readOnly: claim.read === true && claim.owner !== true };
    }
    /* The token in hand, or a new one: asked for once however many calls are waiting on it.
       `refused` is a token the store has just turned down: if a newer one is already in hand that is the answer, and
       otherwise the site is asked. A site that fails to hand one over is not asked again at once: a page that goes on
       calling (a signed-out tab that polls) would ask it without end, so the failure stands for a while, longer each
       time. And while the token in hand is still good, a failed renewal is no reason to stop using it. */
    var failed = null, rest = 0, restUntil = 0, last = null, shunErr = null, shun = 0, shunUntil = 0;
    /* time for "how long since": the page's own steady count where there is one, since the clock on the wall can be set */
    var tick = function () { var p = kit.root.performance; return p && typeof p.now === 'function' ? p.now() : Date.now(); };
    function spurn(e) { failed = e; rest = Math.min(rest ? rest * 2 : 2000, 60000); restUntil = tick() + rest; }
    function ticket(refused) {
      var now = tick();
      if (refused && held && held.token === refused) held = null;
      /* the store has turned this site's tokens down twice running: until its rest is over, another would fare no better */
      if (shunErr && now < shunUntil) return Promise.reject(shunErr);
      if (held && held.until - now > held.ahead) return Promise.resolve(held);
      if (asking) return asking;
      if (failed && now < restUntil) return held && held.until > now ? Promise.resolve(held) : Promise.reject(failed);
      var timer = null, late = new Promise(function (_, fail) { timer = setTimeout(function () { fail(new Error('persistable: the token function did not answer in time')); }, PATIENCE); if (timer && timer.unref) timer.unref(); });
      /* everyone waiting gets the same answer, the fallback included */
      var mine = asking = Promise.race([Promise.resolve().then(function () { return opt.token(); }), late]).then(unpack).then(function (got) {
        /* the page was drawn from one space's data: a token for another (the visitor changed group in another tab) is
           refused, and asked for again later, when the site may say the first space once more */
        if (first && got.space !== first) throw new Error('persistable: the token is for another space than the page started in; load the page again');
        clearTimeout(timer); if (asking === mine) asking = null;
        first = got.space; held = last = got; failed = null; rest = 0;
        return got;
      }, null).then(null, function (e) {
        clearTimeout(timer); if (asking === mine) asking = null;
        spurn(e);
        if (held && held.until > tick()) return held;
        throw e;
      });
      return mine;
    }
    var where = function (t, path, more) { return url + '/v1/s/' + encodeURIComponent(t.space) + '/' + path + '?token=' + t.token + (more ? '&' + more : ''); };
    function call(method, path, body, what, refused) {
      return ticket(refused).then(function (t) {
        var init = { method: method, headers: {} };
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        return kit.fetch(where(t, path), init).then(function (r) { mark(r.status < 500); return r; }, function (e) { mark(false); throw e; }).then(function (r) {
          if (r.status === 204) return null;
          /* the store no longer takes this token (its clock is ahead of ours, say): ask the site for another, once */
          if (r.status === 401 && !refused) return call(method, path, body, what, t.token);
          /* refused twice running: the store does not take this site's tokens just now (the two do not share a secret,
             or the site's clock is far out). Asking the site again for every call would not change that, so it rests
             as it does when the site itself fails. */
          /* (its rest is counted apart from the site's, and only an answer from the store that is not a refusal ends
             it: the site goes on handing tokens over without trouble all the while, the same one each time if it likes.
             Calls refused together count once: the first starts the rest, and the others find it started.) */
          if (r.status === 401) {
            if (held && held.token === t.token) held = null;
            if (!(shunErr && tick() < shunUntil)) { shun = Math.min(shun ? shun * 2 : 2000, 60000); shunErr = new Error('persistable: the store refused the token the site gave'); shunErr.status = 401; shunUntil = tick() + shun; }
          } else { shun = 0; shunErr = null; }
          return r.text().then(function (text) {
            var j = null; try { j = text ? JSON.parse(text) : null; } catch (_) { j = null; }
            if (!r.ok) { var e = new Error('persistable: ' + what + ' failed (' + r.status + ') ' + ((j && j.message) || '')); e.status = r.status; e.detail = (j && j.message) || null; throw e; }
            return j;
          });
        });
      });
    }
    /* The line to the store carries the token it was opened with, and the store closes it when that runs out. So it is
       opened again with a new token a little before: watchers hear the line come back, and read again. */
    function listen(ear) {
      var ws = null, wait = 2000, timer = null, beat = null, renew = null, off = false, renewing = false;
      function open() {
        if (off) return;
        ticket().then(function (t) {
          if (off) return;
          var mine;
          try { mine = ws = new Socket(where(t, '_watch', 'feed=2').replace(/^http/, 'ws')); } catch (_) { retry(); return; }
          mine.onopen = function () {
            if (mine !== ws) return;
            wait = 2000; ear.state(true);
            beat = setInterval(function () { try { mine.send('ping'); } catch (_) { /* closing */ } }, 30000);
            /* only a token with time in hand: one already in its last moments is here because no newer one could be
               had, and closing the line for it would open the same line again, over and over. It stays until the store
               closes it, and the next is opened the slow way. */
            var left = t.until - tick() - t.ahead;
            if (left > 0) renew = setTimeout(function () { renewing = true; try { mine.close(); } catch (_) { /* closing */ } }, Math.max(1000, left));
          };
          mine.onmessage = function (e) {
            if (mine !== ws) return;
            var text = String(e.data), what = null;
            mark(true);
            if (text === 'pong') return;
            if (text.charAt(0) === '{') { try { what = JSON.parse(text); } catch (_) { what = null; } }
            if (what && what.collection) ear.change(what.collection, what); else ear.change(text);
          };
          mine.onclose = function () {
            if (mine !== ws) return;
            clearInterval(beat); clearTimeout(renew); ear.state(false);
            /* closed here to change tokens: open again at once. Watchers hear the line come back and read again, so
               nothing said in between is missed. */
            if (renewing) { renewing = false; open(); return; }
            call('GET', '_me', undefined, 'whoami').catch(function () { /* mark() has heard */ });
            retry();
          };
          mine.onerror = function () { try { mine.close(); } catch (_) { /* never opened */ } };
        }, retry);   // no token to open it with: the site may let this visitor in later
      }
      function retry() { if (off) return; clearTimeout(timer); timer = setTimeout(open, wait); wait = Math.min(wait * 2, 60000); }
      open();
      return function () {
        off = true; clearTimeout(timer); clearInterval(beat); clearTimeout(renew);
        var old = ws; ws = null;
        try { old.close(); } catch (_) { /* not open */ }
      };
    }
    var at = function (name, id) { return name + '/' + id; };
    return {
      token: true,
      told: function () { return ticket(); },
      /* what the token in hand says, or null before the first */
      says: function () { return held || last; },
      me: function () { return call('GET', '_me', undefined, 'whoami').then(function (me) { if (me && held && held.name !== null) me.name = held.name; return me; }); },
      list: function (name) { return call('GET', name, undefined, 'list'); },
      get: function (name, id) { return call('GET', at(name, id), undefined, 'get').catch(function (e) { if (e.status === 404 && e.detail === 'missing') return null; throw e; }); },
      create: function (name, body) { return call('POST', name, body, 'create'); },
      patch: function (name, id, parts) { return call('PATCH', at(name, id), parts, 'update'); },
      remove: function (name, id) { return call('DELETE', at(name, id), undefined, 'remove'); },
      listen: Socket ? listen : undefined
    };
  }

  make.stores = { worker: worker };
  make.version = '0.2.0';   // the same as in the first line of this file, for a page (or a person) to ask which copy this is
  root.Persistable = make;
})(typeof window !== 'undefined' ? window : globalThis);
