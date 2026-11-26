# Stores

Persistable.js is one client and a choice of where the objects are kept. A page codes to the client; the store is one option.

```js
Persistable({ url })                                    // the Worker (worker.js), the default
Persistable({ store: 'supabase', url, apiKey })         // a Supabase project (stores/supabase.js, loaded after persistable.js)
Persistable({ store: 'session' })                       // this browser tab only (stores/session.js): nothing shared, nothing sent
Persistable({ store: myStore, … })                      // one of your own: a function, see below
```

## What every store does

The same in the Worker and Supabase, and checked by `verify.mjs` against each (the session store has one person, so only the shape and the parent rules apply; `tests/stores.mjs` checks it):

- Spaces, collections and objects shaped `{ id, owner, parent, created, updated, data, open }`.
- The one rule: only whoever created an object changes its `data` or deletes it; anyone changes `open`.
- Deleting an object deletes its children. An id cannot be used twice. A child needs a parent that exists.
- One person is a different `owner` in every space.
- A page on one site cannot use a space named after another site.
- The same limits: `data` 100 KB, `open` 8 KB, 32 levels deep, 2000 objects and 16 MB to a collection, 50 collections to a space. The Worker measures what it stores and Supabase what was sent, so the edge can differ by a few bytes.
- A refusal is an `Error` with `status` (400, 401, 403, 404, 409, 413; Supabase also answers 429, "try again", when a person or the store has written too much in a minute) and `detail`.

## Where they differ

The session store is left out of the table: it keeps one tab's objects in `sessionStorage`, for starting before there is a backend or for a demo. One person, so no rule to enforce and nothing shared.

| | Worker | Supabase |
| --- | --- | --- |
| Where the data is | Your Cloudflare account | Your Postgres |
| Setup | One deploy | A project, a setting and one SQL file |
| A person is | A secret the browser makes up | An anonymous sign-in |
| Changes arrive | Pushed, at once, saying what changed | Asked for every few seconds, saying which collection |
| Link keys and read keys | Yes | No (`key` and `read` are refused) |
| The owner's way in | `ADMIN_SECRET` | The SQL editor |
| Closing it to other websites | `ALLOW_ORIGINS` | Not available |
| How many spaces | No limit | 200000 objects and 200 MB in all |
| Writes in a minute | No limit | 10 MB a person; past 100 MB in all, only light writers go on |
| Text it will not keep | None | A NUL character, or half of an emoji (a lone surrogate) |

With a store that cannot say what changed, `db.watch` hears a collection's name with no second argument, and `subscribe` calls `onResync`: read the collection again. Code written that way works on every store.

## Writing a store

A store is a function `(opt, kit) => store`. `opt` is what the page passed to `Persistable`. `kit` has `space`, `storage` (`getItem`, `setItem`), `fetch`, `random(n)` (hex of `n` random bytes) and `mark(up)`, which the store calls with `true` when its backend answers (even with a refusal) and `false` when it does not.

The store returns:

```js
{
  me(),                       // -> Promise<{ id }>: the caller in this space
  list(name),                 // -> Promise<object[]>, oldest first
  get(name, id),              // -> Promise<object | null>
  create(name, body),         // body is { data, id?, parent?, open? } -> Promise<object>
  patch(name, id, parts),     // parts is { data?, open? }; a key set to null is removed -> Promise<object>
  remove(name, id),           // -> Promise
  // one of these two, or neither (then watch() does nothing):
  listen(ear),                // push: call ear.state(true|false) as the line comes and goes and ear.change(name, what) for each change; return a stop function
  pulse(),                    // -> Promise<{ [collection]: anything that differs when the collection has changed }>
  // optional: key, readOnly, readKey(), link(), adopt(), fresh()
}
```

The client has already checked names and ids before it calls. Everything else is the store's to enforce, on the server: a rule kept only in the page is not kept. Reject with an `Error` that has `status` and `detail`.

To check one, add it to `verify.mjs` beside the two that are there and make it pass the shared checks. `stores/supabase.js` and `stores/supabase.sql` are the worked example.
