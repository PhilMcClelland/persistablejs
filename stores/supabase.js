/*! Persistable.js 0.1.0 store: Supabase · MIT · (c) 2026 Phil McClelland · https://github.com/PhilMcClelland/persistablejs */
/* Persistable.js, kept in a Supabase project in place of a Cloudflare Worker. Load it after persistable.js:

     <script src="persistable.js"></script>
     <script src="stores/supabase.js"></script>
     const db = Persistable({ store: 'supabase', url: 'https://abcd1234.supabase.co', apiKey: 'the publishable key' });

   Everything else is the same client: collections, the one rule, subscribe, onStatus. The project needs
   stores/supabase.sql run in it once and anonymous sign-ins turned on (stores/SUPABASE.md).

   Options: url (the project URL), apiKey (the project's publishable key, or the legacy anon key; it is meant to be
   public), space, poll (how often to ask what changed, in ms; 4000 unless set).

   How it differs from the Worker. People are signed in anonymously (no account, no redirect), and the session is kept
   in localStorage under "persistable.supabase.<url>". There is no live connection: the client asks every few seconds
   which collections changed, so watch() hears a collection's name without what changed in it, and subscribe() calls
   onResync. There are no link keys or read keys: passing `key` or `read` is refused, so a page cannot think it is
   private when it is not. Values are kept as the text that was sent, so a number too big for a page (1e400) reads
   back as Infinity, where the Worker would have stored null. Talks to the project over plain HTTPS; no SDK. */
