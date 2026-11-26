# Persistable.js

Make any prototype persistable. A database connection as quick and dirty as your prototype.

**[persistablejs.philmcclelland.com](https://persistablejs.philmcclelland.com)**

```
Your prototype  →  Persistable.js  →  Cloudflare · Supabase · the browser session · your own
```

Your prototype talks to one small client. Where the data is kept is one option, and you can change it without touching the rest of your code. You set a store up once; after that every prototype needs only the script tag. There is no schema to design and nothing to migrate between versions.

## Quick start

Start with no backend at all. This keeps the data in the browser tab:

```html
<script src="https://cdn.jsdelivr.net/gh/PhilMcClelland/persistablejs@v0.2.0/persistable.js"></script>
<script src="https://cdn.jsdelivr.net/gh/PhilMcClelland/persistablejs@v0.2.0/stores/session.js"></script>
<script type="module">
  const db = Persistable({ store: 'session' });
  const votes = db.collection('votes');
  await votes.create({ choice: 'B' });
  const all = await votes.list();
</script>
```

When everyone who opens the prototype should see the same data, deploy a store once and change that one line:

```sh
npx wrangler@4 deploy      # worker.js, to your own free Cloudflare account
node verify.mjs https://persistable.YOUR-SUBDOMAIN.workers.dev
```

```js
const db = Persistable({ url: 'https://persistable.YOUR-SUBDOMAIN.workers.dev' });
```

No sign-in, no build step, and nothing secret in the page. To host the files yourself, copy `persistable.js` next to your page, with `stores/session.js` or `stores/supabase.js` if you use that store, and point each `src` at your copy.

Working with an agent? Tell it "Add github.com/PhilMcClelland/persistablejs to this prototype". [AGENTS.md](AGENTS.md) tells it how to add the client, and [SETUP.md](SETUP.md) how to deploy the store.

## Stores

| Store | Use it when | Setup |
| --- | --- | --- |
| Cloudflare Worker (the default) | Most of the time. Changes are pushed live, and a key in the link keeps data among the people you send it to. | [SETUP.md](SETUP.md) |
| Supabase | You already have a project, or want the data in Postgres. | [stores/SUPABASE.md](stores/SUPABASE.md) |
| Browser session | You are starting out, or the demo should send nothing anywhere. | None |
| Your own | Your data belongs somewhere else. | [docs/stores.md](docs/stores.md) |

The Worker and Supabase keep the same rules and limits, and [`verify.mjs`](verify.mjs) checks either against them. The session store has one person and the browser's own limits. [docs/stores.md](docs/stores.md) says where they differ.

## The one rule

Each object has two parts: `data`, which only its creator can change, and `open`, which anyone can. A comment's words are the author's; its "resolved" tick is everyone's. Deleting an object deletes the objects created with it as `parent`.

## What you get

- Collections of JSON objects: `create`, `get`, `list`, `update`, `setOpen`, `remove`.
- Changes as they happen: `votes.subscribe({ onCreate, onUpdate, onDelete, onResync })`.
- A space for each prototype, named after its address, with nothing to configure.
- With the Worker: access by link with no accounts, or by a token from a site that has its own ([docs/access.md](docs/access.md)), plain HTTP for scripts and agents ([docs/http.md](docs/http.md)), and an owner's way in for removing what strangers add ([docs/admin.md](docs/admin.md)).

## What it is not

It is right for prototypes and wrong for anything private. A key keeps strangers out; it does not make the data private. There are no queries (a collection is read whole), no file uploads and no accounts of its own.

## Docs

- [Stores](docs/stores.md): what every store does, where they differ, and how to write one.
- [Who can get in](docs/access.md): no key, a key in the link, a key in the page, read keys, a token from your own site.
- [Removing data and handling abuse](docs/admin.md): `ADMIN_SECRET`, limits, and what is not limited.
- [Patterns](docs/patterns.md): replies as child objects, hiding, store status, errors, spaces.
- [From a script or an agent](docs/http.md): the HTTP calls.
- [CHANGELOG.md](CHANGELOG.md): what changed, and what broke.

[Crittable.js](https://github.com/PhilMcClelland/crittablejs) is built on it: it shares its notes through this client.

## Contributing

Issues are welcome. Report a security problem privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)

If it saved you time, you can [leave a tip](https://github.com/sponsors/PhilMcClelland). Nothing comes with it.
