# Removing data and handling abuse

Without a key, anyone can add to a space, and only whoever added something can remove it. So the owner needs a way in: set `ADMIN_SECRET` on the Worker (`npx wrangler@4 secret put ADMIN_SECRET`, 24 characters or more, random; `SETUP.md` step 6 does it without the secret ever being typed) and send it as the Bearer token. That caller may delete any object, list a space's collections, clear one, and remove a space whole. Keep it out of every page; it is for you and your scripts.

```sh
# S is the store address, SPACE the space, URL-encoded; ADMIN_SECRET comes from an env file, never typed into the command
curl "$S/v1/s/$SPACE/_collections" -H "Authorization: Bearer $ADMIN_SECRET"              # which collections are there
curl -X DELETE "$S/v1/s/$SPACE/votes/$ID" -H "Authorization: Bearer $ADMIN_SECRET"     # one object, and its children
curl -X DELETE "$S/v1/s/$SPACE/votes?all=1" -H "Authorization: Bearer $ADMIN_SECRET"   # a whole collection
curl -X DELETE "$S/v1/s/$SPACE?all=1" -H "Authorization: Bearer $ADMIN_SECRET"         # the whole space
```

The last two take everything under them, so they have to say so: without `?all=1` the store answers 400 and deletes nothing. An address with an empty part or a slash on the end (`…/votes/` with `$ID` empty) is refused too, so a variable that was never set cannot turn "one object" into "all of them".

The owner reaches a keyed space the way anyone does, with `?k=<key>` or `?r=<read key>` on the address; the read key is enough, and it is in the page. The store keeps no list of spaces, so there is nothing to browse: you act on the spaces you know (a prototype's origin, or the `space` it sets).

A space is bounded so a stranger cannot grow it without limit: 2000 objects and 16 MB to a collection, 50 collections to a space, 200 listeners. The same bounds are what a stranger can fill in a space without a key: 50 collections of 16 MB each, which the prototype's own visitors then cannot add to. Only the owner can clear what a stranger filled, so set `ADMIN_SECRET` before the address is public. What is not bounded:

- **The number of spaces.** Any name makes one, and each can be filled to its limits. Someone with a script and the store's address can use up the account's storage allowance; since spaces cannot be listed, the remedy then is to delete the Worker, which deletes everything, and deploy again.
- **How fast requests arrive.** On the free plan that costs nothing but the day's allowance; on a paid plan, put a Cloudflare rate-limiting rule in front of the Worker.
- **Who listens.** One machine can hold all 200 listener places of a space it can read. Real visitors then get no live updates until it lets go (their pages still load and save). Removing the space drops every listener.
- **How much is read.** Reading needs no secret, and a collection is read whole. Anyone who can reach a space without a key can read a full collection, up to 16 MB, as often as they like. A change is not multiplied the same way: listeners are sent a changed object only while it is 8 KB or less. A page that subscribes fetches a larger one itself, once for a run of changes to it, not once for each.

`ALLOW_ORIGINS` stops none of these, because it only turns away other websites. It does turn away every website it does not list, your own pages on `http://localhost` included, until their origins are added (`SETUP.md`, "Before the address is public"). If any of them would matter, the data does not belong in an open store.