(function (root) {
  'use strict';
  var Persistable = root.Persistable;
  if (typeof Persistable !== 'function' || !Persistable.stores) throw new Error('persistable supabase: load persistable.js before this file');
  var waiting = Object.create(null), apart = null;   // a sign-in under way, by project; and the same for each storage a client was given
  Persistable.stores.supabase = function (opt, kit) {
    /* the dashboard shows the address in several forms (with /rest/v1/ on the end, for one); only the origin is wanted */
    var url = String(opt.url || '').trim().replace(/^(https?:\/\/[^\/?#]+).*$/i, '$1'), apiKey = opt.apiKey;
    var space = kit.space, box = kit.storage, mark = kit.mark, SLOT = 'persistable.supabase.' + url;
    if (!url || !apiKey) throw new Error('persistable supabase: url and apiKey are required');
    if (opt.key || opt.read) throw new Error('persistable supabase: this store has no link keys or read keys');
    /* the session token rides on every request, so over plain http anyone on the way could read it and act as this person.
       A project on this machine (the Supabase CLI serves one over http) is the exception */
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) throw new Error('persistable supabase: the project URL must start with https://');

    /* an answer that is not JSON (a gateway's error page) is an answer with nothing in it, not a crash */
    var parsed = function (t) { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
    /* every request says whether the project is answering: any answer, even a refusal, means up; no answer, or its own
       failure (500 and over, which is also what a paused project gives), means down */
    function ask(path, headers, body, wait) {
      var init = { method: 'POST', headers: Object.assign({ apikey: apiKey, 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) };
      /* A request that never ends must not hold the sign-in, and with it every tab, for good. The timer is this file's
         own, so it holds in a browser with no AbortSignal.timeout and with a fetch that takes no signal; it is for
         getting an answer started, and a long answer (a big list on a slow line) is given longer. */
      var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null, t = null;
      if (ctl) init.signal = ctl.signal;
      var late = new Promise(function (_, fail) { t = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (_) { /* gone already */ } } fail(new Error('persistable: no answer from the project')); }, wait || 30000); });
      late.catch(function () { /* heard below, when it is the first to finish */ });
      var got = new Promise(function (ok) { ok(kit.fetch(url + path, init)); }).then(function (r) { return r.text().then(function (text) { return { status: r.status, ok: r.ok, json: parsed(text) }; }); });
      return Promise.race([got, late]).then(function (r) { clearTimeout(t); mark(r.status < 500); return r; }, function (e) { clearTimeout(t); mark(false); throw e; });
    }
    function refused(what, r) {
      var said = r.json && typeof r.json.message === 'string' ? r.json.message : null;
      var e = new Error('persistable: ' + what + ' failed (' + r.status + ') ' + (said || '')); e.status = r.status; e.detail = said; e.code = (r.json && (r.json.error_code || r.json.error)) || null; return e;
    }

    /* ---- the session: an anonymous user, kept in this browser and refreshed when it is about to run out ---- */
    var session = null;
    /* clients that keep their sessions in the same place share one sign-in, whichever place that is */
    var line = waiting;
    if (box && typeof box === 'object' && typeof WeakMap === 'function') { if (!apart) apart = new WeakMap(); line = apart.get(box); if (!line) { line = Object.create(null); apart.set(box, line); } }
    /* what is stored can be changed by any script on the site: a session is taken only if it has a session's shape */
    function stored() { try { var s = parsed(box.getItem(SLOT)); return s && typeof s === 'object' && typeof s.access === 'string' && /^[\x21-\x7e]+$/.test(s.access) && typeof s.refresh === 'string' && typeof s.until === 'number' ? { access: s.access, refresh: s.refresh, until: s.until } : null; } catch (_) { return null; } }
    session = stored();
    function keep(s) { session = { access: s.access_token, refresh: s.refresh_token, until: Date.now() + (Number(s.expires_in) || 3600) * 1000 }; try { box.setItem(SLOT, JSON.stringify(session)); } catch (_) { /* the session lasts for this visit only */ } return session; }
    function auth(path, body) {
      return ask('/auth/v1/' + path, {}, body).then(function (r) {
        if (!r.ok || !r.json || !r.json.access_token) { var e = refused('sign-in', r); e.message += ' Are anonymous sign-ins turned on in the project?'; throw e; }
        return keep(r.json);
      });
    }
    var fresh = function (s) { return !!(s && s.access && s.until - Date.now() > 60000); };
    /* the project's own words for "this session is finished": only these make a new person */
    var OVER = ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'invalid_grant'];
    function renew() {
      /* another tab, or another client on this page, may have signed in or refreshed since this one last looked, and a
         refresh token works once: take theirs */
      var theirs = stored();
      /* only when theirs is the newer: where nothing can be stored, what is stored is older than what this client holds */
      if (theirs && theirs.access && theirs.refresh !== (session && session.refresh) && (!session || theirs.until > session.until)) { session = theirs; if (fresh(session)) return Promise.resolve(session); }
      if (!session || !session.refresh) return auth('signup', { data: {} });
      /* A new person is made only when the project says this session is finished. A failure to reach it, its own
         trouble, or any other refusal is passed on instead: signing up again would cost this browser everything it
         made, for good. */
      return auth('token?grant_type=refresh_token', { refresh_token: session.refresh }).catch(function (e) { if (e && OVER.indexOf(e.code) >= 0) { session = null; return auth('signup', { data: {} }); } throw e; });
    }
    function signedIn() {
      if (fresh(session)) return Promise.resolve(session);
      /* One sign-in at a time for a project, however many clients the page has (the page's own and a widget's, say):
         two at once would be two people, and one of them would be lost at the next refresh. Across tabs, the
         browser's lock does the same where there is one. */
      if (!line[SLOT]) {
        /* where the browser will not give a lock (a sandboxed frame), go on without one, as a browser with none does */
        /* the answer is taken from renew() itself, not from what the lock hands back: a lock that never ran it, or
           gave back something else, must not become the session */
        var locks = root.navigator && root.navigator.locks, mine = null, go;
        var run = function () { return mine || (mine = renew()); };
        /* and a lock that is never given is not waited for past a minute: better two people than nobody */
        var tired = null, clear = function (v) { clearTimeout(tired); return v; };
        try { go = locks && typeof locks.request === 'function' ? Promise.race([Promise.resolve(locks.request(SLOT, run)).then(clear, function (e) { clear(); throw e; }), new Promise(function (ok) { tired = setTimeout(ok, 60000); })]).then(run, run) : run(); }
        catch (_) { go = run(); }
        line[SLOT] = Promise.resolve(go).then(function (s) { delete line[SLOT]; return s; }, function (e) { delete line[SLOT]; throw e; });
      }
      return line[SLOT].then(function (s) { session = s; return s; });
    }

    /* ---- the database: seven functions, each given one value that names the space; the table itself cannot be read directly ---- */
    function call(fn, args, what) {
      /* the whole request is one value, which the function measures before it looks inside */
      var send = function (s) { return ask('/rest/v1/rpc/persistable_' + fn, { Authorization: 'Bearer ' + s.access }, Object.assign({ space: space }, args), fn === 'list' ? 120000 : 30000); };
      return signedIn().then(send).then(function (r) {
        /* the project no longer takes this token though it had time left (a signing key changed, say): renew it once and ask again */
        if (r.status !== 401 || !session) return r;
        session.until = 0; return signedIn().then(send);
      }).then(function (r) { if (!r.ok) throw refused(what, r); return r.json; });
    }
    return {
      me: function () { return call('me', {}, 'whoami'); },
      /* a collection comes a page at a time (about a megabyte), so that a big one is never held whole by the database */
      list: function (name) {
        var all = [], turn = function (after, left) {
          return call('list', after ? { collection: name, after: after } : { collection: name }, 'list').then(function (page) {
            /* an answer that is not a page (a project still on an older stores/supabase.sql, a gateway's own page) is
               an error, never an empty collection: "nothing there" must only ever mean nothing is there */
            if (!page || !Array.isArray(page.rows)) throw new Error('persistable: list failed: the project did not answer with a page (has the current stores/supabase.sql been run in it?)');
            if (page.next != null && !Array.isArray(page.next)) throw new Error('persistable: list failed: the project did not answer with a page');
            var rows = page.rows, next = page.next || null;
            for (var i = 0; i < rows.length; i++) all.push(rows[i]);
            if (!next) return all;
            /* every page with more to come has at least one object and moves on from the last, so a collection is at
               most as many pages as it has objects; anything else is a project that is not making sense */
            if (!rows.length || left <= 0 || (after && next[0] === after[0] && next[1] === after[1])) throw new Error('persistable: list failed: the project sent the same page again');
            return turn(next, left - 1);
          });
        };
        return turn(null, 2000);
      },
      get: function (name, id) { return call('get', { collection: name, id: id }, 'get'); },   // the function answers null for "no such object"
      create: function (name, body) { return call('create', { collection: name, body: body }, 'create'); },
      patch: function (name, id, parts) { return call('patch', { collection: name, id: id, parts: parts }, 'update'); },
      remove: function (name, id) { return call('remove', { collection: name, id: id }, 'remove').then(function () { return null; }); },
      pulse: function () { return call('pulse', {}, 'pulse'); }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
