-- Persistable.js 0.1.0 on Supabase: one table of objects, two small ones of running totals, and the functions that are the
-- only way to them.
-- Run once in the project (SQL editor, `supabase db push`, or an agent with database access). Safe to run again.
--
-- This is the same store as worker.js, kept in Postgres: spaces hold collections, collections hold objects
--   { id, owner, parent, created, updated, data, open }
-- and the one rule is the same: `data` is changed only by whoever created the object, `open` by anyone.
-- Deleting an object deletes the objects that name it as `parent`.
--
-- Access: the tables have row level security on and NO policies, so nobody reads or writes them directly. Everything
-- goes through the functions below, which need a signed-in user (an anonymous sign-in counts). They run as their
-- owner with an empty search_path, so every name in them is written with its schema.
-- Who is who: `owner` is a fingerprint of the signed-in user and the space, so one person is a different `owner` in
-- every space, as with worker.js.
-- A refusal is raised with SQLSTATE 'PT' and an HTTP status (PT403, PT409), which the API answers with that status.
--
-- What is sent is kept as it was sent. `data` and `open` are `json`, which is the text of the request, and never
-- `jsonb`, which Postgres would write out again in its own way: it keeps 1e131071 in a few bytes and prints it as
-- 131072 digits, so anything that measured, searched or returned a value could be made to build hundreds of megabytes
-- from a short request. Here a value is only ever the characters its author sent, a size is the size of those
-- characters, and each function takes the whole request as one value and measures it before looking inside.
--
-- Limits, the same as worker.js: data 100 KB and open 8 KB, each nested at most 32 deep; a collection holds 2000
-- objects and 16 MB; a space holds 50 collections. Three more, because a space's name is the caller's to choose and a
-- database has a size:
--   the whole table holds at most 200000 objects and 200 MB, counting each object's names as well as its data;
--   one person can write at most 10 MB in any one minute of the clock. Everyone together can write 100 MB, and past that only
--     people who have written little this minute (half a megabyte) go on writing: a few people writing as hard as
--     they can slow each other down, and never stop someone adding a note (at 300 MB it stops for all). A change counts for the part that was
--     changed (`data` or `open`, whole), so a tick in a small `open` costs a few hundred bytes however big `data` is;
--   and as a last stop nothing is added, made bigger, or rewritten in bulk once the table is 480 MB on disk. Small
--     changes (under 2 KB written, growing nothing) still go through then, and so does deleting. If that is ever reached with little in the table,
--     `vacuum full public.persistable_objects;` gives the disk back.
-- All of these numbers are in the functions below. The running totals are kept by triggers, in persistable_total; to
-- empty a space use `delete`, and if a total is ever in doubt, running this file again counts afresh.
-- Not here: link keys and read keys, live push (the client asks persistable_pulse every few seconds), and an owner's
-- secret. The owner is whoever can open the SQL editor:
--   delete from public.persistable_objects where space = '…';                       -- a whole space
--   delete from public.persistable_objects where space = '…' and collection = '…';  -- one collection

create table if not exists public.persistable_objects (
  space      text    not null,
  collection text    not null,
  id         text    not null,
  owner      text    not null,
  parent     text,
  created    bigint  not null,
  updated    bigint  not null,
  data       json    not null,
  open       json    not null,
  bytes      integer not null,   -- the size of data and open together, kept so that adding up a collection reads no values
  primary key (space, collection, id),
  foreign key (space, collection, parent) references public.persistable_objects (space, collection, id) on delete cascade
);
-- how many bytes each person, and everyone together (who = ''), wrote in each recent minute; and how much the table holds
create table if not exists public.persistable_spent (minute bigint not null, who text not null, bytes bigint not null, primary key (minute, who));
create table if not exists public.persistable_total (one boolean primary key default true check (one), objects bigint not null, weight bigint not null);
-- Held while the rest of this file sets them up, in the order a write first touches them. It matters only when the file is
-- run in one transaction over a store that is in use: without it the file and the writers can each wait on the other.
do $$ begin
  lock table public.persistable_objects in access exclusive mode;
  lock table public.persistable_total in access exclusive mode;
  lock table public.persistable_spent in access exclusive mode;
