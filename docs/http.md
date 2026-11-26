# From a script or an agent

The store is plain HTTP and JSON, so anything that can make a request can use it. Make up one secret, keep it somewhere private, and send it every time; it is who you are. A different secret is a different person. Make it random (`openssl rand -hex 24`), not a word you chose, and keep it in an env file that git ignores: everything you create carries a fingerprint of it that every reader sees, and a random secret is what keeps that from being guessed back. The store takes 16 to 200 characters. The fingerprint is made differently in each space, so the same secret is a different `owner` in every space, and `_me` tells you which you are in this one.

```sh
# S is the store address, SPACE the space (the prototype's origin, URL-encoded, unless the page sets one)
# SECRET comes from the env file, never typed into the command:  set -a; . ./.env; set +a
curl "$S/v1/s/$SPACE/_me" -H "Authorization: Bearer $SECRET"                       # who am I here: { id }
curl "$S/v1/s/$SPACE/votes"                                                        # read a collection
curl -X POST "$S/v1/s/$SPACE/votes" -H "Authorization: Bearer $SECRET" \
     -H 'Content-Type: application/json' -d '{"data":{"choice":"B"}}'              # add
curl -X PATCH "$S/v1/s/$SPACE/votes/$ID" -H "Authorization: Bearer $SECRET" \
     -H 'Content-Type: application/json' -d '{"open":{"counted":true}}'            # change
curl -X DELETE "$S/v1/s/$SPACE/votes/$ID" -H "Authorization: Bearer $SECRET"       # remove
```

For a keyed space add `?k=$KEY` to each address; the key is the part after `#k=` in the prototype's link. With the key a script can change or remove anything, which is how to tidy a space. Without one it is held to the one rule like everybody else. The client also runs in Node: pass `fetch` and a `storage` object with `getItem` and `setItem`, as `verify.mjs` does. The full address list is at the top of `worker.js`.

The owner's calls, which need `ADMIN_SECRET`, are in [admin.md](admin.md).
