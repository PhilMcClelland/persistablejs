#!/usr/bin/env node
// The read key that goes with a key: put it in a public page, and send the key itself only in the link.
//   node readkey.mjs --new            makes up a key and prints both
//   node readkey.mjs -                reads a key from standard input and prints its read key: a key typed into a command
//                                     stays in the shell's history, so give it this way (pbpaste | node readkey.mjs -)
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
let key = process.argv[2];
if (!key) { console.error('usage: node readkey.mjs --new | -'); process.exit(2); }
const fresh = key === '--new';
if (fresh) key = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
else if (key === '-') key = fs.readFileSync(0, 'utf8').trim();
if (!/^[A-Za-z0-9_-]{16,200}$/.test(key)) { console.error('a key is 16 to 200 letters, digits, - and _'); process.exit(2); }
if (!fresh && !/^[0-9a-f]{48}$/.test(key)) console.error('warning: this does not look like a key made by --new or by the client. A key someone chose can be guessed from its read key; use --new for a page that publishes its read key.');
const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('persistable read key\n' + key));
const read = [...new Uint8Array(hash)].slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
console.log(fresh ? 'key (for the link, after #k=): ' + key + '\nread key (for the page):       ' + read : read);
