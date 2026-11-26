/*! Persistable.js 0.2.0 store: the browser session · MIT · (c) 2026 Phil McClelland · https://github.com/PhilMcClelland/persistablejs */
/* Persistable.js with nothing behind it: the objects are kept in this tab (sessionStorage) and are gone when it closes.
   For starting a prototype before there is a backend, and for a demo that should send nothing anywhere. Load it after
   persistable.js:

     <script src="persistable.js"></script>
     <script src="stores/session.js"></script>
     const db = Persistable({ store: 'session' });

   The same client and the same calls, so moving to a real store later is a change to that one line. There is one
   person, this tab, so nothing is shared and the one rule has nobody to keep out. Limits are the browser's own
   (about 5 MB to a site); past that, what is added lasts only until the page is closed. Options: space; storage (anything with getItem and setItem, in place of sessionStorage). */
(function (root) {
  'use strict';
  var Persistable = root.Persistable;
  if (typeof Persistable !== 'function' || !Persistable.stores) throw new Error('persistable session: load persistable.js before this file');
  Persistable.stores.session = function (opt, kit) {
    var box = opt.storage, held = null, loose = false, ears = [], SLOT = 'persistable.session.' + kit.space;
    if (opt.key || opt.read) throw new Error('persistable session: this store has no link keys or read keys');
    if (!box) { try { box = root.sessionStorage; } catch (_) { box = null; } }
    /* everything in the space is one value: read whole, changed, written whole. Where nothing can be kept, it lasts for the page */
    /* What is kept can be changed by any script on the site, so its shape is checked each time it is read: anything else
       is a fresh start, not a crash. Once a write has failed (storage full, or not allowed), what this page holds is the
       newer of the two, so it is read from here until a write goes through again. */
    var plain = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
    function read() {
      var all = held;
      if (box && !loose) { try { all = JSON.parse(box.getItem(SLOT) || 'null'); } catch (_) { all = held; } }
      return plain(all) && typeof all.me === 'string' && isFinite(all.n) && typeof all.n === 'number' && plain(all.rows) ? all : { me: kit.random(16), n: 0, rows: {} };
    }
    function write(all) { held = all; if (!box) return; try { box.setItem(SLOT, JSON.stringify(all)); loose = false; } catch (_) { loose = true; } }
    /* a collection is looked up as its own name only: "constructor" is a collection name too, and must not find Object */
    /* an object is what this store wrote: anything else found in its place is not there */
    var whole = function (o, id) { return plain(o) && o.id === id && typeof o.owner === 'string' && (o.parent === null || typeof o.parent === 'string') && typeof o.created === 'number' && isFinite(o.created) && typeof o.updated === 'number' && isFinite(o.updated) && plain(o.data) && plain(o.open); };
    var coll = function (all, name) {
      var c = own(all.rows, name) && plain(all.rows[name]) ? all.rows[name] : {};
      Object.keys(c).forEach(function (id) { if (!whole(c[id], id)) delete c[id]; });
      return c;
    };
    /* nothing a caller does to what it was handed reaches the store, and trouble is a rejection, never a throw */
    var safely = function (fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { return Promise.reject(e); } }; };
    var copy = function (o) { return JSON.parse(JSON.stringify(o)); };
    var no = function (status, detail) { var e = new Error('persistable: refused (' + status + ') ' + detail); e.status = status; e.detail = detail; return Promise.reject(e); };
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var merge = function (into, patch) { Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete into[k]; else into[k] = patch[k]; }); };
    /* a listener's own trouble is not the writer's: the object is stored whatever they do with the news */
    function tell(name, op, id, object) { kit.mark(true); ears.slice().forEach(function (ear) { try { ear.change(name, { collection: name, op: op, id: id, object: object }); } catch (e) { setTimeout(function () { throw e; }, 0); } }); }
    /* a key that would reach an object's prototype in a page, at any depth */
    var proto = function (v) { return !!v && typeof v === 'object' && (own(v, '__proto__') || Object.keys(v).some(function (k) { return proto(v[k]); })); };
    return {
      me: safely(function () { var all = read(); write(all); return Promise.resolve({ id: all.me }); }),
      list: safely(function (name) { var c = coll(read(), name); return Promise.resolve(Object.keys(c).map(function (id) { return copy(c[id]); }).sort(function (a, b) { return a.created - b.created || (a.id < b.id ? -1 : 1); })); }),
      get: safely(function (name, id) { var c = coll(read(), name); return Promise.resolve(own(c, id) ? copy(c[id]) : null); }),
      create: safely(function (name, body) {
        var all = read(), c = own(all.rows, name) && plain(all.rows[name]) ? coll(all, name) : (all.rows[name] = {}), id = body.id == null ? 'o' + (++all.n) + '-' + kit.random(4) : body.id, now = Date.now();
        var data = copy(body.data == null ? {} : body.data), open = copy(body.open == null ? {} : body.open);   // as they would be stored
        if (!plain(data) || !plain(open)) return no(400, 'data and open must be objects');
        if (proto(data) || proto(open)) return no(400, 'a key cannot be named __proto__');
        if (body.parent != null && typeof body.parent !== 'string') return no(400, 'id and parent are strings');
        if (own(c, id)) return no(409, 'that id is taken');
        if (body.parent != null && !own(c, body.parent)) return no(400, 'no such parent');
        c[id] = { id: id, owner: all.me, parent: body.parent == null ? null : body.parent, created: now, updated: now, data: data, open: open };
        write(all); tell(name, 'create', id, copy(c[id])); return Promise.resolve(copy(c[id]));
      }),
      patch: safely(function (name, id, parts) {
        var all = read(), c = coll(all, name);
        if (!own(c, id)) return no(404, 'missing');
        if (!parts || (parts.data == null && parts.open == null)) return no(400, 'send data, open or both');
        var pd = copy(parts.data == null ? {} : parts.data), po = copy(parts.open == null ? {} : parts.open);
        if (!plain(pd) || !plain(po)) return no(400, 'data and open must be objects');
        if (proto(pd) || proto(po)) return no(400, 'a key cannot be named __proto__');
        merge(c[id].data, pd); merge(c[id].open, po); c[id].updated = Math.max(Date.now(), c[id].updated + 1);
        write(all); tell(name, 'update', id, copy(c[id])); return Promise.resolve(copy(c[id]));
      }),
      remove: safely(function (name, id) {
        var all = read(), c = coll(all, name);
        if (!own(c, id)) return no(404, 'missing');
        var gone = [id];
        for (var i = 0; i < gone.length; i++) Object.keys(c).forEach(function (k) { if (c[k].parent === gone[i] && gone.indexOf(k) < 0) gone.push(k); });
        gone.forEach(function (g) { delete c[g]; });
        write(all); gone.reverse().forEach(function (g) { tell(name, 'delete', g); });   // children first
        return Promise.resolve(null);
      }),
      listen: function (ear) { ears.push(ear); ear.state(true); return function () { ears = ears.filter(function (e) { return e !== ear; }); }; }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
