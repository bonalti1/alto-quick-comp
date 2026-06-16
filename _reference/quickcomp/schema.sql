create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  name text not null default '',
  brokerage text not null default '',
  phone text not null default '',
  license text not null default '',
  logo_url text not null default '',
  headshot_url text not null default '',
  status text not null default 'trial' check (status in ('trial', 'active', 'expired')),
  plan text not null default 'trial' check (plan in ('trial', 'monthly', 'annual')),
  report_count integer not null default 0,
  report_limit integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists logo_url text not null default '';
alter table public.profiles add column if not exists headshot_url text not null default '';

create table if not exists public.workspace_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  type text not null check (type in ('comps', 'lending', 'tax', 'workspace')),
  address text not null default '',
  key_value text not null default '',
  meta text not null default '',
  payload jsonb not null default '{}'::jsonb,
  saved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_key)
);

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  report_type text not null default 'report',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.workspace_items enable row level security;
alter table public.usage_events enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "workspace_select_own" on public.workspace_items;
create policy "workspace_select_own"
  on public.workspace_items for select
  using (auth.uid() = user_id);

drop policy if exists "workspace_insert_own" on public.workspace_items;
create policy "workspace_insert_own"
  on public.workspace_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "workspace_update_own" on public.workspace_items;
create policy "workspace_update_own"
  on public.workspace_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "usage_select_own" on public.usage_events;
create policy "usage_select_own"
  on public.usage_events for select
  using (auth.uid() = user_id);

drop policy if exists "usage_insert_own" on public.usage_events;
create policy "usage_insert_own"
  on public.usage_events for insert
  with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('branding-assets', 'branding-assets', true)
on conflict (id) do update set public = true;

drop policy if exists "branding_assets_read_public" on storage.objects;
create policy "branding_assets_read_public"
  on storage.objects for select
  using (bucket_id = 'branding-assets');

drop policy if exists "branding_assets_insert_own" on storage.objects;
create policy "branding_assets_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'branding-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "branding_assets_update_own" on storage.objects;
create policy "branding_assets_update_own"
  on storage.objects for update
  using (
    bucket_id = 'branding-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'branding-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
