// Original, deterministic simulation shared by the game and its own server.
// Coordinates are CSS pixels; player x/y refer to the upper-left corner.
export const PLAYER = Object.freeze({ width: 28, height: 34 });

export const MAP = Object.freeze({
  width: 1280,
  height: 720,
  platforms: Object.freeze([
    { x: 0, y: 650, w: 445, h: 70 },
    { x: 560, y: 650, w: 720, h: 70 },
    { x: 245, y: 555, w: 210, h: 18 },
    { x: 430, y: 465, w: 205, h: 18 },
    { x: 655, y: 380, w: 195, h: 18 },
    { x: 910, y: 350, w: 250, h: 18 },
  ]),
  spawn: Object.freeze({ x: 140, y: 616 }),
  cheese: Object.freeze({ x: 1055, y: 323, r: 18 }),
  goal: Object.freeze({ x: 55, y: 560, w: 80, h: 90 }),
  hazards: Object.freeze([
    { x: 445, y: 685, w: 115, h: 35 },
    { x: 745, y: 630, w: 75, h: 20 },
  ]),
  decor: Object.freeze({ title: 'Jardim das Lanternas' }),
});

const SPEED = 290;
const ACCELERATION = 2200;
const FRICTION = 2500;
const GRAVITY = 1450;
const JUMP_SPEED = 580;
const MAX_FALL_SPEED = 980;
const COYOTE_TIME = 0.1;
const JUMP_BUFFER_TIME = 0.1;

function approach(value, target, amount) {
  return value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function touchesCheese(player, cheese) {
  const closestX = Math.max(player.x, Math.min(cheese.x, player.x + PLAYER.width));
  const closestY = Math.max(player.y, Math.min(cheese.y, player.y + PLAYER.height));
  return (closestX - cheese.x) ** 2 + (closestY - cheese.y) ** 2 <= cheese.r ** 2;
}

export function createPlayer({ id = '', name = 'Visitante', color = 0 } = {}) {
  const player = {
    id,
    name,
    color,
    score: 0,
    _scoredRound: false,
  };
  return resetPlayer(player);
}

// A retry never grants a second point during the same round.
export function resetPlayer(player, world = MAP) {
  Object.assign(player, {
    x: world.spawn.x,
    y: world.spawn.y,
    vx: 0,
    vy: 0,
    facing: 1,
    grounded: false,
    hasCheese: false,
    finished: false,
    _jumpHeld: false,
    _coyote: 0,
    _jumpBuffer: 0,
  });
  return player;
}

export function startNewRoundPlayer(player, world = MAP) {
  player._scoredRound = false;
  return resetPlayer(player, world);
}

// Platforms are one-way: jump through from below, land on the upper surface.
// Server calls this with 1/60 seconds. It has no wall-clock or random inputs.
export function stepPlayer(player, input = {}, dt = 1 / 60, world = MAP) {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 20) {
    throw new RangeError('Physics dt must be greater than 0 and at most 1/20 second.');
  }
  const jump = input.jump === true;
  const jumpPressed = jump && !player._jumpHeld;
  player._jumpHeld = jump;
  if (player.finished) return player;

  player._coyote = player.grounded ? COYOTE_TIME : Math.max(0, player._coyote - dt);
  player._jumpBuffer = jumpPressed ? JUMP_BUFFER_TIME : Math.max(0, player._jumpBuffer - dt);
  const direction = Number(input.right === true) - Number(input.left === true);
  player.vx = approach(player.vx, direction * SPEED, (direction ? ACCELERATION : FRICTION) * dt);
  if (direction) player.facing = direction;

  if (player._jumpBuffer > 0 && player._coyote > 0) {
    player.vy = -JUMP_SPEED;
    player.grounded = false;
    player._coyote = 0;
    player._jumpBuffer = 0;
  }

  const previousBottom = player.y + PLAYER.height;
  player.x = Math.max(0, Math.min(world.width - PLAYER.width, player.x + player.vx * dt));
  if ((player.x === 0 && player.vx < 0) || (player.x === world.width - PLAYER.width && player.vx > 0)) {
    player.vx = 0;
  }
  player.vy = Math.min(MAX_FALL_SPEED, player.vy + GRAVITY * dt);
  player.y += player.vy * dt;
  player.grounded = false;

  if (player.vy >= 0) {
    let landingY = Infinity;
    const nextBottom = player.y + PLAYER.height;
    for (const platform of world.platforms) {
      if (
        player.x + PLAYER.width > platform.x && player.x < platform.x + platform.w &&
        previousBottom <= platform.y + 0.001 && nextBottom >= platform.y &&
        platform.y < landingY
      ) {
        landingY = platform.y;
      }
    }
    if (Number.isFinite(landingY)) {
      player.y = landingY - PLAYER.height;
      player.vy = 0;
      player.grounded = true;
      if (player._jumpBuffer > 0) {
        player.vy = -JUMP_SPEED;
        player.grounded = false;
        player._jumpBuffer = 0;
        player._coyote = 0;
      }
    }
  }

  const bounds = { x: player.x, y: player.y, w: PLAYER.width, h: PLAYER.height };
  if (player.y > world.height + 80 || world.hazards.some(hazard => overlaps(bounds, hazard))) {
    const held = player._jumpHeld;
    resetPlayer(player, world);
    player._jumpHeld = held;
    return player;
  }

  if (!player.hasCheese && touchesCheese(player, world.cheese)) player.hasCheese = true;
  if (player.hasCheese && overlaps(bounds, world.goal)) {
    player.finished = true;
    player.vx = 0;
    player.vy = 0;
    if (!player._scoredRound) {
      player.score += 1;
      player._scoredRound = true;
    }
  }
  return player;
}
