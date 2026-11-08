// 실제 Supabase에 임시 계정 2개를 만들어 가입·저장·격리·삭제를 확인한다.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../public/vendor/supabase.js', import.meta.url), 'utf8');
const supabase = new Function(src + ';return supabase;')();
const URL_ = 'https://cdmfglqqhqfjhblaikdz.supabase.co', KEY = 'sb_publishable_NXzZ41oAbjX6jckVqkfqMg_PGcL-BHN';
const toEmail = u => 'u' + [...new TextEncoder().encode(u)].map(b => b.toString(16).padStart(2, '0')).join('') + '@users.jlptn3.app';
const acct = b => fetch(`${URL_}/functions/v1/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify(b) });
const client = () => supabase.createClient(URL_, KEY, { auth: { persistSession: false } });
const ok = (name, c, extra = '') => console.log(c ? 'PASS' : 'FAIL', name, extra);
const tag = Date.now().toString(36);
const A = `테스트a${tag}`.slice(0, 20), B = `testb${tag}`, PW = 'pass-word-1234';

let r = await acct({ action: 'signup', username: A, password: PW }); ok('한글 아이디 가입', r.ok, r.status + ' ' + (r.ok ? '' : await r.text()));
r = await acct({ action: 'signup', username: A, password: PW }); ok('중복 아이디 거절', r.status === 409, r.status);
r = await acct({ action: 'signup', username: 'x', password: PW }); ok('짧은 아이디 거절', r.status === 400);
r = await acct({ action: 'signup', username: B, password: 'short' }); ok('짧은 비번 거절', r.status === 400);
r = await acct({ action: 'signup', username: B, password: PW }); ok('영문 아이디 가입', r.ok);

const a = client(), b = client();
let s = await a.auth.signInWithPassword({ email: toEmail(A), password: PW }); ok('A 로그인', !s.error, s.error?.message);
const aid = s.data.user?.id;
s = await b.auth.signInWithPassword({ email: toEmail(B), password: PW }); ok('B 로그인', !s.error);
const bad = await client().auth.signInWithPassword({ email: toEmail(A), password: 'wrong-pass' }); ok('틀린 비번 거절', !!bad.error);

const row = { id: crypto.randomUUID(), question_id: 'kanji-001', part: 'kanji', correct: false, mode: 'drill', answered_at: new Date().toISOString() };
let w = await a.from('attempts').upsert([row], { onConflict: 'id', ignoreDuplicates: true }); ok('A 기록 저장', !w.error, w.error?.message);
w = await a.from('attempts').upsert([row], { onConflict: 'id', ignoreDuplicates: true }); ok('재전송해도 오류 없음', !w.error, w.error?.message);
let g = await a.from('attempts').select('*'); ok('A 기록 1건만', g.data?.length === 1, g.data?.length);
g = await b.from('attempts').select('*'); ok('B는 A 기록 못 봄', g.data?.length === 0, g.data?.length);
g = await client().from('attempts').select('*'); ok('비로그인은 못 봄', g.error || g.data?.length === 0, g.error?.message);
w = await b.from('attempts').insert({ id: crypto.randomUUID(), user_id: aid, question_id: 'x', part: 'kanji', correct: true }); ok('B가 A 이름으로 저장 불가', !!w.error, w.error?.code);
w = await b.from('attempts').delete().eq('user_id', aid); g = await a.from('attempts').select('*'); ok('B가 A 기록 삭제 불가', g.data?.length === 1);
w = await a.from('attempts').update({ correct: true }).eq('id', row.id); g = await a.from('attempts').select('*').eq('id', row.id); ok('기록 수정 불가', g.data[0].correct === false);
w = await a.from('bookmarks').upsert([{ question_id: 'kanji-001' }], { onConflict: 'user_id,question_id', ignoreDuplicates: true }); ok('북마크 저장', !w.error, w.error?.message);
w = await a.from('exam_results').upsert([{ id: crypto.randomUUID(), exam_no: 1, lang_correct: 1, lang_total: 2, read_correct: 1, read_total: 2, listen_correct: 1, listen_total: 2 }], { onConflict: 'id', ignoreDuplicates: true }); ok('시험결과 저장', !w.error, w.error?.message);
g = await a.from('profiles').select('nickname').maybeSingle(); ok('프로필 조회', g.data?.nickname === A, g.data?.nickname);
g = await b.from('profiles').select('*'); ok('다른 사람 프로필 안 보임', g.data?.length === 1);
w = await b.from('profiles').insert({ user_id: aid, nickname: 'hack' }); ok('프로필 직접 생성 불가', !!w.error);

for (const c of [a, b]) {
  const { data: { session } } = await c.auth.getSession();
  const res = await fetch(`${URL_}/functions/v1/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: 'delete' }) });
  ok('계정 삭제', res.ok, res.status);
}
r = await acct({ action: 'delete' }); ok('토큰 없는 삭제 거절', r.status === 401, r.status);
const again = await client().auth.signInWithPassword({ email: toEmail(A), password: PW }); ok('삭제 후 로그인 불가', !!again.error);
