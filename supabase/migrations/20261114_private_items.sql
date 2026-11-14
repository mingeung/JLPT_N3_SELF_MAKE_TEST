-- 한 사람만 볼 수 있는 개인 문제(직접 산 문제집에서 옮긴 복습용 문항 등).
-- 앱에는 읽기만 열어 두고, 쓰기는 관리자(서비스 키)만 한다.
create table public.private_items (
  owner uuid not null references auth.users(id) on delete cascade,
  item_id text not null check (char_length(item_id) <= 60),
  set_id text not null,
  kind text not null check (kind in ('q', 'g', 'exam')),
  data jsonb not null check (pg_column_size(data) <= 200000),
  primary key (owner, item_id)
);
alter table public.private_items enable row level security;
create policy "own private items read" on public.private_items for select to authenticated using ((select auth.uid()) = owner);
revoke all on public.private_items from anon;
revoke all on public.private_items from authenticated;
grant select on public.private_items to authenticated;

-- 개인 문제의 음성 파일. <owner uuid>/<파일> 경로에 두고 본인만 읽는다.
insert into storage.buckets (id, name, public) values ('private-audio', 'private-audio', false)
on conflict (id) do nothing;
create policy "own private audio read" on storage.objects for select to authenticated
  using (bucket_id = 'private-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
