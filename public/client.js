import { MAP, PLAYER } from '/shared/game.js';

const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const resolution = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = MAP.width * resolution;
canvas.height = MAP.height * resolution;

const COLORS = ['#d88d71', '#79a89d', '#d1ad61', '#9697bd', '#ba87a4', '#8dab71', '#6c99b5', '#c99260'];
const FURS = ['#eee4d0', '#e2e7d8', '#efe3bd', '#e3ddef', '#ecdade', '#e1e7cb', '#dce6e9', '#eaddce'];
let socket = null;
let playerId = null;
let activeRoom = 'CLAREIRA';
let joining = false;
let wantsConnection = false;
let reconnectTimer = null;
let reconnectDelay = 1200;
let inputSequence = 0;
let snapshots = [];
let latestState = null;
let previousLocal = null;
let playersSignature = '';
let lastTimeLabel = '';
let lastObjective = '';
let toastTimer;
let audioContext;
let muted = false;
let playerName = '';
const keyboard = new Set();
const touches = new Map();
const particles = [];

try {
  const preferences = JSON.parse(localStorage.getItem('toca-trilha.preferences') || '{}');
  $('player-name').value = preferences.name || '';
  $('room-name').value = new URLSearchParams(location.search).get('sala') || preferences.room || 'CLAREIRA';
  muted = preferences.muted === true;
} catch { /* Preferences are optional when storage is unavailable. */ }

function savePreferences() {
  try {
    localStorage.setItem('toca-trilha.preferences', JSON.stringify({
      name: $('player-name').value.trim(), room: $('room-name').value.trim(), muted,
    }));
  } catch { /* The game works without local storage. */ }
}

function setStatus(status, label) {
  $('connection-status').dataset.status = status;
  $('connection-label').textContent = label;
}

function setJoining(value) {
  joining = value;
  $('join-button').disabled = value;
  $('join-button').querySelector('span').textContent = value ? 'Abrindo a clareira…' : 'Entrar na trilha';
}

function showToast(message, duration = 3500) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

function updateSoundButton() {
  $('sound-button').setAttribute('aria-pressed', String(muted));
  const label = muted ? 'Ativar som' : 'Desativar som';
  $('sound-button').setAttribute('aria-label', label);
  $('sound-button').title = label;
  $('sound-button').querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume');
}

function unlockAudio() {
  if (muted) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!audioContext) audioContext = new Audio();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch { /* Audio is decorative; it cannot block joining or input. */ }
}

function tone(frequency, offset = 0, duration = .15, volume = .045, endFrequency = frequency) {
  if (muted || !audioContext || audioContext.state !== 'running') return;
  const start = audioContext.currentTime + offset;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + .03);
}

function playSound(event) {
  if (event === 'jump') tone(230, 0, .14, .022, 460);
  if (event === 'cheese') [523, 659, 784].forEach((note, i) => tone(note, i * .075, .24, .037));
  if (event === 'finish') [523, 659, 784, 1047].forEach((note, i) => tone(note, i * .1, .4, .038));
}

$('sound-button').addEventListener('click', () => {
  muted = !muted;
  unlockAudio();
  updateSoundButton();
  savePreferences();
  if (playerId) canvas.focus({ preventScroll: true });
});
updateSoundButton();

function currentInput() {
  const touchValues = [...touches.values()];
  return {
    left: keyboard.has('left') || touchValues.includes('left'),
    right: keyboard.has('right') || touchValues.includes('right'),
    jump: keyboard.has('jump') || touchValues.includes('jump'),
  };
}

function sendInput() {
  if (socket?.readyState === WebSocket.OPEN && playerId) {
    socket.send(JSON.stringify({ type: 'input', ...currentInput(), seq: ++inputSequence }));
  }
}

function releaseInputs() {
  keyboard.clear();
  touches.clear();
  document.querySelectorAll('[data-control]').forEach(button => button.classList.remove('is-pressed'));
  sendInput();
}

