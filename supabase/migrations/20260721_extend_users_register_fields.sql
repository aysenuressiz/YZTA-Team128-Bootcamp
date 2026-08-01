-- Yanımda AI — kayıt formu genişletmesi (yaşlı + aile alanları)
-- Supabase SQL Editor'da çalıştırın.

alter table public.users
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists birth_date date,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists elderly_password text,
  add column if not exists family_first_name text,
  add column if not exists family_last_name text,
  add column if not exists family_relationship text,
  add column if not exists family_birth_date date,
  add column if not exists family_email text;

-- Geriye uyumluluk: name / family_name dolu kalsın (görünen ad).
-- E-posta varsa tekil olsun (boşlara dokunma).
create unique index if not exists users_email_unique_idx
  on public.users (lower(email))
  where email is not null and length(trim(email)) > 0;

create unique index if not exists users_family_email_unique_idx
  on public.users (lower(family_email))
  where family_email is not null and length(trim(family_email)) > 0;

-- Yaşlı telefonu (aile telefonundan ayrı)
create unique index if not exists users_elderly_phone_unique_idx
  on public.users (phone)
  where phone is not null and length(trim(phone)) > 0;

comment on column public.users.first_name is 'Yaşlı adı';
comment on column public.users.last_name is 'Yaşlı soyadı';
comment on column public.users.birth_date is 'Yaşlı doğum tarihi';
comment on column public.users.phone is 'Yaşlı telefonu';
comment on column public.users.email is 'Yaşlı e-posta (opsiyonel)';
comment on column public.users.elderly_password is 'Yaşlı kullanıcı şifresi (telefon + şifre girişi)';
comment on column public.users.family_first_name is 'Aile/refakatçi adı';
comment on column public.users.family_last_name is 'Aile/refakatçi soyadı';
comment on column public.users.family_relationship is 'Yaşlıya yakınlık (eş, çocuk, torun...)';
comment on column public.users.family_birth_date is 'Aile/refakatçi doğum tarihi';
comment on column public.users.family_email is 'Aile/refakatçi e-posta';
