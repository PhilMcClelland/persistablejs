// Makes the tokens a site hands its visitors so a Persistable.js store takes the site's word for who they are.
// The store has TOKEN_SECRET set (`npx wrangler@4 secret put TOKEN_SECRET`); your server holds the same value.
// docs/access.md, "A token from your own site", has the whole of it.
//
// In your server (a Cloudflare Worker, or Node 20 or later). Copy this file next to your code; it needs nothing else:
//   import { tokenResponse } from './token.mjs';
//   // ...after YOUR check that this visitor is let in:
//   return tokenResponse(env.TOKEN_SECRET, { space: 'review/' + group.id, person: visitor.id, name: visitor.name });
//
//   space    which set of data. One per audience that should not see another's. Use an id of yours that does not
//            change, not a label someone may rename: a new name is a new, empty space.
//   person   who this visitor is: one value per person (an account id, or an id you keep in a cookie per browser).
//            Not the group's: people who share a `person` are one author, and can change each other's words.
//   name     optional: a name to show for them, up to 80 characters. The store does not keep it; the page reads it with (await db.me()).name.
//   read     optional, true: this visitor may read and listen, nothing else.
//   owner    optional, true: this caller may change and delete anything in the space, and remove it. For your own
//            tidying script, never for a visitor.
//   seconds  optional: how long the token lasts, from 60 to 3600. 600 unless set.
//
// From a terminal, for the owner's own calls: newtoken.mjs, beside this file.
// This file only makes tokens: it reads no arguments and no environment, so it is safe to bundle into a server.

const text = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = value => base64url(text.encode(JSON.stringify(value)));
/* half of a character pair cannot be carried in a token */
const whole = value => { try { encodeURIComponent(value); return true; } catch (_) { return false; } };

/* a token for one visitor: a JWT signed with HMAC-SHA-256, which is the only kind the store reads */
export async function token(secret, claims) {
  const { space, person, name, read, owner, seconds = 600 } = claims || {};
  /* a word this does not know is a slip (readOnly for read, say), and letting it pass would make a token that does more than was meant */
  for (const k of Object.keys(claims || {})) if (!['space', 'person', 'name', 'read', 'owner', 'seconds'].includes(k)) throw new Error('token: "' + k + '" is not something a token says (space, person, name, read, owner, seconds)');
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error('token: this needs Web Crypto, which a Cloudflare Worker has and Node has from version 20');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('token: the secret is 32 characters or more, the same as the store\'s TOKEN_SECRET');
  if (typeof space !== 'string' || !space || space.length > 200 || /[\u0000-\u001f]/.test(space) || !whole(space) || space === '.' || space === '..') throw new Error('token: space is a name of up to 200 characters');
  /* the store keeps a space named like a web address for that site's own pages, so a browser could not use this one */
  if (/^https?:\/\//i.test(space)) throw new Error('token: a space is a plain name, not an address');
  /* true or false and nothing like them: "false" from a query or an env file must not make an owner */
  if ((owner !== undefined && typeof owner !== 'boolean') || (read !== undefined && typeof read !== 'boolean')) throw new Error('token: owner and read are true or false');
  if (owner && read) throw new Error('token: owner and read together make an owner; choose one');
  if (!owner || person != null) {
    if (typeof person !== 'string' || !person || person.length > 200 || /[\u0000-\u001f]/.test(person) || !whole(person)) throw new Error('token: person is who this visitor is, in up to 200 characters (only the owner\'s token may leave it out)');
  }
  /* under a minute, a page spends its time asking for the next one; over an hour, the store refuses it */
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error('token: seconds is a whole number from 60 to 3600');
  const now = Math.floor(Date.now() / 1000), claim = { space, iat: now, exp: now + seconds };
  if (person != null) claim.sub = person;
  if (name != null) {
    if (typeof name !== 'string' || !whole(name)) throw new Error('token: name is text');
    const shown = Array.from(name.trim()).slice(0, 80).join('');   // cut between characters, never through one
    if (shown) claim.name = shown;
  }
  if (read) claim.read = true;
  if (owner) claim.owner = true;
  const body = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part(claim);
  const key = await crypto.subtle.importKey('raw', text.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const made = body + '.' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(body))));
  if (made.length > 2000) throw new Error('token: too long for the store to read (2000 characters); shorten space, person or name');
  return made;
}

/* the same, as the answer your token address gives: plain text that no cache, shared or the browser's own, may keep.
   A kept answer is one visitor's token handed to the next. */
export async function tokenResponse(secret, claims) {
  return new Response(await token(secret, claims), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
}
