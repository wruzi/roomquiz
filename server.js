'use strict';

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const POINTS = 10;
const MIN_TIME = 5; // seconds
const MAX_TIME = 60 * 60; // 60 minutes
const GRACE_MS = 300; // network slack on personal deadlines
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // drop rooms idle for 3h
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- helpers ---------------- */

function lanAddress() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) candidates.push(i.address);
    }
  }
  return (
    candidates.find((a) => a.startsWith('192.168.')) ||
    candidates.find((a) => a.startsWith('10.')) ||
    candidates[0] ||
    'localhost'
  );
}

function baseUrl(clientOrigin) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  try {
    const u = new URL(clientOrigin);
    // A host on localhost would produce a QR phones can't open: swap in the LAN IP.
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
      return `${u.protocol}//${lanAddress()}:${u.port || PORT}`;
    }
    return u.origin;
  } catch {
    return `http://${lanAddress()}:${PORT}`;
  }
}

const token = () => crypto.randomBytes(16).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => clean(s, 200).toLowerCase();

const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

/* ---------------- scoring ---------------- */

function recomputeScores(room) {
  for (const s of room.students.values()) {
    s.score = 0;
    s.correctMs = 0;
    s.correctCount = 0;
  }
  for (const q of room.questions) {
    if (!q.closed) continue;
    for (const [sid, a] of q.answers) {
      const s = room.students.get(sid);
      if (s && a.correct) {
        s.score += POINTS;
        s.correctMs += a.timeMs;
        s.correctCount += 1;
      }
    }
  }
}

// Higher score first; ties broken by total time spent on correct answers (quicker wins).
function leaderboard(room) {
  return [...room.students.values()]
    .sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || a.name.localeCompare(b.name))
    .map((s, i) => ({ id: s.id, name: s.name, score: s.score, rank: i + 1, connected: s.connected }));
}

// Per-question ranking: correct answers by speed, then everyone else by speed.
function questionRanking(q) {
  return [...q.answers.entries()]
    .map(([sid, a]) => ({ sid, ...a }))
    .sort((a, b) => (b.correct === true) - (a.correct === true) || a.timeMs - b.timeMs);
}

function gradeAnswer(q, answer) {
  if (q.type === 'mcq') return answer === q.correct;
  if (!q.accepted.length) return null; // open question, ungraded
  return q.accepted.includes(norm(answer));
}

/* ---------------- question flow ----------------
 * Every student moves through room.questions at their own pace:
 *   s.cur  = index of the question they're answering right now (or null)
 *   s.next = first index they haven't passed yet
 * A student gets a question with its full time limit the moment they're free
 * (answered / timed out on the previous one). A question closes - and its
 * results are revealed - once every student has passed it.
 */

function parseQuestion(data) {
  const type = data?.type === 'text' ? 'text' : 'mcq';
  const text = clean(data?.text, 300);
  if (!text) return { error: 'Write a question first.' };
  const duration = Math.min(MAX_TIME, Math.max(MIN_TIME, Math.round(Number(data?.duration) || 20)));
  const spec = { type, text, duration, options: [], correct: null, accepted: [], acceptedRaw: '' };
  if (type === 'mcq') {
    spec.options = (Array.isArray(data?.options) ? data.options : []).slice(0, 4).map((o) => clean(o, 120));
    if (spec.options.length < 2 || spec.options.some((o) => !o)) return { error: 'Fill in at least 2 options.' };
    spec.correct = Number(data?.correct);
    if (!Number.isInteger(spec.correct) || spec.correct < 0 || spec.correct >= spec.options.length) {
      return { error: 'Choose the correct option.' };
    }
  } else {
    spec.acceptedRaw = clean(data?.accepted, 300);
    spec.accepted = spec.acceptedRaw.split(',').map(norm).filter(Boolean);
  }
  return spec;
}

const isPending = (q) => !q.closed && q.starts.size === 0;
const specOf = (q) => ({
  type: q.type, text: q.text, duration: q.duration, options: q.options,
  correct: q.correct, accepted: q.accepted, acceptedRaw: q.acceptedRaw,
});

function phaseOf(room) {
  if (!room.questions.length) return 'compose';
  return room.questions.some((q) => !q.closed) ? 'live' : 'results';
}