function connect() {
  clearTimeout(reconnectTimer);
  playerId = null;
  setStatus('connecting', reconnectDelay > 1200 ? 'Retomando a trilha…' : 'Abrindo a clareira…');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
  } catch {
    handleConnectionFailure();
    return;
  }
  const connection = socket;
  connection.addEventListener('open', () => {
    if (connection !== socket) return;
    connection.send(JSON.stringify({ type: 'join', name: playerName, room: activeRoom }));
  });
  connection.addEventListener('message', event => {
    if (connection !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome') {
      const reconnecting = $('welcome').hidden;
      playerId = message.id;
      activeRoom = message.room || activeRoom;
      $('room-name').value = activeRoom;
      $('room-button').firstChild.textContent = `${activeRoom} `;
      $('welcome').hidden = true;
      $('players-panel').hidden = false;
      $('objective-banner').hidden = false;
      $('reset-button').disabled = false;
      setJoining(false);
      reconnectDelay = 1200;
      snapshots = [];
      previousLocal = null;
      playersSignature = '';
      setStatus('connected', 'Todo mundo é bem-vindo');
      if (reconnecting) showToast('Conectado de novo. Bora continuar!');
      savePreferences();
      sendInput();
      if (!reconnecting) canvas.focus({ preventScroll: true });
    } else if (message.type === 'state' && Array.isArray(message.players)) {
      latestState = message;
      snapshots.push({ ...message, receivedAt: performance.now() });
      if (snapshots.length > 12) snapshots.shift();
      updateHud(message);
    } else if (message.type === 'error') {
      const messageText = message.message || 'Não foi possível entrar nesta sala.';
      if (!$('welcome').hidden) {
        $('join-error').textContent = messageText;
        $('join-error').hidden = false;
        wantsConnection = false;
        setJoining(false);
        connection.close();
        setStatus('offline', 'Confira a sala');
      } else showToast(messageText, 4500);
    }
  });
  connection.addEventListener('close', () => {
    if (connection !== socket || !wantsConnection) return;
    handleConnectionFailure();
  });
  connection.addEventListener('error', () => {
    if (connection !== socket) return;
    setStatus('offline', 'Conexão interrompida');
  });
}

function handleConnectionFailure() {
  playerId = null;
  releaseInputs();
  $('reset-button').disabled = true;
  setStatus('connecting', 'Reconectando…');
  if (!$('welcome').hidden) {
    $('join-error').textContent = 'A clareira ainda não respondeu. Tentando conectar de novo…';
    $('join-error').hidden = false;
    setJoining(false);
  }
  if (!wantsConnection) return;
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 6000);
}

$('join-form').addEventListener('submit', event => {
  event.preventDefault();
  if (joining) return;
  const name = $('player-name').value.trim();
  const room = $('room-name').value.trim();
  if (!name || !room) {
    $('join-error').textContent = 'Escolha um nome e uma sala para começar.';
    $('join-error').hidden = false;
    return;
  }
  unlockAudio();
  releaseInputs();
  clearTimeout(reconnectTimer);
  const oldSocket = socket;
  socket = null;
  oldSocket?.close();
  playerName = name;
  activeRoom = room;
  wantsConnection = true;
  reconnectDelay = 1200;
  latestState = null;
  snapshots = [];
  previousLocal = null;
  $('join-error').hidden = true;
  setJoining(true);
  connect();
});

$('room-button').addEventListener('click', () => {
  wantsConnection = false;
  clearTimeout(reconnectTimer);
  releaseInputs();
  socket?.close();
  socket = null;
  playerId = null;
  latestState = null;
  snapshots = [];
  previousLocal = null;
  $('welcome').hidden = false;
  $('players-panel').hidden = true;
  $('objective-banner').hidden = true;
  $('reset-button').disabled = true;
  $('join-error').hidden = true;
  setJoining(false);
  setStatus('idle', 'Pronto para explorar');
  $('room-name').focus({ preventScroll: true });
});

function reset() {
  if (socket?.readyState !== WebSocket.OPEN || !playerId) return;
  releaseInputs();
  socket.send(JSON.stringify({ type: 'reset' }));
  showToast('Uma nova chance, a mesma aventura.');
  canvas.focus({ preventScroll: true });
}
$('reset-button').addEventListener('click', reset);

$('invite-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(activeRoom);
    showToast(`Sala ${activeRoom} copiada. Use-a em outra janela.`, 4500);
  } catch {
    showToast(`Abra outra janela e entre na sala ${activeRoom}.`, 5000);
  } finally {
    if (playerId) canvas.focus({ preventScroll: true });
  }
});

const keyActions = { a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right', w: 'jump', ArrowUp: 'jump', ' ': 'jump' };
function isTyping(target) { return target instanceof HTMLElement && (target.matches('input,textarea,select,button') || target.isContentEditable); }
document.addEventListener('keydown', event => {
  if (!playerId || isTyping(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'r') {
    event.preventDefault();
    if (!event.repeat) reset();
    return;
  }
  const action = keyActions[key];
  if (!action) return;
  event.preventDefault();
  unlockAudio();
  keyboard.add(action);
  sendInput();
});
document.addEventListener('keyup', event => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = keyActions[key];
  if (!action) return;
  keyboard.delete(action);
  if (playerId && !isTyping(event.target)) event.preventDefault();
  sendInput();
});
window.addEventListener('blur', releaseInputs);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInputs(); });
for (const button of document.querySelectorAll('[data-control]')) {
  button.addEventListener('pointerdown', event => {
    if (!playerId) return;
    event.preventDefault();
    unlockAudio();
    button.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, button.dataset.control);
    button.classList.add('is-pressed');
    sendInput();
  });
  const endTouch = event => {
    touches.delete(event.pointerId);
    if (![...touches.values()].includes(button.dataset.control)) button.classList.remove('is-pressed');
    sendInput();
  };
  button.addEventListener('pointerup', endTouch);
  button.addEventListener('pointercancel', endTouch);
  button.addEventListener('lostpointercapture', endTouch);
}
setInterval(sendInput, 40);

