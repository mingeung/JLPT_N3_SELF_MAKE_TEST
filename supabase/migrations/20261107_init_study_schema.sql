-- 계정별 학습 기록. 문제 본문은 앱(public/questions.js)에 포함되고 DB에는 풀이 기록만 둔다.
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null unique check (char_length(nickname) between 2 and 20),
  created_at timestamptz not null default now()
);
create table public.attempts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question_id text not null check (char_length(question_id) <= 40),
  part text not null check (char_length(part) <= 20),
  correct boolean not null,
  mode text not null default 'drill' check (mode in ('drill','review','exam')),
  answered_at timestamptz not null default now()
);
create index attempts_user_time_idx on public.attempts (user_id, answered_at desc);
create table public.bookmarks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question_id text not null check (char_length(question_id) <= 40),
  created_at timestamptz not null default now(),
  primary key (user_id, question_id)
);
create table public.exam_results (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exam_no int not null check (exam_no between 1 and 20),
  lang_correct int not null, lang_total int not null,
  read_correct int not null, read_total int not null,
  listen_correct int not null, listen_total int not null,
  finished_at timestamptz not null default now()
);
create index exam_results_user_idx on public.exam_results (user_id, finished_at desc);
alter table public.profiles enable row level security;
alter table public.attempts enable row level security;
alter table public.bookmarks enable row level security;
alter table public.exam_results enable row level security;
create policy "own profile read" on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "own attempts read" on public.attempts for select to authenticated using ((select auth.uid()) = user_id);
create policy "own attempts add" on public.attempts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own attempts delete" on public.attempts for delete to authenticated using ((select auth.uid()) = user_id);
create policy "own bookmarks read" on public.bookmarks for select to authenticated using ((select auth.uid()) = user_id);
create policy "own bookmarks add" on public.bookmarks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own bookmarks delete" on public.bookmarks for delete to authenticated using ((select auth.uid()) = user_id);
create policy "own exams read" on public.exam_results for select to authenticated using ((select auth.uid()) = user_id);
create policy "own exams add" on public.exam_results for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own exams delete" on public.exam_results for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.profiles, public.attempts, public.bookmarks, public.exam_results from anon;
grant select on public.profiles to authenticated;
grant select, insert, delete on public.attempts, public.bookmarks, public.exam_results to authenticated;
