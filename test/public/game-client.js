const CELL_SIZE = 30;
const BOARD_WIDTH = COLS * CELL_SIZE;
const BOARD_HEIGHT = ROWS * CELL_SIZE;

let ws = null;
let playerEngine = new TetrisEngine();
let opponentEngine = null;
let skillManager = new SkillManager();
let playerId = null;
let roomCode = null;
let gameStarted = false;
let gameOver = false;
let lastStateSend = 0;
let stateSendInterval = 50;

const playerCanvas = document.getElementById('player-board');
const opponentCanvas = document.getElementById('opponent-board');
const playerCtx = playerCanvas.getContext('2d');
const opponentCtx = opponentCanvas.getContext('2d');

playerCanvas.width = BOARD_WIDTH;
playerCanvas.height = BOARD_HEIGHT;
opponentCanvas.width = BOARD_WIDTH;
opponentCanvas.height = BOARD_HEIGHT;

const nextCanvas = document.getElementById('next-piece');
const nextCtx = nextCanvas.getContext('2d');
nextCanvas.width = 4 * CELL_SIZE;
nextCanvas.height = 4 * CELL_SIZE;

const scoreEl = document.getElementById('score');
const linesEl = document.getElementById('lines');
const roomCodeEl = document.getElementById('room-code');
const gameStatusEl = document.getElementById('game-status');

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const roomInput = document.getElementById('room-input').value.trim();
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomInput || null }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    gameStatusEl.textContent = 'Disconnected. Refresh to reconnect.';
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      playerId = msg.playerId;
      roomCode = msg.room;
      roomCodeEl.textContent = `Room: ${roomCode}`;
      gameStatusEl.textContent = 'Waiting for opponent...';
      break;

    case 'game_start':
      gameStarted = true;
      gameOver = false;
      playerEngine = new TetrisEngine();
      opponentEngine = null;
      skillManager = new SkillManager();
      gameStatusEl.textContent = '';
      break;

    case 'opponent_joined':
      gameStatusEl.textContent = 'Opponent connected!';
      break;

    case 'opponent_left':
      gameStarted = false;
      gameStatusEl.textContent = 'Opponent disconnected. Waiting...';
      opponentEngine = null;
      break;

    case 'opponent_state':
      if (!opponentEngine) {
        opponentEngine = new TetrisEngine();
      }
      if (msg.board) {
        opponentEngine.board = msg.board;
      }
      if (msg.score !== undefined) {
        opponentEngine.score = msg.score;
      }
      break;

    case 'opponent_skill':
      if (playerEngine && !playerEngine.gameOver) {
        const skill = SKILLS.find(s => s.id === msg.skill);
        if (skill) {
          const data = {};
          if (msg.skill === 'block_swap') {
            data.pieceName = PIECE_NAMES[Math.floor(Math.random() * PIECE_NAMES.length)];
          }
          playerEngine.applySkillEffect(msg.skill, data);
          showSkillNotification(skill.name);
        }
      }
      break;

    case 'opponent_game_over':
      gameStatusEl.textContent = 'You Win!';
      break;

    case 'error':
      gameStatusEl.textContent = msg.message;
      break;
  }
}

function showSkillNotification(name) {
  const el = document.getElementById('skill-notification');
  el.textContent = `Skill used: ${name}`;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

function sendInput(action) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', action }));
  }
}

function sendState() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !gameStarted) return;
  const state = playerEngine.getState();
  ws.send(JSON.stringify({
    type: 'state',
    board: state.board,
    score: state.score,
    currentPiece: state.currentPiece,
    position: { row: state.currentRow, col: state.currentCol },
  }));
}

function sendGameOver() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'game_over' }));
  }
}

function useSkill(skillId) {
  if (!gameStarted || gameOver || !skillManager.canUse(skillId)) return;
  skillManager.use(skillId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'skill', skill: skillId }));
  }
}

function drawBoard(ctx, board, options = {}) {
  ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const color = board[r][c];
      if (color !== EMPTY) {
        ctx.fillStyle = color;
        ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(c * CELL_SIZE + 2, r * CELL_SIZE + 2, CELL_SIZE - 5, 2);
        ctx.fillRect(c * CELL_SIZE + 2, r * CELL_SIZE + 2, 2, CELL_SIZE - 5);
      } else {
        ctx.fillStyle = '#16213e';
        ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
      }
    }
  }

  ctx.strokeStyle = '#0f3460';
  ctx.lineWidth = 0.5;
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * CELL_SIZE);
    ctx.lineTo(BOARD_WIDTH, r * CELL_SIZE);
    ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * CELL_SIZE, 0);
    ctx.lineTo(c * CELL_SIZE, BOARD_HEIGHT);
    ctx.stroke();
  }

  if (options.piece && options.shape) {
    drawPiece(ctx, options.shape, options.row, options.col, options.color, 0.3);
  }

  if (options.ghost && options.shape) {
    drawPiece(ctx, options.shape, options.ghostRow, options.col, '#ffffff', 0.1);
  }
}