function updateHud(state) {
  const remaining = Math.max(0, Math.ceil(Number(state.remaining) || 0));
  const time = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  if (time !== lastTimeLabel) {
    $('time-label').textContent = time;
    $('round-timer').classList.toggle('is-urgent', remaining < 15);
    lastTimeLabel = time;
  }
  const local = state.players.find(player => player.id === playerId);
  if (local) {
    const objective = local.finished ? 'Você chegou! Recomece com R ou espere a próxima rodada.' : local.hasCheese ? 'Queijo na mochila! Agora volte à toca.' : 'Pegue o queijo e volte à toca.';
    if (objective !== lastObjective) {
      $('objective-label').textContent = objective;
      $('objective-banner').classList.toggle('is-finished', local.finished);
      $('cheese-label').textContent = local.finished ? 'Na toca!' : local.hasCheese ? 'Queijo coletado' : 'Queijo à vista';
      lastObjective = objective;
    }
    if (previousLocal) {
      if (previousLocal.grounded && !local.grounded && local.vy < -150) playSound('jump');
      if (!previousLocal.hasCheese && local.hasCheese) {
        playSound('cheese');
        burst(local.x + 14, local.y + 10, 18, ['#f5cd75', '#fff3bd', '#e5a75d']);
        showToast('Boa! Agora leve o queijo para casa.');
      }
      if (!previousLocal.finished && local.finished) {
        playSound('finish');
        burst(MAP.goal.x + MAP.goal.w / 2, MAP.goal.y + 15, 65, COLORS, true);
        showToast('Bem-vindo à toca! +1 ponto nesta rodada.', 5500);
      }
      if (previousLocal.finished && !local.finished && remaining > 115) showToast('Uma nova rodada começou. A trilha é sua!');
    }
    previousLocal = { ...local };
  }
  const players = [...state.players].sort((a, b) => b.score - a.score || (a.id === playerId ? -1 : b.id === playerId ? 1 : a.name.localeCompare(b.name)));
  const signature = JSON.stringify(players.map(player => [player.id, player.name, player.score, player.color]));
  if (signature !== playersSignature) {
    $('players-list').replaceChildren(...players.map(player => {
      const item = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'player-dot';
      dot.style.backgroundColor = COLORS[player.color % COLORS.length] || COLORS[0];
      const name = document.createElement('span');
      name.className = `player-list-name${player.id === playerId ? ' player-list-local' : ''}`;
      name.textContent = `${player.name}${player.id === playerId ? ' · você' : ''}`;
      const score = document.createElement('span');
      score.className = 'player-list-score';
      score.textContent = player.score;
      score.title = `${player.score} ${player.score === 1 ? 'chegada' : 'chegadas'} à toca`;
      item.append(dot, name, score);
      return item;
    }));
    $('player-count').textContent = state.players.length;
    playersSignature = signature;
  }
}

function interpolatedPlayers(now) {
  if (!snapshots.length) return [];
  const target = now - 100;
  let before = snapshots[0];
  let after = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length - 1; i++) {
    if (snapshots[i].receivedAt <= target && snapshots[i + 1].receivedAt >= target) {
      before = snapshots[i]; after = snapshots[i + 1]; break;
    }
  }
  const duration = after.receivedAt - before.receivedAt;
  const amount = duration ? Math.max(0, Math.min(1, (target - before.receivedAt) / duration)) : 1;
  const previous = new Map(before.players.map(player => [player.id, player]));
  return after.players.map(player => {
    const old = previous.get(player.id);
    if (!old || Math.abs(player.x - old.x) > 200 || Math.abs(player.y - old.y) > 240) return player;
    return { ...player, x: old.x + (player.x - old.x) * amount, y: old.y + (player.y - old.y) * amount };
  });
}

function rounded(c, x, y, w, h, radius, color, stroke = null) {
  c.beginPath(); c.roundRect(x, y, w, h, radius);
  if (color) { c.fillStyle = color; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}

function ellipse(c, x, y, rx, ry, color, rotation = 0) {
  c.beginPath(); c.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); c.fillStyle = color; c.fill();
}

function leaf(c, x, y, size, rotation, color) {
  c.save(); c.translate(x, y); c.rotate(rotation);
  c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(-size * .8, -size, size * .4, -size * 1.5, 0, -size * 2); c.bezierCurveTo(size * 1.1, -size * 1.1, size, -size * .3, 0, 0); c.fillStyle = color; c.fill(); c.restore();
}

