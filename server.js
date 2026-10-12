import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createPlayer, resetPlayer, startNewRoundPlayer, stepPlayer } from './public/shared/game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PHYSICS_HZ = 60;
const SNAPSHOT_HZ = 20;
const ROUND_SECONDS = 120;
const MAX_ROOM_PLAYERS = 16;
const MAX_CLIENTS = 256;
const MAX_MESSAGE_BYTES = 2048;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function safeName(value) {
  if (typeof value !== 'string') return 'Visitante';
  const trimmed = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return [...trimmed].slice(0, 32).join('') || 'Visitante';
}

function safeRoom(value) {
  if (typeof value !== 'string') return 'JARDIM';
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12) || 'JARDIM';
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function visiblePlayer(player) {
  const { id, name, x, y, vx, vy, facing, grounded, hasCheese, finished, score, color } = player;
  return { id, name, x, y, vx, vy, facing, grounded, hasCheese, finished, score, color };
}

export async function startServer({ port = 3000, host = '127.0.0.1' } = {}) {
  const rooms = new Map();
  const clients = new Map();
  let shuttingDown = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Método não permitido.');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Endereço inválido.');
      return;
    }
    if (pathname === '/health') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
        ok: true,
        game: 'Toca & Trilha',
        rooms: rooms.size,
        players: [...rooms.values()].reduce((count, room) => count + room.players.size, 0),
      }));
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) {
      response.writeHead(400).end('Endereço inválido.');
      return;
    }
    const target = path.resolve(PUBLIC, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(PUBLIC + path.sep)) {
      response.writeHead(403).end('Acesso negado.');
      return;
    }
    try {
      const canonical = await realpath(target);
      if (!canonical.startsWith(PUBLIC + path.sep)) {
        response.writeHead(403).end('Acesso negado.');
        return;
      }
      const details = await stat(canonical);
      if (!details.isFile()) {
        response.writeHead(404).end('Arquivo não encontrado.');
        return;
      }
      response.setHeader('Content-Type', MIME[path.extname(canonical).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Content-Length', details.size);
      if (request.method === 'HEAD') response.end();
      else response.end(await readFile(canonical));
    } catch (error) {
      const status = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500;
      response.writeHead(status).end(status === 404 ? 'Arquivo não encontrado.' : 'Erro ao abrir arquivo.');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws' || shuttingDown || wss.clients.size >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  function snapshot(room) {
    const players = [...room.players.values()].map(visiblePlayer);
    return {
      type: 'state',
      room: room.name,
      tick: room.tick,
      remaining: Math.max(0, Math.ceil((room.endsAt - performance.now()) / 1000)),
      players,
      leaderboard: players.map(({ id, name, score, color }) => ({ id, name, score, color }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    };
  }

  function leave(client) {
    clearTimeout(client.joinTimeout);
    clients.delete(client.id);
    if (!client.room) return;
    client.room.players.delete(client.id);
    client.room.sockets.delete(client.socket);
    if (client.room.players.size === 0) rooms.delete(client.room.name);
  }

  wss.on('connection', socket => {
    const client = {
      id: randomUUID(),
      socket,
      room: null,
      player: null,
      input: { left: false, right: false, jump: false },
      pendingJump: false,
      seq: -1,
      lastInputAt: performance.now(),
      rateStart: performance.now(),
      messages: 0,
      lastResetAt: -Infinity,
      alive: true,
      joinTimeout: setTimeout(() => socket.close(1008, 'Entre em uma sala.'), 10000),
    };
    clients.set(client.id, client);
    socket.on('pong', () => { client.alive = true; });
    socket.on('error', () => {});
    socket.on('close', () => leave(client));
    socket.on('message', (raw, binary) => {
      if (binary) {
        send(socket, { type: 'error', message: 'Use mensagens JSON de texto.' });
        return;
      }
      const now = performance.now();
      if (now - client.rateStart >= 1000) {
        client.rateStart = now;
        client.messages = 0;
      }
      if (++client.messages > 100) {
        socket.close(1008, 'Limite de mensagens excedido.');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        send(socket, { type: 'error', message: 'JSON inválido.' });
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        send(socket, { type: 'error', message: 'Mensagem inválida.' });
        return;
      }
      if (message.type === 'join') {
        if (client.room) {
          send(socket, { type: 'error', message: 'Você já está em uma sala.' });
          return;
        }
        const roomName = safeRoom(message.room);
        let room = rooms.get(roomName);
        if (!room) {
          room = { name: roomName, players: new Map(), sockets: new Set(), tick: 0, endsAt: now + ROUND_SECONDS * 1000 };
          rooms.set(roomName, room);
        }
        if (room.players.size >= MAX_ROOM_PLAYERS) {
          send(socket, { type: 'error', message: 'Sala cheia. Escolha outra sala (até 16 jogadores).' });
          return;
        }
        const usedColors = new Set([...room.players.values()].map(player => player.color));
        let color = 0;
        while (color < 8 && usedColors.has(color)) color++;
        client.player = createPlayer({ id: client.id, name: safeName(message.name), color: color % 8 });
        client.room = room;
        room.players.set(client.id, client.player);
        room.sockets.add(socket);
        clearTimeout(client.joinTimeout);
        send(socket, { type: 'welcome', id: client.id, room: roomName });
        send(socket, snapshot(room));
        return;
      }
      if (!client.room) {
        send(socket, { type: 'error', message: 'Entre em uma sala primeiro.' });
        return;
      }
      if (message.type === 'input') {
        if (
          typeof message.left !== 'boolean' || typeof message.right !== 'boolean' ||
          typeof message.jump !== 'boolean' || !Number.isSafeInteger(message.seq) || message.seq < 0
        ) {
          send(socket, { type: 'error', message: 'Comando de movimento inválido.' });
          return;
        }
        if (message.seq <= client.seq) return;
        client.seq = message.seq;
        // Preserve a press/release pair that arrives between simulation ticks.
        // Repeated `true` inputs while holding the key do not queue new jumps.
        if (message.jump && !client.input.jump) client.pendingJump = true;
        client.input = { left: message.left, right: message.right, jump: message.jump };
        client.lastInputAt = now;
      } else if (message.type === 'reset') {
        if (now - client.lastResetAt < 500) return;
        client.lastResetAt = now;
        client.input = { left: false, right: false, jump: false };
        client.pendingJump = false;
        resetPlayer(client.player);
        send(socket, snapshot(client.room));
      } else {
        send(socket, { type: 'error', message: 'Tipo de mensagem desconhecido.' });
      }
    });
  });

  const simulationTimer = setInterval(() => {
    const now = performance.now();
    for (const room of rooms.values()) {
      if (now >= room.endsAt) {
        room.endsAt = now + ROUND_SECONDS * 1000;
        for (const player of room.players.values()) startNewRoundPlayer(player);
      }
      room.tick++;
    }
    for (const client of clients.values()) {
      if (!client.player) continue;
      if (now - client.lastInputAt > 1500) {
        client.input = { left: false, right: false, jump: false };
        client.pendingJump = false;
      }
      const pendingJump = client.pendingJump;
      client.pendingJump = false;
      // The queued event is an actual key edge, including when the key was
      // released and pressed again before the simulation observed the release.
      if (pendingJump) client.player._jumpHeld = false;
      stepPlayer(client.player, { ...client.input, jump: pendingJump || client.input.jump }, 1 / PHYSICS_HZ);
    }
  }, 1000 / PHYSICS_HZ);

  const snapshotTimer = setInterval(() => {
    for (const room of rooms.values()) {
      const update = snapshot(room);
      for (const socket of room.sockets) {
        // Slow clients receive the next state rather than an unbounded queue.
        if (socket.bufferedAmount > 128 * 1024) continue;
        send(socket, update);
      }
    }
  }, 1000 / SNAPSHOT_HZ);

  const heartbeatTimer = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30000);

  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    clearInterval(simulationTimer);
    clearInterval(snapshotTimer);
    clearInterval(heartbeatTimer);
    for (const client of clients.values()) {
      clearTimeout(client.joinTimeout);
      client.socket.terminate();
    }
    closePromise = Promise.all([
      new Promise(resolve => wss.close(() => resolve())),
      new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    ]).then(() => {
      clients.clear();
      rooms.clear();
    });
    return closePromise;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  return { port: address.port, host, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('PORT inválida.');
  const instance = await startServer({ port, host });
  console.log(`Toca & Trilha em http://${instance.host}:${instance.port}`);
  const stop = async () => {
    await instance.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
