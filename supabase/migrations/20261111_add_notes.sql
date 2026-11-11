-- 문제별 메모(필기). 문제마다 한 행.
create table public.notes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question_id text not null check (char_length(question_id) <= 40),
  body text not null default '' check (char_length(body) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);
alter table public.notes enable row level security;
create policy "own notes read" on public.notes for select to authenticated using ((select auth.uid()) = user_id);
create policy "own notes add" on public.notes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own notes change" on public.notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own notes delete" on public.notes for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.notes from anon;
grant select, insert, update, delete on public.notes to authenticated;