const noise = n => Math.abs(Math.sin(n * 127.1 + 311.7) * 43758.5453) % 1;

function cloud(c, x, y, scale, opacity = .65) {
  c.save(); c.globalAlpha = opacity; c.translate(x, y); c.scale(scale, scale);
  ellipse(c, 0, 0, 46, 12, '#fff4de');
  ellipse(c, -17, -10, 18, 17, '#fff4de');
  ellipse(c, 10, -18, 24, 22, '#fff4de');
  ellipse(c, 32, -6, 21, 13, '#fff4de'); c.restore();
}

function tree(c, x, bottom, height, foliage, trunk, width = .7) {
  c.save(); c.translate(x, bottom);
  c.fillStyle = trunk;
  c.beginPath(); c.moveTo(-11 * width, 0); c.bezierCurveTo(-8 * width, -height * .2, -7, -height * .6, -3, -height); c.lineTo(11, -height); c.bezierCurveTo(8, -height * .55, 16 * width, -height * .16, 24 * width, 0); c.fill();
  c.strokeStyle = trunk; c.lineWidth = 8 * width; c.lineCap = 'round';
  c.beginPath(); c.moveTo(3, -height * .36); c.quadraticCurveTo(-38, -height * .45, -48, -height * .6); c.moveTo(4, -height * .57); c.quadraticCurveTo(42, -height * .64, 47, -height * .78); c.stroke();
  for (let j = 0; j < 7; j++) {
    const angle = j / 7 * Math.PI * 2;
    ellipse(c, Math.cos(angle) * height * .18 * width, -height * .85 + Math.sin(angle) * height * .115, height * .19 * width, height * .15, foliage, Math.cos(angle) * .2);
  }
  ellipse(c, 0, -height * .92, height * .18 * width, height * .18, foliage);
  c.restore();
}

function flower(c, x, y, size, color) {
  c.strokeStyle = '#73956e'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 3, y - size * .6, x, y - size); c.stroke();
  for (let j = 0; j < 5; j++) ellipse(c, x + Math.cos(j * Math.PI * .4) * 3.2, y - size + Math.sin(j * Math.PI * .4) * 3.2, 3.4, 2.7, color, j);
  ellipse(c, x, y - size, 2, 2, '#e6b659');
}

function mushroom(c, x, y, size) {
  rounded(c, x - size * .12, y - size * .7, size * .24, size * .7, 3, '#ecdabb');
  c.beginPath(); c.ellipse(x, y - size * .65, size * .6, size * .44, 0, Math.PI, Math.PI * 2); c.closePath(); c.fillStyle = '#cf8d73'; c.fill();
  ellipse(c, x - size * .2, y - size * .93, size * .07, size * .05, '#f8ddbc');
  ellipse(c, x + size * .18, y - size * .85, size * .08, size * .05, '#f8ddbc');
}

function drawPlatform(c, platform, index) {
  const { x, y, w, h } = platform;
  const ground = h > 30;
  c.save();
  c.shadowColor = '#4d65512b'; c.shadowBlur = ground ? 0 : 13; c.shadowOffsetY = 7;
  rounded(c, x, y + 2, w, ground ? h + 10 : 26, ground ? 0 : 10, ground ? '#b18d66' : '#b58c62');
  c.shadowBlur = 0; c.shadowOffsetY = 0;
  rounded(c, x + 2, y + 8, w - 4, ground ? 10 : 12, 4, '#c2a071');
  c.strokeStyle = '#997959'; c.lineWidth = 1.1;
  for (let j = 18; j < w - 8; j += 43) {
    c.beginPath(); c.moveTo(x + j, y + 13); c.quadraticCurveTo(x + j + 10, y + 8, x + j + 18, y + 15); c.stroke();
  }
  if (!ground) {
    ellipse(c, x + w - 14, y + 15, 6, 4.5, '#b79165');
    c.strokeStyle = '#9d7a57'; c.beginPath(); c.ellipse(x + w - 14, y + 15, 4, 3, 0, 0, Math.PI * 2); c.stroke();
  }
  rounded(c, x, y - 2, w, ground ? 13 : 10, 5, '#6a9271');
  rounded(c, x + 1, y - 3, w - 2, 5, 3, '#9ab98a');
  c.strokeStyle = '#7ca477'; c.lineWidth = 2; c.lineCap = 'round';
  for (let j = 10; j < w - 7; j += 13) {
    const height = 3 + noise(j + index) * 8;
    c.beginPath(); c.moveTo(x + j, y); c.lineTo(x + j - 2, y - height); c.moveTo(x + j, y); c.lineTo(x + j + 3, y - height * .7); c.stroke();
  }
  if (ground) {
    for (let j = 10; j < w - 10; j += 19) ellipse(c, x + j, y + 30 + noise(j) * 38, 2 + noise(j + 1) * 3, 1.2, '#d1b087');
  }
  const bloomX = x + Math.min(29, w * .1);
  flower(c, bloomX, y - 2, 13, '#edc5a5');
  flower(c, bloomX + 11, y - 2, 9, '#f8e1ae');
  if (w > 150 && index !== 0) {
    mushroom(c, x + w - 30, y, 15);
    mushroom(c, x + w - 16, y, 10);
  }
  c.restore();
}

