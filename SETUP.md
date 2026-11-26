# Setting up Persistable.js

Written for an agent to follow. The outcome: the person has one small store, deployed once to their own Cloudflare account, that any of their prototypes can use with a script tag to keep shared JSON.

Nothing has to be kept running. It is one Worker file with storage attached; it sleeps when nobody is using it, and the free plan is enough for prototypes.

You need a Cloudflare account (free), Node 22 or later, and this repo checked out. The prototype needs one file from it, `persistable.js` (with another store, that store's file from `stores/` as well).

## Steps

1. **Sign in to Cloudflare.** `npx wrangler@4 whoami`. If it says you are not signed in, ask the person to do one of two things. Either they run `npx wrangler@4 login` themselves (it opens a browser). Or they make an API token with "Edit Cloudflare Workers" and put it in a file named `.env` in this folder, as the one line `CLOUDFLARE_API_TOKEN=<the token>`, then `chmod 600 .env`. Git ignores that file. Never paste a token into a command.

   With a token, wrangler has to be run with the file loaded, and that goes for every wrangler command below:

   ```
   (set -a; . ./.env; set +a; npx wrangler@4 whoami)
   ```

   If wrangler says it cannot tell which account to use, add the line `CLOUDFLARE_ACCOUNT_ID=<the account id>` to the same file; `whoami` lists the ids. The commands here say `wrangler@4` so that a later major version cannot change what they do.

2. **Deploy.** From this folder:

   ```
   npx wrangler@4 deploy
   ```

   or, with a token in `.env`:

   ```
   (set -a; . ./.env; set +a; npx wrangler@4 deploy)
   ```

   It prints the store's address, `https://persistable.<their-subdomain>.workers.dev`. If this is the account's first Worker, wrangler asks to pick a `workers.dev` subdomain first. That question is the person's to answer: ask them to run the deploy themselves this once, or to choose the subdomain in the Cloudflare dashboard (Workers & Pages) and then deploy again. Deploying again later is safe and keeps the data. A first deploy can take up to a minute before the address answers; an "error code: 1042" page in that time is Cloudflare still setting it up.

3. **Verify before touching the prototype.**

   ```
   node verify.mjs https://persistable.<their-subdomain>.workers.dev
   ```

   Two made-up people write to a throwaway space; it checks who may do what and that changes are pushed, and deletes what it made. Go on only when it prints "All checks passed".

4. **Put the client in the prototype.** Copy `persistable.js` next to the prototype's pages and load it:

   ```html
   <script src="persistable.js"></script>
   <script>
     const db = Persistable({ url: 'https://persistable.<their-subdomain>.workers.dev' });
   </script>
   ```

   There is no key. The data goes in a space named after the page's origin (`https://my-prototype.example`), so a prototype on a site of its own gets its own space with nothing to configure. The origin is the scheme, host and port and nothing after them, so prototypes that share one share a space: every project under `https://someone.github.io/`, and every project run on the same `http://localhost` port. Give each of those a space of its own with `space: 'any-name-you-choose'`. The same option makes several addresses share one (a preview URL and a custom domain, say): pass the same name on each.

5. **Check it in two browsers.** Open the prototype in a normal window and a private window. Something saved in one should be readable in the other.

6. **Close it to other sites, and give the owner a way in.** Do both before the store's address is in a page other people can see.
   - In `wrangler.jsonc` set `"vars": { "ALLOW_ORIGINS": "https://the-prototype.example" }` (the page's origin: scheme, host and port, no path; several separated by commas) and deploy again. From then on every origin not in the list is turned away, and that includes the prototype run on this machine: add `http://localhost:<port>` (and `http://127.0.0.1:<port>` if that is how it is opened) for as long as it is being worked on. Then check it took, and open the prototype to check it still saves: a wrong origin locks the real page out, and the verify script cannot see that, because it is not a browser.

     ```
     curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://not-allowed.example' https://persistable.<their-subdomain>.workers.dev/v1/s/x/things   # 403
     ```

   - Make the owner's secret in a file of its own, `.env.admin`, not on a command line, and hand it to wrangler from the file. These three lines can be run again safely: the first makes the file only if git will ignore it and it is not there yet (`set -C` refuses to write over a file), so a second run keeps the secret already made and sends the same one again.

     ```
     git check-ignore -q .env.admin && (set -C; umask 077; node -e "console.log('ADMIN_SECRET=' + require('crypto').randomBytes(24).toString('hex'))" > .env.admin)
     chmod 600 .env.admin
     sed -n 's/^ADMIN_SECRET=//p' .env.admin | head -n 1 | npx wrangler@4 secret put ADMIN_SECRET
     ```

     If the first line says the file exists, that is the secret from last time: go on. If it prints nothing and makes no file, git is not ignoring `.env.admin`: add `.env.*` to `.gitignore` and run it again. With a token in `.env`, load it for the last line as in step 2: `sed … | (set -a; . ./.env; set +a; npx wrangler@4 secret put ADMIN_SECRET)`. To change the secret, delete `.env.admin` and run the three lines again.

     Tell the person where the file is and that it is theirs to keep: it is the only way to remove what someone else added (`docs/admin.md`). Never put it in a page or print it. A secret shorter than 24 characters is ignored, and the store then answers "only the owner can…" to its own owner. Check it works; this prints `[]` or a list:

     ```
     (set -a; . ./.env.admin; set +a; curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://persistable.<their-subdomain>.workers.dev/v1/s/x/_collections)
     ```
   - Tell the person what `ALLOW_ORIGINS` does not stop: it refuses other websites, not a script or a command line.

7. **Only if the prototype's own site signs people in, and they should be kept apart or named: tokens.** Skip this otherwise. It needs code on that site's server, and the steps are in `docs/access.md`, "A token from your own site". The store's part is one more secret, made and set the same way as the owner's:

   ```sh
   git check-ignore -q .env.token && (set -C; umask 077; node -e "console.log('TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" > .env.token)
   sed -n 's/^TOKEN_SECRET=//p' .env.token | head -n 1 | npx wrangler@4 secret put TOKEN_SECRET
   ```

   The site's server needs the same value as a secret of its own. `node tests/token.mjs` proves the store's side of it without a deploy.

That is the whole setup, and it is done once: the next prototype needs only step 4, and its origin added to `ALLOW_ORIGINS` (with a `space` of its own if it shares an origin with another).

## Using it

```html
<script src="persistable.js"></script>
<script type="module">
  const db = Persistable({ url: 'https://persistable.<their-subdomain>.workers.dev' });
  const votes = db.collection('votes');
  const { id } = await votes.create({ choice: 'B' });   // -> { id, owner, parent, created, updated, data, open }
  await votes.list();                           // every object, oldest first
  await votes.update(id, { choice: 'C' });      // `data`: only whoever created the object
  await votes.setOpen(id, { counted: true });   // `open`: anyone
  await votes.remove(id);                       // only its creator; takes its children with it
  db.watch(name => { /* a collection changed: list() again */ });
</script>
```

- An object has two parts. `data` belongs to whoever created it; `open` can be changed by anyone. Put the words in `data` and the shared ticks, counts and positions in `open`.
- `create(data, { id, parent, open })`: give an `id` to choose it, a `parent` to hang the object off another in the same collection.
- A collection name is up to 40 lower-case letters, digits, `-` and `_`; an id is up to 80 letters, digits, `.`, `-` and `_`; both start with a letter or digit. The client refuses any other before asking the store. An object's `data` can be up to 100 KB (bytes as stored) and its `open` part up to 8 KB, each nested at most 32 deep; a collection holds up to 2000 objects and 16 MB, a space up to 50 collections.
- `get(id)` gives the object, or `null` if there is none. A call the store refuses rejects with an `Error` that has `status` (the HTTP status) and `detail` (the store's message).
- `db.watch(fn)` listens on the page's one WebSocket and calls `fn(collectionName, what)` on every change, or `fn(null)` after a reconnect, when anything may have changed. `what` is `{ collection, op, id, object }`, with `op` one of `create`, `update`, `delete` or `clear` (the owner emptied the collection); `object` is left out of a delete, a clear and any object over 8 KB. It returns a function that stops it. A second function, `db.watch(fn, up => …)`, hears the connection come and go. `collection.subscribe({ onCreate, onUpdate, onDelete, onResync })` sorts the same events out for one collection, and fetches a large object before handing it over. Both hear changes from the moment they are called: call `list()` once for what is already there.
- `key: 'link'` keeps the data among the people who were sent the prototype's link, and lets any of them change anything. See `docs/access.md`.
- With Crittable.js, add `data-backend="persistable" data-url="…"` to its script tag instead; it carries its own copy of the client.

## Before the address is public

A fresh deploy accepts any website that knows its address, which is convenient while trying it and wrong once the address is in pages other people can see: a stranger could point their own prototype at it. `ALLOW_ORIGINS` stops that, and only that: it refuses other websites. It does not stop a script or a command line, which can still read an unkeyed space, add to it and use up the account's daily allowance, because nothing but a browser has to say where it is calling from. Before a prototype that uses the store is shared widely, set `ALLOW_ORIGINS` in `wrangler.jsonc` to the origins that should be allowed, deploy again, and run the verify script once more. Each new prototype's origin then has to be added to the list.

The list is exact, and it applies to your own pages too. Once it is set, a prototype opened at `http://localhost:8000` is refused (403, "this page may not use this store") until `http://localhost:8000` is in the list, port and all. A page opened from a file, or run in a sandboxed frame, tells the store its origin is `null`, and is refused the same way. Adding `null` to the list lets those pages in, but it lets in every such page anywhere, since any website can put a page in a sandboxed frame: do it only while developing, or serve the page from `http://localhost` and list that. A caller that names no origin at all (a script, `curl`, the verify script) is never turned away by the list.

## What to tell the person

- Anyone with the prototype's link can read its data and add to it. There are no accounts. It is right for prototypes and wrong for anything private.
- Without a key, anyone who finds the store's address can do the same, and only whoever created an object can change its `data` or delete it; anyone can change its `open` part. The store enforces this. "Whoever" means that browser: clearing site data makes someone a new person.
- With a key and its read key in the page (`key: 'link', read: '…'`), anyone who opens the page can read; only people who were sent the link can write. The store enforces it.
- With a key (`key: 'link'`), only people who were sent the link reach the data, and any of them can change or delete anything. A new circle (`db.fresh()`) is a new, empty space; nobody can be removed from an old one.
- A space named after a site can only be used from that site's pages. To allow only chosen sites at all, set `ALLOW_ORIGINS` in `wrangler.jsonc` and deploy again. Neither stops someone with a command line; they stop other websites.
- The data lives in their Cloudflare account (Workers, then `persistable`, then its Durable Objects). With `ADMIN_SECRET` (in `.env.admin`) they can delete any object, clear a collection or remove a space; deleting the Worker deletes everything.
- Cost: the free plan covers a prototype. Its daily allowances (requests, and rows of storage read and written: every object is a row, and listing a collection reads all of its rows) are shared by everything on their account, and a busy public page or a script could use one up; the store then stops answering until the next day (00:00 UTC), and nothing is charged. The plan's storage allowance is shared the same way. Cloudflare's pricing pages have the current figures. That is the free plan only: on a paid Workers plan there is no daily stop and the store has no rate limit of its own, so heavy use, or abuse, is billed. On a paid account put a Cloudflare rate-limiting rule in front of it.

## How it works, for debugging

- The store is `worker.js`: a Worker that routes each space to its own Durable Object, which keeps the objects in its built-in storage. The address list is at the top of that file.
- The client is `persistable.js`. No SDK, no build step.
- Changes are pushed over one WebSocket per page (`…/_watch`), however many `watch` and `subscribe` calls the page makes. The client reconnects by itself, more slowly each time.
- Each browser makes up a random secret and sends it as a Bearer token; the store keeps only a fingerprint of it as `owner`. The fingerprint is keyed with a random value each space keeps, so one browser is a different `owner` in every space, and removing a space makes everyone in it new.
- A 404 "no such address" on a delete usually means an empty id left a slash on the end of the address; a 400 on a wide delete means `?all=1` is missing.
- `npx wrangler@4 dev` runs the store on this machine, and `verify.mjs` works against that address too. `PERSISTABLE_VERIFY_MOCK=1 node verify.mjs https://mock.invalid` runs the Worker's code in Node with no account at all.
- Not covered yet: signing people in, file uploads, queries (a collection is always read whole).