end $$;
create index if not exists persistable_objects_parent on public.persistable_objects (space, collection, parent);
-- old versions of changed objects are cleared away after a couple of hundred changes, not after a fifth of the table
alter table public.persistable_objects set (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 200,
  toast.autovacuum_vacuum_scale_factor = 0, toast.autovacuum_vacuum_threshold = 200);
alter table public.persistable_objects enable row level security;
revoke all on public.persistable_objects from public, anon, authenticated;

alter table public.persistable_spent enable row level security;
revoke all on public.persistable_spent from public, anon, authenticated;

alter table public.persistable_total enable row level security;
revoke all on public.persistable_total from public, anon, authenticated;

-- What an object weighs against the table's limit: its data, and its names once for the row and once for each index
-- they are in. An empty object with long names is not free.
create or replace function public.persistable_weight(p_space text, p_collection text, p_id text, p_parent text, p_bytes int)
returns bigint language sql immutable set search_path = '' as $$
  select p_bytes::bigint + 3 * (octet_length(p_space) + octet_length(p_collection)) + 2 * octet_length(p_id) + 2 * coalesce(octet_length(p_parent), 0) + 200;
$$;

-- (each `where one` is there because Supabase refuses an update with no `where`, for the roles a page signs in as)
create or replace function public.persistable_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    update public.persistable_total set objects = 0, weight = 0 where one;
  elsif tg_op = 'INSERT' then
    update public.persistable_total set objects = objects + (select count(*) from fresh),
      weight = weight + (select coalesce(sum(public.persistable_weight(f.space, f.collection, f.id, f.parent, f.bytes)), 0) from fresh f) where one;
  elsif tg_op = 'DELETE' then
    update public.persistable_total set objects = objects - (select count(*) from gone),
      weight = weight - (select coalesce(sum(public.persistable_weight(g.space, g.collection, g.id, g.parent, g.bytes)), 0) from gone g) where one;
  else
    update public.persistable_total set weight = weight
      + (select coalesce(sum(public.persistable_weight(f.space, f.collection, f.id, f.parent, f.bytes)), 0) from fresh f)
      - (select coalesce(sum(public.persistable_weight(g.space, g.collection, g.id, g.parent, g.bytes)), 0) from gone g) where one;
  end if;
  return null;
exception when lock_not_available then   -- someone else has held the total too long: this write is undone and can be tried again
  perform public.persistable_no(429, 'this store is busy; try again');
  return null;
end $$;
drop trigger if exists persistable_count_insert on public.persistable_objects;
drop trigger if exists persistable_count_update on public.persistable_objects;
drop trigger if exists persistable_count_delete on public.persistable_objects;
drop trigger if exists persistable_count_truncate on public.persistable_objects;
create trigger persistable_count_insert after insert on public.persistable_objects referencing new table as fresh for each statement execute function public.persistable_count();
create trigger persistable_count_update after update on public.persistable_objects referencing old table as gone new table as fresh for each statement execute function public.persistable_count();
create trigger persistable_count_delete after delete on public.persistable_objects referencing old table as gone for each statement execute function public.persistable_count();
create trigger persistable_count_truncate after truncate on public.persistable_objects for each statement execute function public.persistable_count();
-- counted afresh each time this file is run, with writers kept waiting while it counts so that none is missed
do $$ begin
  perform 1 from public.persistable_total where one for update;   -- the total first and then the table, as a write takes them
  lock table public.persistable_objects in share row exclusive mode;
  insert into public.persistable_total (one, objects, weight)
    select true, count(*), coalesce(sum(public.persistable_weight(space, collection, id, parent, bytes)), 0) from public.persistable_objects
    on conflict (one) do update set objects = excluded.objects, weight = excluded.weight;
end $$;

-- say no, with the HTTP status the answer should carry
create or replace function public.persistable_no(p_status int, p_message text)
returns void language plpgsql volatile set search_path = '' as $$
begin
  raise exception using errcode = 'PT' || p_status::text, message = p_message;
end $$;

