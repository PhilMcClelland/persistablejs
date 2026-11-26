# Who can get in

The one rule first. Each object has two parts: `data`, which only its creator can change, and `open`, which anyone can. A comment's words are the author's; its "resolved" tick is everyone's. Deleting an object deletes the objects created with it as `parent`. What goes inside `data` and `open` is yours to decide; the store never looks.

The store has no accounts, so access is decided by who holds what: nothing, a key, or a token from a site that has accounts of its own.

- **No key (the default).** Anyone who finds the store's address can read a space and add to it. The one rule is the only protection: nobody can change someone else's words.
- **A key in the link.** `Persistable({ url, key: 'link' })`. The prototype's link carries a random key after the `#`, the part of an address a browser never sends to the page's own server. The client does send the key to your store with every request, which is how the store finds the circle, so it is in the store's request logs and in anything else that logs the addresses a browser asks for; it sits in the address bar and the browser's history; and any other script on the page can read it. Treat the link as the key it is. Whoever opens that link is in; anyone without it reaches a different, empty space. The first person to open the page with no key starts a circle, and their address bar becomes the link to share (`db.link()` returns it too). The store keeps no list of keys or members.

  A browser comes back to the first circle it held. For a browser that already holds one, someone else's link is followed for that visit only, so opening it cannot cut a person off from their own data; call `db.adopt()` (behind a "stay in this one" button, say) to keep the new circle instead. A browser that holds none keeps the first it is given: someone whose first visit is through your link is in your circle from then on, link or no link. To shut people out, call `db.fresh()`: it makes a new, empty circle, remembers it and returns its link to share. `location.href = db.fresh()` moves the page there: when the address comes to carry the key this browser now keeps, the client reloads the page, which starts again in the new circle. Someone else's link clicked or pasted into the same tab does nothing, so a link cannot throw away what is on the page; open it in a new tab. Nobody can be removed from the old one.
- **A key in the page.** `Persistable({ url, key: '<16 or more letters and digits>' })`. Right when the page itself sits behind a sign-in or a password (your company's, or your host's), because then only the people let in can read the page's source. On a public page a key in the source protects nothing.
- **Open to read, closed to write.** `Persistable({ url, key: 'link', read: '<read key>' })`. Every key has a read key: a one-way hash of it that lets its holder read and listen, and nothing else. Put the read key in a public page and send the key, in the link, only to the people who should write. A visitor without the link sees everything and can change nothing; the store refuses them, not just the page. `node readkey.mjs --new` makes up a key and prints both; `await db.readKey()` gives the read key for the key in use, and `node readkey.mjs -` gives it for a key sent to its standard input. The read key cannot be turned back into the key, provided the key is a random one (`--new`, or the one the client makes): a key someone typed can be guessed from its read key, so never hand-pick one for a page that publishes its read key. On such a page a writer arrives with the key in the link; once their browser has stored it, the client takes it out of the address bar, so the address they copy to show the page around carries nothing. `db.link()` gives the link that does. In a browser that stores nothing (some private windows), the key stays in the address, because it is all that visitor has: such a writer should copy the page's plain address by hand.

- **A token from your own site.** `Persistable({ url, token: () => fetch('/api/token').then(r => r.text()) })`. For a page on a site that already knows who its visitors are: a sign-in, a password for each client, anything its server checks. The server vouches for each visitor, and the store takes its word for which space they are in and who they are. It is the only way in that needs code on a server, so it is not for a page on a static host. The rest of this is under "A token from your own site", below.

Inside a keyed space everyone is trusted: anyone may change or delete anything, the way colleagues can in a shared document. Each object still records who created it, so an app can show authors and offer "edit" only on your own. That is manners, not enforcement.

A key keeps strangers out; it does not make the data private. A read key keeps strangers from writing; it does nothing to stop them reading, or to stop a script from reading until the day's allowance is gone. Anyone given the link can pass it on, and nobody can be removed without starting a new link.

## A token from your own site

Use it when one prototype goes in front of several audiences who should not see each other's data, or when the people using it should appear under the names your site already has for them.

**Once, for the store.** Make a random secret of 32 characters or more (`openssl rand -hex 32`), keep it in an env file that git ignores, and set it on the Worker with `npx wrangler@4 secret put TOKEN_SECRET`, which asks for the value and keeps it out of the command. Give the same value to your site's server as a secret of its own. Make it a new one, used for nothing else: not a secret your site already signs other things with. A store with no `TOKEN_SECRET` refuses every token.

