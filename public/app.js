/* 능이 JLPT N3 — 학습 기록은 이 기기에 먼저 쓰고, 로그인되어 있으면 Supabase로 보낸다. */
const SB_URL = 'https://cdmfglqqhqfjhblaikdz.supabase.co';
const SB_KEY = 'sb_publishable_NXzZ41oAbjX6jckVqkfqMg_PGcL-BHN'; // 공개용 키. 접근은 RLS가 막는다.
const sb = supabase.createClient(SB_URL, SB_KEY);
const { parts: PARTS, q: QS, g: GROUPS, exams: EXAMS } = window.N3;
const PRIV_EXAMS = []; // 로그인한 사람만 받는 개인 모의고사(문제집 풀이 결과)
const examOf = no => EXAMS.find(x => x.no === no) || PRIV_EXAMS.find(x => x.no === no);
const examName = no => examOf(no)?.label || `모의고사 ${no}회`;
const revKey = id => `${'n3'}-examrev-${id}`;
/* 지난 시험의 문항별 결과. 이 기기에서 푼 것은 고른 답까지 저장돼 있고, 아니면 풀이 기록에서 되살린다. */
function examReview(row, no) {
  const pe = PRIV_EXAMS.find(x => x.no === no); if (pe) return pe.review.filter(r => Q[r.id]);
  const saved = lsGet(revKey(row.id)); if (saved) return saved;
  const ids = examOf(no)?.sec.flat() || [], t = +new Date(row.finished_at), set = new Set(ids), got = {};
  for (const a of store.attempts) if (a.mode === 'exam' && set.has(a.question_id) && Math.abs(+new Date(a.answered_at) - t) < 5 * 6e4) got[a.question_id] = a.correct;
  return ids.filter(id => id in got).map(id => ({ id, pick: null, ok: got[id] }));
}
const examMins = e => e.min || SECTIONS.slice(0, 2).map(s => s.min);
const PART = Object.fromEntries(PARTS.map(p => [p.key, p]));
const Q = Object.fromEntries(QS.map(q => [q.id, q]));
const AREAS = ['문자·어휘', '문법', '독해', '청해'];
const SECTIONS = [
  { name: '언어지식 (문자·어휘)', min: 30 },
  { name: '언어지식 (문법)·독해', min: 70 },
  { name: '청해', min: 0 },
];
const PASS_TOTAL = 95, PASS_SECTION = 19;
const $app = document.getElementById('app');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장소가 막힌 환경 */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* 저장소가 막힌 환경 */ } };
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const toEmail = u => 'u' + [...new TextEncoder().encode(u)].map(b => b.toString(16).padStart(2, '0')).join('') + '@users.jlptn3.app';

/* 다음 시험일: 7월·12월 첫째 일요일 */
function nextExamDate() {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let y = now.getFullYear(); ; y++) for (const m of [6, 11]) {
    const d = new Date(y, m, 1); d.setDate(1 + (7 - d.getDay()) % 7);
    if (d >= today) return { date: d, days: Math.round((d - today) / 864e5) };
  }
}

/* ── 저장 ─────────────────────────────────────────── */
let user = null;      // { id, name } 또는 null(게스트)
let store = { attempts: [], bookmarks: [], exams: [], queue: [], hl: {}, notes: {} };
let syncState = 'local', flushing = false;
const key = () => `n3-store-${user ? user.id : 'guest'}`;
const persist = () => lsSet(key(), store);
const emptyStore = () => ({ attempts: [], bookmarks: [], exams: [], queue: [], hl: {}, notes: {} });

function enqueue(op) { if (user) { store.queue.push(op); } persist(); flush(); }

async function flush() {
  if (!user || flushing) return paintSync();
  flushing = true;
  try {
    while (store.queue.length) {
      const batch = [], kind = store.queue[0].t;
      while (batch.length < 200 && store.queue[batch.length]?.t === kind) batch.push(store.queue[batch.length]);
      const rows = batch.map(o => o.row);
      let res;
      if (kind === 'attempt') res = await sb.from('attempts').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      else if (kind === 'exam') res = await sb.from('exam_results').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      else if (kind === 'bm+') res = await sb.from('bookmarks').upsert(rows, { onConflict: 'user_id,question_id', ignoreDuplicates: true });
      else if (kind === 'hl') res = await sb.from('highlights').upsert(rows, { onConflict: 'user_id,question_id' });
      else if (kind === 'note') res = await sb.from('notes').upsert(rows, { onConflict: 'user_id,question_id' });
      else res = await sb.from('bookmarks').delete().eq('user_id', user.id).in('question_id', rows.map(r => r.question_id));
      if (res.error) throw res.error;
      store.queue.splice(0, batch.length); persist();
    }
    syncState = 'ok';
  } catch (e) { console.warn(e); syncState = 'fail'; }
  flushing = false; paintSync();
}
function paintSync() {
  const el = document.getElementById('sync'); if (!el) return;
  const n = store.queue.length;
  const t = !user ? '이 기기에만 저장 중' : syncState === 'fail' ? `연결되면 저장할게요 (${n})` : n ? '저장 중…' : '저장됨';
  el.textContent = t; el.className = 'sync' + (syncState === 'fail' || !user ? ' warn' : '');
}
addEventListener('online', flush);
setInterval(() => { if (store.queue.length) flush(); }, 30000);

/* 같은 계정을 N4 앱도 쓴다. N4 기록(문제 id 'n4-…', 모의고사 회차 11 이상)은 여기서 읽거나 지우지 않는다. */
const N3_ONLY = q => q.not('question_id', 'like', 'n4-%');
async function fetchAll(table, order, only) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await only(sb.from(table).select('*')).order(order, { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...data); if (data.length < 1000) return out;
  }
}
/* 로그인 시 서버 기록을 받고, 아직 안 보낸 기록과 게스트 기록을 합친다. */
async function loadAccount() {
  store = { ...emptyStore(), ...(lsGet(key()) || {}) };
  const guest = lsGet('n3-store-guest');
  if (guest && (guest.attempts.length || guest.bookmarks.length || guest.exams.length)) {
    for (const a of guest.attempts) store.queue.push({ t: 'attempt', row: a });
    for (const e of guest.exams) store.queue.push({ t: 'exam', row: e });
    for (const b of guest.bookmarks) store.queue.push({ t: 'bm+', row: { question_id: b } });
    for (const [qid, marks] of Object.entries(guest.hl || {})) store.queue.push({ t: 'hl', row: { question_id: qid, marks, updated_at: new Date().toISOString() } });
    store.hl = { ...(store.hl || {}), ...(guest.hl || {}) };
    for (const [qid, body] of Object.entries(guest.notes || {})) store.queue.push({ t: 'note', row: { question_id: qid, body, updated_at: new Date().toISOString() } });
    store.notes = { ...(store.notes || {}), ...(guest.notes || {}) };
    lsDel('n3-store-guest');
    store.attempts.push(...guest.attempts); store.exams.push(...guest.exams);
    store.bookmarks = [...new Set([...store.bookmarks, ...guest.bookmarks])];
    persist();
  }
  try {
    await flush();
    const [a, b, e, h, n] = await Promise.all([fetchAll('attempts', 'answered_at', N3_ONLY), fetchAll('bookmarks', 'created_at', N3_ONLY), fetchAll('exam_results', 'finished_at', q => q.lte('exam_no', 10)), fetchAll('highlights', 'updated_at', N3_ONLY).catch(err => { console.warn(err); return null; }), fetchAll('notes', 'updated_at', N3_ONLY).catch(err => { console.warn(err); return null; })]);
    const pendA = store.queue.filter(o => o.t === 'attempt').map(o => o.row);
    const pendE = store.queue.filter(o => o.t === 'exam').map(o => o.row);
    store.attempts = [...a, ...pendA];
    store.exams = [...e, ...pendE];
    store.bookmarks = b.map(x => x.question_id);
    if (h) { // 아직 못 보낸 형광펜이 서버 것보다 새롭다
      const pendH = Object.fromEntries(store.queue.filter(o => o.t === 'hl').map(o => [o.row.question_id, o.row.marks]));
      store.hl = { ...Object.fromEntries(h.map(x => [x.question_id, x.marks])), ...pendH };
    }
    if (n) { // 아직 못 보낸 메모가 서버 것보다 새롭다
      const pendN = Object.fromEntries(store.queue.filter(o => o.t === 'note').map(o => [o.row.question_id, o.row.body]));
      store.notes = { ...Object.fromEntries(n.filter(x => x.body).map(x => [x.question_id, x.body])), ...pendN };
    }
    persist(); indexAttempts();
  } catch (err) { console.warn(err); syncState = 'fail'; }
  await loadPrivate().catch(err => console.warn(err));
}