create or replace function public.persistable_now()
returns bigint language sql volatile set search_path = '' as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- A request, before anything looks inside it: an object, and no bigger than it may be. Its size is the size of the
-- text that was sent, read off the value without writing it out again.
create or replace function public.persistable_ask(p json, p_most int)
returns void language plpgsql volatile set search_path = '' as $$
begin
  if p is null or pg_column_size(p) > p_most + 8 then perform public.persistable_no(413, 'a request can be at most ' || p_most || ' bytes'); end if;
  if json_typeof(p) is distinct from 'object' then perform public.persistable_no(400, 'the body must be a JSON object'); end if;
end $$;

-- a name in a request (space, collection, id), if it was sent as words; anything else is no name at all
create or replace function public.persistable_str(p json)
returns text language sql immutable set search_path = '' as $$
  select case when json_typeof(p) = 'string' then p #>> '{}' end;
$$;

-- Who the caller is in this space. Also where the space's name is checked, and where a page on one site is kept out
-- of a space named after another: a browser says which page is asking, and cannot lie about it.
create or replace function public.persistable_who(p_space text)
returns text language plpgsql stable set search_path = '' as $$
declare v_origin text := nullif(current_setting('request.headers', true), '')::json ->> 'origin';
begin
  if auth.uid() is null then perform public.persistable_no(401, 'sign in first (an anonymous sign-in counts)'); end if;
  if p_space is null or p_space = '' or octet_length(p_space) > 200 or p_space ~ '[\x01-\x1f]' then perform public.persistable_no(404, 'no such address'); end if;
  if v_origin is not null and p_space ~ '^https?://' and p_space <> v_origin then perform public.persistable_no(403, 'this space belongs to another site'); end if;
  return substr(encode(sha256(convert_to(auth.uid()::text || E'\n' || p_space, 'UTF8')), 'hex'), 1, 32);
end $$;

create or replace function public.persistable_name(p_collection text)
returns void language plpgsql volatile set search_path = '' as $$
begin
  if p_collection is null or p_collection !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
    perform public.persistable_no(400, 'a collection name is up to 40 lower-case letters, digits, - and _, starting with a letter or digit');
  end if;
end $$;

create or replace function public.persistable_id(p_id text)
returns void language plpgsql volatile set search_path = '' as $$
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' then
    perform public.persistable_no(400, 'an id is up to 80 letters, digits, . - and _, starting with a letter or digit');
  end if;
end $$;

-- A part (data or open) as sent: an object, nested at most 32 deep (only objects and arrays count as a level, and the
-- part itself is the first), with no key anywhere in it that would reach an object's prototype in a page. It comes
-- back with each of its own keys once, in the order they were sent (the last value sent for a key wins, as it does
-- in a browser) and with nothing between them; every value in it is the text that was sent.
create or replace function public.persistable_part(p json)
returns json language plpgsql volatile set search_path = '' as $$
declare v_deep boolean; v_proto boolean;
begin
  if json_typeof(p) is distinct from 'object' then perform public.persistable_no(400, 'data and open must be objects'); end if;
  with recursive walk(k, v, d) as (
    select null::text, p, 1
    union all
    select kid.key, kid.value, walk.d + 1
    from walk cross join lateral (
      select key, value from json_each(case when json_typeof(walk.v) = 'object' then walk.v else '{}'::json end)
      union all
      select null::text, value from json_array_elements(case when json_typeof(walk.v) = 'array' then walk.v else '[]'::json end)
    ) kid
    where walk.d <= 32 and json_typeof(walk.v) in ('object', 'array')
  )
  select coalesce(bool_or(d > 32 and json_typeof(v) in ('object', 'array')), false), coalesce(bool_or(k = '__proto__'), false) into v_deep, v_proto from walk;
  if v_deep then perform public.persistable_no(400, 'data and open can be nested at most 32 deep'); end if;
  if v_proto then perform public.persistable_no(400, 'a key cannot be named __proto__'); end if;
  return coalesce((select ('{' || string_agg(to_json(t.key)::text || ':' || t.value::text, ',' order by t.first) || '}')::json from (
    select distinct on (e.key collate "C") e.key, e.value, min(e.n) over (partition by e.key collate "C") as first
    from json_each(p) with ordinality as e(key, value, n) order by e.key collate "C", e.n desc) t), '{}'::json);
