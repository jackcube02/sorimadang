-- Supabase SQL Editor에서 전체 실행한다. 신규 소리마당 전용 프로젝트를 사용한다.
-- 이 테이블과 함수는 서버(service_role)만 접근한다. 방문자에게 쓰기 권한을 주지 않는다.
create table if not exists public.sori_settings (
  id integer primary key check (id = 1),
  uploads_enabled boolean not null default true,
  max_storage_bytes bigint not null default 900000000 check (max_storage_bytes between 1 and 900000000),
  uploads_per_hour integer not null default 10 check (uploads_per_hour between 1 and 100),
  uploads_per_day integer not null default 100 check (uploads_per_day between 1 and 1000)
);
insert into public.sori_settings(id) values (1) on conflict do nothing;
create table if not exists public.sori_sounds (
  id text primary key check (id ~ '^user-[0-9a-fA-F-]{36}$'),
  author text not null check (length(trim(author)) between 1 and 30),
  title text not null check (length(trim(title)) between 1 and 80),
  recorded_date text not null default '',
  source text not null check (source in ('file','recording')),
  created_at timestamptz not null default now(),
  duration double precision not null check (duration >= 0.05 and duration <= 60.1),
  bytes bigint not null check (bytes > 0 and bytes <= 52428800),
  content_type text not null check (content_type in ('audio/wav','audio/mpeg')),
  object_key text not null unique,
  status text not null default 'pending' check (status in ('pending','published','hidden'))
);
create index if not exists sori_sounds_date on public.sori_sounds(status,created_at desc,id desc);
create table if not exists public.sori_limits (
  key text primary key, count integer not null, expires_at timestamptz not null
);
alter table public.sori_settings enable row level security;
alter table public.sori_sounds enable row level security;
alter table public.sori_limits enable row level security;
revoke all on public.sori_settings, public.sori_sounds, public.sori_limits from public, anon, authenticated;
grant all on public.sori_settings, public.sori_sounds, public.sori_limits to service_role;

-- 용량 예약을 한 행의 잠금으로 처리해 동시 등록 시에도 총량을 넘지 않게 한다.
create or replace function public.reserve_sori_sound(p_sound jsonb, p_ip_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  settings public.sori_settings%rowtype;
  existing public.sori_sounds%rowtype;
  used_bytes bigint;
  hour_key text := 'ip:' || to_char(now() at time zone 'UTC','YYYY-MM-DD-HH24') || ':' || p_ip_hash;
  day_key text := 'day:' || to_char(now() at time zone 'UTC','YYYY-MM-DD');
begin
  select * into settings from public.sori_settings where id=1 for update;
  if not found then raise exception 'Settings missing'; end if;
  select * into existing from public.sori_sounds where id=p_sound->>'id';
  if found then
    if existing.status='published' then return jsonb_build_object('existing',to_jsonb(existing)); end if;
    return jsonb_build_object('error','같은 소리가 이미 등록 중이거나 숨김 처리되어 있다.','status',409);
  end if;
  if not settings.uploads_enabled then return jsonb_build_object('error','현재 새 소리 등록을 잠시 쉬고 있다.','status',503); end if;
  delete from public.sori_limits where expires_at < now();
  if coalesce((select count from public.sori_limits where key=hour_key),0) >= settings.uploads_per_hour
     or coalesce((select count from public.sori_limits where key=day_key),0) >= settings.uploads_per_day then
    return jsonb_build_object('error','등록 횟수 한도에 도달했다. 잠시 뒤 다시 시도해달라.','status',429);
  end if;
  select coalesce(sum(bytes),0) into used_bytes from public.sori_sounds;
  if used_bytes + (p_sound->>'bytes')::bigint > settings.max_storage_bytes then
    return jsonb_build_object('error','공용 저장 공간이 가득 차 새 소리를 등록할 수 없다.','status',507);
  end if;
  insert into public.sori_sounds(id,author,title,recorded_date,source,duration,bytes,content_type,object_key)
  values(p_sound->>'id',p_sound->>'author',p_sound->>'title',p_sound->>'recorded_date',p_sound->>'source',
    (p_sound->>'duration')::double precision,(p_sound->>'bytes')::bigint,p_sound->>'content_type',p_sound->>'object_key');
  insert into public.sori_limits(key,count,expires_at) values(hour_key,1,now()+interval '2 hours'),(day_key,1,now()+interval '2 days')
  on conflict(key) do update set count=public.sori_limits.count+1;
  return jsonb_build_object('reserved',true);
end;
$$;
create or replace function public.list_sori_sounds(p_query text default '', p_before_time timestamptz default null, p_before_id text default '')
returns setof public.sori_sounds language sql stable security invoker set search_path = '' as $$
  select * from public.sori_sounds where status='published'
    and (p_query='' or strpos(lower(author || ' ' || title || ' ' || recorded_date || ' ' || created_at::text),lower(p_query))>0)
    and (p_before_time is null or (created_at,id) < (p_before_time,p_before_id))
  order by created_at desc,id desc limit 201;
$$;
revoke all on function public.reserve_sori_sound(jsonb,text), public.list_sori_sounds(text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.reserve_sori_sound(jsonb,text), public.list_sori_sounds(text,timestamptz,text) to service_role;

-- private 버킷. 공개 업로드 정책을 추가하지 않는다. 서버만 파일을 읽고 쓴다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sorimadang-sounds','sorimadang-sounds',false,52428800,array['audio/wav','audio/mpeg'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