// Give a free student the next open question, starting their personal timer.
function dispatch(room, s) {
  if (s.cur != null) return;
  let i = s.next;
  while (i < room.questions.length && room.questions[i].closed) i++;
  s.next = i;
  const q = room.questions[i];
  if (!q) return;
  const now = Date.now();
  q.starts.set(s.id, { at: now, endsAt: now + q.duration * 1000 });
  s.cur = i;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (finish(room, s, i)) emitAll(room);
  }, q.duration * 1000 + GRACE_MS);
}

// Student is done with question i (answered or out of time). Returns true if state changed.
function finish(room, s, i) {
  if (s.cur !== i) return false;
  clearTimeout(s.timer);
  s.timer = null;
  s.cur = null;
  s.next = i + 1;
  dispatch(room, s);
  checkClose(room);
  return true;
}

function closeQ(room, q) {
  if (q.closed) return;
  q.closed = true;
  q.closedAt = Date.now();
  recomputeScores(room);
}

function checkClose(room) {
  if (!room.students.size) return;
  room.questions.forEach((q, k) => {
    if (q.closed) return;
    if ([...room.students.values()].every((s) => s.next > k)) closeQ(room, q);
  });
}

function addQuestion(room, spec) {
  room.questions.push({
    ...spec,
    id: token().slice(0, 8),
    index: room.questions.length + 1,
    starts: new Map(),
    answers: new Map(),
    closed: false,
    createdAt: Date.now(),
  });
  for (const s of room.students.values()) dispatch(room, s);
}

// Host ends question k for everyone: students on it move on, students who haven't reached it skip it.
function endQuestion(room, k) {
  const q = room.questions[k];
  if (!q || q.closed) return;
  closeQ(room, q);
  for (const s of room.students.values()) {
    if (s.cur === k) finish(room, s, k);
  }
  checkClose(room);
}

function removeStudent(room, s) {
  clearTimeout(s.timer);
  room.students.delete(s.id);
  for (const q of room.questions) {
    q.answers.delete(s.id);
    q.starts.delete(s.id);
  }
  recomputeScores(room);
  checkClose(room);
}

// The question the host is looking at: their pick, else the earliest one in progress, else the latest.
function hostViewIndex(room) {
  const qs = room.questions;
  if (room.hostView != null && qs[room.hostView]) return room.hostView;
  const inProgress = qs.findIndex((q) => !q.closed && q.starts.size > 0);
  if (inProgress !== -1) return inProgress;
  for (let k = qs.length - 1; k >= 0; k--) if (!isPending(qs[k])) return k;
  return qs.length ? 0 : null;
}

/* ---------------- state snapshots ---------------- */