end $$;

-- a patch laid over a part: keys set to null are removed, the rest replace what was there or are added after it.
-- Both have each key once.
create or replace function public.persistable_merge(p_into json, p_patch json)
returns json language sql volatile set search_path = '' as $$
  select coalesce((select ('{' || string_agg(to_json(t.key)::text || ':' || t.value::text, ',' order by t.side, t.n) || '}')::json from (
    select a.key, coalesce(b.value, a.value) as value, 0 as side, a.n
      from json_each(p_into) with ordinality as a(key, value, n) left join json_each(p_patch) b on b.key collate "C" = a.key collate "C"
      where b.key is null or json_typeof(b.value) <> 'null'
    union all
    select b.key, b.value, 1, b.n from json_each(p_patch) with ordinality as b(key, value, n)
      where json_typeof(b.value) <> 'null' and b.key collate "C" not in (select a.key collate "C" from json_each(p_into) a)
  ) t), '{}'::json);
$$;

create or replace function public.persistable_json(o public.persistable_objects)
returns json language sql stable set search_path = '' as $$
  select json_build_object('id', o.id, 'owner', o.owner, 'parent', o.parent, 'created', o.created, 'updated', o.updated, 'data', o.data, 'open', o.open);
$$;

-- one writer at a time in a space, so two requests cannot both count from the same number. Someone who has waited
-- three seconds for their turn is told to try again, not left waiting.
create or replace function public.persistable_hold(p_space text)
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('persistable ' || p_space, 0));
exception when lock_not_available then
  perform public.persistable_no(429, 'this space is busy; try again');
end $$;

-- May the caller write this much now? Asked BEFORE anything is written, because a write that is refused afterwards
-- is undone but has already taken its room on the disk, and would cost its sender nothing. The caller's own count
-- for the minute is added to here (one person's requests wait for each other on it, and nobody else's do); everyone's
-- is only read. Everyone's allowance stops only those who have written more than half a megabyte themselves this
-- minute: whoever is using it up, someone adding a note or ticking a box is not the one turned away. Three times
-- everyone's allowance is where it stops for all.
create or replace function public.persistable_allow(p_bytes int)
returns void language plpgsql volatile set search_path = '' as $$
declare v_minute bigint := public.persistable_now() / 60000; v_mine bigint; v_total bigint;
begin
  insert into public.persistable_spent as s (minute, who, bytes) values (v_minute, auth.uid()::text, p_bytes)
    on conflict (minute, who) do update set bytes = s.bytes + excluded.bytes returning s.bytes into v_mine;
  if v_mine > 10485760 then perform public.persistable_no(429, 'you are writing too much at once; try again in a minute'); end if;
  select bytes into v_total from public.persistable_spent where minute = v_minute and who = '';
  if (v_total > 104857600 and v_mine > 524288) or v_total > 314572800 then
    perform public.persistable_no(429, 'this store is taking too much at once; try again in a minute');
  end if;
exception when lock_not_available then
  perform public.persistable_no(429, 'this store is busy; try again');
end $$;

-- Add what was written to everyone's count for the minute. Called last, and it never refuses.
create or replace function public.persistable_spend(p_bytes int)
returns void language plpgsql volatile set search_path = '' as $$
declare v_minute bigint := public.persistable_now() / 60000;
begin
  insert into public.persistable_spent as s (minute, who, bytes) values (v_minute, '', p_bytes)
    on conflict (minute, who) do update set bytes = s.bytes + excluded.bytes;
  delete from public.persistable_spent where minute < v_minute - 10;
exception when lock_not_available then
  perform public.persistable_no(429, 'this store is busy; try again');
end $$;

-- The total is taken before anything is written, so that waiting for it (it is what every write passes through)
-- happens while there is still nothing to undo. The trigger then finds it already in hand.
create or replace function public.persistable_take()
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform 1 from public.persistable_total where one for update;
exception when lock_not_available then
  perform public.persistable_no(429, 'this store is busy; try again');
