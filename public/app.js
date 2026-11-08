/* 오니기리 N3 — 학습 기록은 이 기기에 먼저 쓰고, 로그인되어 있으면 Supabase로 보낸다. */
const SB_URL = 'https://cdmfglqqhqfjhblaikdz.supabase.co';
const SB_KEY = 'sb_publishable_NXzZ41oAbjX6jckVqkfqMg_PGcL-BHN'; // 공개용 키. 접근은 RLS가 막는다.
const sb = supabase.createClient(SB_URL, SB_KEY);
const { parts: PARTS, q: QS, g: GROUPS, exams: EXAMS } = window.N3;
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
let store = { attempts: [], bookmarks: [], exams: [], queue: [] };
let syncState = 'local', flushing = false;
const key = () => `n3-store-${user ? user.id : 'guest'}`;
const persist = () => lsSet(key(), store);
const emptyStore = () => ({ attempts: [], bookmarks: [], exams: [], queue: [] });

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

async function fetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').order(order, { ascending: true }).range(from, from + 999);
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
    lsDel('n3-store-guest');
    store.attempts.push(...guest.attempts); store.exams.push(...guest.exams);
    store.bookmarks = [...new Set([...store.bookmarks, ...guest.bookmarks])];
    persist();
  }
  try {
    await flush();
    const [a, b, e] = await Promise.all([fetchAll('attempts', 'answered_at'), fetchAll('bookmarks', 'created_at'), fetchAll('exam_results', 'finished_at')]);
    const pendA = store.queue.filter(o => o.t === 'attempt').map(o => o.row);
    const pendE = store.queue.filter(o => o.t === 'exam').map(o => o.row);
    store.attempts = [...a, ...pendA];
    store.exams = [...e, ...pendE];
    store.bookmarks = b.map(x => x.question_id);
    persist(); indexAttempts();
  } catch (err) { console.warn(err); syncState = 'fail'; }
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
  const qs = QS.filter(q => q.part === k); let seen = 0, last = 0;
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
function pickUnits(partKey, want) {
  const qs = QS.filter(q => q.part === partKey);
  const units = {}; for (const q of qs) (units[q.gid || q.id] ||= []).push(q);
  const lastSeen = id => { let t = 0; for (const a of store.attempts) if (a.question_id === id) t = Math.max(t, +new Date(a.answered_at)); return t; };
  const scored = shuffle(Object.values(units)).map(u => ({ u, r: rank(u[0]), t: lastSeen(u[0].id) }))
    .sort((a, b) => a.r - b.r || a.t - b.t);
  const out = [];
  for (const { u } of scored) { if (out.length >= want) break; out.push(...u.map(q => q.id)); }
  return out;
}
function todaySet() {
  const ids = shuffle(wrongIds()).slice(0, 5);
  const single = PARTS.filter(p => !p.group).map(p => ({ p, s: partStat(p.key) }))
    .sort((a, b) => (a.s.acc ?? .5) - (b.s.acc ?? .5) || a.s.seen / a.s.total - b.s.seen / b.s.total).slice(0, 3);
  for (const { p } of single) ids.push(...pickUnits(p.key, 3).filter(i => !ids.includes(i)));
  ids.push(...pickUnits('tanbun', 1).filter(i => !ids.includes(i)));
  return ids;
}
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
const MASCOT = `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M60 12c9 0 15 6 21 16l21 36c6 11 3 27-9 31-10 4-21 5-33 5s-23-1-33-5c-12-4-15-20-9-31l21-36c6-10 12-16 21-16Z" fill="#FFFCEF" stroke="#4A3426" stroke-width="5" stroke-linejoin="round"/><path d="M36 74h48v25c-8 1-16 1-24 1s-16 0-24-1V74Z" fill="#4A3426"/><circle cx="46" cy="55" r="4.5" fill="#4A3426"/><circle cx="74" cy="55" r="4.5" fill="#4A3426"/><path d="M54 60c3 4 9 4 12 0" fill="none" stroke="#4A3426" stroke-width="4" stroke-linecap="round"/><ellipse cx="36" cy="63" rx="6" ry="4" fill="#F7B6C6"/><ellipse cx="84" cy="63" rx="6" ry="4" fill="#F7B6C6"/></svg>`;
const syncEl = () => `<span id="sync" class="sync"></span>`;
const tabs = cur => `<nav class="tabs">${[['home', '홈'], ['practice', '연습'], ['exams', '모의고사'], ['notes', '오답노트'], ['me', '내 기록']]
  .map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-go="${k}">${l}</button>`).join('')}</nav>`;
const bar = (r, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.round(r * 100)}%"></i></div>`;
const pct = r => r == null ? '–' : Math.round(r * 100) + '%';
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function vocabHtml(q) {
  if (!q.v?.length) return '';
  return `<div class="vocab">${q.v.map(x => `<span class="ja">${esc(x.w)}${x.r ? ` <small>${esc(x.r)}</small>` : ''}</span><span>${esc(x.m)}</span>`).join('')}</div>`;
}
const scriptHtml = q => `<div class="scr">${q.script.map(l => `<p>${l.sp === 'N' ? '' : (l.sp === 'M' ? '男: ' : '女: ')}${esc(l.t)}</p>`).join('')}</div>`;
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
    <button class="speed" data-act="rate">속도 ${TTS.rate}배</button></div>${warn}</section>`;
}
function optsHtml(q, chosen, reveal) {
  const hidden = PART[q.part].spoken && !reveal && !(!q.au && !TTS.ok && V.showScript);
  return `<div class="opts" lang="ja">${q.c.map((c, i) => {
    let cls = 'opt', mark = '';
    if (reveal) { if (i === q.a) { cls += ' right'; mark = '정답'; } else if (i === chosen) { cls += ' wrong'; mark = '내 답'; } }
    else if (i === chosen) cls += ' sel';
    return `<button class="${cls}" data-pick="${i}" ${reveal === 'lock' ? 'disabled' : ''}><span class="n">${i + 1}</span><span>${hidden ? '' : c}</span>${mark ? `<span class="mark">${mark}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
function explainHtml(q, ok) {
  const g = q.gid ? GROUPS[q.gid] : null;
  return `<section class="panel exp">
    <p class="verdict ${ok ? 'ok' : 'no'}">${ok ? '정답이에요' : '아쉬워요'}</p>
    ${q.answer ? `<p class="ja" lang="ja">${esc(q.answer)}</p>` : ''}
    <p>${esc(q.e)}</p>
    ${q.tr ? `<details><summary>${q.script ? '대본과 번역' : '번역'}</summary>${q.script ? scriptHtml(q) : ''}<p>${esc(q.tr)}</p></details>` : ''}
    ${g?.tr ? `<details><summary>지문 번역</summary><p>${esc(g.tr)}</p></details>` : ''}
    ${q.v?.length ? `<details open><summary>단어 메모</summary>${vocabHtml(q)}</details>` : ''}
    <button class="link" data-act="bm" data-id="${q.id}">${store.bookmarks.includes(q.id) ? '★ 저장한 문제' : '☆ 문제 저장'}</button>
  </section>`;
}

/* ── 화면 ─────────────────────────────────────────── */
let V = { name: 'home' };
function go(v) { TTS.stop(); V = typeof v === 'string' ? { name: v } : v; render(); document.querySelector('.scroll')?.scrollTo(0, 0); }

function vAuth() {
  const up = V.mode === 'signup';
  return `<div class="scroll"><form class="panel auth" id="authform">
    <div class="hero">${MASCOT}<div class="bubble"><h1>오니기리 N3</h1><p class="sub">직접 만든 문제로 N3 합격까지</p></div></div>
    <div class="seg"><button type="button" class="${up ? '' : 'on'}" data-act="mode" data-m="login">로그인</button><button type="button" class="${up ? 'on' : ''}" data-act="mode" data-m="signup">회원가입</button></div>
    <label class="field">아이디<input name="u" autocomplete="username" autocapitalize="none" required value="${esc(V.u || '')}"></label>
    <label class="field">비밀번호${up ? ' (8자 이상)' : ''}<input name="p" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required></label>
    ${up ? `<label class="field">비밀번호 확인<input name="p2" type="password" autocomplete="new-password" required></label><p class="sub">이메일을 받지 않아서 비밀번호를 찾을 수 없어요. 꼭 기억해 주세요.</p>` : ''}
    <p class="err" role="alert">${esc(V.err || '')}</p>
    <button class="primary" ${V.busy ? 'disabled' : ''}>${V.busy ? '잠시만요…' : up ? '가입하고 시작하기' : '로그인'}</button>
    <button type="button" class="textbtn" data-act="guest">로그인 없이 써보기</button>
  </form></div>`;
}

function vHome() {
  const { date, days } = nextExamDate();
  const wrong = wrongIds().length;
  const solved = Object.keys(hist).filter(id => Q[id]).length;
  const todayN = store.attempts.filter(a => dayKey(a.answered_at) === dayKey(Date.now())).length;
  return `<header class="top"><span class="t">${esc(user ? user.name : '게스트')}</span>${syncEl()}</header>
  <div class="scroll">
    <div class="hero">${MASCOT}<div class="bubble"><h1>오니기리 N3</h1><p class="sub">오늘 ${todayN}문제 · ${streak()}일 연속</p></div></div>
    ${user ? '' : `<button class="warnbox" data-act="toauth">지금은 이 기기에만 저장돼요. 로그인하면 지금까지 푼 기록도 계정으로 옮겨져요.</button>`}
    <section class="panel">
      <div class="row"><span>다음 시험 ${date.getMonth() + 1}/${date.getDate()}</span><span class="big">D-${days}</span></div>
      <div class="row"><span class="sub">푼 문제</span><span>${solved} / ${QS.length}</span></div>${bar(solved / QS.length)}
      <button class="primary" data-act="today">오늘의 문제 풀기</button>
    </section>
    <div class="grid">
      <button class="part" data-go="notes"><b>오답노트</b><span>복습할 문제 ${wrong}개</span></button>
      <button class="part" data-go="exams"><b>모의고사</b><span>실전 구성 ${EXAMS.length}회분</span></button>
    </div>
    <h2 class="lbl">영역별 정답률</h2>
    <section class="panel">${AREAS.map(a => {
      const ps = PARTS.filter(p => p.area === a).map(p => partStat(p.key));
      const seen = ps.reduce((s, x) => s + x.seen, 0), acc = seen ? ps.reduce((s, x) => s + (x.acc || 0) * x.seen, 0) / seen : null;
      return `<div class="row"><span>${a}</span><span class="sub">${pct(acc)}</span></div>${bar(acc || 0, 'blue')}`;
    }).join('')}</section>
  </div>${tabs('home')}`;
}

function vPractice() {
  return `<header class="top"><h1>유형별 연습</h1>${syncEl()}</header><div class="scroll">${AREAS.map(a => `
    <h2 class="lbl">${a}</h2><div class="grid">${PARTS.filter(p => p.area === a).map(p => {
      const s = partStat(p.key);
      return `<button class="part" data-part="${p.key}"><b>${esc(p.name)}</b><span class="ja">${esc(p.ja)}</span><span>${s.seen}/${s.total} · 정답률 ${pct(s.acc)}</span>${bar(s.seen / (s.total || 1))}</button>`;
    }).join('')}</div>`).join('')}</div>${tabs('practice')}`;
}

function startQuiz(ids, title, mode = 'drill') {
  ids = keepGroups(ids);
  if (!ids.length) return toast('풀 문제가 없어요');
  go({ name: 'quiz', ids, i: 0, title, mode, res: {}, showScript: false });
}
function vQuiz() {
  const q = Q[V.ids[V.i]], p = PART[q.part], chosen = V.res[q.id]?.pick, done = chosen != null;
  const two = !!q.gid;
  $app.classList.toggle('wide', two);
  const side = `<div class="side"><section class="panel">
      <p class="ins ja" lang="ja">${esc(p.ins)}</p>
      ${q.q ? `<p class="qtext" lang="ja">${q.q}</p>` : ''}
      ${optsHtml(q, chosen, done ? 'lock' : false)}</section>
      ${done ? explainHtml(q, chosen === q.a) : ''}</div>`;
  return `<header class="top"><button class="link" data-act="quit">← 그만하기</button><span class="t">${esc(V.title)} ${V.i + 1}/${V.ids.length}</span>${syncEl()}</header>
  <div class="scroll">${q.script ? audioHtml(q, false) : ''}<div class="layout ${two ? 'two' : ''}">${passageHtml(q)}${side}</div></div>
  ${done ? `<div class="foot"><button class="primary" data-act="next">${V.i + 1 < V.ids.length ? '다음 문제' : '결과 보기'}</button></div>` : ''}`;
}
function vResult() {
  const rows = Object.entries(V.res), right = rows.filter(([, r]) => r.ok).length;
  const wrong = rows.filter(([, r]) => !r.ok).map(([id]) => id);
  return `<header class="top"><h1>${esc(V.title)} 결과</h1>${syncEl()}</header><div class="scroll">
    <div class="hero">${MASCOT}<div class="bubble"><p class="big">${right}<small> / ${rows.length}</small></p><p class="sub">${right === rows.length ? '전부 맞혔어요!' : wrong.length + '문제는 오답노트에 넣어 뒀어요'}</p></div></div>
    <div class="btns">${wrong.length ? `<button class="primary" data-act="retry">틀린 문제 다시</button>` : ''}<button class="primary ghost" data-go="home">홈으로</button></div>
  </div>`;
}

function vNotes() {
  const ids = wrongIds(), bm = store.bookmarks.filter(id => Q[id]);
  const row = id => { const q = Q[id]; return `<button class="part" data-review="${id}"><b>${esc(PART[q.part].name)}</b><span class="ja">${esc((q.q || (q.script && q.script[0].t) || GROUPS[q.gid]?.title || '').replace(/<[^>]+>/g, '').slice(0, 40))}</span></button>`; };
  return `<header class="top"><h1>오답노트</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><p class="sub">틀린 문제는 2번 연속 맞히면 빠져나가요.</p>
      <button class="primary" data-act="revall" ${ids.length ? '' : 'disabled'}>복습 시작 (${ids.length}문제)</button></section>
    <div class="list">${ids.slice(0, 60).map(row).join('')}</div>
    <h2 class="lbl">저장한 문제 ${bm.length}개</h2>
    ${bm.length ? `<button class="primary ghost" data-act="bmall">저장한 문제 풀기</button><div class="list">${bm.slice(0, 60).map(row).join('')}</div>` : ''}
  </div>${tabs('notes')}`;
}

/* ── 모의고사 ─────────────────────────────────────── */
const examKey = () => `n3-exam-${user ? user.id : 'guest'}`;
let EX = null;
const scoreOf = (c, t) => t ? Math.round(c / t * 60) : 0;
function vExams() {
  EX = EX || lsGet(examKey());
  return `<header class="top"><h1>모의고사</h1>${syncEl()}</header><div class="scroll">
    ${EX ? `<section class="panel"><p>${EX.no}회 시험을 풀던 중이에요.</p><div class="btns"><button class="primary" data-act="exresume">이어서 풀기</button><button class="primary ghost" data-act="exdrop">버리기</button></div></section>` : ''}
    <p class="sub">실제 시험과 비슷한 구성이에요. 언어지식 30분, 문법·독해 70분이 지나면 다음 교시로 넘어가고, 청해는 문제당 한 번만 들을 수 있어요. 점수는 정답 비율로 어림한 값이고 실제 시험의 채점 방식과는 달라요.</p>
    <div class="list">${EXAMS.map(e => {
      const past = store.exams.filter(x => x.exam_no === e.no).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at))[0];
      return `<button class="part" data-exam="${e.no}" ${EX ? 'disabled' : ''}><b>모의고사 ${e.no}회</b><span>${e.sec.flat().length}문항 · 약 140분</span><span>${past ? `최근 추정 ${total(past)}점 / 180` : '아직 안 풀었어요'}</span></button>`;
    }).join('')}</div>
    ${store.exams.length ? `<h2 class="lbl">지난 결과</h2><div class="list">${[...store.exams].sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at)).slice(0, 10).map(x => `<div class="part"><b>${x.exam_no}회 · 추정 ${total(x)}점</b><span>${dayKey(x.finished_at)} · ${passed(x) ? '합격권' : '불합격권'}</span></div>`).join('')}</div>` : ''}
  </div>${tabs('exams')}`;
}
const scores = x => [scoreOf(x.lang_correct, x.lang_total), scoreOf(x.read_correct, x.read_total), scoreOf(x.listen_correct, x.listen_total)];
const total = x => scores(x).reduce((a, b) => a + b, 0);
const passed = x => total(x) >= PASS_TOTAL && scores(x).every(s => s >= PASS_SECTION);

function startExam(no) {
  const e = EXAMS.find(x => x.no === no);
  EX = { no, sec: 0, i: 0, ans: {}, played: {}, sections: e.sec, deadline: Date.now() + SECTIONS[0].min * 6e4 };
  lsSet(examKey(), EX); go('exam');
}
function nextSection() {
  TTS.stop();
  if (EX.sec >= 2) return finishExam();
  EX.sec++; EX.i = 0; EX.deadline = SECTIONS[EX.sec].min ? Date.now() + SECTIONS[EX.sec].min * 6e4 : null;
  lsSet(examKey(), EX); go('exam');
}
function vExam() {
  const ids = EX.sections[EX.sec], q = Q[ids[EX.i]], p = PART[q.part], chosen = EX.ans[q.id];
  const answered = ids.filter(id => EX.ans[id] != null).length;
  $app.classList.toggle('wide', !!q.gid);
  return `<header class="top"><span class="t">${EX.no}회 ${EX.sec + 1}교시 · ${EX.i + 1}/${ids.length}</span><span id="timer" class="timer"></span></header>
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
  EX = null; lsDel(examKey());
  go({ name: 'examresult', row, review });
}
function vExamResult() {
  const x = V.row, [a, b, c] = scores(x), t = a + b + c, pass = passed(x);
  const wrong = V.review.filter(r => !r.ok);
  const low = n => n < PASS_SECTION ? 'low' : '';
  return `<header class="top"><h1>모의고사 ${x.exam_no}회 결과</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><div class="row"><span>${pass ? '합격권이에요' : '조금 더 해봐요'}</span><span class="big">${t}<small> / 180</small></span></div>
      <div class="score"><div><b class="${low(a)}">${a}</b><span>언어지식 ${x.lang_correct}/${x.lang_total}</span></div><div><b class="${low(b)}">${b}</b><span>독해 ${x.read_correct}/${x.read_total}</span></div><div><b class="${low(c)}">${c}</b><span>청해 ${x.listen_correct}/${x.listen_total}</span></div></div>
      <p class="sub">합격 기준은 총점 ${PASS_TOTAL}점 이상, 영역별 ${PASS_SECTION}점 이상이에요. 위 점수는 정답 비율로 계산한 추정치예요.</p></section>
    <div class="btns">${wrong.length ? `<button class="primary" data-act="exreview">틀린 ${wrong.length}문제 보기</button>` : ''}<button class="primary ghost" data-go="exams">목록으로</button></div>
  </div>`;
}

function vMe() {
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); const k = dayKey(d); return store.attempts.filter(a => dayKey(a.answered_at) === k).length; });
  const max = Math.max(1, ...days);
  return `<header class="top"><h1>내 기록</h1>${syncEl()}</header><div class="scroll">
    <section class="panel"><div class="row"><span>최근 14일</span><span class="sub">${store.attempts.length}회 풀이 · ${streak()}일 연속</span></div>
      <div class="days">${days.map(n => `<div class="${n ? '' : 'none'}" style="height:${Math.max(4, n / max * 100)}%" title="${n}문제"></div>`).join('')}</div></section>
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

function render() {
  if (V.name !== 'quiz' && V.name !== 'exam') $app.classList.remove('wide');
  const views = { auth: vAuth, home: vHome, practice: vPractice, quiz: vQuiz, result: vResult, notes: vNotes, exams: vExams, exam: vExam, examresult: vExamResult, me: vMe };
  $app.innerHTML = views[V.name]();
  paintSync(); tickTimer();
}
function tickTimer() {
  const el = document.getElementById('timer');
  if (!el || !EX) return;
  if (!EX.deadline) { el.textContent = '청해'; return; }
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
    record(q, ok, V.mode); render();
    document.querySelector('.scroll').scrollTo({ top: 1e5, behavior: 'smooth' });
  } else if (V.name === 'exam') {
    const q = Q[EX.sections[EX.sec][EX.i]]; EX.ans[q.id] = i; lsSet(examKey(), EX); render();
  }
}
function next() {
  if (V.i + 1 < V.ids.length) { V.i++; V.showScript = false; TTS.stop(); render(); document.querySelector('.scroll').scrollTo(0, 0); }
  else go({ ...V, name: 'result' });
}
const ACT = {
  async mode(b) { V.mode = b.dataset.m; V.err = ''; render(); },
  guest() { user = null; store = { ...emptyStore(), ...(lsGet(key()) || {}) }; indexAttempts(); lsSet('n3-guest', true); go('home'); },
  toauth() { lsDel('n3-guest'); go({ name: 'auth', mode: 'signup' }); },
  today() { startQuiz(todaySet(), '오늘의 문제'); },
  next,
  quit() { if (Object.keys(V.res).length) go({ ...V, name: 'result' }); else go('home'); },
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
  exresume() { go('exam'); },
  exdrop() { if (confirm('풀던 시험을 버릴까요?')) { EX = null; lsDel(examKey()); render(); } },
  exprev() { EX.i--; TTS.stop(); lsSet(examKey(), EX); render(); },
  exnext() { EX.i++; TTS.stop(); lsSet(examKey(), EX); render(); },
  exsec() {
    const left = EX.sections[EX.sec].filter(id => EX.ans[id] == null).length;
    if (confirm(left ? `안 푼 문제가 ${left}개 있어요. 끝낼까요?` : '이번 교시를 끝낼까요?')) nextSection();
  },
  exreview() { startQuiz(V.review.filter(r => !r.ok).map(r => r.id), '모의고사 복습', 'review'); },
  async pw() {
    const p = prompt('새 비밀번호 (8자 이상)'); if (!p) return;
    if (p.length < 8) return toast('8자 이상으로 입력해 주세요');
    const { error } = await sb.auth.updateUser({ password: p });
    toast(error ? '바꾸지 못했어요' : '비밀번호를 바꿨어요');
  },
  async logout() {
    if (store.queue.length && !confirm('아직 저장되지 않은 기록이 있어요. 이 기기에는 남아 있어요. 로그아웃할까요?')) return;
    await sb.auth.signOut(); user = null; store = emptyStore(); hist = {}; EX = null; go({ name: 'auth' });
  },
  async reset() {
    if (!confirm('풀이 기록과 모의고사 결과를 모두 지울까요? 되돌릴 수 없어요.')) return;
    const r = await Promise.all([sb.from('attempts').delete().eq('user_id', user.id), sb.from('exam_results').delete().eq('user_id', user.id)]);
    if (r.some(x => x.error)) return toast('지우지 못했어요');
    store.attempts = []; store.exams = []; store.queue = store.queue.filter(o => o.t.startsWith('bm')); persist(); indexAttempts(); toast('기록을 지웠어요'); render();
  },
  async delacc() {
    if (!confirm('계정과 모든 기록을 삭제할까요? 되돌릴 수 없어요.')) return;
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
  else if (d.part) startQuiz(pickUnits(d.part, PART[d.part].group ? 5 : 10), PART[d.part].name);
  else if (d.pick != null) pick(+d.pick);
  else if (d.review) startQuiz([d.review], '다시 보기', 'review');
  else if (d.exam) { if (confirm(`모의고사 ${d.exam}회를 시작할까요? 약 140분이 걸려요.`)) startExam(+d.exam); }
  else if (d.jump != null) { EX.i = +d.jump; TTS.stop(); lsSet(examKey(), EX); render(); }
  else if (d.act) ACT[d.act]?.(b);
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (V.name !== 'quiz' && V.name !== 'exam') return;
  if (/^[1-4]$/.test(e.key)) document.querySelector(`[data-pick="${+e.key - 1}"]`)?.click();
  if (e.key === 'Enter' && V.name === 'quiz' && V.res[V.ids[V.i]]) next();
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