function stats(room, q, k) {
  const answers = [...q.answers.entries()];
  const counts = q.type === 'mcq' ? q.options.map(() => 0) : [];
  const textGroups = new Map();
  let totalMs = 0;
  for (const [, a] of answers) {
    totalMs += a.timeMs;
    if (q.type === 'mcq') counts[a.answer] += 1;
    else {
      const key = norm(a.answer);
      const g = textGroups.get(key) || { text: a.answer, count: 0, correct: a.correct };
      g.count += 1;
      textGroups.set(key, g);
    }
  }
  const pool = q.closed && (q.type === 'mcq' || q.accepted.length || answers.some(([, a]) => a.correct))
    ? answers.filter(([, a]) => a.correct)
    : answers;
  const fastest = pool
    .sort((a, b) => a[1].timeMs - b[1].timeMs)
    .slice(0, 3)
    .map(([sid, a]) => ({ name: room.students.get(sid)?.name || '—', timeMs: a.timeMs }));
  const total = q.closed
    ? q.starts.size
    : [...room.students.values()].filter((s) => q.starts.has(s.id) || s.next <= k).length;
  return {
    counts,
    textGroups: [...textGroups.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    answered: answers.length,
    total,
    avgMs: answers.length ? Math.round(totalMs / answers.length) : 0,
    correctCount: answers.filter(([, a]) => a.correct).length,
    fastest,
    fastestIsCorrect: pool !== answers,
  };
}

function publicQuestion(q, includeKey) {
  const base = {
    id: q.id,
    index: q.index,
    text: q.text,
    type: q.type,
    options: q.options,
    duration: q.duration,
    closed: q.closed,
  };
  if (includeKey || q.closed) {
    base.correct = q.correct;
    base.accepted = q.acceptedRaw;
  }
  return base;
}

function hostState(room) {
  const k = hostViewIndex(room);
  const q = k == null ? null : room.questions[k];
  const lb = leaderboard(room);
  const pendingQ = room.questions.find(isPending);
  let question = null;
  if (q) {
    // Countdown = the latest personal deadline among students still on it.
    let deadline = 0;
    for (const s of room.students.values()) {
      if (s.cur === k) deadline = Math.max(deadline, q.starts.get(s.id).endsAt);
    }
    question = { ...publicQuestion(q, true), deadline: deadline || null, pending: isPending(q) };
  }
  return {
    code: room.code,
    joinUrl: room.joinUrl,
    phase: phaseOf(room),
    questionCount: room.questions.length,
    pinned: room.hostView != null,
    viewIndex: k,
    questions: room.questions.map((x) => ({
      index: x.index,
      closed: x.closed,
      pending: isPending(x),
      on: [...room.students.values()].filter((s) => s.cur === x.index - 1).length,
    })),
    question,
    stats: q ? stats(room, q, k) : null,
    students: [...room.students.values()].map((s) => {
      const a = q?.answers.get(s.id);
      let status = 'none';
      if (q) {
        if (a) status = 'answered';
        else if (s.cur === k) status = 'on';
        else if (s.next <= k) status = 'behind';
        else status = 'missed';
      }
      return {
        id: s.id,
        name: s.name,
        score: s.score,
        connected: s.connected,
        status,
        onIndex: s.cur != null ? s.cur + 1 : null,
        answered: !!a,
        answer: a ? a.answer : null,
        timeMs: a ? a.timeMs : null,
        correct: a ? a.correct : null,
      };
    }),
    ranking: q && q.closed
      ? questionRanking(q).map((r) => ({ name: room.students.get(r.sid)?.name || '—', timeMs: r.timeMs, correct: r.correct }))
      : [],
    leaderboard: lb,
    queued: pendingQ
      ? { text: pendingQ.text, type: pendingQ.type, options: pendingQ.options.length, duration: pendingQ.duration, index: pendingQ.index }
      : null,
    serverNow: Date.now(),
  };
}

function resultFor(q, s) {
  const a = q.answers.get(s.id);
  const correctOnes = questionRanking(q).filter((r) => r.correct);
  return {
    answered: !!a,
    correct: a ? a.correct : null,
    points: a && a.correct ? POINTS : 0,
    timeMs: a ? a.timeMs : null,
    position: a && a.correct ? correctOnes.findIndex((r) => r.sid === s.id) + 1 : null,
    ofCorrect: correctOnes.length,
  };
}

function studentState(room, s) {
  const lb = leaderboard(room);
  const me = lb.find((r) => r.id === s.id);
  let question = null;
  if (s.cur != null) {
    const q = room.questions[s.cur];
    question = { ...publicQuestion(q, false), endsAt: q.starts.get(s.id).endsAt };
  }
  // Last question this student actually took (for the "locked in" / result screens).
  let last = null;
  if (s.cur == null) {
    for (let k = Math.min(s.next, room.questions.length) - 1; k >= 0; k--) {
      const q = room.questions[k];
      if (!q.starts.has(s.id)) continue;
      const a = q.answers.get(s.id);
      last = {
        question: publicQuestion(q, false),
        myAnswer: a ? { answer: a.answer, timeMs: a.timeMs } : null,
        result: q.closed ? resultFor(q, s) : null,
      };
      break;
    }
  }
  const history = room.questions
    .filter((q) => q.closed && q.starts.has(s.id))
    .map((q) => {
      const r = resultFor(q, s);
      return { index: q.index, answered: r.answered, correct: r.correct, points: r.points };
    });
  return {
    code: room.code,
    me: { id: s.id, name: s.name, score: s.score, rank: me?.rank || null, total: lb.length },
    question,
    last,
    history,
    leaderboard: lb.slice(0, 5).map(({ id, name, score, rank }) => ({ id, name, score, rank })),
    serverNow: Date.now(),
  };
}

function emitHost(room) {
  room.touched = Date.now();
  if (room.hostSocket) io.to(room.hostSocket).emit('host:state', hostState(room));
}

function emitStudent(room, s) {
  if (s.socket) io.to(s.socket).emit('student:state', studentState(room, s));
}

function emitAll(room) {
  emitHost(room);
  for (const s of room.students.values()) emitStudent(room, s);
}

function destroyRoom(room) {
  for (const s of room.students.values()) clearTimeout(s.timer);
  rooms.delete(room.code);
}

/* ---------------- sockets ---------------- */

io.on('connection', (socket) => {
  const ack = (fn, payload) => typeof fn === 'function' && fn(payload);

  /* ---- host ---- */

  socket.on('host:create', async (data, fn) => {
    const code = newCode();
    const joinUrl = `${baseUrl(data?.origin)}/?room=${code}`;
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const room = {
      code,
      joinUrl,
      qrSvg,
      hostToken: token(),
      hostSocket: socket.id,
      hostView: null,
      students: new Map(),
      questions: [],
      touched: Date.now(),
    };
    rooms.set(code, room);
    socket.data = { role: 'host', code };
    socket.join(`room:${code}`);
    ack(fn, { ok: true, code, hostToken: room.hostToken, qrSvg, joinUrl });
    emitHost(room);
  });

  socket.on('host:resume', (data, fn) => {
    const room = rooms.get(clean(data?.code, 6).toUpperCase());
    if (!room || room.hostToken !== data?.hostToken) return ack(fn, { ok: false });
    room.hostSocket = socket.id;
    socket.data = { role: 'host', code: room.code };
    socket.join(`room:${room.code}`);
    ack(fn, { ok: true, code: room.code, qrSvg: room.qrSvg, joinUrl: room.joinUrl });
    emitHost(room);
  });

  const hostRoom = () => {
    if (socket.data?.role !== 'host') return null;
    const room = rooms.get(socket.data.code);
    return room && room.hostSocket === socket.id ? room : null;
  };

  // Ask a question. If others are still running it's queued: free students get it
  // right away, everyone else as soon as they finish what they're on.
  socket.on('host:start', (data, fn) => {
    const room = hostRoom();
    if (!room) return ack(fn, { ok: false, error: 'Room not found.' });
    if (room.questions.some(isPending)) return ack(fn, { ok: false, error: 'A question is already queued. Edit or remove it first.' });
    const spec = parseQuestion(data);
    if (spec.error) return ack(fn, { ok: false, error: spec.error });
    const wasLive = phaseOf(room) === 'live';
    addQuestion(room, spec);
    const q = room.questions[room.questions.length - 1];
    ack(fn, { ok: true, queued: wasLive && isPending(q) });
    emitAll(room);
  });

  // Take back a queued question nobody has started yet (to edit or discard).
  socket.on('host:unqueue', (_data, fn) => {
    const room = hostRoom();
    if (!room) return ack(fn, { ok: false });
    const last = room.questions[room.questions.length - 1];
    if (!last || !isPending(last)) return ack(fn, { ok: false, error: 'Students have already started it.' });
    room.questions.pop();
    for (const s of room.students.values()) s.next = Math.min(s.next, room.questions.length);
    if (room.hostView != null && room.hostView >= room.questions.length) room.hostView = null;
    ack(fn, { ok: true, spec: specOf(last) });
    emitAll(room);
  });

  socket.on('host:view', (data) => {
    const room = hostRoom();
    if (!room) return;
    const k = data?.index == null ? NaN : Number(data.index); // null = follow live
    room.hostView = Number.isInteger(k) && room.questions[k] ? k : null;
    emitHost(room);
  });

  socket.on('host:end', (data) => {
    const room = hostRoom();
    if (!room) return;
    const k = room.questions.findIndex((q) => q.id === data?.questionId);
    if (k === -1) return;
    endQuestion(room, k);
    emitAll(room);
  });

  // Host marks a text answer right/wrong (during or after the question).
  // `correct` is explicit so repeated taps can't flip it back.
  socket.on('host:markAnswer', (data) => {
    const room = hostRoom();
    const q = room?.questions.find((x) => x.id === data?.questionId);
    if (!q || q.type !== 'text') return;
    const a = q.answers.get(data?.studentId);
    if (!a) return;
    a.correct = data?.correct === null ? null : !!data?.correct;
    if (q.closed) {
      recomputeScores(room);
      emitAll(room);
    } else emitHost(room); // students learn the result once the question closes
  });

  socket.on('host:kick', (data) => {
    const room = hostRoom();
    const s = room?.students.get(data?.studentId);
    if (!s) return;
    if (s.socket) io.to(s.socket).emit('student:kicked');
    removeStudent(room, s);
    emitAll(room);
  });

  socket.on('host:close', () => {
    const room = hostRoom();
    if (!room) return;
    io.to(`room:${room.code}`).emit('room:closed');
    destroyRoom(room);
  });

  /* ---- student ---- */

  socket.on('student:join', (data, fn) => {
    const code = clean(data?.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack(fn, { ok: false, field: 'code', error: 'No room with that code. Check it and try again.' });

    // Reconnect with a saved identity
    if (data?.studentId && data?.token) {
      const s = room.students.get(data.studentId);
      if (s && s.token === data.token) {
        s.socket = socket.id;
        s.connected = true;
        socket.data = { role: 'student', code, sid: s.id };
        socket.join(`room:${code}`);
        ack(fn, { ok: true, studentId: s.id, token: s.token, name: s.name });
        emitStudent(room, s);
        emitHost(room);
        return;
      }
    }

    const name = clean(data?.name, 24);
    if (!name) return ack(fn, { ok: false, field: 'name', error: 'Enter your name.' });
    const taken = [...room.students.values()].some((s) => s.name.toLowerCase() === name.toLowerCase());
    if (taken) return ack(fn, { ok: false, field: 'name', error: 'That name is taken in this room. Try adding an initial.' });

    // Late joiners start at the newest question already in progress (or the first open one).
    const qs = room.questions;
    let start = -1;
    for (let k = qs.length - 1; k >= 0; k--) if (!qs[k].closed && qs[k].starts.size > 0) { start = k; break; }
    if (start === -1) start = qs.findIndex((q) => !q.closed);
    if (start === -1) start = qs.length;

    const s = {
      id: token().slice(0, 10),
      token: token(),
      name,
      socket: socket.id,
      connected: true,
      score: 0,
      correctMs: 0,
      correctCount: 0,
      cur: null,
      next: start,
      timer: null,
    };
    room.students.set(s.id, s);
    socket.data = { role: 'student', code, sid: s.id };
    socket.join(`room:${code}`);
    dispatch(room, s);
    ack(fn, { ok: true, studentId: s.id, token: s.token, name: s.name });
    emitStudent(room, s);
    emitHost(room);
  });

  socket.on('student:answer', (data, fn) => {
    if (socket.data?.role !== 'student') return ack(fn, { ok: false });
    const room = rooms.get(socket.data.code);
    const s = room?.students.get(socket.data.sid);
    if (!s || s.cur == null) return ack(fn, { ok: false, error: 'Time is up.' });
    const k = s.cur;
    const q = room.questions[k];
    if (q.id !== data?.questionId) return ack(fn, { ok: false, error: 'That question has ended.' });
    if (q.answers.has(s.id)) return ack(fn, { ok: false, error: 'You already answered.' });
    const start = q.starts.get(s.id);
    const now = Date.now();
    if (now > start.endsAt + GRACE_MS) return ack(fn, { ok: false, error: 'Time is up.' });

    let answer;
    if (q.type === 'mcq') {
      answer = Number(data?.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= q.options.length) return ack(fn, { ok: false });
    } else {
      answer = clean(data?.answer, 200);
      if (!answer) return ack(fn, { ok: false, error: 'Type an answer first.' });
    }
    q.answers.set(s.id, {
      answer,
      timeMs: Math.min(now - start.at, q.duration * 1000),
      correct: gradeAnswer(q, answer),
    });
    ack(fn, { ok: true });
    finish(room, s, k); // moves them straight on to the next question, if any
    emitAll(room);
  });

  socket.on('student:leave', () => {
    if (socket.data?.role !== 'student') return;
    const room = rooms.get(socket.data.code);
    const s = room?.students.get(socket.data.sid);
    if (!s) return;
    removeStudent(room, s);
    socket.data = {};
    emitAll(room);
  });

  socket.on('disconnect', () => {
    const d = socket.data || {};
    const room = rooms.get(d.code);
    if (!room) return;
    if (d.role === 'student') {
      const s = room.students.get(d.sid);
      if (s && s.socket === socket.id) {
        s.connected = false;
        s.socket = null;
        emitHost(room);
      }
    } else if (d.role === 'host' && room.hostSocket === socket.id) {
      room.hostSocket = null;
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.hostSocket && now - room.touched > ROOM_TTL_MS) destroyRoom(room);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  const lan = `http://${lanAddress()}:${PORT}`;
  console.log(`\n  Roomquiz is running\n`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  ${lan}   <- phones on the same Wi-Fi use this\n`);
});
