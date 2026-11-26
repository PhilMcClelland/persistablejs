# Persistable.js on Supabase

Written for an agent to follow. The outcome: the same Persistable.js client, with the data kept in the person's Supabase project in place of a Cloudflare Worker. Pick this when they already have a project, or want the data in Postgres. Otherwise the Worker (`SETUP.md`) is less to set up and does more: see the table in `docs/stores.md`.

You need a Supabase project (the free tier is enough) and permission to change its Authentication settings and run SQL in it.

## Steps

1. **Have a project, and prefer a new one.** Step 2 changes who counts as signed in for the whole project, so a project made for this is the safe choice. If you have the Supabase CLI or a Supabase MCP connection, use it; otherwise ask the person to create a project in the dashboard and give you its URL.

   **If the person wants an existing project, stop and tell them this first.** An anonymous visitor is given the `authenticated` role. Any table in that project whose policy says `to authenticated` (the usual way to write "signed-in users only") would then be open to anyone holding the publishable key, which is in the page. Go on only when they have checked their policies, or restricted them to real accounts (`(auth.jwt() ->> 'is_anonymous')::boolean is false`). Do not turn anonymous sign-ins on in an existing project without their say-so.

2. **Turn on anonymous sign-ins.** Dashboard: Authentication, then Sign In / Providers, then "Allow anonymous sign-ins". On a project that already exists, use that dashboard switch: it changes this one setting and nothing else. Pushing a `supabase/config.toml` sends every auth setting in the file, so a file that was not first pulled from the project would put its other auth settings back to the defaults. Without this setting, step 5 fails at its first check.

3. **Create the table and functions.** Run `stores/supabase.sql` in the project, unchanged: paste it into the SQL editor, or run it through the CLI or your database tool. It is safe to run more than once.

4. **Collect two public values.** The project URL (`https://<ref>.supabase.co`) and the publishable key (`sb_publishable_...`; on older projects, the `anon` key). Both are designed to be shipped in a web page. Never use a secret or `service_role` key here.

5. **Verify before touching the prototype.**

   ```
   node verify.mjs --store supabase https://<ref>.supabase.co <publishable key>
   ```

   It signs in two anonymous people, writes to a throwaway space, checks who may do what, and deletes what it made. (With no project yet, `PERSISTABLE_VERIFY_MOCK=1 node verify.mjs --store supabase https://mock.supabase.co mock-key` runs the same checks against a stand-in. That proves the client, not your project.) Go on only when it prints "All checks passed". If a check fails, the message says which; the usual causes are step 2 or step 3 not done, or the wrong key.