function drawBurrow(c) {
  const { x, y, w, h } = MAP.goal;
  ellipse(c, x + w / 2, y + h + 2, w * .75, 9, '#4c655526');
  c.beginPath(); c.moveTo(x - 9, y + h); c.bezierCurveTo(x - 15, y + 4, x + w + 20, y - 10, x + w + 9, y + h); c.closePath(); c.fillStyle = '#b99b75'; c.fill();
  c.beginPath(); c.moveTo(x + 6, y + h); c.bezierCurveTo(x + 3, y + 12, x + w + 2, y + 9, x + w - 5, y + h); c.closePath(); c.fillStyle = '#d2b18a'; c.fill();
  c.beginPath(); c.moveTo(x + 21, y + h); c.lineTo(x + 21, y + 50); c.arc(x + 40, y + 50, 19, Math.PI, 0); c.lineTo(x + 59, y + h); c.closePath();
  const glow = c.createLinearGradient(0, y + 25, 0, y + h); glow.addColorStop(0, '#795e4c'); glow.addColorStop(1, '#c08d56'); c.fillStyle = glow; c.fill();
  c.strokeStyle = '#e1be89'; c.lineWidth = 4; c.stroke();
  c.strokeStyle = '#85694d'; c.lineWidth = 1.2;
  for (let j = 0; j < 4; j++) { c.beginPath(); c.moveTo(x + 28 + j * 8, y + 41); c.lineTo(x + 28 + j * 8, y + 88); c.stroke(); }
  ellipse(c, x + 49, y + 64, 2.5, 2.5, '#e4c17a');
  for (let j = 0; j < 9; j++) leaf(c, x + j * 10 - 3, y + 35 - Math.sin(j / 8 * Math.PI) * 16, 16, (j - 4) * .19, j % 2 ? '#72946b' : '#86a479');
  rounded(c, x - 5, y + h - 5, w + 10, 8, 4, '#95a77b');
  c.fillStyle = '#826f51'; c.fillRect(x + w + 13, y + 48, 4, 41);
  rounded(c, x + w - 2, y + 43, 42, 18, 3, '#d5b583', '#b19466');
  c.font = '700 9px Trebuchet MS, sans-serif'; c.textAlign = 'center'; c.fillStyle = '#6f7651'; c.fillText('TOCA', x + w + 19, y + 55);
  mushroom(c, x - 17, y + h, 23); mushroom(c, x - 29, y + h, 14);
  for (let j = 0; j < 4; j++) ellipse(c, x + w + 8 + j * 14, y + h - 1, 6, 2.4, '#d5c3a0', -.15);
}

const backdrop = document.createElement('canvas');
backdrop.width = canvas.width; backdrop.height = canvas.height;
const back = backdrop.getContext('2d');
back.scale(resolution, resolution);

