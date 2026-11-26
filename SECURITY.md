# Security

Persistable.js is an open store by design: read `docs/access.md` and `docs/admin.md` for what it does and does not protect.

If you find a way round those rules (reading or writing a keyed space without its key, writing with a read key, changing someone else's `data`, getting past a limit, or anything that lets a caller harm a store or the pages that use it), please report it privately: open a draft security advisory on this repository (Security, then "Report a vulnerability"). Do not open a public issue for it.

There is no bounty and no promised response time. Fixes go into `worker.js` and `persistable.js` here; a deployed store has to be redeployed by its owner to get them.
