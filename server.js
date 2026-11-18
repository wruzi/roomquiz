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
const MIN_TIME = 10;
const MAX_TIME = 60;
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

function currentQuestion(room) {
  return room.questions[room.questions.length - 1] || null;
}

/* ---------------- state snapshots ---------------- */

function stats(room, q) {
  if (!q) return null;
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
  return {
    counts,
    textGroups: [...textGroups.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    answered: answers.length,
    total: room.students.size,
    avgMs: answers.length ? Math.round(totalMs / answers.length) : 0,
    correctCount: answers.filter(([, a]) => a.correct).length,
    fastest,
    fastestIsCorrect: pool !== answers,
  };
}

function publicQuestion(q, includeKey) {
  if (!q) return null;
  const base = {
    id: q.id,
    index: q.index,
    text: q.text,
    type: q.type,
    options: q.options,
    duration: q.duration,
    endsAt: q.endsAt,
    closed: q.closed,
  };
  if (includeKey || q.closed) {
    base.correct = q.correct;
    base.accepted = q.acceptedRaw;
  }
  return base;
}

function hostState(room) {
  const q = currentQuestion(room);
  const live = room.phase !== 'compose' ? q : null;
  const lb = leaderboard(room);
  return {
    code: room.code,
    joinUrl: room.joinUrl,
    phase: room.phase,
    questionCount: room.questions.length,
    question: publicQuestion(live, true),
    stats: stats(room, live),
    students: [...room.students.values()].map((s) => {
      const a = live?.answers.get(s.id);
      return {
        id: s.id,
        name: s.name,
        score: s.score,
        connected: s.connected,
        answered: !!a,
        answer: a ? a.answer : null,
        timeMs: a ? a.timeMs : null,
        correct: a ? a.correct : null,
      };
    }),
    ranking: live && live.closed
      ? questionRanking(live).map((r) => ({ name: room.students.get(r.sid)?.name || '—', timeMs: r.timeMs, correct: r.correct }))
      : [],
    leaderboard: lb,
    queued: room.queued
      ? { text: room.queued.text, type: room.queued.type, options: room.queued.options.length, duration: room.queued.duration }
      : null,
    autoStartAt: room.autoStartAt || null,
    serverNow: Date.now(),
  };
}

function studentState(room, s) {
  const q = currentQuestion(room);
  const live = room.phase !== 'compose' ? q : null;
  const lb = leaderboard(room);
  const me = lb.find((r) => r.id === s.id);
  const a = live?.answers.get(s.id);
  let result = null;
  if (live && live.closed) {
    const ranking = questionRanking(live);
    result = {
      answered: !!a,
      correct: a ? a.correct : null,
      points: a && a.correct ? POINTS : 0,
      timeMs: a ? a.timeMs : null,
      position: a && a.correct ? ranking.filter((r) => r.correct).findIndex((r) => r.sid === s.id) + 1 : null,
      ofCorrect: ranking.filter((r) => r.correct).length,
    };
  }
  return {
    code: room.code,
    phase: room.phase,
    me: { id: s.id, name: s.name, score: s.score, rank: me?.rank || null, total: lb.length },
    question: publicQuestion(live, false),
    myAnswer: a ? { answer: a.answer, timeMs: a.timeMs } : null,
    result,
    leaderboard: lb.slice(0, 5).map(({ id, name, score, rank }) => ({ id, name, score, rank })),
    nextAt: room.autoStartAt || null,
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

/* ---------------- question lifecycle ---------------- */

const AUTO_START_MS = 5000; // results break before a queued question starts

// Validate host input into a question spec, or { error }.
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

function cancelAutoStart(room) {
  clearTimeout(room.autoTimer);
  room.autoTimer = null;
  room.autoStartAt = null;
}

function startQuestion(room, spec) {
  cancelAutoStart(room);
  if (room.queued === spec) room.queued = null;
  const now = Date.now();
  const q = {
    ...spec,
    id: token().slice(0, 8),
    index: room.questions.length + 1,
    startedAt: now,
    endsAt: now + spec.duration * 1000,
    answers: new Map(),
    closed: false,
  };
  q.timer = setTimeout(() => closeQuestion(room), spec.duration * 1000 + 300);
  room.questions.push(q);
  room.phase = 'live';
  emitAll(room);
}

function closeQuestion(room) {
  const q = currentQuestion(room);
  if (!q || q.closed) return;
  clearTimeout(q.timer);
  clearTimeout(q.allInTimer);
  q.closed = true;
  q.endsAt = Math.min(q.endsAt, Date.now());
  room.phase = 'results';
  recomputeScores(room);
  if (room.queued) {
    room.autoStartAt = Date.now() + AUTO_START_MS;
    room.autoTimer = setTimeout(() => room.queued && startQuestion(room, room.queued), AUTO_START_MS);
  }
  emitAll(room);
}

function maybeCloseEarly(room) {
  const q = currentQuestion(room);
  if (!q || q.closed) return;
  const connected = [...room.students.values()].filter((s) => s.connected);
  if (connected.length && connected.every((s) => q.answers.has(s.id))) {
    clearTimeout(q.allInTimer);
    q.allInTimer = setTimeout(() => closeQuestion(room), 800);
  }
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
      phase: 'compose',
      students: new Map(),
      questions: [],
      queued: null,
      autoStartAt: null,
      autoTimer: null,
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

  socket.on('host:start', (data, fn) => {
    const room = hostRoom();
    if (!room) return ack(fn, { ok: false, error: 'Room not found.' });
    const spec = parseQuestion(data);
    if (spec.error) return ack(fn, { ok: false, error: spec.error });
    if (room.phase === 'live') {
      // A question is running: hold this one and send it when time is up.
      room.queued = spec;
      ack(fn, { ok: true, queued: true });
      emitHost(room);
      return;
    }
    startQuestion(room, spec);
    ack(fn, { ok: true });
  });

  // Take the queued question back out (to edit or discard it).
  socket.on('host:unqueue', (_data, fn) => {
    const room = hostRoom();
    if (!room) return ack(fn, { ok: false });
    const spec = room.queued;
    cancelAutoStart(room);
    room.queued = null;
    ack(fn, { ok: true, spec });
    emitAll(room);
  });

  socket.on('host:sendQueued', () => {
    const room = hostRoom();
    if (!room || !room.queued || room.phase === 'live') return;
    startQuestion(room, room.queued);
  });

  socket.on('host:hold', () => {
    const room = hostRoom();
    if (!room) return;
    cancelAutoStart(room);
    emitAll(room);
  });

  socket.on('host:end', () => {
    const room = hostRoom();
    if (room) closeQuestion(room);
  });

  socket.on('host:toggleCorrect', (data) => {
    const room = hostRoom();
    const q = room && currentQuestion(room);
    if (!q || !q.closed || q.type !== 'text') return;
    const a = q.answers.get(data?.studentId);
    if (!a) return;
    a.correct = !a.correct;
    recomputeScores(room);
    emitAll(room);
  });

  socket.on('host:kick', (data) => {
    const room = hostRoom();
    const s = room?.students.get(data?.studentId);
    if (!s) return;
    if (s.socket) io.to(s.socket).emit('student:kicked');
    room.students.delete(s.id);
    for (const q of room.questions) q.answers.delete(s.id);
    recomputeScores(room);
    emitAll(room);
  });

  socket.on('host:close', () => {
    const room = hostRoom();
    if (!room) return;
    const q = currentQuestion(room);
    if (q) clearTimeout(q.timer);
    cancelAutoStart(room);
    io.to(`room:${room.code}`).emit('room:closed');
    rooms.delete(room.code);
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

    const s = {
      id: token().slice(0, 10),
      token: token(),
      name,
      socket: socket.id,
      connected: true,
      score: 0,
      correctMs: 0,
      correctCount: 0,
    };
    room.students.set(s.id, s);
    socket.data = { role: 'student', code, sid: s.id };
    socket.join(`room:${code}`);
    ack(fn, { ok: true, studentId: s.id, token: s.token, name: s.name });
    emitStudent(room, s);
    emitHost(room);
  });

  socket.on('student:answer', (data, fn) => {
    if (socket.data?.role !== 'student') return ack(fn, { ok: false });
    const room = rooms.get(socket.data.code);
    const s = room?.students.get(socket.data.sid);
    const q = room && currentQuestion(room);
    if (!s || !q || q.closed || room.phase !== 'live') return ack(fn, { ok: false, error: 'Time is up.' });
    if (q.id !== data?.questionId) return ack(fn, { ok: false, error: 'That question has ended.' });
    if (q.answers.has(s.id)) return ack(fn, { ok: false, error: 'You already answered.' });
    const now = Date.now();
    if (now > q.endsAt + 300) return ack(fn, { ok: false, error: 'Time is up.' });

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
      timeMs: Math.min(now - q.startedAt, q.duration * 1000),
      correct: gradeAnswer(q, answer),
    });
    ack(fn, { ok: true });
    emitStudent(room, s);
    emitHost(room);
    maybeCloseEarly(room);
  });

  socket.on('student:leave', () => {
    if (socket.data?.role !== 'student') return;
    const room = rooms.get(socket.data.code);
    if (!room) return;
    room.students.delete(socket.data.sid);
    for (const q of room.questions) q.answers.delete(socket.data.sid);
    recomputeScores(room);
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
  for (const [code, room] of rooms) {
    if (!room.hostSocket && now - room.touched > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  const lan = `http://${lanAddress()}:${PORT}`;
  console.log(`\n  Roomquiz is running\n`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  ${lan}   <- phones on the same Wi-Fi use this\n`);
});
