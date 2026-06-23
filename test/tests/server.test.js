const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

const SCRIPT = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [SCRIPT], { env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
    let done = false;
    p.stdout.on('data', d => { if (!done && d.toString().includes('Server running')) { done = true; resolve(p); } });
    p.on('error', reject);
    setTimeout(() => { if (!done) { p.kill(); reject(new Error('timeout')); } }, 5000);
  });
}
function stop(p) { try { if (p && !p.killed) p.kill(); } catch {} }

function fetch_(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ s: res.statusCode, h: res.headers, b })); }).on('error', reject);
  });
}
function wsC(url) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(url);
    w.on('open', () => resolve(w));
    w.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 3000);
  });
}
function send(w, m) { w.send(JSON.stringify(m)); }
function onMsg(w, t = 4000) {
  return new Promise((resolve, reject) => {
    const h = d => { w.removeListener('message', h); resolve(JSON.parse(d)); };
    w.on('message', h);
    setTimeout(() => { w.removeListener('message', h); reject(new Error('timeout')); }, t);
  });
}
function onMsgs(w, n, t = 4000) {
  const msgs = [];
  return new Promise((resolve, reject) => {
    const h = d => { msgs.push(JSON.parse(d)); if (msgs.length === n) { w.removeListener('message', h); resolve(msgs); } };
    w.on('message', h);
    setTimeout(() => { w.removeListener('message', h); reject(new Error(`got ${msgs.length}/${n}`)); }, t);
  });
}
async function pair(u, rm) {
  const a = await wsC(u), b = await wsC(u);
  const aJoined = onMsg(a);
  send(a, { type: 'join', room: rm });
  const j1 = (await aJoined).type;
  assert.equal(j1, 'joined');
  const aGs = onMsg(a), bBoth = onMsgs(b, 2);
  send(b, { type: 'join', room: rm });
  assert.equal((await aGs).type, 'game_start');
  const bb = await bBoth;
  assert.equal(bb[0].type, 'joined');
  assert.equal(bb[1].type, 'game_start');
  return [a, b];
}

describe('http', () => {
  let p; const port = 19876;
  before(async () => p = await startServer(port));
  after(() => stop(p));

  it('index.html', async () => {
    const r = await fetch_(`http://localhost:${port}/`);
    assert.equal(r.s, 200);
    assert.ok(r.b.includes('Tetris Battle'));
  });
  it('static .js', async () => {
    const r = await fetch_(`http://localhost:${port}/tetris.js`);
    assert.equal(r.s, 200);
    assert.ok(r.h['content-type'].includes('javascript'));
  });
  it('static .css', async () => {
    const r = await fetch_(`http://localhost:${port}/style.css`);
    assert.equal(r.s, 200);
    assert.ok(r.h['content-type'].includes('css'));
  });
  it('404', async () => {
    assert.equal((await fetch_(`http://localhost:${port}/nope`)).s, 404);
  });
});

describe('ws rooms', () => {
  let p; const port = 19877; const u = `ws://localhost:${port}`;
  before(async () => p = await startServer(port));
  after(() => stop(p));

  it('auto room code', async () => {
    const w = await wsC(u);
    const m = onMsg(w);
    send(w, { type: 'join' });
    const r = await m;
    assert.equal(r.type, 'joined');
    assert.equal(r.room.length, 4);
    assert.equal(typeof r.playerId, 'number');
    w.close();
  });
  it('specific room', async () => {
    const w = await wsC(u);
    const m = onMsg(w);
    send(w, { type: 'join', room: 'ROOM' });
    assert.equal((await m).room, 'ROOM');
    w.close();
  });
  it('two players get game_start', async () => {
    const [a, b] = await pair(u, 'P2P');
    a.close(); b.close();
  });
  it('room full', async () => {
    const [a, b] = await pair(u, 'FULL');
    const c = await wsC(u);
    const m = onMsg(c);
    send(c, { type: 'join', room: 'FULL' });
    assert.equal((await m).type, 'error');
    a.close(); b.close(); c.close();
  });
  it('opponent_left', async () => {
    const [a, b] = await pair(u, 'LEFT');
    const m = onMsg(a);
    b.close();
    assert.equal((await m).type, 'opponent_left');
    a.close();
  });
});

describe('ws relay', () => {
  let p; const port = 19878; const u = `ws://localhost:${port}`;
  before(async () => p = await startServer(port));
  after(() => stop(p));

  it('input', async () => {
    const [a, b] = await pair(u, 'IN');
    const m = onMsg(b);
    send(a, { type: 'input', action: 'left' });
    const r = await m;
    assert.equal(r.type, 'opponent_input');
    assert.equal(r.action, 'left');
    a.close(); b.close();
  });
  it('skill', async () => {
    const [a, b] = await pair(u, 'SK');
    const m = onMsg(b);
    send(a, { type: 'skill', skill: 'chaos' });
    const r = await m;
    assert.equal(r.type, 'opponent_skill');
    assert.equal(r.skill, 'chaos');
    a.close(); b.close();
  });
  it('state', async () => {
    const [a, b] = await pair(u, 'ST');
    const m = onMsg(b);
    send(a, { type: 'state', board: [[1]], score: 42, currentPiece: null, position: { row: 0, col: 0 } });
    const r = await m;
    assert.equal(r.type, 'opponent_state');
    assert.deepEqual(r.board, [[1]]);
    assert.equal(r.score, 42);
    a.close(); b.close();
  });
  it('game_over', async () => {
    const [a, b] = await pair(u, 'GO');
    const m = onMsg(b);
    send(a, { type: 'game_over' });
    assert.equal((await m).type, 'opponent_game_over');
    a.close(); b.close();
  });
  it('no echo to sender', async () => {
    const [a, b] = await pair(u, 'ECHO');
    const m = onMsg(a);
    send(a, { type: 'input', action: 'drop' });
    const race = await Promise.race([m, new Promise(r => setTimeout(() => r('TIMEOUT'), 600))]);
    assert.equal(race, 'TIMEOUT');
    a.close(); b.close();
  });
  it('bad json ignored', async () => {
    const w = await wsC(u);
    const m = onMsg(w);
    w.send('{{{not json}}}');
    const race = await Promise.race([m, new Promise(r => setTimeout(() => r('TIMEOUT'), 400))]);
    assert.equal(race, 'TIMEOUT');
    w.close();
  });
  it('unknown type ignored', async () => {
    const w = await wsC(u);
    const m = onMsg(w);
    send(w, { type: 'bogus' });
    const race = await Promise.race([m, new Promise(r => setTimeout(() => r('TIMEOUT'), 400))]);
    assert.equal(race, 'TIMEOUT');
    w.close();
  });
});
