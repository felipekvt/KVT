import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startServer } from '../server.js';
import { createPlayer, MAP, PLAYER, resetPlayer, startNewRoundPlayer, stepPlayer } from '../public/shared/game.js';

let server;
const sockets = new Set();

class TestClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.messages = [];
    this.listeners = new Set();
    this.socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      this.messages.push(message);
      for (const listener of this.listeners) listener(message);
    });
    sockets.add(this);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 3000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket failed')); }, { once: true });
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  waitFor(predicate, { timeout = 4000, fresh = false } = {}) {
    if (!fresh) {
      const previous = this.messages.find(predicate);
      if (previous) return Promise.resolve(previous);
    }
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for server message; received ${this.messages.map(m => m.type).join(', ')}`));
      }, timeout);
      this.listeners.add(listener);
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.close();
    });
    sockets.delete(this);
  }
}

function playersOf(state) {
  return Array.isArray(state.players) ? state.players : Object.values(state.players ?? {});
}

async function join(name, room) {
  const client = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
  await client.open();
  client.send({ type: 'join', name, room });
  const welcome = await client.waitFor(message => message.type === 'welcome');
  assert.equal(welcome.room, room.toUpperCase());
  assert.ok(welcome.id, 'welcome identifies the player');
  return { client, id: welcome.id };
}

before(async () => { server = await startServer({ port: 0, host: '127.0.0.1' }); });
after(async () => {
  await Promise.all([...sockets].map(client => client.close()));
  if (server) await server.close();
});

test('server serves health and the original playable frontend', async () => {
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /json/);
  const payload = await health.json();
  assert.equal(payload.ok, true);
  const frontend = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(frontend.status, 200);
  const html = await frontend.text();
  assert.match(html, /<canvas\b/i, 'frontend has a game surface');
  assert.match(html, /client\.js/, 'frontend loads its own client');
});

test('two players share a room, movement is broadcast, and another room stays isolated', async () => {
  const first = await join('QA Primeiro', 'qa-room');
  const second = await join('QA Segundo', 'qa-room');
  const isolated = await join('QA Isolado', 'qa-other');
  const hasBoth = message => message.type === 'state' && playersOf(message).some(p => p.id === first.id) && playersOf(message).some(p => p.id === second.id);
  const initial = await first.client.waitFor(hasBoth, { fresh: true });
  await second.client.waitFor(hasBoth, { fresh: true });
  const isolatedState = await isolated.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === isolated.id), { fresh: true });
  assert.deepEqual(playersOf(isolatedState).map(p => p.id), [isolated.id]);
  assert.ok(!playersOf(initial).some(p => p.id === isolated.id));
  const initialPlayer = playersOf(initial).find(p => p.id === first.id);
  first.client.send({ type: 'input', left: false, right: true, jump: false, seq: 1 });
  const moved = await second.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === first.id && p.x > initialPlayer.x + 10), { fresh: true });
  const movedPlayer = playersOf(moved).find(p => p.id === first.id);
  assert.ok(Number.isFinite(movedPlayer.x) && Number.isFinite(movedPlayer.y));
  first.client.send({ type: 'input', left: false, right: false, jump: false, seq: 2 });
  first.client.send({ type: 'reset' });
  await second.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === first.id && p.x < initialPlayer.x + 5), { fresh: true });
  await Promise.all([first.client.close(), second.client.close(), isolated.client.close()]);
});

test('invalid JSON does not crash the server or interrupt valid players', async () => {
  const valid = await join('QA Resiliente', 'qa-invalid');
  valid.client.socket.send('{invalid');
  valid.client.send({ type: 'input', left: false, right: true, jump: false, seq: 1 });
  const state = await valid.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === valid.id), { fresh: true });
  assert.equal(playersOf(state).length, 1);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 200);
  await valid.client.close();
});

test('client coordinates cannot teleport the authoritative player', async () => {
  const player = await join('QA Autoridade', 'qa-authority');
  const initial = await player.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === player.id));
  const origin = playersOf(initial).find(p => p.id === player.id);
  player.client.send({ type: 'input', left: false, right: false, jump: false, seq: 1, x: 999999, y: -999999, score: 999 });
  const later = await player.client.waitFor(message => message.type === 'state' && message.tick > initial.tick + 2, { fresh: true });
  const actual = playersOf(later).find(p => p.id === player.id);
  assert.ok(Math.abs(actual.x - origin.x) < 10, 'only server physics changes the x position');
  assert.ok(actual.y >= 0 && actual.y < 10000, 'server rejects client-supplied coordinates');
  assert.equal(actual.score, origin.score, 'client cannot assign points');
  await player.client.close();
});

test('a quick jump press and release between snapshots still makes the player jump', async () => {
  const player = await join('QA Salto Rápido', 'qa-tap');
  const initial = await player.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === player.id && p.grounded));
  const groundY = playersOf(initial).find(p => p.id === player.id).y;
  player.client.send({ type: 'input', left: false, right: false, jump: true, seq: 1 });
  player.client.send({ type: 'input', left: false, right: false, jump: false, seq: 2 });
  const state = await player.client.waitFor(message => message.type === 'state' && playersOf(message).some(p => p.id === player.id && p.y < groundY - 1 && p.vy < 0), { fresh: true, timeout: 2000 });
  const airborne = playersOf(state).find(p => p.id === player.id);
  assert.equal(airborne.grounded, false);
  assert.ok(airborne.y < groundY, 'server keeps a short jump press until the next physics step');
  await player.client.close();
});

test('players land, move and jump once when the jump button stays held', () => {
  const player = createPlayer({ id: 'physics', name: 'Physics' });
  stepPlayer(player, {}, 1 / 60);
  assert.equal(player.grounded, true);
  assert.equal(player.y + PLAYER.height, MAP.platforms[0].y);
  const originX = player.x;
  for (let frame = 0; frame < 12; frame++) stepPlayer(player, { right: true }, 1 / 60);
  assert.ok(player.x > originX + 25);
  resetPlayer(player);
  stepPlayer(player, {}, 1 / 60);
  const groundY = player.y;
  stepPlayer(player, { jump: true }, 1 / 60);
  assert.ok(player.y < groundY && player.vy < 0);
  assert.equal(player.grounded, false);
  for (let frame = 0; frame < 100; frame++) stepPlayer(player, { jump: true }, 1 / 60);
  assert.equal(player.grounded, true, 'holding jump does not repeat automatically');
  assert.equal(player.y, groundY);
  stepPlayer(player, { jump: false }, 1 / 60);
  stepPlayer(player, { jump: true }, 1 / 60);
  assert.ok(player.y < groundY && player.vy < 0, 'a released and pressed jump works again');
});

test('the shared simulation is deterministic for the same ordered inputs', () => {
  const first = createPlayer({ id: 'deterministic', name: 'Same' });
  const second = createPlayer({ id: 'deterministic', name: 'Same' });
  for (let frame = 0; frame < 360; frame++) {
    const input = { right: frame < 120, left: frame >= 180 && frame < 270, jump: frame % 45 < 3 };
    stepPlayer(first, input, 1 / 60);
    stepPlayer(second, input, 1 / 60);
  }
  assert.deepEqual(first, second);
  assert.ok(Number.isFinite(first.x) && Number.isFinite(first.y));
});

test('the complete course can be finished with movement and jumps alone', () => {
  const player = createPlayer({ id: 'course', name: 'Course' });
  const jumpAt = [220, 390, 560, 760];
  let nextJump = 0;
  for (let frame = 0; frame < 1200 && !player.finished; frame++) {
    const jump = !player.hasCheese && player.grounded && nextJump < jumpAt.length && player.x >= jumpAt[nextJump];
    if (jump) nextJump++;
    stepPlayer(player, { right: !player.hasCheese, left: player.hasCheese, jump }, 1 / 60);
  }
  assert.equal(player.finished, true, 'the cheese and exit are reachable using the real controls');
  assert.equal(player.hasCheese, true);
  assert.equal(player.score, 1);
});

function collect(player) {
  Object.assign(player, { x: MAP.cheese.x - PLAYER.width / 2, y: MAP.cheese.y - PLAYER.height / 2, vx: 0, vy: 0 });
  stepPlayer(player, {}, 1 / 60);
  assert.equal(player.hasCheese, true);
}

function enterGoal(player) {
  Object.assign(player, { x: MAP.goal.x + 10, y: MAP.spawn.y, vx: 0, vy: 0 });
  stepPlayer(player, {}, 1 / 60);
}

test('cheese must reach the goal, scores once per round and resets safely', () => {
  const player = createPlayer({ id: 'objective', name: 'Objective' });
  enterGoal(player);
  assert.equal(player.score, 0, 'visiting the goal without cheese gives no score');
  assert.equal(player.finished, false);
  collect(player);
  enterGoal(player);
  assert.equal(player.finished, true);
  assert.equal(player.score, 1);
  for (let frame = 0; frame < 10; frame++) stepPlayer(player, {}, 1 / 60);
  assert.equal(player.score, 1, 'remaining in the goal cannot farm points');
  resetPlayer(player);
  assert.equal(player.hasCheese, false);
  assert.equal(player.finished, false);
  assert.equal(player.score, 1);
  collect(player);
  enterGoal(player);
  assert.equal(player.score, 1, 'manual retry cannot farm points in the same round');
  startNewRoundPlayer(player);
  collect(player);
  enterGoal(player);
  assert.equal(player.score, 2, 'a new round allows one more point');
});

test('falling into a hazard returns the player to spawn and loses carried cheese', () => {
  const player = createPlayer({ id: 'hazard', name: 'Hazard' });
  collect(player);
  const hazard = MAP.hazards[0];
  Object.assign(player, { x: hazard.x + 10, y: hazard.y + 1, vx: 0, vy: 0 });
  stepPlayer(player, {}, 1 / 60);
  assert.equal(player.x, MAP.spawn.x);
  assert.equal(player.y, MAP.spawn.y);
  assert.equal(player.hasCheese, false);
  assert.equal(player.score, 0);
});

test('closing clients removes empty rooms and players', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  const health = await response.json();
  assert.equal(health.players, 0);
  assert.equal(health.rooms, 0);
});