end $$;

-- A request may ask the API to undo it after it has run (Prefer: tx=rollback, or a limit on rows affected). By then
-- it has taken its room on the disk and been counted against nobody, so a write that asks for either is refused
-- before it starts.
create or replace function public.persistable_plain()
returns void language plpgsql stable set search_path = '' as $$
declare v_prefer text := lower(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'prefer', ''));
begin
  if v_prefer ~ 'tx\s*=|max-affected' then perform public.persistable_no(400, 'this store takes no Prefer for a transaction or for rows affected'); end if;
end $$;

-- Is there room? For one more object, for an object to grow by this much, or for this much to be written again in
-- place. A small change that grows nothing is not asked: tidying up, and ticking a box, go on working in a full
-- store. A big rewrite is asked about the disk whichever way the size went, because writing a part again takes
-- disk until the old copy is cleared; to make room in a full store, delete.
create or replace function public.persistable_room(p_more bigint, p_adding boolean, p_written int)
returns void language plpgsql volatile set search_path = '' as $$
declare v_n bigint; v_w bigint;
begin
  if p_adding or p_more > 0 then
    select objects, weight into v_n, v_w from public.persistable_total;
    if (p_adding and v_n >= 200000) or v_w + greatest(p_more, 0) > 209715200 then perform public.persistable_no(409, 'this store is full'); end if;
  end if;
  if (p_adding or p_more > 0 or p_written > 2048) and pg_total_relation_size('public.persistable_objects'::regclass) > 503316480 then
    perform public.persistable_no(409, 'this store is full');
  end if;
end $$;

revoke all on function public.persistable_no(int, text), public.persistable_now(), public.persistable_ask(json, int), public.persistable_who(text), public.persistable_name(text),
  public.persistable_id(text), public.persistable_part(json), public.persistable_merge(json, json), public.persistable_json(public.persistable_objects), public.persistable_hold(text),
  public.persistable_spend(int), public.persistable_allow(int), public.persistable_take(), public.persistable_plain(), public.persistable_room(bigint, boolean, int), public.persistable_str(json),
  public.persistable_weight(text, text, text, text, int), public.persistable_count()
  from public, anon, authenticated;

-- Every function below takes the request as one value, { space, collection?, id?, body?, parts? }.

create or replace function public.persistable_me(json)
returns json language plpgsql security definer set search_path = '' stable as $$
begin
  perform public.persistable_ask($1, 4096);
  return json_build_object('id', public.persistable_who(public.persistable_str($1->'space')));
end $$;

-- A collection, a page at a time: about a megabyte of objects, oldest first, and where to go on from if there are
-- more ({ rows, next }; send next back as `after`). Handed over whole, a full collection would have the database
-- hold several copies of all of it at once, for anyone who asked.
create or replace function public.persistable_list(json)
returns json language plpgsql security definer set search_path = '' stable as $$
declare v_space text; v_collection text; v_after json := $1->'after'; v_c bigint; v_i text;
        v_rows json; v_kept bigint; v_all bigint; v_last_c bigint; v_last_i text;
begin
  perform public.persistable_ask($1, 4096);
  v_space := public.persistable_str($1->'space'); v_collection := public.persistable_str($1->'collection');
  perform public.persistable_who(v_space); perform public.persistable_name(v_collection);
  if v_after is not null and json_typeof(v_after) <> 'null' then
    if json_typeof(v_after) <> 'array' or coalesce(v_after->>0, '') !~ '^[0-9]{1,18}$' or public.persistable_str(v_after->1) is null then
      perform public.persistable_no(400, 'after is the next from the page before');
    end if;
    v_c := (v_after->>0)::bigint; v_i := public.persistable_str(v_after->1);
  end if;
  with page as (
    select o.*, sum(o.bytes::bigint + 300) over (order by o.created, o.id) as run
    from public.persistable_objects o
    where o.space = v_space and o.collection = v_collection and (v_c is null or (o.created, o.id) > (v_c, v_i))
  ), kept as (
    select * from page where run - (bytes + 300) < 1048576
  )
  select (select json_agg(json_build_object('id', k.id, 'owner', k.owner, 'parent', k.parent, 'created', k.created, 'updated', k.updated, 'data', k.data, 'open', k.open) order by k.created, k.id) from kept k),
         (select count(*) from kept), (select count(*) from page),
         (select k.created from kept k order by k.created desc, k.id desc limit 1), (select k.id from kept k order by k.created desc, k.id desc limit 1)
    into v_rows, v_kept, v_all, v_last_c, v_last_i;
  return json_build_object('rows', coalesce(v_rows, '[]'::json), 'next', case when v_all > v_kept then json_build_array(v_last_c, v_last_i) end);
