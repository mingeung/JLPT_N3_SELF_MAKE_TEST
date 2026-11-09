-- 청해 대본 형광펜. 문제마다 한 행, 줄 번호별 [시작, 끝] 글자 위치 목록을 JSON으로 둔다.
create table public.highlights (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question_id text not null check (char_length(question_id) <= 40),
  marks jsonb not null default '{}'::jsonb check (pg_column_size(marks) <= 8192),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);
alter table public.highlights enable row level security;
create policy "own highlights read" on public.highlights for select to authenticated using ((select auth.uid()) = user_id);
create policy "own highlights add" on public.highlights for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own highlights change" on public.highlights for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own highlights delete" on public.highlights for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.highlights from anon;
grant select, insert, update, delete on public.highlights to authenticated;