/* 개인 문항: 본인 계정에만 열린 private_items 표와 private-audio 저장소에서 받는다. */
async function loadPrivate() {
  if (!user) return;
  const { data, error } = await sb.from('private_items').select('kind,item_id,data');
  if (error) return console.warn(error);
  const paths = [];
  for (const r of data || []) {
    if (r.kind === 'g') GROUPS[r.item_id] = r.data;
    else if (r.kind === 'q') { if (!Q[r.item_id]) QS.push(r.data); Q[r.item_id] = r.data; if (r.data.aup) paths.push(r.data.aup); }
    else if (r.kind === 'exam' && !PRIV_EXAMS.some(x => x.no === r.data.no)) PRIV_EXAMS.push(r.data);
  }
  if (!paths.length) return;
  const { data: urls } = await sb.storage.from('private-audio').createSignedUrls(paths, 60 * 60 * 12);
  for (const u of urls || []) for (const q of QS) if (q.aup && q.aup === u.path && u.signedUrl) q.au = u.signedUrl;
}

/* ── 통계 ─────────────────────────────────────────── */
let hist = {}; // question_id → [correct, ...] 시간순
function indexAttempts() {
  hist = {};
  for (const a of [...store.attempts].sort((x, y) => new Date(x.answered_at) - new Date(y.answered_at))) (hist[a.question_id] ||= []).push(a.correct);
}
const isOpenWrong = id => { // 틀린 적이 있고, 그 뒤로 2번 연속 맞히지 못한 문제
  const h = hist[id]; if (!h) return false;
  const last = h.lastIndexOf(false); return last >= 0 && h.length - 1 - last < 2;
};
const wrongIds = () => Object.keys(hist).filter(id => Q[id] && isOpenWrong(id));
function partStat(k) {
  const qs = QS.filter(q => q.part === k && !q.src); let seen = 0, last = 0;
  for (const q of qs) { const h = hist[q.id]; if (h) { seen++; if (h[h.length - 1]) last++; } }
  return { total: qs.length, seen, acc: seen ? last / seen : null };
}
function record(q, correct, mode) {
  const row = { id: crypto.randomUUID(), question_id: q.id, part: q.part, correct, mode, answered_at: new Date().toISOString() };
  store.attempts.push(row); (hist[q.id] ||= []).push(correct);
  enqueue({ t: 'attempt', row });
}
function streak() {
  const days = new Set(store.attempts.map(a => dayKey(a.answered_at)));
  let n = 0; const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ── 문제 고르기 ──────────────────────────────────── */
const examIds = new Set(EXAMS.flatMap(e => e.sec.flat()));
function rank(q) { // 안 푼 연습 전용 → 안 푼 모의고사 문제 → 오래전에 푼 순
  if (!hist[q.id]) return examIds.has(q.id) ? 1 : 0;
  return 2;
}
function pickUnits(partKey, want, exclude = new Set()) {
  const qs = QS.filter(q => q.part === partKey && !q.src && !exclude.has(q.id));
  const units = {}; for (const q of qs) (units[q.gid || q.id] ||= []).push(q);
  const lastSeen = id => { let t = 0; for (const a of store.attempts) if (a.question_id === id) t = Math.max(t, +new Date(a.answered_at)); return t; };
  const scored = shuffle(Object.values(units)).map(u => ({ u, r: rank(u[0]), t: lastSeen(u[0].id) }))
    .sort((a, b) => a.r - b.r || a.t - b.t);
  const out = [];
  for (const { u } of scored) { if (out.length >= want) break; out.push(...u.map(q => q.id)); }
  return out;
}
const TODAY_N = 10;
/* 오늘의 학습 10문제: 복습할 문제 조금 + 약한 유형 + 단문 하나 + 여러 유형에서 고르게. exclude에 든 문제는 빼고 고른다. */
function todaySet(exclude = new Set()) {
  const ids = [];
  const add = arr => { for (const i of arr) if (ids.length < TODAY_N && !ids.includes(i) && !exclude.has(i)) ids.push(i); };
  const open = shuffle(wrongIds()); // 복습 3자리: 문제집 모의고사 오답을 2개까지 먼저
  add([...open.filter(i => Q[i].src).slice(0, 2), ...open.filter(i => !Q[i].src)].slice(0, 3));
  const weak = PARTS.filter(p => !p.group).map(p => ({ p, s: partStat(p.key) }))
    .sort((a, b) => (a.s.acc ?? .5) - (b.s.acc ?? .5) || a.s.seen / a.s.total - b.s.seen / b.s.total).slice(0, 3);
  for (const { p } of weak) add(pickUnits(p.key, 2, exclude));
  add(pickUnits('tanbun', 1, exclude));
  for (const p of shuffle(PARTS.filter(p => !p.group))) add(pickUnits(p.key, 1, exclude));
  return ids;
}
const bookRow = a => a.mode === 'exam' && Q[a.question_id]?.src; // 종이 문제집 채점 기록(오늘 푼 수에는 넣지 않음)
const todayDone = () => new Set(store.attempts.filter(a => !bookRow(a) && dayKey(a.answered_at) === dayKey(Date.now())).map(a => a.question_id));
/* 지문 문제는 같은 지문끼리 붙여 둔다 */
function keepGroups(ids) {
  const out = [], done = new Set();
  for (const id of ids) {
    const gid = Q[id].gid; if (!gid) { out.push(id); continue; }
    if (done.has(gid)) continue; done.add(gid);
    out.push(...ids.filter(x => Q[x].gid === gid));
  }
  return out;
}

/* ── 듣기 (브라우저 음성합성) ─────────────────────── */
const TTS = {
  rate: lsGet('n3-rate') || 1, run: 0, playing: false, voices: [],
  load() { this.voices = (speechSynthesis.getVoices() || []).filter(v => /^ja/i.test(v.lang)); },
  get ok() { return 'speechSynthesis' in window && this.voices.length > 0; },
  voice(sp) {
    const male = this.voices.find(v => /otoya|hattori|ichiro|keita|male|男/i.test(v.name) && !/female/i.test(v.name));
    const female = this.voices.find(v => /kyoko|o-ren|haruka|ayumi|nanami|sayaka|female|女/i.test(v.name)) || this.voices[0];
    if (sp === 'M') return { v: male || this.voices[0], pitch: male ? 1 : .72 };
    if (sp === 'F') return { v: female, pitch: 1.1 };
    return { v: female, pitch: .98 };
  },
  audio: null,
  stop() {
    this.run++; this.playing = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (this.audio) { this.audio.pause(); this.audio.onended = this.audio.onerror = null; this.audio = null; }
  },
  /* 미리 만든 음성 파일 재생. 실패하면 기기 음성으로 대신 읽는다. */
  playFile(q, onEnd) {
    this.stop(); const run = this.run; this.playing = true;
    const a = new Audio(q.au); this.audio = a;
    a.preservesPitch = true; a.playbackRate = this.rate;
    a.onended = () => { if (run === this.run) { this.playing = false; this.audio = null; onEnd?.(); } };
    const fail = () => { // 멈추기로 끊긴 경우(run이 바뀜)는 무시한다
      if (run !== this.run) return;
      this.audio = null;
      if (this.ok) this.play(audioLines(q), onEnd);
      else { this.playing = false; render(); toast('음성 파일을 불러오지 못했어요'); }
    };
    a.onerror = fail;
    a.play().catch(fail);
  },
  setRate(r) { this.rate = r; if (this.audio) this.audio.playbackRate = r; },
  async play(lines, onEnd) {
    this.stop(); const run = this.run; this.playing = true;
    for (const l of lines) {
      const sentences = l.t.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean); // 긴 문장은 크롬에서 끊겨서 나눈다
      for (const s of sentences) {
        if (run !== this.run) return;
        await new Promise(res => {
          const u = new SpeechSynthesisUtterance(s); const { v, pitch } = this.voice(l.sp);
          u.lang = 'ja-JP'; if (v) u.voice = v; u.pitch = pitch; u.rate = this.rate * .95;
          u.onend = u.onerror = res; speechSynthesis.speak(u);
        });
      }
      if (run === this.run) await new Promise(r => setTimeout(r, l.gap || 380));
    }
    if (run === this.run) { this.playing = false; onEnd?.(); }
  },
};
if ('speechSynthesis' in window) { TTS.load(); speechSynthesis.onvoiceschanged = () => { TTS.load(); }; }
function audioLines(q) {
  const lines = [...q.script];
  if (PART[q.part].spoken) q.c.forEach((c, i) => lines.push({ sp: 'N', t: `${i + 1}ばん。${c}`, gap: 700 }));
  return lines;
}