function paintBackdrop() {
  const sky = back.createLinearGradient(0, 0, 0, MAP.height);
  sky.addColorStop(0, '#f7dfbe'); sky.addColorStop(.56, '#f7d5b4'); sky.addColorStop(1, '#d0d0ae');
  back.fillStyle = sky; back.fillRect(0, 0, MAP.width, MAP.height);
  const sunlight = back.createRadialGradient(960, 171, 20, 960, 171, 210);
  sunlight.addColorStop(0, '#fff4cf96'); sunlight.addColorStop(1, '#fff4cf00');
  back.fillStyle = sunlight; back.fillRect(720, 0, 500, 440);
  ellipse(back, 960, 170, 77, 77, '#fff0c3');
  cloud(back, 304, 121, 1.15, .64); cloud(back, 1069, 137, 1.15, .7); cloud(back, 686, 79, .65, .51); cloud(back, 821, 237, .77, .3);

  back.beginPath(); back.moveTo(0, 410); back.bezierCurveTo(220, 287, 370, 440, 560, 380); back.bezierCurveTo(800, 301, 960, 340, 1280, 390); back.lineTo(1280, 720); back.lineTo(0, 720); back.fillStyle = '#b7c5a7'; back.fill();
  for (let j = 0; j < 20; j++) tree(back, j * 73 - 24, 505 + noise(j) * 75, 145 + noise(j + 2) * 100, '#a7bea3', '#9caf8e', .75);
  back.beginPath(); back.moveTo(0, 500); back.bezierCurveTo(270, 386, 468, 550, 760, 450); back.bezierCurveTo(985, 380, 1140, 471, 1280, 450); back.lineTo(1280, 720); back.lineTo(0, 720); back.fillStyle = '#94b49a'; back.fill();
  const treeData = [[34, 675, 436, .85], [208, 675, 349, .85], [575, 705, 345, 1], [782, 699, 396, .85], [1182, 692, 475, .93]];
  treeData.forEach(([x, y, h, width], j) => tree(back, x, y, h, j % 2 ? '#80a48c' : '#739f89', '#829776', width));
  tree(back, 439, 700, 359, '#82a78c', '#8c9f7f', .9);
  tree(back, 971, 706, 400, '#88ae93', '#8da083', .8);
  for (let j = 0; j < 12; j++) {
    const x = j * 121 + 25;
    ellipse(back, x, 650, 76 + noise(j) * 50, 66 + noise(j + 1) * 41, j % 2 ? '#759c80' : '#83a487');
  }
  back.save(); back.globalAlpha = .14;
  back.fillStyle = '#fff4d1';
  back.beginPath(); back.moveTo(945, 0); back.lineTo(612, 720); back.lineTo(730, 720); back.lineTo(989, 0); back.fill();
  back.beginPath(); back.moveTo(1100, 0); back.lineTo(857, 720); back.lineTo(953, 720); back.lineTo(1127, 0); back.fill(); back.restore();

  // The low gap is a stream; the collision rectangles themselves stay visible.
  back.fillStyle = '#7bada6'; back.fillRect(445, 674, 115, 46);
  for (let j = 0; j < 4; j++) rounded(back, 454 + j * 22, 688 + j % 2 * 12, 13, 2, 1, '#bfdbbf');
  MAP.platforms.forEach((platform, index) => drawPlatform(back, platform, index));
  for (const hazard of MAP.hazards.filter(item => item.y < 650)) {
    ellipse(back, hazard.x + hazard.w / 2, hazard.y + hazard.h - 1, hazard.w / 2 + 5, 6, '#57765b');
    for (let j = 0; j < hazard.w; j += 11) {
      const height = 13 + noise(j) * 10;
      back.beginPath(); back.moveTo(hazard.x + j, hazard.y + hazard.h); back.quadraticCurveTo(hazard.x + j + 2, hazard.y + height * .1, hazard.x + j + 5, hazard.y + hazard.h - height); back.quadraticCurveTo(hazard.x + j + 8, hazard.y + height * .4, hazard.x + j + 13, hazard.y + hazard.h); back.fillStyle = '#82756a'; back.fill();
      leaf(back, hazard.x + j + 5, hazard.y + hazard.h - 5, 6, -.7, '#71876b');
    }
    flower(back, hazard.x + 14, hazard.y + 4, 5, '#d8a58d');
    flower(back, hazard.x + hazard.w - 19, hazard.y + 4, 5, '#d8a58d');
  }
  drawBurrow(back);
  // A handmade trail sign and lanterns belong to this original world.
  rounded(back, 947, 285, 4, 62, 2, '#997b57');
  rounded(back, 928, 284, 47, 18, 4, '#e0c292', '#bba177');
  back.fillStyle = '#967d58'; back.font = '700 10px Trebuchet MS, sans-serif'; back.textAlign = 'center'; back.fillText('QUEIJO →', 951, 297);
  [[609, 332], [1193, 201], [202, 312]].forEach(([x, y]) => {
    back.strokeStyle = '#76916f'; back.lineWidth = 1; back.beginPath(); back.moveTo(x, y - 31); back.lineTo(x, y); back.stroke();
    rounded(back, x - 8, y, 16, 22, 5, '#e7c382'); rounded(back, x - 5, y + 3, 10, 15, 4, '#ffdfa0');
    rounded(back, x - 10, y - 2, 20, 4, 2, '#907d58');
  });
  // Nearby leaves frame the playfield without hiding its platforms.
  for (let j = 0; j < 7; j++) leaf(back, -18 + j * 10, 126 + j * 7, 45, .3 + j * .09, j % 2 ? '#56876d' : '#639577');
  for (let j = 0; j < 7; j++) leaf(back, 1277 + j * 7, 612 - j * 8, 37, -1.1 - j * .13, j % 2 ? '#60866c' : '#6a9675');
}
paintBackdrop();
$('game-viewport').querySelector('.world-caption').lastChild.textContent = ` ${String(MAP.decor?.title || 'A Clareira Dourada').toUpperCase()}`;

