-- 개인 단어장(문제집에서 형광펜 친 단어 등)도 private_items에 둔다: kind 'v' = 단어장 한 묶음.
alter table public.private_items drop constraint if exists private_items_kind_check;
alter table public.private_items add constraint private_items_kind_check check (kind in ('q', 'g', 'exam', 'v'));