/* ── 공통 조각 ────────────────────────────────────── */
const syncEl = () => `<span id="sync" class="sync"></span>`;
const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  practice: '<path d="M14.5 5.5l4 4M5 19l1-4.5L15.5 5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9.5 18z"/>',
  exams: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3"/>',
  notes: '<path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z"/>',
  me: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V4"/>',
};
const tabs = cur => `<nav class="tabs">${[['home', '홈'], ['practice', '연습'], ['exams', '모의고사'], ['notes', '오답노트'], ['me', '내 기록']]
  .map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-go="${k}" aria-label="${l}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${l}</button>`).join('')}</nav>`;
const bar = (r, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.round(r * 100)}%"></i></div>`;
const pct = r => r == null ? '–' : Math.round(r * 100) + '%';
const accPill = acc => acc == null ? '' : `<span class="pill ${acc >= .8 ? 'ok' : acc < .6 ? 'no' : ''}">${pct(acc)}</span>`;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function vocabHtml(q) {
  if (!q.v?.length) return '';
  return `<div class="vocab">${q.v.map(x => `<span class="ja">${esc(x.w)}${x.r ? ` <small>${esc(x.r)}</small>` : ''}</span><span>${esc(x.m)}</span>`).join('')}</div>`;
}
/* 대본 한 줄을 글자 단위 조각으로 나눈다. 후리가나 덩어리는 한 조각. 형광펜 위치는 원문(t) 글자 번호로 저장한다. */
const unesc = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function lineUnits(l) {
  const src = l.r || esc(l.t), units = []; let o = 0;
  for (const m of src.matchAll(/<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>|([^<]+)/g)) {
    if (m[1] != null) { const b = unesc(m[1]); units.push({ b, rt: unesc(m[2]), o }); o += b.length; }
    else for (const ch of unesc(m[3])) { units.push({ b: ch, o }); o += ch.length; }
  }
  return units;
}
function lineHtml(l, ranges = []) {
  const on = u => ranges.some(([a, b]) => u.o < b && u.o + u.b.length > a);
  let out = '', open = false;
  for (const u of lineUnits(l)) {
    const h = on(u);
    if (h !== open) { out += h ? '<mark>' : '</mark>'; open = h; }
    const inner = u.rt ? `<ruby>${esc(u.b)}<rt>${esc(u.rt)}</rt></ruby>` : esc(u.b);
    out += `<span data-o="${u.o}" data-n="${u.b.length}">${inner}</span>`;
  }
  return out + (open ? '</mark>' : '');
}
const WHO = { M: '男', F: '女', N: '' };
function scriptHtml(q) {
  const marks = store.hl?.[q.id] || {};
  return `<div class="scr ${V.hlOn ? 'hlon' : ''}" data-q="${q.id}">${q.script.map((l, i) => `<div class="ln"><span class="who">${WHO[l.sp]}</span><div><p class="jp" lang="ja" data-li="${i}">${lineHtml(l, marks[i])}</p>${l.k ? `<p class="ko">${esc(l.k)}</p>` : ''}</div></div>`).join('')}</div>`;
}
function scriptPanel(q) {
  const has = Object.keys(store.hl?.[q.id] || {}).length;
  return `<div class="scrhead"><b>대본</b><div class="btns2">${has ? `<button class="chip" data-act="hlclear">지우기</button>` : ''}<button class="chip ${V.hlOn ? 'on' : ''}" data-act="hltoggle">🖍 형광펜${V.hlOn ? ' 켜짐' : ''}</button></div></div>
    ${V.hlOn ? '<p class="sub hlhelp">칠할 부분을 길게 눌러(또는 드래그해) 고르면 칠해져요. 칠한 곳을 누르면 지워져요.</p>' : ''}${scriptHtml(q)}`;
}
function passageHtml(q) {
  if (!q.gid) return '';
  const g = GROUPS[q.gid];
  return `<section class="panel">${g.title ? `<h3 class="ptitle ja">${esc(g.title)}</h3>` : ''}<div class="passage" lang="ja">${g.text}</div></section>`;
}
function audioHtml(q, disabled) {
  if (!q.script) return '';
  const warn = q.au || TTS.ok ? '' : `<p class="warnbox">이 기기에는 일본어 음성이 없어서 소리를 낼 수 없어요. 아래 ‘대본으로 풀기’를 쓰거나, 기기 설정에서 일본어 음성을 추가해 주세요.</p>
    <button class="primary ghost" data-act="showscript">대본으로 풀기</button>${V.showScript ? scriptHtml(q) : ''}`;
  return `<section class="panel"><div class="audio">
    <button class="primary" data-act="play" ${disabled || (!q.au && !TTS.ok) ? 'disabled' : ''}>${TTS.playing ? '■ 멈추기' : disabled ? '재생 완료' : '▶ 듣기'}</button>
    <button class="speed" data-act="rate">${TTS.rate}x</button></div>${warn}</section>`;
}
function optsHtml(q, chosen, reveal) {
  const hidden = PART[q.part].spoken && !reveal && !(!q.au && !TTS.ok && V.showScript);
  const hint = hidden ? '<p class="spokenhint">선택지는 소리로만 나와요. 끝까지 듣고 번호를 고르세요.</p>' : '';
  return `${hint}<div class="opts" lang="ja">${q.c.map((c, i) => {
    let cls = 'opt', mark = '';
    if (reveal) { if (i === q.a) { cls += ' right'; mark = '정답'; } else if (i === chosen) { cls += ' wrong'; mark = '내 답'; } }
    else if (i === chosen) cls += ' sel';
    return `<button class="${cls}" data-pick="${i}" ${reveal === 'lock' ? 'disabled' : ''}><span class="n">${i + 1}</span><span>${hidden ? '' : c}</span>${mark ? `<span class="mark">${mark}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
function choicesHtml(q, chosen) {
  return `<ol class="choices">${q.c.map((c, i) => {
    const tag = i === q.a ? '<span class="pill ok">정답</span>' : i === chosen ? '<span class="pill no">내 답</span>' : '';
    return `<li class="${i === q.a ? 'right' : i === chosen ? 'wrong' : ''}"><span class="n">${i + 1}</span><div>
      <p class="ja" lang="ja">${q.cr[i]} ${tag}</p><p class="m">${esc(q.cm[i])}</p><p class="why">${esc(q.cn[i])}</p></div></li>`;
  }).join('')}</ol>`;
}
function explainHtml(q, ok, chosen) {
  const g = q.gid ? GROUPS[q.gid] : null, rich = !!q.cr;
  const lineK = q.script?.some(l => l.k);
  return `<section class="panel exp">
    <p class="verdict ${ok ? 'ok' : 'no'}">${ok ? '정답이에요' : '아쉬워요'}</p>
    ${rich && q.fr ? `<div class="sent"><p class="ja" lang="ja">${q.fr}</p><p class="ko">${esc(q.fk)}</p></div>`
      : q.answer ? `<p class="ja" lang="ja">${esc(q.answer)}</p>` : ''}
    ${rich ? choicesHtml(q, chosen) : `<p>${esc(q.e)}</p>`}
    ${q.script ? `<div class="scrbox">${scriptPanel(q)}${lineK ? '' : `<p class="sub">${esc(q.tr || '')}</p>`}</div>`
      : q.tr && !rich ? `<details><summary>번역</summary><p>${esc(q.tr)}</p></details>` : ''}
    ${g?.sents ? `<details open><summary>지문 한 문장씩 보기</summary><div class="sentlist">${g.sents.map((x, i) => `<div class="ln"><span class="no">${i + 1}</span><div><p class="jp" lang="ja">${x.r}</p><p class="ko">${esc(x.k)}</p></div></div>`).join('')}</div></details>`
      : g?.tr ? `<details><summary>지문 번역</summary><p>${esc(g.tr)}</p></details>` : ''}
    ${q.v?.length ? `<details open><summary>단어 메모</summary>${vocabHtml(q)}</details>` : ''}
    <div class="memo"><label for="memo-${q.id}">📝 메모</label><textarea id="memo-${q.id}" data-memo="${q.id}" maxlength="2000" rows="3" placeholder="외울 단어, 헷갈린 점 등을 적어 두세요. 자동으로 저장돼요.">${esc(store.notes?.[q.id] || '')}</textarea></div>
    <button class="bmk" data-act="bm" data-id="${q.id}">${store.bookmarks.includes(q.id) ? '★ 저장한 문제' : '☆ 문제 저장하기'}</button>
  </section>`;
}

/* ── 화면 ─────────────────────────────────────────── */
let V = { name: 'home' };
function go(v) { TTS.stop(); V = typeof v === 'string' ? { name: v } : v; render(); document.querySelector('.scroll')?.scrollTo(0, 0); }

function vAuth() {
  const up = V.mode === 'signup';
  return `<div class="scroll"><form class="auth panel white" id="authform" style="border:0">
    <div class="brand"><div class="logo">N3</div><h1>능이 JLPT N3</h1><p class="sub">직접 만든 문제로 N3 합격까지</p></div>
    <div class="seg"><button type="button" class="${up ? '' : 'on'}" data-act="mode" data-m="login">로그인</button><button type="button" class="${up ? 'on' : ''}" data-act="mode" data-m="signup">회원가입</button></div>
    <label class="field">아이디<input name="u" autocomplete="username" autocapitalize="none" required value="${esc(V.u || '')}" placeholder="한글·영문·숫자 2~20자"></label>
    <label class="field">비밀번호<input name="p" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required ${up ? 'placeholder="8자 이상"' : ''}></label>
    ${up ? `<label class="field">비밀번호 확인<input name="p2" type="password" autocomplete="new-password" required></label><p class="sub">이메일을 받지 않아서 비밀번호를 찾을 수 없어요. 꼭 기억해 주세요.</p>` : ''}
    <p class="err" role="alert">${esc(V.err || '')}</p>
    <button class="primary" ${V.busy ? 'disabled' : ''}>${V.busy ? '잠시만요…' : up ? '가입하고 시작하기' : '로그인'}</button>
    <button type="button" class="textbtn" data-act="guest">로그인 없이 둘러보기</button>
  </form></div>`;
}

function vHome() {
  const { date, days } = nextExamDate();
  const wrong = wrongIds().length;
  const solved = Object.keys(hist).filter(id => Q[id] && !Q[id].src).length;
  const todayN = todayDone().size; // 같은 문제를 다시 풀어도 한 번만 센다
  return `<header class="top"><h1>오늘의 학습</h1>${syncEl()}</header>
  <div class="scroll">
    ${user ? `<p class="sub" style="margin-top:-8px">${esc(user.name)}님, 오늘도 한 걸음씩 가볼까요?</p>` : `<button class="notice" data-act="toauth"><span>로그인하면 기록이 계정에 저장돼요</span><span>›</span></button>`}
    <section class="panel">
      <div class="dday"><div><p class="sub">다음 JLPT</p><p style="font-weight:600">${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}</p></div><span class="big">D-${days}</span></div>
      <div class="stats3"><div><b>${todayN}</b><span>오늘 푼 문제</span></div><div><b>${streak()}일</b><span>연속 학습</span></div><div><b>${solved}</b><span>/ ${QS.filter(q => !q.src).length} 문제</span></div></div>
      ${bar(solved / QS.length)}
      ${(() => { const ss = lsGet(sessKey()); if (!ss || !ss.ids?.every(id => Q[id])) return ''; const n = Object.keys(ss.res).length;
        return `<div class="resume"><button class="primary" data-act="resume">이어서 풀기 · ${esc(ss.title)} ${n}/${ss.ids.length}</button><button class="link sub" data-act="dropsess">그만두기</button></div>`; })()}
      <button class="primary ${lsGet(sessKey()) ? 'ghost' : ''}" data-act="today">${todayN >= TODAY_N ? '다음 10문제 풀기' : '오늘의 10문제 풀기'}</button>
    </section>
    <div class="grid">
      <button class="part big2" data-go="notes">${wrong ? `<span class="pill no">${wrong}</span>` : ''}<b>오답노트</b><span>${wrong ? `복습할 문제 ${wrong}개` : '틀린 문제가 없어요'}</span></button>
      <button class="part big2" data-go="exams"><b>모의고사</b><span>정식 ${EXAMS.filter(e => !e.mini).length}회 · 미니 ${EXAMS.filter(e => e.mini).length}회</span></button>
    </div>
    <div class="lblrow"><h2 class="lbl">영역별 정답률</h2><button class="link sub" data-go="practice">연습하기 ›</button></div>
    <section class="panel">${AREAS.map(a => {
      const ps = PARTS.filter(p => p.area === a).map(p => partStat(p.key));
      const seen = ps.reduce((s, x) => s + x.seen, 0), acc = seen ? ps.reduce((s, x) => s + (x.acc || 0) * x.seen, 0) / seen : null;
      return `<div class="row"><span style="font-weight:600">${a}</span><span class="sub">${pct(acc)}</span></div>${bar(acc || 0, 'blue')}`;
    }).join('')}</section>
  </div>${tabs('home')}`;
}

function vPractice() {
  const area = V.area || '전체';
  const list = PARTS.filter(p => area === '전체' || p.area === area);
  return `<header class="top"><h1>유형별 연습</h1>${syncEl()}</header><div class="scroll">
    <div class="chips">${['전체', ...AREAS].map(a => `<button class="chip ${a === area ? 'on' : ''}" data-area="${a}">${a}</button>`).join('')}</div>
    <div class="grid">${list.map(p => {
      const s = partStat(p.key);
      return `<button class="part" data-part="${p.key}">${accPill(s.acc)}<b>${esc(p.name)}</b><span class="ja">${esc(p.ja)}</span><span>${s.seen} / ${s.total}</span>${bar(s.seen / (s.total || 1))}</button>`;
    }).join('')}</div></div>${tabs('practice')}`;
}

function startQuiz(ids, title, mode = 'drill', more = null) {
  ids = keepGroups(ids);
  if (!ids.length) return toast('풀 문제가 없어요');
  const open = new Set(wrongIds()); // 시작할 때 기준: 복습할 문제 / 전에 푼 문제
  const tags = Object.fromEntries(ids.filter(id => hist[id]).map(id => [id, open.has(id) ? 'review' : 'again']));
  go({ name: 'quiz', ids, i: 0, title, mode, res: {}, showScript: false, more, tags });
  saveSess();
}
function vQuiz() {
  const q = Q[V.ids[V.i]], p = PART[q.part], chosen = V.res[q.id]?.pick, done = chosen != null;
  const two = !!q.gid;
  $app.classList.toggle('wide', two);
  const side = `<div class="side"><section class="qcard">
      ${q.src ? `<p class="qtag"><span class="pill src">📘 ${esc(q.src)}</span>${q.flag ? '헷갈림 표시' : ''}</p>` : ''}
      ${V.tags?.[q.id] ? `<p class="qtag">${V.tags[q.id] === 'review' ? '<span class="pill no">복습</span> 전에 틀린 문제예요' : '<span class="pill">다시 풀기</span> 전에 풀어 본 문제예요'}</p>` : ''}
      <p class="ins ja" lang="ja">${esc(p.ins)}</p>
      ${q.q ? `<p class="qtext" lang="ja">${q.q}</p>` : ''}
      ${optsHtml(q, chosen, done ? 'lock' : false)}</section>
      ${done ? explainHtml(q, chosen === q.a, chosen) : ''}</div>`;
  return `<header class="top sm"><button class="link" data-act="quit">✕ 닫기</button><span class="t">${esc(V.title)} · ${V.i + 1}/${V.ids.length}</span>${syncEl()}</header>
  <div class="bar blue" style="border-radius:0;height:3px;flex:none"><i style="width:${(V.i + (done ? 1 : 0)) / V.ids.length * 100}%;border-radius:0"></i></div>
  <div class="scroll" style="padding-top:18px">${q.script ? audioHtml(q, false) : ''}<div class="layout ${two ? 'two' : ''}">${passageHtml(q)}${side}</div></div>
  ${done || V.i > 0 ? `<div class="foot two">${V.i > 0 ? '<button class="primary ghost" data-act="prev">이전</button>' : ''}${done ? (V.i + 1 < V.ids.length ? '<button class="primary" data-act="next">다음 문제</button>' : V.back ? '<button class="primary" data-act="quit">시험 결과로</button>' : '<button class="primary" data-act="next">결과 보기</button>') : ''}</div>` : ''}`;
}
function vResult() {
  const rows = Object.entries(V.res), right = rows.filter(([, r]) => r.ok).length;
  const wrong = rows.filter(([, r]) => !r.ok).map(([id]) => id);
  return `<header class="top"><h1>${esc(V.title)} 결과</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><p class="sub">맞힌 문제</p><p class="big">${right}<small> / ${rows.length}</small></p>${bar(rows.length ? right / rows.length : 0, 'blue')}
      <p class="sub">${right === rows.length ? '전부 맞혔어요!' : wrong.length + '문제는 오답노트에 넣어 뒀어요'}</p></section>
    <div class="btns">${V.more ? `<button class="primary" data-act="more">다음 ${V.more.part && PART[V.more.part].group ? '지문' : '10문제'} 풀기</button>` : ''}${wrong.length ? `<button class="primary ${V.more ? 'ghost' : ''}" data-act="retry">틀린 문제 다시</button>` : ''}<button class="primary ghost" data-go="home">홈으로</button></div>
  </div>`;
}

function vNotes() {
  const ids = wrongIds(), bm = store.bookmarks.filter(id => Q[id]);
  const row = (id, pill) => { const q = Q[id]; return `<button class="part item" data-review="${id}">${pill}<span>${esc(PART[q.part].name)}${q.src ? ' · 📘 문제집' : ''}</span><span class="ja">${esc((q.q || (q.script && q.script[0].t) || GROUPS[q.gid]?.title || '').replace(/<rt>.*?<\/rt>|<[^>]+>/g, '').slice(0, 40))}</span></button>`; };
  const misses = id => (hist[id] || []).filter(x => !x).length;
  return `<header class="top"><h1>오답노트</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><div class="row"><div><p style="font-weight:700;font-size:17px">복습할 문제 ${ids.length}개</p><p class="sub">2번 연속 맞히면 목록에서 빠져요</p></div></div>
      <button class="primary" data-act="revall" ${ids.length ? '' : 'disabled'}>복습 시작</button></section>
    <div class="list">${ids.slice(0, 60).map(id => row(id, `<span class="pill no">${misses(id)}번 틀림</span>`)).join('')}</div>
    ${(() => { const memo = Object.keys(store.notes || {}).filter(id => Q[id]); return memo.length ? `<div class="lblrow"><h2 class="lbl">메모한 문제 ${memo.length}개</h2></div><div class="list">${memo.slice(0, 60).map(id => row(id, '<span class="pill">메모</span>')).join('')}</div>` : ''; })()}
    <div class="lblrow"><h2 class="lbl">저장한 문제 ${bm.length}개</h2>${bm.length ? `<button class="link sub" data-act="bmall">모두 풀기 ›</button>` : ''}</div>
    ${bm.length ? `<div class="list">${bm.slice(0, 60).map(id => row(id, '<span class="pill ac">저장</span>')).join('')}</div>` : `<p class="sub">해설 화면에서 ☆를 누르면 여기에 모여요.</p>`}
  </div>${tabs('notes')}`;
}

/* ── 모의고사 ─────────────────────────────────────── */
const sessKey = () => `n3-sess-${user ? user.id : 'guest'}`;
/* 오늘의 학습·유형별 연습 세트를 풀다가 닫으면 이 기기에 남겨 두고 홈에서 이어 푼다(한 세트만).
   오답노트의 '다시 보기'나 시험의 '틀린 문제 보기'는 남기지도, 남은 세트를 지우지도 않는다. */
const sessOwn = () => V.name === 'quiz' && !!V.more && !V.back;
function saveSess() {
  if (!sessOwn()) return;
  const left = V.ids.filter(id => !V.res[id]).length;
  if (!left) return lsDel(sessKey());
  lsSet(sessKey(), { ids: V.ids, i: V.i, title: V.title, mode: V.mode, res: V.res, more: V.more, tags: V.tags, at: Date.now() });
}
const examKey = () => `n3-exam-${user ? user.id : 'guest'}`;
let EX = null;
const scoreOf = (c, t) => t ? Math.round(c / t * 60) : 0;
function vExams() {
  EX = EX || lsGet(examKey());
  return `<header class="top"><h1>모의고사</h1>${syncEl()}</header><div class="scroll">
    ${EX ? `<section class="panel"><p>${esc(examName(EX.no))} ${EX.sec + 1}교시를 풀던 중이에요${EX.left != null ? ` (남은 시간 ${Math.floor(EX.left / 6e4)}분 ${pad(Math.floor(EX.left / 1000) % 60)}초)` : ''}.</p><div class="btns"><button class="primary" data-act="exresume">이어서 풀기</button><button class="primary ghost" data-act="exdrop">버리기</button></div></section>` : ''}
    <p class="sub">정식 모의고사는 실제 시험과 비슷한 구성이에요. 언어지식 30분, 문법·독해 70분이 지나면 다음 교시로 넘어가고, 청해는 문제당 한 번만 들을 수 있어요. 점수는 정답 비율로 어림한 값이고 실제 시험의 채점 방식과는 달라요.</p>
    ${PRIV_EXAMS.length ? `<h2 class="lbl">내 문제집 모의고사</h2><p class="sub" style="margin:-6px 0 4px">종이 문제집으로 푼 결과예요. 이 계정에서만 보여요.</p>
      <div class="list">${PRIV_EXAMS.map(e => {
        return `<button class="part" data-exam="${e.no}"><b>📘 ${esc(e.label)}</b><span>${esc(e.sub || '')}</span><span>${dayKey(e.row.finished_at)} 풀이 · 추정 ${total(e.row)}점 / 180</span></button>`; }).join('')}</div>` : ''}
    ${['mini', 'full'].map(kind => {
      const list = EXAMS.filter(e => kind === 'mini' ? e.mini : !e.mini);
      return `<h2 class="lbl">${kind === 'mini' ? '미니 모의고사' : '정식 모의고사'}</h2>
      <p class="sub" style="margin:-6px 0 4px">${kind === 'mini' ? `실력 점검용 짧은 시험이에요. 세 영역을 1/3 분량으로, 약 ${list[0]?.minutes || ''}분 걸려요.` : '실제 시험과 같은 문항 수예요.'}</p>
      <div class="list">${list.map(e => {
        const past = store.exams.filter(x => x.exam_no === e.no).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at))[0];
        return `<button class="part" data-exam="${e.no}" ${EX ? 'disabled' : ''}><b>${esc(e.label)}</b><span>${e.sec.flat().length}문항 · 약 ${e.minutes}분</span><span>${past ? `최근 추정 ${total(past)}점 / 180` : '아직 안 풀었어요'}</span></button>`;
      }).join('')}</div>`;
    }).join('')}
    ${store.exams.length ? `<h2 class="lbl">지난 결과</h2><div class="list">${[...store.exams].sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at)).slice(0, 10).map(x => `<div class="part"><b>${esc(examName(x.exam_no))} · 추정 ${total(x)}점</b><span>${dayKey(x.finished_at)} · ${passed(x) ? '합격권' : '불합격권'}</span></div>`).join('')}</div>` : ''}
  </div>${tabs('exams')}`;
}
const scores = x => [scoreOf(x.lang_correct, x.lang_total), scoreOf(x.read_correct, x.read_total), scoreOf(x.listen_correct, x.listen_total)];
const total = x => scores(x).reduce((a, b) => a + b, 0);
const passed = x => total(x) >= PASS_TOTAL && scores(x).every(s => s >= PASS_SECTION);

function startExam(no) {
  const e = EXAMS.find(x => x.no === no);
  const mins = [...examMins(e), 0];
  EX = { no, sec: 0, i: 0, ans: {}, played: {}, sections: e.sec, mins, deadline: Date.now() + mins[0] * 6e4 };
  lsSet(examKey(), EX); go('exam');
}
function nextSection() {
  TTS.stop();
  if (EX.sec >= 2) return finishExam();
  EX.sec++; EX.i = 0; const m = (EX.mins || SECTIONS.map(s => s.min))[EX.sec]; EX.deadline = m ? Date.now() + m * 6e4 : null;
  lsSet(examKey(), EX); go('exam');
}
function vExam() {
  const ids = EX.sections[EX.sec], q = Q[ids[EX.i]], p = PART[q.part], chosen = EX.ans[q.id];
  const answered = ids.filter(id => EX.ans[id] != null).length;
  $app.classList.toggle('wide', !!q.gid);
  return `<header class="top"><button class="link" data-act="exexit">나가기</button><span class="t">${esc(examName(EX.no))} ${EX.sec + 1}교시 · ${EX.i + 1}/${ids.length}</span><span id="timer" class="timer"></span></header>
  <div class="scroll">
    ${q.script ? audioHtml(q, EX.played[q.id]) : ''}
    <div class="layout ${q.gid ? 'two' : ''}">${passageHtml(q)}<div class="side"><section class="panel">
      <p class="ins ja" lang="ja">${esc(p.ins)}</p>
      ${q.q ? `<p class="qtext" lang="ja">${q.q}</p>` : ''}${optsHtml(q, chosen, false)}</section></div></div>
    <div class="btns"><button class="primary ghost" data-act="exprev" ${EX.i ? '' : 'disabled'}>이전</button>
      ${EX.i + 1 < ids.length ? `<button class="primary" data-act="exnext">다음</button>` : `<button class="primary" data-act="exsec">${EX.sec < 2 ? '이번 교시 끝내기' : '시험 끝내기'}</button>`}</div>
    <details><summary>문제 목록 (${answered}/${ids.length} 답함)</summary><div class="nav" style="margin-top:8px">${ids.map((id, i) => `<button class="${EX.ans[id] != null ? 'done' : ''} ${i === EX.i ? 'cur' : ''}" data-jump="${i}">${i + 1}</button>`).join('')}</div></details>
  </div>`;
}
function finishExam() {
  const tally = { lang: [0, 0], read: [0, 0], listen: [0, 0] };
  const review = [];
  for (const id of EX.sections.flat()) {
    const q = Q[id], ok = EX.ans[id] === q.a, a = PART[q.part].area;
    const bucket = a === '독해' ? tally.read : a === '청해' ? tally.listen : tally.lang;
    bucket[1]++; if (ok) bucket[0]++;
    record(q, ok, 'exam'); review.push({ id, pick: EX.ans[id] ?? null, ok });
  }
  const row = { id: crypto.randomUUID(), exam_no: EX.no, lang_correct: tally.lang[0], lang_total: tally.lang[1], read_correct: tally.read[0], read_total: tally.read[1], listen_correct: tally.listen[0], listen_total: tally.listen[1], finished_at: new Date().toISOString() };
  store.exams.push(row); enqueue({ t: 'exam', row });
  lsSet(revKey(row.id), review);
  EX = null; lsDel(examKey());
  go({ name: 'examresult', row, review });
}
function vExamResult() {
  const x = V.row, [a, b, c] = scores(x), t = a + b + c, pass = passed(x);
  const wrong = V.review.filter(r => !r.ok);
  const low = n => n < PASS_SECTION ? 'low' : '';
  return `<header class="top"><h1>${esc(examName(x.exam_no))} 결과</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><div class="row"><span>${pass ? '합격권이에요' : '조금 더 해봐요'}</span><span class="big">${t}<small> / 180</small></span></div>
      <div class="score"><div><b class="${low(a)}">${a}</b><span>언어지식 ${x.lang_correct}/${x.lang_total}</span></div><div><b class="${low(b)}">${b}</b><span>독해 ${x.read_correct}/${x.read_total}</span></div><div><b class="${low(c)}">${c}</b><span>청해 ${x.listen_correct}/${x.listen_total}</span></div></div>
      <p class="sub">합격 기준은 총점 ${PASS_TOTAL}점 이상, 영역별 ${PASS_SECTION}점 이상이에요. 위 점수는 정답 비율로 계산한 추정치예요.</p></section>
    ${examOf(x.exam_no)?.book ? `<p class="sub">${esc(examOf(x.exam_no).note || '')}</p>` : ''}
    <div class="btns ${examOf(x.exam_no)?.book ? 'col' : ''}">${wrong.length ? `<button class="primary" data-act="exreview">틀린 ${wrong.length}문제 보기</button>` : ''}${examOf(x.exam_no)?.book
      ? `${V.review.some(r => r.ok && r.flag) ? `<button class="primary ghost" data-act="exflag">헷갈린 ${V.review.filter(r => r.ok && r.flag).length}문제 보기</button>` : ''}${wrong.length ? `<button class="primary ghost" data-act="exredo">틀린 문제 다시 풀기</button>` : ''}`
      : `<button class="primary ghost" data-act="exretake" data-no="${x.exam_no}">다시 풀기</button>`}<button class="primary ghost" data-go="exams">목록으로</button></div>
  </div>`;
}

function vMe() {
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); const k = dayKey(d); return new Set(store.attempts.filter(a => dayKey(a.answered_at) === k).map(a => a.question_id)).size; });
  const max = Math.max(1, ...days);
  return `<header class="top"><h1>내 기록</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><div class="row"><span>최근 14일</span><span class="sub">${new Set(store.attempts.map(a => a.question_id)).size}문제 풀이 · ${streak()}일 연속</span></div>
      <div class="days">${days.map(n => `<div class="${n ? '' : 'none'}" style="height:${Math.max(4, n / max * 100)}%" title="${n}문제"></div>`).join('')}</div><div class="daylbl"><span>2주 전</span><span>오늘</span></div></section>
    <h2 class="lbl">유형별</h2><section class="panel">${PARTS.map(p => { const s = partStat(p.key); return `<div class="row"><span>${esc(p.name)}</span><span class="sub">${s.seen}/${s.total} · ${pct(s.acc)}</span></div>`; }).join('')}</section>
    <h2 class="lbl">계정</h2><section class="panel">
      ${user ? `<p>${esc(user.name)} 님</p>
        <button class="primary ghost" data-act="pw">비밀번호 바꾸기</button>
        <button class="primary ghost" data-act="logout">로그아웃</button>
        <button class="primary ghost" data-act="reset">풀이 기록 지우기</button>
        <button class="textbtn" data-act="delacc">계정 삭제</button>`
      : `<p class="sub">게스트로 쓰는 중이에요. 기록은 이 기기에만 있어요.</p><button class="primary" data-act="toauth">로그인 / 회원가입</button>`}
    </section>
    <p class="sub">이 앱의 문제는 JLPT 공식 문제나 시중 교재를 옮긴 것이 아니라 N3 출제 유형에 맞춰 새로 만든 연습 문제예요. JLPT 시행 기관과 관련이 없어요.</p>
  </div>${tabs('me')}`;
}

const viewKey = () => V.name + ':' + (V.name === 'exam' ? `${EX?.sec}-${EX?.i}` : V.i ?? '');
function render() {
  if (V.name !== 'quiz' && V.name !== 'exam') $app.classList.remove('wide');
  const views = { auth: vAuth, home: vHome, practice: vPractice, quiz: vQuiz, result: vResult, notes: vNotes, exams: vExams, exam: vExam, examresult: vExamResult, me: vMe };
  const keep = render.last === viewKey() ? document.querySelector('.scroll')?.scrollTop : null;
  $app.innerHTML = views[V.name]();
  render.last = viewKey();
  if (keep != null) { const sc = document.querySelector('.scroll'); if (sc) sc.scrollTop = keep; }
  paintSync(); tickTimer();
}
function tickTimer() {
  const el = document.getElementById('timer');
  if (!el || !EX) return;
  if (!EX.deadline) { el.textContent = EX.sec === 2 ? '청해' : ''; return; }
  const left = EX.deadline - Date.now();
  if (left <= 0) { toast('시간이 끝나서 다음으로 넘어가요'); return nextSection(); }
  const s = Math.ceil(left / 1000);
  el.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
setInterval(() => { if (V.name === 'exam') tickTimer(); }, 1000);

/* ── 입력 ─────────────────────────────────────────── */
function pick(i) {
  if (V.name === 'quiz') {
    const q = Q[V.ids[V.i]]; if (V.res[q.id]) return;
    const ok = i === q.a; V.res[q.id] = { pick: i, ok }; TTS.stop();
    record(q, ok, V.mode); saveSess(); render();
  } else if (V.name === 'exam') {
    const q = Q[EX.sections[EX.sec][EX.i]]; EX.ans[q.id] = i; lsSet(examKey(), EX); render();
  }
}
function next() {
  if (V.i + 1 < V.ids.length) { V.i++; V.showScript = false; TTS.stop(); saveSess(); render(); document.querySelector('.scroll').scrollTo(0, 0); }
  else { if (sessOwn()) lsDel(sessKey()); go({ ...V, name: 'result' }); }
}
const ACT = {
  async mode(b) { V.mode = b.dataset.m; V.err = ''; render(); },
  guest() { user = null; store = { ...emptyStore(), ...(lsGet(key()) || {}) }; indexAttempts(); lsSet('n3-guest', true); go('home'); },
  toauth() { lsDel('n3-guest'); go({ name: 'auth', mode: 'signup' }); },
  today() { startQuiz(todaySet(todayDone()), '오늘의 학습', 'drill', { kind: 'today' }); },
  prev() { if (V.i > 0) { V.i--; V.showScript = false; TTS.stop(); saveSess(); render(); document.querySelector('.scroll').scrollTo(0, 0); } },
  more() {
    const m = V.more, seen = new Set([...(m.seen || []), ...V.ids]);
    if (m.kind === 'today') startQuiz(todaySet(new Set([...seen, ...todayDone()])), '오늘의 학습', 'drill', { kind: 'today', seen: [...seen] });
    else startQuiz(pickUnits(m.part, PART[m.part].group ? 5 : 10, seen), PART[m.part].name, 'drill', { part: m.part, seen: [...seen] });
  },
  hltoggle() { V.hlOn = !V.hlOn; getSelection()?.removeAllRanges(); render(); },
  hlclear() { if (confirm('이 문제의 형광펜을 모두 지울까요?')) setMarks(curQ().id, {}); },
  next,
  quit() {
    if (V.back) return go(V.back);
    const answered = Object.keys(V.res).length, left = V.ids.length - answered;
    const own = sessOwn();
    if (own && left && answered) { saveSess(); toast('풀던 곳을 저장했어요. 홈에서 이어서 풀 수 있어요'); go('home'); }
    else if (answered) { if (own) lsDel(sessKey()); go({ ...V, name: 'result' }); }
    else { if (own) lsDel(sessKey()); go('home'); }
  },
  resume() {
    const ss = lsGet(sessKey()); if (!ss) return render();
    const first = ss.ids.findIndex(id => !ss.res[id]);
    go({ name: 'quiz', ...ss, i: first < 0 ? ss.i : first, showScript: false });
  },
  dropsess() { if (confirm('풀던 문제를 그만두고 지울까요? 푼 기록은 남아요.')) { lsDel(sessKey()); render(); } },
  retry() { startQuiz(Object.entries(V.res).filter(([, r]) => !r.ok).map(([id]) => id), '다시 풀기', 'review'); },
  revall() { startQuiz(shuffle(wrongIds()), '오답 복습', 'review'); },
  bmall() { startQuiz(store.bookmarks.filter(id => Q[id]), '저장한 문제', 'review'); },
  bm(b) {
    const id = b.dataset.id, on = store.bookmarks.includes(id);
    store.bookmarks = on ? store.bookmarks.filter(x => x !== id) : [...store.bookmarks, id];
    enqueue({ t: on ? 'bm-' : 'bm+', row: { question_id: id } }); render();
  },
  play(b) {
    if (TTS.playing) { TTS.stop(); return render(); }
    const q = V.name === 'exam' ? Q[EX.sections[EX.sec][EX.i]] : Q[V.ids[V.i]];
    const done = () => { if (V.name === 'exam') { EX.played[q.id] = true; lsSet(examKey(), EX); } render(); };
    if (q.au) TTS.playFile(q, done); else TTS.play(audioLines(q), done);
    render();
  },
  rate() { const r = [1, 1.2, .8]; TTS.setRate(r[(r.indexOf(TTS.rate) + 1) % 3]); lsSet('n3-rate', TTS.rate); render(); },
  showscript() { V.showScript = true; render(); },
  exresume() { if (EX.left != null) { EX.deadline = Date.now() + EX.left; EX.left = null; lsSet(examKey(), EX); } go('exam'); },
  exexit() {
    if (!confirm('지금까지 푼 것을 임시 저장하고 나갈까요? 남은 시간도 멈춰 둬요.')) return;
    EX.left = EX.deadline ? Math.max(0, EX.deadline - Date.now()) : null; EX.deadline = null; EX.paused = true;
    lsSet(examKey(), EX); TTS.stop(); go('exams'); toast('임시 저장했어요');
  },
  exdrop() { if (confirm('풀던 시험을 버릴까요?')) { EX = null; lsDel(examKey()); render(); } },
  exprev() { EX.i--; TTS.stop(); lsSet(examKey(), EX); render(); },
  exnext() { EX.i++; TTS.stop(); lsSet(examKey(), EX); render(); },
  exsec() {
    const left = EX.sections[EX.sec].filter(id => EX.ans[id] == null).length;
    if (confirm(left ? `안 푼 문제가 ${left}개 있어요. 끝낼까요?` : '이번 교시를 끝낼까요?')) nextSection();
  },
  exreview() { // 내가 고른 답과 해설을 바로 보여 준다(다시 풀지 않음)
    const wrong = V.review.filter(r => !r.ok), back = { ...V };
    if (!wrong.length) return;
    go({ name: 'quiz', ids: keepGroups(wrong.map(r => r.id)), i: 0, title: '틀린 문제 보기', mode: 'review', showScript: false, back,
      res: Object.fromEntries(wrong.map(r => [r.id, { pick: r.pick ?? -1, ok: false, seen: true }])) });
  },
  exflag() {
    const fl = V.review.filter(r => r.ok && r.flag), back = { ...V };
    if (!fl.length) return;
    go({ name: 'quiz', ids: keepGroups(fl.map(r => r.id)), i: 0, title: '헷갈린 문제 보기', mode: 'review', showScript: false, back,
      res: Object.fromEntries(fl.map(r => [r.id, { pick: r.pick ?? -1, ok: true, seen: true }])) });
  },
  exredo() { startQuiz(V.review.filter(r => !r.ok).map(r => r.id), '문제집 오답 다시 풀기', 'review'); },
  exretake(b) { const e = examOf(+b.dataset.no); if (e && confirm(`${e.label}를 다시 풀까요? 약 ${e.minutes}분이 걸려요.`)) startExam(e.no); },
  async pw() {
    const p = prompt('새 비밀번호 (8자 이상)'); if (!p) return;
    if (p.length < 8) return toast('8자 이상으로 입력해 주세요');
    const { error } = await sb.auth.updateUser({ password: p });
    toast(error ? '바꾸지 못했어요' : '비밀번호를 바꿨어요');
  },
  async logout() {
    if (store.queue.length && !confirm('아직 저장되지 않은 기록이 있어요. 이 기기에는 남아 있어요. 로그아웃할까요?')) return;
    await sb.auth.signOut(); if (PRIV_EXAMS.length) return location.reload(); user = null; store = emptyStore(); hist = {}; EX = null; go({ name: 'auth' });
  },
  async reset() {
    if (!confirm('N3 풀이 기록과 모의고사 결과를 모두 지울까요? 되돌릴 수 없어요.')) return;
    const r = await Promise.all([N3_ONLY(sb.from('attempts').delete().eq('user_id', user.id)), sb.from('exam_results').delete().eq('user_id', user.id).lte('exam_no', 10)]);
    if (r.some(x => x.error)) return toast('지우지 못했어요');
    store.attempts = []; store.exams = []; store.queue = store.queue.filter(o => o.t.startsWith('bm')); persist(); indexAttempts(); toast('기록을 지웠어요'); render();
  },
  async delacc() {
    if (!confirm('계정을 삭제하면 N3·N4 앱의 기록이 모두 지워져요. 삭제할까요? 되돌릴 수 없어요.')) return;
    const { data: { session } } = await sb.auth.getSession();
    const { error } = await sb.functions.invoke('account', { body: { action: 'delete' }, headers: { Authorization: `Bearer ${session.access_token}` } });
    if (error) return toast('삭제하지 못했어요');
    lsDel(key()); lsDel(examKey()); await sb.auth.signOut(); user = null; store = emptyStore(); hist = {}; go({ name: 'auth' });
  },
};
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.go) go(d.go);
  else if (d.area) { V.area = d.area; render(); }
  else if (d.part) startQuiz(pickUnits(d.part, PART[d.part].group ? 5 : 10), PART[d.part].name, 'drill', { part: d.part });
  else if (d.pick != null) pick(+d.pick);
  else if (d.review) startQuiz([d.review], '다시 보기', 'review');
  else if (d.exam) {
    const e = examOf(+d.exam); if (e.book) return go({ name: 'examresult', row: e.row, review: examReview(e.row, e.no) });
    const past = store.exams.filter(x => x.exam_no === e.no).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at))[0];
    if (past) go({ name: 'examresult', row: past, review: examReview(past, e.no) });
    else if (confirm(`${e.label}를 시작할까요? 약 ${e.minutes}분이 걸려요.`)) startExam(e.no);
  }
  else if (d.jump != null) { EX.i = +d.jump; TTS.stop(); lsSet(examKey(), EX); render(); }
  else if (d.act) ACT[d.act]?.(b);
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (V.name !== 'quiz' && V.name !== 'exam') return;
  if (/^[1-4]$/.test(e.key)) document.querySelector(`[data-pick="${+e.key - 1}"]`)?.click();
  if (e.key === 'Enter' && V.name === 'quiz' && V.res[V.ids[V.i]]) next();
  if (e.key === 'ArrowLeft' && V.name === 'quiz') ACT.prev();
  if (e.key === 'ArrowRight' && V.name === 'quiz' && V.res[V.ids[V.i]]) next();
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); document.querySelector('[data-act="play"]')?.click(); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), name = String(f.get('u')).trim().toLowerCase(), pw = String(f.get('p'));
  const up = V.mode === 'signup';
  if (up && pw !== f.get('p2')) { V.err = '비밀번호가 서로 달라요'; V.u = name; return render(); }
  V.busy = true; V.err = ''; V.u = name; render();
  try {
    if (up) {
      const res = await fetch(`${SB_URL}/functions/v1/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY }, body: JSON.stringify({ action: 'signup', username: name, password: pw }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '가입하지 못했어요');
    }
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(name), password: pw });
    if (error) throw new Error(up ? '가입은 됐지만 로그인하지 못했어요' : error.status === 429 ? '시도가 너무 많아요. 잠시 뒤 다시 해 주세요' : '아이디나 비밀번호가 맞지 않아요');
    await enter(name);
  } catch (err) { V.busy = false; V.err = err.message === 'Failed to fetch' ? '인터넷 연결을 확인해 주세요' : err.message; render(); }
});
async function enter(name) {
  const { data } = await sb.auth.getUser();
  user = { id: data.user.id, name }; lsDel('n3-guest');
  lsSet('n3-name-' + user.id, name);
  await loadAccount(); indexAttempts();
  go('home');
}

