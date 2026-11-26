#!/usr/bin/env node
// Runs the keep-alive's one query from here, so you know it works before trusting the schedule.
//   SUPABASE_URL=... SUPABASE_KEY=... node stores/supabase-keepalive/check.mjs
import { ping } from './worker.js';
const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('set SUPABASE_URL and SUPABASE_KEY (the publishable key) in the environment'); process.exit(2); }
try { const ok = await ping({ SUPABASE_URL, SUPABASE_KEY }); console.log(ok ? 'ok: the project answered the keep-alive query' : 'FAIL: unexpected answer'); process.exit(ok ? 0 : 1); }
catch (e) { console.log('FAIL: ' + e.message + '\n(run stores/supabase.sql again: it adds persistable_ping)'); process.exit(1); }
