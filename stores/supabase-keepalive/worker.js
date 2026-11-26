/* Keeps a quiet Supabase project awake. A free project is paused after about a week with no activity; this Worker
   runs one small query every two days (persistable_ping, from stores/supabase.sql). It has no address of its own and holds no
   secret: the two values it needs are the public ones the prototype's page already carries.
   Deploy: see ../SUPABASE.md, "Keep a quiet project awake". */
export async function ping(env, doFetch) {
  const origin = new URL(env.SUPABASE_URL).origin;
  const res = await (doFetch || fetch)(origin + '/rest/v1/rpc/persistable_ping', {
    method: 'POST', headers: { apikey: env.SUPABASE_KEY, 'content-type': 'application/json' }, body: '{}'
  });
  if (!res.ok) throw new Error('persistable_ping failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
  return (await res.json()) === true;
}
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(ping(env).then(ok => console.log('persistable keep-alive: ' + (ok ? 'awake' : 'unexpected answer')))); }
};