function drawCheese(c, x, y, scale = 1, time = 0, glow = true) {
  c.save(); c.translate(x, y); c.scale(scale, scale);
  if (glow) {
    const light = c.createRadialGradient(0, 0, 4, 0, 0, 44); light.addColorStop(0, '#ffedab6b'); light.addColorStop(1, '#ffedab00');
    c.fillStyle = light; c.fillRect(-44, -44, 88, 88);
  }
  c.lineJoin = 'round'; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(-17, -4); c.lineTo(8, -18); c.lineTo(19, -4); c.lineTo(19, 14); c.lineTo(-17, 14); c.closePath(); c.fillStyle = '#edbf60'; c.fill(); c.strokeStyle = '#c49a4e'; c.stroke();
  c.beginPath(); c.moveTo(-17, -4); c.lineTo(8, -18); c.lineTo(19, -4); c.closePath(); c.fillStyle = '#ffe19a'; c.fill();
  c.beginPath(); c.moveTo(-16, -3); c.lineTo(18, -3); c.strokeStyle = '#d7ad5b'; c.stroke();
  ellipse(c, -8, 3, 3, 3, '#d6a650'); ellipse(c, 7, 7, 4, 3.5, '#d6a650'); ellipse(c, 10, -8, 2.2, 1.3, '#e7bc6a'); ellipse(c, -1, 11, 1.8, 1.8, '#d6a650');
  if (glow) {
    c.fillStyle = '#fff3c0';
    for (let j = 0; j < 3; j++) {
      const angle = time * .7 + j * Math.PI * 2 / 3;
      const px = Math.cos(angle) * 29; const py = Math.sin(angle) * 25;
      c.beginPath(); c.moveTo(px, py - 3); c.lineTo(px + 1, py - 1); c.lineTo(px + 3, py); c.lineTo(px + 1, py + 1); c.lineTo(px, py + 3); c.lineTo(px - 1, py + 1); c.lineTo(px - 3, py); c.lineTo(px - 1, py - 1); c.closePath(); c.fill();
    }
  }
  c.restore();
}

function drawMouse(c, player, time, ghost = false) {
  const color = COLORS[player.color % COLORS.length] || COLORS[0];
  const fur = FURS[player.color % FURS.length] || FURS[0];
  const running = Math.abs(player.vx || 0) > 10 && player.grounded;
  const hop = running && !reducedMotion ? Math.sin(time * 19) * 1.2 : 0;
  const cx = player.x + PLAYER.width / 2;
  const cy = player.y + 15 + hop;
  c.save();
  if (ghost) c.globalAlpha = .42;
  if (player.id === playerId) ellipse(c, cx, player.y + PLAYER.height + 2, 20, 4.5, '#faffd29b');
  ellipse(c, cx, player.y + PLAYER.height + 3, 16, 3.5, '#3b65532b');
  c.translate(cx, cy); c.scale(player.facing === -1 ? -1 : 1, 1);
  // Tail, paws, ears and scarf are drawn from original simple shapes.
  c.strokeStyle = '#ccad9a'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-10, 9); c.bezierCurveTo(-26, 13, -25, 2, -22, -2); c.stroke();
  const stride = running && !reducedMotion ? Math.sin(time * 19) * 4 : 0;
  ellipse(c, -6 + stride, 17, 5, 2.6, '#b6a58f'); ellipse(c, 6 - stride, 17, 5, 2.6, '#b6a58f');
  ellipse(c, -7, -7, 7.4, 8.3, fur, -.28); ellipse(c, 7, -7, 7.4, 8.3, fur, .2);
  ellipse(c, -7, -7, 4.5, 5.1, '#dcaea4', -.28); ellipse(c, 7, -7, 4.5, 5.1, '#dcaea4', .2);
  ellipse(c, 0, 6, 13.5, 14, fur);
  ellipse(c, 5, 8, 11, 8.3, '#f5eddb');
  ellipse(c, 13, 6, 3, 2.7, '#846c63');
  ellipse(c, 4.5, 0, 2.1, 2.5, '#42594d'); ellipse(c, 5.2, -.8, .7, .8, '#fffdf1');
  ellipse(c, 2, 7, 3, 1.7, '#e5b3a1');
  c.strokeStyle = '#b7a38b'; c.lineWidth = .9;
  c.beginPath(); c.moveTo(9, 7); c.lineTo(20, 4); c.moveTo(10, 9); c.lineTo(21, 9); c.stroke();
  rounded(c, -10, 12, 19, 4, 2, color);
  c.beginPath(); c.moveTo(-8, 14); c.lineTo(-13, 23); c.lineTo(-5, 22); c.lineTo(-3, 14); c.closePath(); c.fillStyle = color; c.fill();
  if (player.hasCheese && !player.finished) {
    rounded(c, -14, 2, 8, 11, 3, '#b49566');
    drawCheese(c, -13, 2, .35, 0, false);
  }
  c.restore();
  if (!ghost) {
    c.save(); c.font = '600 11px Trebuchet MS, sans-serif'; c.textAlign = 'center';
    const name = String(player.name || 'Visitante');
    const width = Math.min(155, c.measureText(name).width + 17);
    rounded(c, cx - width / 2, player.y - 30, width, 19, 6, player.id === playerId ? '#fffaf1f0' : '#fffaf1c9');
    c.fillStyle = player.id === playerId ? '#456d50' : '#688165';
    c.fillText(name, cx, player.y - 17, width - 10);
    if (player.id === playerId) {
      c.beginPath(); c.moveTo(cx - 3, player.y - 9); c.lineTo(cx + 3, player.y - 9); c.lineTo(cx, player.y - 5); c.closePath(); c.fillStyle = '#faf4db'; c.fill();
    }
    if (player.finished) {
      c.font = '700 11px Trebuchet MS, sans-serif'; c.fillStyle = '#faf4db'; c.fillText('✓', cx + width / 2 + 8, player.y - 17);
    }
    c.restore();
  }
}

