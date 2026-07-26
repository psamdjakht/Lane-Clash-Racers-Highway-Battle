-- Lane Clash Racers: Highway Battle
-- Chạy toàn bộ file này trong Supabase > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null default 'Phòng đua',
  host_id text not null,
  status text not null default 'waiting' check (status in ('waiting','racing','closed')),
  mode text not null default 'race' check (mode in ('race','endless')),
  max_players integer not null default 4 check (max_players between 2 and 8),
  lane_count integer not null default 4 check (lane_count between 2 and 8),
  duration_seconds integer not null default 120 check (duration_seconds between 0 and 1800),
  ai_difficulty integer not null default 6 check (ai_difficulty between 1 and 10),
  obstacle_density integer not null default 6 check (obstacle_density between 1 and 10),
  powerup_density integer not null default 5 check (powerup_density between 1 and 10),
  seed integer not null default 1,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id text not null,
  name text not null,
  avatar integer not null default 1 check (avatar between 1 and 22),
  color integer not null default 0 check (color between 0 and 7),
  is_host boolean not null default false,
  is_ready boolean not null default true,
  slot integer not null default 0 check (slot between 0 and 7),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique(room_id, player_id),
  unique(room_id, slot)
);

create index if not exists rooms_status_created_idx on public.rooms(status, created_at desc);
create index if not exists room_players_room_idx on public.room_players(room_id);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;

-- Chính sách mở cho game gia đình không đăng nhập.
-- Không dùng nguyên chính sách này cho game thương mại hoặc hệ thống cần chống gian lận.
drop policy if exists "rooms_public_read" on public.rooms;
drop policy if exists "rooms_public_insert" on public.rooms;
drop policy if exists "rooms_public_update" on public.rooms;
drop policy if exists "rooms_public_delete" on public.rooms;
create policy "rooms_public_read" on public.rooms for select to anon, authenticated using (true);
create policy "rooms_public_insert" on public.rooms for insert to anon, authenticated with check (true);
create policy "rooms_public_update" on public.rooms for update to anon, authenticated using (true) with check (true);
create policy "rooms_public_delete" on public.rooms for delete to anon, authenticated using (true);

drop policy if exists "players_public_read" on public.room_players;
drop policy if exists "players_public_insert" on public.room_players;
drop policy if exists "players_public_update" on public.room_players;
drop policy if exists "players_public_delete" on public.room_players;
create policy "players_public_read" on public.room_players for select to anon, authenticated using (true);
create policy "players_public_insert" on public.room_players for insert to anon, authenticated with check (true);
create policy "players_public_update" on public.room_players for update to anon, authenticated using (true) with check (true);
create policy "players_public_delete" on public.room_players for delete to anon, authenticated using (true);

-- Bật Postgres Changes cho danh sách phòng và người chơi.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='rooms'
  ) then alter publication supabase_realtime add table public.rooms; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='room_players'
  ) then alter publication supabase_realtime add table public.room_players; end if;
end $$;

-- Có thể chạy định kỳ để xóa phòng cũ hơn 12 giờ:
-- delete from public.rooms where updated_at < now() - interval '12 hours';