end $$;

-- one object, or null when there is none
create or replace function public.persistable_get(json)
returns json language plpgsql security definer set search_path = '' stable as $$
declare v_space text; v_collection text; v_id text;
begin
  perform public.persistable_ask($1, 4096);
  v_space := public.persistable_str($1->'space'); v_collection := public.persistable_str($1->'collection'); v_id := public.persistable_str($1->'id');
  perform public.persistable_who(v_space); perform public.persistable_name(v_collection); perform public.persistable_id(v_id);
  return (select public.persistable_json(o) from public.persistable_objects o where o.space = v_space and o.collection = v_collection and o.id = v_id);
end $$;

create or replace function public.persistable_create(json)
returns json language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_space text; v_collection text; v_body json; v_who text;
        v_id text; v_parent text; v_data json; v_open json; v_n bigint; v_b bigint; v_size int; v_cost int; v_now bigint;
        v_row public.persistable_objects;
begin
  perform public.persistable_plain();
  perform public.persistable_ask($1, 131072);
  v_space := public.persistable_str($1->'space'); v_collection := public.persistable_str($1->'collection'); v_body := $1->'body';
  v_who := public.persistable_who(v_space);
  perform public.persistable_name(v_collection);
  if json_typeof(v_body) is distinct from 'object' then perform public.persistable_no(400, 'data and open must be objects'); end if;
  if coalesce(json_typeof(v_body->'id'), 'null') not in ('string', 'null') or coalesce(json_typeof(v_body->'parent'), 'null') not in ('string', 'null') then
    perform public.persistable_no(400, 'id and parent are strings');
  end if;
  v_id := coalesce(v_body->>'id', gen_random_uuid()::text);
  v_parent := v_body->>'parent';
  perform public.persistable_id(v_id);
  v_data := public.persistable_part(coalesce(v_body->'data', '{}'::json));
  v_open := public.persistable_part(coalesce(v_body->'open', '{}'::json));
  if octet_length(v_open::text) > 8192 then perform public.persistable_no(413, 'the open part can be at most 8192 bytes'); end if;
  if octet_length(v_data::text) > 102400 then perform public.persistable_no(413, 'an object''s data can be at most 102400 bytes'); end if;
  v_size := octet_length(v_data::text) + octet_length(v_open::text);
  perform public.persistable_hold(v_space);
  if exists (select 1 from public.persistable_objects where space = v_space and collection = v_collection and id = v_id) then perform public.persistable_no(409, 'that id is taken'); end if;
  if v_parent is not null and not exists (select 1 from public.persistable_objects where space = v_space and collection = v_collection and id = v_parent) then
    perform public.persistable_no(400, 'no such parent');
  end if;
  select count(*), coalesce(sum(bytes), 0) into v_n, v_b from public.persistable_objects where space = v_space and collection = v_collection;
  if v_n >= 2000 or v_b + v_size > 16777216 then perform public.persistable_no(409, 'this collection is full'); end if;
  if v_n = 0 and (select count(distinct collection) from public.persistable_objects where space = v_space) >= 50 then
    perform public.persistable_no(409, 'this space has all the collections it can take');
  end if;
  perform public.persistable_room(public.persistable_weight(v_space, v_collection, v_id, v_parent, v_size), true, v_size);
  -- charged what it weighs, names and all; these are the last things that can say no, and nothing is written before them
  v_cost := least(public.persistable_weight(v_space, v_collection, v_id, v_parent, v_size), 2000000)::int;
  perform public.persistable_allow(v_cost);
  perform public.persistable_take();
  v_now := public.persistable_now();
  insert into public.persistable_objects (space, collection, id, owner, parent, created, updated, data, open, bytes)
    values (v_space, v_collection, v_id, v_who, v_parent, v_now, v_now, v_data, v_open, v_size) returning * into v_row;
  -- everyone's count last, so the row all writes pass through is held for as short a time as can be
  perform public.persistable_spend(v_cost);
  return public.persistable_json(v_row);