**On your server.** Add one address that answers with a token, after your own check that the visitor is let in. Copy [`token.mjs`](../token.mjs) next to your server's code; it is one ES module that runs in a Cloudflare Worker and in Node 20 or later, imports nothing, and reads no arguments or environment, so it can be bundled:

```js
import { tokenResponse } from './token.mjs';

// inside your request handler, for GET /api/token
const visitor = await whoIsThis(request);          // your own check: a session cookie, say
if (!visitor) return new Response('sign in first', { status: 401 });
return tokenResponse(env.TOKEN_SECRET, {
  space: 'review/' + visitor.groupId,              // which set of data
  person: visitor.id,                              // who this one visitor is
  name: visitor.name                               // optional: a name to show
});
```

**In the page.** Pass the client a function that fetches from that address, and nothing else about access:

```js
const db = Persistable({ url: '<store address>', token: () => fetch('/api/token').then(r => r.ok ? r.text() : Promise.reject(Object.assign(new Error('not let in'), { status: r.status }))) });
await db.ready();                                  // the first token is in: db.space and db.readOnly are known
const me = await db.me();                          // { id, name }; db.name has the name too, with no call to the store
```

The client asks for a token when it first needs one and again shortly before each runs out. If the function fails, calls reject with its error, so a page can tell "not let in" from a store that is down; the client then asks your server again less and less often, up to once a minute. A token already in hand goes on being used for as long as it is good.

**What to put in a token.**

- `space`: one per audience. Use an id of yours that never changes, not a label somebody may rename: a new name is a new, empty space. The name need not be secret, since nothing reaches the space without a token, so it can be worked out from your own records each time and kept nowhere.
- `person`: one value for each person: an account id, or an id your server keeps in a cookie for each browser. Never the group's. Everyone who shares a `person` is one author to the store and can change or delete each other's objects. The store keeps a fingerprint of it, not the value: readers see an `owner` of 32 hex digits.
- `name`: optional, up to 80 characters, and only passed through to the page. The store does not keep it or check what a page writes into an object, so a name stored inside an object's `data` is still its author's own claim.
- `read: true`: this visitor reads and listens, and the store refuses anything else.
- `seconds`: how long it lasts, from 60 to 3600; 600 unless set. The store refuses a token good for more than an hour, and one that has run out, by its own clock. It allows a minute over the hour and nothing past the end, so keep your server's clock right, and stay off the two ends of the range if you cannot.

**What it gives you.**

- A space reached by token is its own. The same name with no token, or with a key, is a different and separate space, so nobody gets in by guessing a name, and one audience cannot ask for another's.
- The one rule holds inside it, as it does with no key: only an object's creator changes its `data` or deletes it. A keyed space trusts everyone who holds the key; this does not have to, because the store is told who each person is.
- Access ends by itself. Stop handing someone tokens (they signed out, the password changed) and the last one they hold stops working within its `seconds`. There is nothing to rotate and no data to move. There is also no way to end one sooner, which is why they are short.

**What it does not.**

- It cannot tell whether your server put the right space in a token. The store checks that the token is yours, not that it is right: a mistake there puts a visitor in another audience's data.
- Whoever holds `TOKEN_SECRET` can make a token for any space in the store. Keep it where you keep other server secrets. Sites that should not be able to reach each other's data need a store each.
- The data is no more private than before. A token keeps other audiences and strangers out; everyone let into a space reads all of it.
- Limits are still per space and per store, not per audience you care about more.

**Rules for your token address.** Check the visitor first, every time. Answer only to your own pages (same site; no `Access-Control-Allow-Origin`). Never let any cache keep the answer: `tokenResponse` sets `Cache-Control: no-store, private`, and if you build the answer another way, set it yourself, or one visitor's token is served to the next.

**From another language.** A token is a JWT signed with HS256 and your `TOKEN_SECRET`, with the claims `space`, `sub` (the person), `exp` (seconds since 1970, at most an hour ahead), `iat` (when it was made), and optionally `name`, `read` and `owner`. Any JWT library makes one. The store does not need `iat`, but send it: the page uses it to know how long the token is good for without trusting the visitor's clock. The store reads HS256 only.

**Tidying up.** Your own script reaches a token's space with the owner's token; see [admin.md](admin.md).

Removing what a stranger added, and the limits on a space, are in [admin.md](admin.md).