function burst(x, y, count, colors, confetti = false) {
  if (reducedMotion) return;
  for (let j = 0; j < count; j++) {
    particles.push({ x, y, vx: (Math.random() - .5) * (confetti ? 460 : 170), vy: -80 - Math.random() * (confetti ? 360 : 130), life: confetti ? 2.4 + Math.random() : .8 + Math.random() * .4, age: 0, size: confetti ? 4 + Math.random() * 3 : 2 + Math.random() * 2, color: colors[j % colors.length], confetti, angle: Math.random() * 6 });
  }
}

function drawParticles(dt) {
  for (let j = particles.length - 1; j >= 0; j--) {
    const particle = particles[j];
    particle.age += dt;
    if (particle.age > particle.life) { particles.splice(j, 1); continue; }
    particle.x += particle.vx * dt; particle.y += particle.vy * dt;
    particle.vy += (particle.confetti ? 290 : 160) * dt;
    particle.vx *= 1 - dt * (particle.confetti ? .6 : 1);
    ctx.save(); ctx.globalAlpha = Math.min(1, (particle.life - particle.age) * 2); ctx.translate(particle.x, particle.y); ctx.rotate(particle.angle + particle.age * 4); ctx.fillStyle = particle.color;
    if (particle.confetti) ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * .6);
    else { ctx.beginPath(); ctx.arc(0, 0, particle.size, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
}

let lastFrame = performance.now();
function render(now) {
  const dt = Math.min((now - lastFrame) / 1000, .05);
  lastFrame = now;
  const time = reducedMotion ? 0 : now / 1000;
  ctx.setTransform(resolution, 0, 0, resolution, 0, 0);
  ctx.clearRect(0, 0, MAP.width, MAP.height);
  ctx.drawImage(backdrop, 0, 0, MAP.width, MAP.height);
  // A few drifting motes and soft lantern light make this forest feel alive.
  if (!reducedMotion) {
    for (let j = 0; j < 16; j++) {
      const x = noise(j + 90) * 1280 + Math.sin(time * .2 + j) * 12;
      const y = 180 + noise(j + 48) * 410 + Math.cos(time * .3 + j) * 8;
      ctx.globalAlpha = .17 + Math.sin(time * 1.1 + j) * .1;
      ellipse(ctx, x, y, 1.7, 1.7, '#fff9d7');
    }
    ctx.globalAlpha = 1;
  }
  [[609, 342], [1193, 211], [202, 322]].forEach(([x, y], j) => {
    const light = ctx.createRadialGradient(x, y, 0, x, y, 29 + Math.sin(time + j) * 3);
    light.addColorStop(0, '#ffe5aa29'); light.addColorStop(1, '#ffe5aa00');
    ctx.fillStyle = light; ctx.fillRect(x - 33, y - 33, 66, 66);
  });
  const local = latestState?.players.find(player => player.id === playerId);
  if (local?.hasCheese && !local.finished) {
    ctx.save(); ctx.globalAlpha = .25 + Math.sin(time * 3) * .08; ctx.strokeStyle = '#fff3a4'; ctx.lineWidth = 3;
    rounded(ctx, MAP.goal.x - 7, MAP.goal.y - 5, MAP.goal.w + 14, MAP.goal.h + 5, [46, 46, 8, 8], null, '#fff3a4'); ctx.restore();
  }
  const cheeseY = MAP.cheese.y - (reducedMotion ? 0 : Math.sin(time * 2) * 2);
  ellipse(ctx, MAP.cheese.x, MAP.cheese.y + 22, 15, 3, '#57755228');
  if (!local?.hasCheese) drawCheese(ctx, MAP.cheese.x, cheeseY, 1, time);
  else {
    ctx.save(); ctx.globalAlpha = .16; drawCheese(ctx, MAP.cheese.x, cheeseY, 1, time, false); ctx.restore();
  }
  const players = interpolatedPlayers(now).sort((a, b) => a.y - b.y);
  if (players.length) players.forEach(player => drawMouse(ctx, player, time));
  else drawMouse(ctx, { x: MAP.spawn.x, y: MAP.spawn.y, vx: 0, facing: 1, color: 0, grounded: true }, time, true);
  drawParticles(dt);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
