-- Yanımda AI — aile/yaşlı kayıt-giriş tablosu
-- Supabase SQL Editor'da çalıştırın (MCP auth yoksa).
-- Mevcut `elders` ilaç/sohbet şemasına dokunmaz; kayıtta elder_id ile bağlanır.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  elder_id uuid references public.elders (id) on delete set null,
  name text not null,
  age integer,
  face_vector jsonb,
  family_name text,
  family_phone text not null,
  family_password text not null,
  family_sms_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_family_phone_unique unique (family_phone)
);

create index if not exists users_elder_id_idx on public.users (elder_id);
create index if not exists users_name_age_idx on public.users (lower(name), age);

alter table public.users enable row level security;

-- Backend service_role RLS'yi bypass eder.
-- Anon/authenticated doğrudan tabloya yazmasın (API üzerinden gelsin).
drop policy if exists "users_service_read" on public.users;
-- Bilinçli olarak anon policy yok: sadece service_role / backend.

comment on table public.users is
  'Yaşlı + aile kimlik/giriş profili; elders satırına elder_id ile bağlanır.';
