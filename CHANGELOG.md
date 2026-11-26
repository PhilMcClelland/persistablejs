# Changelog

Every file says its version in its first line, and a page can ask the client with `Persistable.version`. A deployed store runs whatever `worker.js` it was deployed with. After pulling a change to `worker.js`, deploy again; copy `persistable.js` again when it changes.

## 0.1.0

The first public version.

- One client, a choice of store: `Persistable({ url })` is the Cloudflare Worker, `Persistable({ store: 'supabase', url, apiKey })` a Supabase project (`stores/supabase.js`, `stores/supabase.sql`), `Persistable({ store: 'session' })` keeps one tab's objects in the browser (`stores/session.js`), and `store` also takes a function of your own (`docs/stores.md`). `verify.mjs` runs the same checks against the Worker and Supabase.
- Objects in collections in spaces, each with a `data` part its creator owns and an `open` part anyone may change; children by `parent`, deleted with it.
- `owner` is a fingerprint of the caller's secret keyed with a random value each space keeps: the same secret is a different `owner` in every space, and removing a space makes its people new.
- Keys: `key: 'link'` or a fixed key keeps a space among the people who hold it. `db.link()`, `db.adopt()`, `db.fresh()`. When the key in the address bar changes, the client reloads the page into that circle, so `location.href = db.fresh()` is enough.
- Read keys: `?r=<read key>` and the client's `read` option read a keyed space and cannot write to it. `readkey.mjs`, `db.readOnly`, `db.readKey()`.
- Changes pushed over one WebSocket per page: `db.watch()`, `collection.subscribe()`. An object over 8 KB is left out of what listeners are sent; `subscribe` fetches it, `watch` hears the change without `object`. A listener that sends anything is closed.
- `db.onStatus(fn)`: hears when the store stops and starts answering. While it is down the client asks again by itself, more slowly each time.
- Errors from the client carry `status` and `detail`. `collection.get(id)` gives `null` for an object that is not there. A collection name or id the store would refuse is refused by the client first.
- The default space is the page's origin; a page with no real site (a file, a sandboxed frame) uses `default`.
- `ALLOW_ORIGINS`: which websites may use the store.
- `ADMIN_SECRET`: the owner may delete anything, list a space's collections, clear one, and remove a space. The two wide deletes need `?all=1`.
- Addresses are strict: an empty part or a slash on the end is 404, and a method an address does not take is 405.
- Limits: `data` 100 KB and `open` 8 KB, in bytes as stored; each nested at most 32 deep; no `__proto__` keys; 16 MB and 2000 objects to a collection; 50 collections and 200 listeners to a space.