end $$;

create or replace function public.persistable_patch(json)
returns json language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_space text; v_collection text; v_id text; v_parts json; v_who text; v_has_data boolean; v_has_open boolean;
        v_was record; v_sent_data json; v_sent_open json; v_data json; v_open json;
        v_b bigint; v_size int; v_written int; v_now bigint; v_seen text;
begin
  perform public.persistable_plain();
  perform public.persistable_ask($1, 131072);
  v_space := public.persistable_str($1->'space'); v_collection := public.persistable_str($1->'collection'); v_id := public.persistable_str($1->'id'); v_parts := $1->'parts';
  v_who := public.persistable_who(v_space);
  perform public.persistable_name(v_collection); perform public.persistable_id(v_id);
  if json_typeof(v_parts) is distinct from 'object' then perform public.persistable_no(400, 'data and open must be objects'); end if;
  -- a part that was sent, whatever it was sent as: null and "words" are refused below, not passed over
  v_has_data := (v_parts->'data') is not null; v_has_open := (v_parts->'open') is not null;
  if v_has_data then v_sent_data := public.persistable_part(v_parts->'data'); end if;
  if v_has_open then v_sent_open := public.persistable_part(v_parts->'open'); end if;
  -- The change is worked out first with the space not held, and whatever would refuse it refuses it then: laying a
  -- big patch over a big part takes a while, and a request that is going to be turned away must not make the
  -- space's other writers wait for it. Then the space is held; if the object is not the very row that was read, it
  -- is worked out once more, owner and all, this time for certain.
  for v_try in 1..2 loop
    if v_try = 2 then perform public.persistable_hold(v_space); end if;
    -- `mark` names this very version of the row: which transaction wrote it, and where it lies. A time would not do:
    -- an object deleted and made again in the same millisecond, by someone else, has the same times and is not the same.
    select o.*, o.xmin::text || '/' || o.ctid::text as mark into v_was
      from public.persistable_objects o where o.space = v_space and o.collection = v_collection and o.id = v_id;
    if not found then perform public.persistable_no(404, 'missing'); end if;
    exit when v_try = 2 and v_was.mark = v_seen;
    v_seen := v_was.mark;
    if not (v_has_data or v_has_open) then perform public.persistable_no(400, 'send data, open or both'); end if;
    if v_has_data and v_was.owner <> v_who then perform public.persistable_no(403, 'only whoever created this can change its data'); end if;
    v_data := case when v_has_data then public.persistable_merge(v_was.data, v_sent_data) else v_was.data end;
    v_open := case when v_has_open then public.persistable_merge(v_was.open, v_sent_open) else v_was.open end;
    -- the open part is anyone's to change, so it has a small limit of its own: nobody can pad it until the author's own words no longer fit
    if v_has_open and octet_length(v_open::text) > 8192 then perform public.persistable_no(413, 'the open part can be at most 8192 bytes'); end if;
    if v_has_data and octet_length(v_data::text) > 102400 then perform public.persistable_no(413, 'an object''s data can be at most 102400 bytes'); end if;
  end loop;
  -- from here the space is held and v_was is the object as it is
  if not v_has_data then v_data := v_was.data; end if;
  if not v_has_open then v_open := v_was.open; end if;
  v_size := octet_length(v_data::text) + octet_length(v_open::text);
  if v_size > v_was.bytes then
    select coalesce(sum(bytes), 0) into v_b from public.persistable_objects where space = v_space and collection = v_collection;
    if v_b - v_was.bytes + v_size > 16777216 then perform public.persistable_no(409, 'this collection is full'); end if;
  end if;
  v_written := case when v_has_data then octet_length(v_data::text) else 0 end + case when v_has_open then octet_length(v_open::text) else 0 end;
  perform public.persistable_room(v_size - v_was.bytes, false, v_written);
  -- charged for the part that will be written; these are the last things that can say no, and nothing is written before them
  perform public.persistable_allow(200 + v_written);
  perform public.persistable_take();
  -- Only a part that was sent is written again: the other is left where it lies, however big it is. And always later
  -- than it was, so a change is never missed by someone comparing times.
  v_now := greatest(public.persistable_now(), v_was.updated + 1);
  if v_has_data and v_has_open then
    update public.persistable_objects set data = v_data, open = v_open, bytes = v_size, updated = v_now where space = v_space and collection = v_collection and id = v_id;
  elsif v_has_data then
    update public.persistable_objects set data = v_data, bytes = v_size, updated = v_now where space = v_space and collection = v_collection and id = v_id;
  else
    update public.persistable_objects set open = v_open, bytes = v_size, updated = v_now where space = v_space and collection = v_collection and id = v_id;
  end if;
  perform public.persistable_spend(200 + v_written);
  return json_build_object('id', v_was.id, 'owner', v_was.owner, 'parent', v_was.parent, 'created', v_was.created, 'updated', v_now, 'data', v_data, 'open', v_open);
