#!/usr/bin/env node
// Makes one token from a terminal, for the owner's own calls on a space reached by token (docs/admin.md).
// The secret is read from the environment, never typed into the command:
//   set -a; . ./.env.token; set +a                 # an env file that git ignores, holding TOKEN_SECRET=...
//   node newtoken.mjs --space review/acme --owner
//   node newtoken.mjs --space review/acme --person someone [--read] [--name "Their name"] [--seconds 600]
// A site's server uses token.mjs itself; this file is only its command line. Node 20 or later.
import { token } from './token.mjs';
const usage = 'usage: TOKEN_SECRET in the environment, then\n  node newtoken.mjs --space <space> --owner\n  node newtoken.mjs --space <space> --person <id> [--read] [--name <name>] [--seconds <n>]';
const stop = why => { console.error((why ? why + '\n' : '') + usage); process.exit(2); };
/* every word is accounted for: a flag that is not one of these, or a value that is missing, stops it. A typing slip must not
   quietly make a different token from the one that was meant. */
const TAKES = Object.assign(Object.create(null), { space: true, person: true, name: true, seconds: true, read: false, owner: false }), got = Object.create(null);
for (let args = process.argv.slice(2), i = 0; i < args.length; i++) {
  const m = /^--([a-z]+)(?:=(.*))?$/s.exec(args[i]);
  if (!m || !(m[1] in TAKES)) stop('not understood: ' + args[i]);
  if (m[1] in got) stop('given twice: --' + m[1]);
  if (!TAKES[m[1]]) { if (m[2] !== undefined) stop('--' + m[1] + ' takes no value'); got[m[1]] = true; continue; }
  const v = m[2] !== undefined ? m[2] : args[++i];
  if (v === undefined || (m[2] === undefined && /^--/.test(v))) stop('--' + m[1] + ' needs a value');
  got[m[1]] = v;
}
if (!process.env.TOKEN_SECRET) stop('TOKEN_SECRET is not in the environment');
if (!got.space) stop();
try { console.log(await token(process.env.TOKEN_SECRET, { space: got.space, person: got.person, name: got.name, read: got.read, owner: got.owner, seconds: got.seconds === undefined ? undefined : /^[0-9]+$/.test(got.seconds) ? Number(got.seconds) : NaN })); }
catch (e) { stop(e.message); }