6. **Point the prototype at it.** Two script tags, the store's file after the client:

   ```html
   <script src="persistable.js"></script>
   <script src="stores/supabase.js"></script>
   <script type="module">
     const db = Persistable({ store: 'supabase', url: 'https://<ref>.supabase.co', apiKey: '<publishable key>' });
   </script>
   ```

   The calls after that line are the same as with the Worker, with one difference to code for: this store cannot say what changed. `subscribe` calls only `onResync`, within about four seconds of a change (the page's own included), never `onCreate`, `onUpdate` or `onDelete`. Draw from `list()` in `onResync`, and after the page's own writes. Code written that way works on every store. Each deployed prototype gets its own space, named after its origin; pass `space: 'a-name'` to share one between addresses.

## Keep a quiet project awake (optional)

Supabase pauses a free project after about a week with no activity, and a paused project answers nothing until someone restores it in the dashboard. A prototype that is opened most weeks never notices. For one that may sit untouched, set up the keep-alive: a scheduled Cloudflare Worker that runs one small query every two days. It has no public address and holds only the two public values from step 4.

1. Check the query works from here: `SUPABASE_URL=https://<ref>.supabase.co SUPABASE_KEY=<publishable key> node stores/supabase-keepalive/check.mjs`.
2. From `stores/supabase-keepalive/`: `npx wrangler@4 deploy`, then `npx wrangler@4 secret put SUPABASE_URL` and `npx wrangler@4 secret put SUPABASE_KEY`.
3. Tell the person it exists and where: the Worker `persistable-keepalive` on their Cloudflare account. Deleting it there is all it takes to stop it.

Ask before setting this up. It keeps a free project running that would otherwise rest, on the person's accounts, and that is their call.

## What to tell the person

- Anyone who has the page can read the space and add to it: the publishable key is in the page, and a space's name is the only thing between one prototype's data and another's. By default that name is the page's address, which anyone can guess. This store has no link keys and no read keys; for data that should stay among the people sent a link, use the Worker.
- The one rule is enforced by the database, not the page: only whoever created an object can change its `data` or delete it; anyone can change its `open` part.
- "A person" is a browser. Each one is signed in anonymously, which makes a user row in the project. Clearing site data makes someone a new person, who can no longer change what they made before.
- CAPTCHA is not supported: the client sends no CAPTCHA token, so with Supabase's CAPTCHA protection on, every sign-in is refused. Leave it off in this project.
- Changes arrive within about four seconds, not at once: the page asks what changed. On a page many people keep open, raise `poll` (`Persistable({ …, poll: 10000 })`, in milliseconds; 4000 unless set).
- The data is in the `persistable_objects` table of their project. They can read, export or delete it in the SQL editor, which is also how abuse is taken down: `delete from public.persistable_objects where space = '<the space>';`. To see what is there: `select space, collection, count(*) from public.persistable_objects group by 1, 2 order by 3 desc;`.
- The limits stop a space growing without end; they do not stop someone filling one, or making spaces of their own until the table reaches its limit (200000 objects or 200 MB), after which nobody can add anything, or make anything bigger, until something is deleted: `delete from public.persistable_objects where space = '<a space you do not recognise>';`. Small changes that do not grow an object (under 2 KB written), and deleting, go on working in a full store.
- One person can write 10 MB a minute. When everyone together has written 100 MB in a minute, people who have written more than half a megabyte themselves are told to try again in a minute (429); someone adding a note or ticking a box is not, until 300 MB, where it stops for everyone until the minute is out. Nothing is lost either way, and a write that is refused takes no room. A minute is a minute of the clock, so twice the allowance can pass across the turn of one. A new object counts for its data and its names; a change counts for the part that changed, whole: ticking a box in a small `open` costs a few hundred bytes however big `data` is, and changing one key of a 100 KB `data` costs 100 KB. Signing in again makes a new person with a new allowance, which Supabase's own sign-in rate limit is the brake on.
- If it ever says it is full with little in it, the disk has filled with old versions of changed objects faster than Postgres clears them. `vacuum full public.persistable_objects;` in the SQL editor gives the disk back.
- Anyone with the page can sign in anonymously as often as Supabase's own rate limit allows (a setting under Authentication), and each sign-in makes a user row. With CAPTCHA unsupported, that limit is the only brake.

## How it works, for debugging

- The store is `stores/supabase.js`. It uses no SDK: `POST /auth/v1/signup` for an anonymous session, `POST /auth/v1/token?grant_type=refresh_token` to renew it, and `POST /rest/v1/rpc/persistable_{me,list,get,create,patch,remove,pulse}` for data. (`persistable_ping` is only for the keep-alive.) A project run on this machine by the Supabase CLI works too: `http://localhost` and `http://127.0.0.1` are the only addresses accepted without https.
- The table has row level security with no policies, so it cannot be read or written directly. The functions are the only way in. Each takes the request as one JSON value, `{ space, collection, id, body, parts }`, and measures it before looking inside.
- `data` and `open` are kept as `json`, the text that was sent, not `jsonb`. A number such as `1e400` therefore comes back as it was written, and a page reading it gets `Infinity`. If a key was sent twice, the last one is kept. Text holding a NUL character or half of an emoji (a string cut in the middle of one) is refused by Postgres with a 400.
- A collection is read a page at a time, about a megabyte each; the client puts the pages together, so `list()` is the same call as ever.
- A refusal comes back with the same HTTP status the Worker gives (403, 404, 409, 413), raised in SQL as `PT403` and so on.
- Supabase Realtime is not used. `persistable_pulse` answers, for each collection, how many objects, the latest change and the sum of all their change times; the client asks it every `poll` ms while the tab is visible and tells watchers which collections differ.