end $$;

create or replace function public.persistable_remove(json)
returns void language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_space text; v_collection text; v_id text; v_who text; v_owner text;
begin
  perform public.persistable_plain();
  perform public.persistable_ask($1, 4096);
  v_space := public.persistable_str($1->'space'); v_collection := public.persistable_str($1->'collection'); v_id := public.persistable_str($1->'id');
  v_who := public.persistable_who(v_space);
  perform public.persistable_name(v_collection); perform public.persistable_id(v_id);
  perform public.persistable_hold(v_space);
  select owner into v_owner from public.persistable_objects where space = v_space and collection = v_collection and id = v_id;
  if not found then perform public.persistable_no(404, 'missing'); end if;
  if v_owner <> v_who then perform public.persistable_no(403, 'only whoever created this can delete it'); end if;
  perform public.persistable_take();
  delete from public.persistable_objects where space = v_space and collection = v_collection and id = v_id;   -- its children go with it
end $$;

-- What a page asks every few seconds in place of a live connection: for each collection in the space, how many
-- objects, the latest change, and the sum of every object's last change. A change always moves an object's time
-- on, so the sum differs whenever anything in the collection was added, changed or removed.
create or replace function public.persistable_pulse(json)
returns json language plpgsql security definer set search_path = '' stable as $$
declare v_space text;
begin
  perform public.persistable_ask($1, 4096);
  v_space := public.persistable_str($1->'space');
  perform public.persistable_who(v_space);
  return coalesce((select json_object_agg(c.collection, c.n || ':' || c.latest || ':' || c.total) from (
    select collection, count(*) as n, max(updated) as latest, sum(updated) as total from public.persistable_objects where space = v_space group by collection) c), '{}'::json);
end $$;

revoke all on function public.persistable_me(json), public.persistable_list(json), public.persistable_get(json), public.persistable_create(json),
  public.persistable_patch(json), public.persistable_remove(json), public.persistable_pulse(json) from public, anon;
grant execute on function public.persistable_me(json), public.persistable_list(json), public.persistable_get(json), public.persistable_create(json),
  public.persistable_patch(json), public.persistable_remove(json), public.persistable_pulse(json) to authenticated;

-- Keep-alive (optional; see stores/SUPABASE.md, "Keep a quiet project awake"). A free project is paused after about a
-- week with no activity. This is the smallest real query there is, open to the publishable key alone, so a scheduled
-- job can run it without signing anyone in. It says nothing about the data: it answers true.
create or replace function public.persistable_ping()
returns boolean language sql security definer set search_path = '' stable as $$
  select true from (select count(*) from public.persistable_objects where false) as touched;
$$;
revoke all on function public.persistable_ping() from public;
grant execute on function public.persistable_ping() to anon, authenticated;
