/* Roomquiz client — vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const LETTERS = ['A', 'B', 'C', 'D'];
  const socket = io({ transports: ['websocket', 'polling'] });

  let clockOffset = 0; // serverNow - Date.now()
  const serverNow = () => Date.now() + clockOffset;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  /* ---------------- utilities ---------------- */

  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) n.append(c);
    return n;
  };
  const icon = (name, cls = 'icon') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };
  const letter = (i) => el('span', { class: 'letter', dataset: { i: String(i) }, 'aria-hidden': 'true', text: LETTERS[i] });
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const secFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const secs = (ms) => (ms == null ? '–' : `${secFmt.format(ms / 1000)}s`);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  function confirmDialog(title, msg, okLabel = 'Confirm') {
    const d = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    $('#confirmOk').textContent = okLabel;
    d.returnValue = '';
    d.showModal();
    return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
  }

  const haptic = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

  function setLoading(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('loading', on);
  }

  /* ---------------- theme ---------------- */

  const root = document.documentElement;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches;
  function syncThemeButton() {
    $('#themeToggle').setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
    $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', isDark() ? '#0d0d0d' : '#f7f7f5'));
  }
  $('#themeToggle').addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('rq-theme', root.dataset.theme); } catch {}
    syncThemeButton();
  });
  mq.addEventListener('change', syncThemeButton);
  syncThemeButton();

  /* ---------------- screens ---------------- */

  let current = null;
  function show(name, { push = false } = {}) {
    if (current === name) return;
    current = name;
    $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    const url = name === 'join' && $('#jCode').value ? `/?room=${$('#jCode').value}` : '/';
    if (push) history.pushState({ screen: name }, '', url);
    else history.replaceState({ screen: name }, '', url);
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
    if (name === 'host') refreshResume();
  }
  window.addEventListener('popstate', (e) => {
    const s = e.state?.screen;
    if (mode) return history.pushState({ screen: current }, '', location.href); // stay in rooms
    if (s && s !== current) { current = null; show(s); }
  });

  let mode = null; // 'host' | 'student' | null
  const finePointer = matchMedia('(pointer: fine)').matches; // avoid popping the keyboard on phones

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const to = b.dataset.go;
    if (to === 'home') { mode = null; }
    show(to, { push: to !== 'home' });
    if (to === 'join' && finePointer) setTimeout(() => ($('#jName').value ? $('#jCode') : $('#jName')).focus(), 50);
  }));

  $('#brand').addEventListener('click', async () => {
    if (mode === 'host') return toast('Close the room first, or keep it running in this tab.');
    if (mode === 'student') {
      if (!(await confirmDialog('Leave room?', 'Your score will be removed from this room.', 'Leave'))) return;
      socket.emit('student:leave');
      store.del('rq-student');
      mode = null;
    }
    show('home');
  });

  /* ---------------- connection status ---------------- */

  socket.on('disconnect', () => { $('#conn').hidden = false; });
  socket.on('connect', () => {
    $('#conn').hidden = true;
    // Re-attach on reconnect
    if (mode === 'host') resumeHost(true);
    if (mode === 'student') rejoinStudent(true);
  });

  /* =====================================================
     HOST
     ===================================================== */

  let hostInfo = null; // { code, hostToken, qrSvg, joinUrl }
  let hostState = null;

  function refreshResume() {
    const saved = store.get('rq-host');
    $('#resumeRoom').hidden = !saved;
    $('#resumeCode').textContent = saved ? saved.code : '';
  }

  $('#createRoom').addEventListener('click', () => {
    const btn = $('#createRoom');
    setLoading(btn, true);
    $('#createError').textContent = '';
    socket.timeout(8000).emit('host:create', { origin: location.origin }, (err, res) => {
      setLoading(btn, false);
      if (err || !res?.ok) { $('#createError').textContent = 'Could not create a room. Check your connection and try again.'; return; }
      enterHost(res);
      store.set('rq-host', { code: res.code, hostToken: res.hostToken });
    });
  });

  $('#resumeRoom').addEventListener('click', () => resumeHost(false));

  function resumeHost(silent) {
    const saved = store.get('rq-host');
    if (!saved) return;
    socket.timeout(8000).emit('host:resume', saved, (err, res) => {
      if (err) return;
      if (!res?.ok) {
        store.del('rq-host');
        refreshResume();
        if (!silent) toast('That room has expired. Create a new one.');
        if (mode === 'host') { mode = null; showClosed('Room ended', 'This room is no longer available.'); }
        return;
      }
      enterHost({ ...res, hostToken: saved.hostToken });
    });
  }

  function enterHost(info) {
    hostInfo = info;
    mode = 'host';
    $('#qrThumb').innerHTML = info.qrSvg; // server-generated SVG
    $('#qrBig').innerHTML = info.qrSvg;
    $('#roomCode').textContent = info.code;
    $('#presentCode').textContent = info.code;
    const u = new URL(info.joinUrl);
    $('#joinUrl').textContent = u.host;
    $('#presentUrl').textContent = u.host;
    show('room');
  }

  socket.on('host:state', (s) => {
    clockOffset = s.serverNow - Date.now();
    const prevPhase = hostState?.phase;
    hostState = s;
    renderHost(prevPhase);
  });

  /* ---- compose form ---- */

  const optionsEdit = $('#optionsEdit');
  for (let i = 0; i < 4; i++) {
    optionsEdit.append(
      el('div', { class: 'opt-row' },
        letter(i),
        el('input', {
          type: 'text', id: `opt${i}`, maxlength: '120', autocomplete: 'off',
          placeholder: i < 2 ? `Option ${LETTERS[i]}` : `Option ${LETTERS[i]} (optional)`,
          'aria-label': `Option ${LETTERS[i]}`,
        }),
        el('label', { class: 'correct-pick', title: `Mark ${LETTERS[i]} as correct` },
          el('input', { type: 'radio', name: 'qCorrect', value: String(i), 'aria-label': `${LETTERS[i]} is correct`, checked: i === 0 }),
          el('span', {}, icon('check')),
        ),
      ),
    );
  }

  const qType = () => $('input[name="qType"]:checked').value;
  $$('input[name="qType"]').forEach((r) => r.addEventListener('change', () => {
    $('#optionsField').hidden = qType() !== 'mcq';
    $('#acceptedField').hidden = qType() !== 'text';
  }));

  const qTime = $('#qTime');
  const savedTime = store.get('rq-time');
  if (savedTime) qTime.value = savedTime;
  const syncTime = () => { $('#qTimeOut').textContent = `${qTime.value}s`; };
  qTime.addEventListener('input', syncTime);
  syncTime();

  $('#composeCard').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#composeError');
    err.textContent = '';
    const text = $('#qText').value.trim();
    if (!text) { err.textContent = 'Write a question first.'; $('#qText').focus(); return; }

    const payload = { text, type: qType(), duration: Number(qTime.value) };
    if (payload.type === 'mcq') {
      const raw = [0, 1, 2, 3].map((i) => $(`#opt${i}`).value.trim());
      const correctRaw = Number($('input[name="qCorrect"]:checked')?.value ?? -1);
      // Trailing empty options are dropped; gaps in the middle are not allowed.
      let last = raw.length - 1;
      while (last >= 0 && !raw[last]) last--;
      const options = raw.slice(0, last + 1);
      const gap = options.findIndex((o) => !o);
      if (options.length < 2) { err.textContent = 'Add at least two options (A and B).'; $(`#opt${options.length}`).focus(); return; }
      if (gap !== -1) { err.textContent = `Option ${LETTERS[gap]} is empty — fill it or clear the ones after it.`; $(`#opt${gap}`).focus(); return; }
      if (correctRaw < 0 || correctRaw >= options.length) { err.textContent = 'The option marked correct is empty. Pick a filled option.'; return; }
      payload.options = options;
      payload.correct = correctRaw;
    } else {
      payload.accepted = $('#qAccepted').value;
    }
    store.set('rq-time', qTime.value);
    const btn = $('#startQ');
    setLoading(btn, true);
    socket.timeout(8000).emit('host:start', payload, (e2, res) => {
      setLoading(btn, false);
      if (e2) { err.textContent = 'No response from server. Try again.'; return; }
      if (!res?.ok) { err.textContent = res?.error || 'Could not start the question.'; return; }
      // Clear for the next question, keep type & timer.
      $('#qText').value = '';
      [0, 1, 2, 3].forEach((i) => { $(`#opt${i}`).value = ''; });
      $('#qAccepted').value = '';
      $('input[name="qCorrect"][value="0"]').checked = true;
      haptic();
    });
  });

  $('#endQ').addEventListener('click', () => socket.emit('host:end'));
  $('#nextQ').addEventListener('click', () => socket.emit('host:next'));

  $('#copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(hostInfo.joinUrl);
      toast('Join link copied');
    } catch {
      toast(hostInfo.joinUrl);
    }
  });

  const presentDialog = $('#presentDialog');
  const openPresent = () => presentDialog.showModal();
  $('#qrThumb').addEventListener('click', openPresent);
  $('#presentQr').addEventListener('click', openPresent);
  $('#presentClose').addEventListener('click', () => presentDialog.close());
  presentDialog.addEventListener('click', (e) => { if (e.target === presentDialog) presentDialog.close(); });

  $('#closeRoom').addEventListener('click', async () => {
    const ok = await confirmDialog('Close this room?', 'Everyone will be disconnected and scores will be cleared. This can’t be undone.', 'Close Room');
    if (!ok) return;
    socket.emit('host:close');
    store.del('rq-host');
    mode = null;
    hostInfo = hostState = null;
    show('home');
  });

  /* ---- tabs ---- */
  const tabs = [$('#tabStudents'), $('#tabBoard')];
  function selectTab(t) {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      $(`#${x.getAttribute('aria-controls')}`).hidden = !on;
    });
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(n); n.focus();
    });
  });

  /* ---- render ---- */

  function renderHost(prevPhase) {
    const s = hostState;
    if (!s) return;
    const q = s.question;
    const compose = s.phase === 'compose';

    $('#composeCard').hidden = !compose;
    $('#liveCard').hidden = compose;
    $('#composeTitle').textContent = `Question ${s.questionCount + 1}`;
    $('#noStudentsHint').hidden = s.students.length > 0;
    $('#studentCount').textContent = s.students.length;
    $('#presentCount').textContent = s.students.length;

    if (compose && prevPhase && prevPhase !== 'compose') {
      setTimeout(() => $('#qText').focus(), 50);
    }

    if (!compose && q) renderLive(s, q);
    renderStudents(s, q);
    renderBoard(s);
  }

  function renderLive(s, q) {
    const st = s.stats;
    const closed = q.closed;
    $('#liveIndex').textContent = `Question ${q.index}`;
    const phase = $('#livePhase');
    phase.textContent = closed ? 'Results' : 'Live';
    phase.classList.toggle('live', !closed);
    $('#liveText').textContent = q.text;
    $('#hostTimer').hidden = closed;
    $('#endQ').hidden = closed;
    $('#nextQ').hidden = !closed;

    $('#tAnswered').textContent = `${st.answered}/${st.total}`;
    $('#tAvg').textContent = st.answered ? secs(st.avgMs) : '–';
    const graded = q.type === 'mcq' || (q.accepted && q.accepted.length) || st.correctCount > 0;
    $('#tCorrectTile').hidden = !closed || !graded;
    $('#tCorrect').textContent = `${st.correctCount}/${st.answered}`;

    // Bar chart
    const bars = $('#bars');
    bars.replaceChildren();
    bars.classList.toggle('revealed', closed && q.type === 'mcq');
    if (q.type === 'mcq') {
      $('#chartTitle').textContent = 'Answers by option';
      q.options.forEach((opt, i) => bars.append(barRow({
        i, text: opt, count: st.counts[i], total: st.answered, correct: closed && i === q.correct,
      })));
      $('#barsEmpty').hidden = true;
    } else {
      $('#chartTitle').textContent = 'Most common answers';
      st.textGroups.forEach((g, i) => bars.append(barRow({
        i, text: g.text, count: g.count, total: st.answered, correct: closed && g.correct, isText: true,
      })));
      $('#barsEmpty').hidden = st.textGroups.length > 0;
    }
    requestAnimationFrame(() => $$('.bar-fill', bars).forEach((f) => { f.style.transform = `scaleX(${f.dataset.v})`; }));

    // Podium
    $('#fastTitle').textContent = st.fastestIsCorrect ? 'Quickest correct' : 'Quickest';
    const podium = $('#podium');
    podium.replaceChildren(...st.fastest.map((f, i) => el('li', {},
      el('span', { class: 'place', text: ['1st', '2nd', '3rd'][i] }),
      el('span', { class: 'who', text: f.name, title: f.name }),
      el('span', { class: 't mono', text: secs(f.timeMs) }),
    )));
    $('#podiumEmpty').hidden = st.fastest.length > 0;
    $('#podiumEmpty').textContent = closed && st.fastestIsCorrect ? 'Nobody got this one right.' : 'No one yet.';

    // Per-question ranking
    $('#rankingSection').hidden = !closed || !s.ranking.length;
    $('#qRanking').replaceChildren(...s.ranking.map((r, i) => el('li', {},
      el('span', { class: 'rank mono', text: i + 1 }),
      el('span', { class: 'name', text: r.name }),
      el('span', { class: 'muted small mono', text: secs(r.timeMs) }),
      markFor(r.correct),
    )));

    startTimer(q, $('#hostTimerFill'), $('#hostTimerNum'));
  }

  function barRow({ i, text, count, total, correct, isText }) {
    const v = total ? count / total : 0;
    return el('div', {
      class: `bar-row${correct ? ' is-correct' : ''}${isText ? ' text' : ''}`,
      dataset: { i: String(i) }, role: 'listitem',
      'aria-label': `${isText ? '' : `Option ${LETTERS[i]}: `}${text} — ${count} answer${count === 1 ? '' : 's'}, ${pct(count, total)}%${correct ? ', correct' : ''}`,
    },
      isText ? el('span', { class: 'letter', 'aria-hidden': 'true', text: `#${i + 1}` }) : letter(i),
      el('div', { class: 'bar-body', 'aria-hidden': 'true' },
        el('div', { class: 'bar-label' },
          el('span', { class: 'txt', text, title: text }),
          correct && el('span', { class: 'tag' }, icon('check'), 'Correct'),
        ),
        el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', dataset: { v: String(v) } })),
      ),
      el('span', { class: 'bar-val mono', 'aria-hidden': 'true' }, String(count), el('span', { class: 'pct', text: `${pct(count, total)}%` })),
    );
  }

  function markFor(correct) {
    if (correct === true) return el('span', { class: 'mark ok' }, icon('check'), 'Correct');
    if (correct === false) return el('span', { class: 'mark no' }, icon('x'), 'Wrong');
    return null;
  }

  function renderStudents(s, q) {
    const list = $('#studentList');
    $('#studentsEmpty').hidden = s.students.length > 0;
    const live = q && !q.closed;
    const closed = q && q.closed;
    list.replaceChildren(...s.students.map((st) => {
      let sub;
      let right = null;
      if (live) {
        sub = st.answered ? `Answered · ${secs(st.timeMs)}` : 'Thinking…';
        right = st.answered
          ? el('span', { class: 'mark ok' }, icon('check'), 'In')
          : el('span', { class: 'mark wait' }, icon('clock'));
      } else if (closed) {
        if (!st.answered) sub = 'No answer';
        else if (q.type === 'mcq') sub = `${LETTERS[st.answer]} · ${q.options[st.answer]} · ${secs(st.timeMs)}`;
        else sub = `“${st.answer}” · ${secs(st.timeMs)}`;
        if (st.answered && q.type === 'text') {
          right = el('button', {
            class: 'toggle-correct', type: 'button', 'aria-pressed': String(!!st.correct),
            'aria-label': `${st.correct ? 'Unmark' : 'Mark'} ${st.name}'s answer as correct`,
            onclick: () => socket.emit('host:toggleCorrect', { studentId: st.id }),
          }, st.correct ? 'Correct' : 'Mark correct');
        } else right = markFor(st.correct);
      } else {
        sub = `${st.score} pts`;
      }
      if (!st.connected) sub = `Offline · ${sub}`;
      return el('li', { class: st.connected ? '' : 'offline' },
        el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(st.name) }),
        el('span', { class: 'person-main' },
          el('span', { class: 'name', text: st.name }),
          el('span', { class: 'person-sub', text: sub, title: sub }),
        ),
        right,
        el('button', {
          class: 'kick', type: 'button', 'aria-label': `Remove ${st.name}`,
          onclick: async () => {
            if (await confirmDialog(`Remove ${st.name}?`, 'They will be removed from the room and their score deleted.', 'Remove')) {
              socket.emit('host:kick', { studentId: st.id });
            }
          },
        }, icon('x')),
      );
    }));
  }

  function renderBoard(s) {
    const anyScore = s.leaderboard.some((r) => r.score > 0);
    $('#boardEmpty').hidden = anyScore;
    $('#boardList').replaceChildren(...(anyScore ? s.leaderboard : []).map((r) => el('li', {},
      el('span', { class: 'rank mono', text: r.rank }),
      el('span', { class: 'name', text: r.name }),
      el('span', { class: 'score mono', text: `${r.score}` }),
    )));
  }

  /* ---------------- shared countdown ---------------- */

  let timerRAF = null;
  function startTimer(q, fill, num) {
    cancelAnimationFrame(timerRAF);
    if (!q || q.closed) return;
    const total = q.duration * 1000;
    let lastSec = -1;
    const tick = () => {
      const left = Math.max(0, q.endsAt - serverNow());
      const frac = left / total;
      fill.style.transform = `scaleX(${frac})`;
      fill.classList.toggle('low', left <= 5000);
      const sec = Math.ceil(left / 1000);
      if (num && sec !== lastSec) { num.textContent = sec; lastSec = sec; }
      if (left > 0) timerRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  /* =====================================================
     STUDENT
     ===================================================== */

  let studentState = null;
  let booting = false; // true while silently restoring a saved student session
  let renderedQuestionId = null;

  const jName = $('#jName');
  const jCode = $('#jCode');
  jCode.addEventListener('input', () => {
    const v = jCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (v !== jCode.value) jCode.value = v;
    setFieldError(jCode, '');
  });
  jName.addEventListener('input', () => setFieldError(jName, ''));
  const savedName = store.get('rq-name');
  if (savedName) jName.value = savedName;

  function setFieldError(input, msg) {
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    $(`#${input.getAttribute('aria-describedby')}`).textContent = msg;
  }

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = jName.value.trim();
    const code = jCode.value.trim().toUpperCase();
    let bad = null;
    if (code.length !== 6) { setFieldError(jCode, 'Room codes are 6 characters.'); bad = jCode; }
    if (!name) { setFieldError(jName, 'Enter your name so the host knows who you are.'); bad = jName; }
    if (bad) { bad.focus(); return; }

    const saved = store.get('rq-student');
    const sameRoom = saved && saved.code === code && saved.name.toLowerCase() === name.toLowerCase();
    const btn = $('#joinBtn');
    setLoading(btn, true);
    socket.timeout(8000).emit('student:join', {
      code, name,
      studentId: sameRoom ? saved.studentId : undefined,
      token: sameRoom ? saved.token : undefined,
    }, (err, res) => {
      setLoading(btn, false);
      if (err) { setFieldError(jCode, 'No response from server. Check your Wi-Fi and try again.'); return; }
      if (!res?.ok) {
        const input = res?.field === 'name' ? jName : jCode;
        setFieldError(input, res?.error || 'Could not join.');
        input.focus();
        return;
      }
      store.set('rq-name', name);
      store.set('rq-student', { code, name: res.name, studentId: res.studentId, token: res.token });
      mode = 'student';
      haptic();
      show('play');
    });
  });

  function rejoinStudent() {
    const saved = store.get('rq-student');
    if (!saved) return;
    socket.timeout(8000).emit('student:join', saved, (err, res) => {
      if (err) return;
      if (!res?.ok) {
        store.del('rq-student');
        if (mode === 'student') {
          mode = null;
          if (booting) { booting = false; show(roomParam ? 'join' : 'home'); }
          else showClosed('Room closed', 'The host has ended this session.');
        }
        return;
      }
      booting = false;
      mode = 'student';
      show('play');
    });
  }

  socket.on('student:state', (s) => {
    clockOffset = s.serverNow - Date.now();
    studentState = s;
    if (mode === 'student') renderStudent();
  });

  socket.on('room:closed', () => {
    if (mode === 'student') { store.del('rq-student'); mode = null; showClosed('Room closed', 'The host has ended this session. Thanks for playing!'); }
  });
  socket.on('student:kicked', () => {
    store.del('rq-student');
    mode = null;
    showClosed('Removed from room', 'The host removed you from this room.');
  });

  $('#leaveRoom').addEventListener('click', async () => {
    if (!(await confirmDialog('Leave room?', 'Your score will be removed from this room.', 'Leave'))) return;
    socket.emit('student:leave');
    store.del('rq-student');
    mode = null;
    studentState = null;
    show('home');
  });

  function showClosed(title, msg) {
    $('#closedTitle').textContent = title;
    $('#closedMsg').textContent = msg;
    show('closed');
  }

  function renderStudent() {
    const s = studentState;
    if (!s) return;
    $('#meName').textContent = s.me.name;
    $('#meAvatar').textContent = initials(s.me.name);
    $('#meScore').textContent = s.me.score;
    $('#meRank').textContent = s.me.score > 0 && s.me.rank ? `#${s.me.rank} of ${s.me.total}` : '';
    $('#pCode').textContent = s.code;

    const q = s.question;
    const view =
      s.phase === 'compose' || !q ? 'pWait'
      : q.closed ? 'pResult'
      : s.myAnswer ? 'pLocked'
      : 'pQuestion';
    ['pWait', 'pQuestion', 'pLocked', 'pResult'].forEach((id) => { $(`#${id}`).hidden = id !== view; });

    if (view === 'pQuestion') renderQuestion(q);
    if (view === 'pLocked') renderLocked(q, s.myAnswer);
    if (view === 'pResult') renderResult(s, q);
    if (view !== 'pQuestion' && view !== 'pLocked') cancelAnimationFrame(timerRAF);
  }

  function renderQuestion(q) {
    if (renderedQuestionId !== q.id) {
      renderedQuestionId = q.id;
      $('#pError').textContent = '';
      $('#pIndex').textContent = `Question ${q.index}`;
      $('#pText').textContent = q.text;
      const grid = $('#pOptions');
      grid.hidden = q.type !== 'mcq';
      $('#pTextForm').hidden = q.type !== 'text';
      if (q.type === 'mcq') {
        grid.replaceChildren(...q.options.map((opt, i) => el('button', {
          class: 'answer-btn', type: 'button', dataset: { i: String(i) },
          'aria-label': `${LETTERS[i]}: ${opt}`,
          onclick: () => submitAnswer(i),
        }, letter(i), el('span', { text: opt }))));
      } else {
        $('#pTextInput').value = '';
        setTimeout(() => $('#pTextInput').focus(), 50);
      }
      haptic(20);
    }
    startTimer(q, $('#pTimerFill'), $('#pTimerNum'));
  }

  $('#pTextForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#pTextInput').value.trim();
    if (!v) { $('#pError').textContent = 'Type an answer first.'; return; }
    submitAnswer(v);
  });

  let submitting = false;
  function submitAnswer(answer) {
    const q = studentState?.question;
    if (!q || submitting) return;
    submitting = true;
    $$('#pOptions .answer-btn, #pTextForm button').forEach((b) => { b.disabled = true; });
    haptic();
    socket.timeout(6000).emit('student:answer', { questionId: q.id, answer }, (err, res) => {
      submitting = false;
      if (err || !res?.ok) {
        $('#pError').textContent = err ? 'Connection problem — tap again.' : (res?.error || 'Could not send your answer.');
        $$('#pOptions .answer-btn, #pTextForm button').forEach((b) => { b.disabled = false; });
      }
    });
  }

  function answerLabel(q, answer) {
    if (q.type === 'mcq') return [letter(answer), el('span', { text: q.options[answer] })];
    return [el('span', { text: `“${answer}”` })];
  }

  function renderLocked(q, mine) {
    $('#pLockedAnswer').replaceChildren(...answerLabel(q, mine.answer));
    $('#pLockedTime').textContent = `Answered in ${secs(mine.timeMs)} · waiting for time to run out`;
    startTimer(q, $('#pLockFill'), null);
  }

  function renderResult(s, q) {
    const r = s.result;
    const iconEl = $('#rIcon');
    let title, iconName, cls, detail = '';
    const ungraded = r.answered && r.correct == null;

    if (!r.answered) {
      title = 'Time’s up'; iconName = 'clock'; cls = 'neutral';
      detail = 'You didn’t answer this one.';
    } else if (ungraded) {
      title = 'Answer submitted'; iconName = 'check'; cls = 'neutral';
      detail = `Open question · answered in ${secs(r.timeMs)}`;
    } else if (r.correct) {
      title = 'Correct!'; iconName = 'check'; cls = '';
      detail = `#${r.position} of ${r.ofCorrect} correct · ${secs(r.timeMs)}`;
    } else {
      title = 'Not quite'; iconName = 'x'; cls = 'bad';
      detail = `Answered in ${secs(r.timeMs)}`;
    }
    $('#rTitle').textContent = title;
    iconEl.className = `badge-icon ${cls}`;
    iconEl.replaceChildren(icon(iconName));
    $('#rPoints').textContent = ungraded || !r.answered ? '' : `+${r.points}`;
    $('#rPoints').hidden = ungraded || !r.answered;
    $('#rDetail').textContent = detail;

    const reveal = $('#rAnswer');
    if (q.type === 'mcq' && q.correct != null && !r.correct) {
      reveal.replaceChildren(el('span', { class: 'muted', text: 'Answer:' }), ...answerLabel(q, q.correct));
    } else if (q.type === 'text' && q.accepted && !r.correct) {
      reveal.replaceChildren(el('span', { class: 'muted', text: 'Accepted:' }), el('span', { text: q.accepted }));
    } else reveal.replaceChildren();

    const board = $('#rBoard');
    board.replaceChildren(...s.leaderboard.map((row) => el('li', { class: row.id === s.me.id ? 'me' : '' },
      el('span', { class: 'rank mono', text: row.rank }),
      el('span', { class: 'name', text: row.id === s.me.id ? `${row.name} (you)` : row.name }),
      el('span', { class: 'score mono', text: row.score }),
    )));
    const inTop = s.leaderboard.some((row) => row.id === s.me.id);
    $('#rMyRank').textContent = inTop ? '' : `You’re #${s.me.rank} of ${s.me.total} with ${s.me.score} pts`;

    if (renderedQuestionId !== `${q.id}:r`) {
      renderedQuestionId = `${q.id}:r`;
      haptic(r.correct ? [15, 60, 15] : 30);
    }
  }

  /* ---------------- boot ---------------- */

  var params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const savedStudent = store.get('rq-student');

  if (roomParam) {
    jCode.value = roomParam;
    if (savedStudent && savedStudent.code === roomParam) {
      mode = 'student';
      booting = true;
      show('play');
    } else {
      show('join');
      if (finePointer) setTimeout(() => (jName.value ? $('#joinBtn') : jName).focus(), 80);
    }
  } else if (savedStudent) {
    mode = 'student';
    booting = true;
    show('play');
  } else {
    show('home');
  }
})();