/* ── 시작 ─────────────────────────────────────────── */
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    user = { id: session.user.id, name: lsGet('n3-name-' + session.user.id) || '나' };
    store = { ...emptyStore(), ...(lsGet(key()) || {}) }; indexAttempts();
    go('home');
    await loadAccount(); indexAttempts();
    const { data } = await sb.from('profiles').select('nickname').maybeSingle();
    if (data) { user.name = data.nickname; lsSet('n3-name-' + user.id, data.nickname); }
    if (V.name === 'home') render();
  } else if (lsGet('n3-guest')) { store = { ...emptyStore(), ...(lsGet(key()) || {}) }; indexAttempts(); go('home'); }
  else go({ name: 'auth', mode: 'signup' });
})();

/* ── 형광펜 ───────────────────────────────────────── */
const curQ = () => V.name === 'exam' ? Q[EX.sections[EX.sec][EX.i]] : Q[V.ids[V.i]];
function setMarks(qid, marks) {
  for (const k of Object.keys(marks)) if (!marks[k].length) delete marks[k];
  store.hl = { ...(store.hl || {}), [qid]: marks };
  if (!Object.keys(marks).length) delete store.hl[qid];
  store.queue = store.queue.filter(o => !(o.t === 'hl' && o.row.question_id === qid)); // 같은 문제는 마지막 것만 보낸다
  enqueue({ t: 'hl', row: { question_id: qid, marks, updated_at: new Date().toISOString() } });
  render();
}
function mergeRanges(rs) {
  const out = [];
  for (const [a, b] of [...rs].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
/* 선택 끝점이 가리키는 원문 글자 위치. 후리가나 덩어리 안이면 덩어리 전체로 넓힌다. */
function pointOf(node, off, isEnd) {
  if (node.nodeType === 1 && !node.closest('[data-o]')) { // 요소 사이 경계면 옆 자식으로 내려간다
    const kids = node.childNodes; if (!kids.length) return null;
    return off < kids.length ? pointOf(kids[off], 0, false) : pointOf(kids[kids.length - 1], Infinity, true);
  }
  const el = node.nodeType === 1 ? node : node.parentElement;
  const jp = el?.closest('.jp'), u = el?.closest('[data-o]'); if (!jp || !u) return null;
  const li = +jp.dataset.li, o = +u.dataset.o, n = +u.dataset.n;
  const len = node.nodeType === 3 ? node.length : node.childNodes.length;
  if (el.closest('rt')) return { li, o: isEnd ? o + n : o };
  if (off <= 0) return { li, o };
  if (off >= len) return { li, o: o + n };
  return { li, o: isEnd ? o + n : o };
}
function applySelection() {
  if (!V.hlOn) return;
  const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const r = sel.getRangeAt(0), box = document.querySelector('.scr');
  if (!box || !r.intersectsNode(box)) return;
  let a = pointOf(r.startContainer, r.startOffset, false), b = pointOf(r.endContainer, r.endOffset, true);
  const lines = [...box.querySelectorAll('.jp')];
  if (!a) { const first = lines.find(l => r.intersectsNode(l)); if (first) a = { li: +first.dataset.li, o: 0 }; }
  if (!b) { const last = [...lines].reverse().find(l => r.intersectsNode(l)); if (last) b = { li: +last.dataset.li, o: Infinity }; }
  if (!a || !b || a.li > b.li) return;
  const q = Q[box.dataset.q], marks = JSON.parse(JSON.stringify(store.hl?.[q.id] || {}));
  for (let li = a.li; li <= b.li; li++) {
    const len = q.script[li].t.length, s0 = li === a.li ? a.o : 0, e0 = Math.min(len, li === b.li ? b.o : len);
    if (e0 > s0) marks[li] = mergeRanges([...(marks[li] || []), [s0, e0]]);
  }
  sel.removeAllRanges();
  setMarks(q.id, marks);
}
let selTimer = 0;
const scheduleSel = () => { clearTimeout(selTimer); selTimer = setTimeout(applySelection, 350); };
document.addEventListener('mouseup', e => { if (V.hlOn && e.target.closest('.scr')) scheduleSel(); });
document.addEventListener('touchend', e => { if (V.hlOn && e.target.closest('.scr')) scheduleSel(); });
document.addEventListener('selectionchange', () => { if (V.hlOn && !getSelection()?.isCollapsed && document.querySelector('.scr')) { clearTimeout(selTimer); selTimer = setTimeout(applySelection, 900); } });
/* 형광펜이 켜져 있을 때 칠한 곳을 누르면 그 덩어리를 지운다 */
document.addEventListener('click', e => {
  if (!V.hlOn) return;
  const m = e.target.closest('.scr mark'); if (!m || !getSelection()?.isCollapsed) return;
  const jp = m.closest('.jp'), box = m.closest('.scr'), q = Q[box.dataset.q], li = +jp.dataset.li;
  const u = e.target.closest('[data-o]'); if (!u) return;
  const o = +u.dataset.o, marks = JSON.parse(JSON.stringify(store.hl?.[q.id] || {}));
  marks[li] = (marks[li] || []).filter(([a, b]) => !(o >= a && o < b));
  setMarks(q.id, marks);
});

/* ── 메모 ─────────────────────────────────────────── */
let memoTimer = 0;
function setNote(qid, body) {
  body = body.slice(0, 2000);
  store.notes = { ...(store.notes || {}) };
  if (body.trim()) store.notes[qid] = body; else delete store.notes[qid];
  persist();
  clearTimeout(memoTimer);
  memoTimer = setTimeout(() => { // 입력이 멈추면 서버로 (같은 문제는 마지막 것만)
    store.queue = store.queue.filter(o => !(o.t === 'note' && o.row.question_id === qid));
    enqueue({ t: 'note', row: { question_id: qid, body: store.notes[qid] || '', updated_at: new Date().toISOString() } });
  }, 800);
}
document.addEventListener('input', e => { if (e.target.matches('[data-memo]')) setNote(e.target.dataset.memo, e.target.value); });