function drawPiece(ctx, shape, row, col, color, alpha) {
  ctx.globalAlpha = alpha;
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      ctx.fillStyle = color;
      ctx.fillRect((col + c) * CELL_SIZE, (row + r) * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
    }
  }
  ctx.globalAlpha = 1;
}

function drawNextPiece(ctx, piece) {
  ctx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (!piece) return;

  const shape = piece.shape;
  const rows = shape.length;
  const cols = shape[0].length;
  const offsetX = (nextCanvas.width - cols * CELL_SIZE) / 2;
  const offsetY = (nextCanvas.height - rows * CELL_SIZE) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!shape[r][c]) continue;
      ctx.fillStyle = piece.color;
      ctx.fillRect(offsetX + c * CELL_SIZE, offsetY + r * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
    }
  }
}

function drawSkillBar() {
  const container = document.getElementById('skill-buttons');
  container.innerHTML = '';

  for (const skill of SKILLS) {
    const btn = document.createElement('button');
    btn.className = 'skill-btn';
    btn.dataset.skillId = skill.id;

    const overlay = document.createElement('div');
    overlay.className = 'skill-cooldown-overlay';

    const icon = document.createElement('span');
    icon.className = 'skill-icon';
    icon.textContent = skill.icon;

    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = skill.name;

    const cdText = document.createElement('span');
    cdText.className = 'skill-cooldown-text';

    btn.appendChild(overlay);
    btn.appendChild(icon);
    btn.appendChild(name);
    btn.appendChild(cdText);

    btn.addEventListener('click', () => useSkill(skill.id));
    container.appendChild(btn);
  }
}

function updateSkillBar() {
  const buttons = document.querySelectorAll('.skill-btn');
  for (const btn of buttons) {
    const skillId = btn.dataset.skillId;
    const canUse = skillManager.canUse(skillId);
    const progress = skillManager.getProgress(skillId);
    const remaining = skillManager.getRemainingCooldown(skillId);

    const overlay = btn.querySelector('.skill-cooldown-overlay');
    const cdText = btn.querySelector('.skill-cooldown-text');

    if (canUse) {
      overlay.style.height = '0%';
      cdText.textContent = '';
      btn.classList.remove('on-cooldown');
    } else {
      overlay.style.height = `${(1 - progress) * 100}%`;
      cdText.textContent = Math.ceil(remaining / 1000) + 's';
      btn.classList.add('on-cooldown');
    }
  }
}

function gameLoop(timestamp) {
  if (gameStarted && !gameOver) {
    playerEngine.update(timestamp);

    if (playerEngine.gameOver) {
      gameOver = true;
      sendGameOver();
      gameStatusEl.textContent = 'Game Over!';
    }

    const state = playerEngine.getState();

    drawBoard(playerCtx, state.board, {
      piece: state.currentPiece,
      shape: state.currentPiece ? state.currentPiece.shape : null,
      row: state.currentRow,
      col: state.currentCol,
      color: state.currentPiece ? state.currentPiece.color : null,
      ghost: true,
      ghostRow: state.ghostRow,
    });

    if (opponentEngine) {
      drawBoard(opponentCtx, opponentEngine.board);
    }

    drawNextPiece(nextCtx, state.nextPiece);
    scoreEl.textContent = `Score: ${state.score}`;
    linesEl.textContent = `Lines: ${state.lines}`;

    if (timestamp - lastStateSend > stateSendInterval) {
      sendState();
      lastStateSend = timestamp;
    }
  }

  updateSkillBar();
  requestAnimationFrame(gameLoop);
}

document.addEventListener('keydown', (e) => {
  if (!gameStarted || gameOver) return;

  switch (e.key) {
    case 'ArrowLeft':
    case 'a':
      e.preventDefault();
      if (playerEngine.moveLeft()) sendInput('left');
      break;
    case 'ArrowRight':
    case 'd':
      e.preventDefault();
      if (playerEngine.moveRight()) sendInput('right');
      break;
    case 'ArrowDown':
    case 's':
      e.preventDefault();
      if (playerEngine.moveDown()) sendInput('down');
      break;
    case 'ArrowUp':
    case 'w':
      e.preventDefault();
      if (playerEngine.rotate()) sendInput('rotate');
      break;
    case ' ':
      e.preventDefault();
      if (playerEngine.hardDrop() > 0) sendInput('drop');
      break;
  }
});

document.getElementById('join-btn').addEventListener('click', () => {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('game-container').classList.remove('hidden');
  connect();
});

document.getElementById('room-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('login-btn').click();
  }
});

drawSkillBar();
requestAnimationFrame(gameLoop);
