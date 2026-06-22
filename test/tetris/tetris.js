const COLS = 10;
const ROWS = 20;
const CELL_SIZE = 30;
const PREVIEW_CELL = 24;

const COLORS = [
  null,
  '#00f0f0',
  '#f0f000',
  '#a000f0',
  '#00f000',
  '#f00000',
  '#0000f0',
  '#f0a000',
];

const PIECES = [
  {
    type: 1,
    shape: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  },
  {
    type: 2,
    shape: [
      [2, 2],
      [2, 2],
    ],
  },
  {
    type: 3,
    shape: [
      [0, 3, 0],
      [3, 3, 3],
      [0, 0, 0],
    ],
  },
  {
    type: 4,
    shape: [
      [0, 4, 4],
      [4, 4, 0],
      [0, 0, 0],
    ],
  },
  {
    type: 5,
    shape: [
      [5, 5, 0],
      [0, 5, 5],
      [0, 0, 0],
    ],
  },
  {
    type: 6,
    shape: [
      [6, 0, 0],
      [6, 6, 6],
      [0, 0, 0],
    ],
  },
  {
    type: 7,
    shape: [
      [0, 0, 7],
      [7, 7, 7],
      [0, 0, 0],
    ],
  },
];

function rotateMatrix(matrix) {
  const n = matrix.length;
  const result = [];
  for (let y = 0; y < n; y++) {
    result[y] = [];
    for (let x = 0; x < n; x++) {
      result[y][x] = matrix[n - 1 - x][y];
    }
  }
  return result;
}

function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function randomPiece() {
  const idx = Math.floor(Math.random() * PIECES.length);
  const template = PIECES[idx];
  const shape = template.shape.map(row => [...row]);
  return {
    type: template.type,
    shape,
    x: Math.floor((COLS - template.shape[0].length) / 2),
    y: 0,
  };
}

function collision(board, piece, dx, dy, shape) {
  const s = shape || piece.shape;
  for (let y = 0; y < s.length; y++) {
    for (let x = 0; x < s[y].length; x++) {
      if (s[y][x]) {
        const bx = piece.x + x + dx;
        const by = piece.y + y + dy;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by < 0) continue;
        if (board[by][bx]) return true;
      }
    }
  }
  return false;
}

function lockPiece(board, piece) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (piece.shape[y][x]) {
        const by = piece.y + y;
        const bx = piece.x + x;
        if (by >= 0 && by < ROWS && bx >= 0 && bx < COLS) {
          board[by][bx] = piece.type;
        }
      }
    }
  }
}

function clearLines(board) {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y].every(cell => cell !== 0)) {
      board.splice(y, 1);
      board.unshift(Array(COLS).fill(0));
      cleared++;
      y++;
    }
  }
  return cleared;
}

const LINE_SCORES = [0, 100, 300, 500, 800];

const boardCanvas = document.getElementById('board');
const boardCtx = boardCanvas.getContext('2d');
const nextCanvas = document.getElementById('next');
const nextCtx = nextCanvas.getContext('2d');
const scoreEl = document.getElementById('score');
const levelEl = document.getElementById('level');
const linesEl = document.getElementById('lines');
const finalScoreEl = document.getElementById('final-score');
const gameOverOverlay = document.getElementById('game-over-overlay');
const pauseOverlay = document.getElementById('pause-overlay');

let board, currentPiece, nextPiece, score, level, lines, gameOver, paused;
let dropTimer = null;
let animationId = null;
let lastDrop = 0;

function getDropInterval() {
  return Math.max(100, 1000 - (level - 1) * 100);
}

function spawnNewPiece() {
  currentPiece = nextPiece || randomPiece();
  nextPiece = randomPiece();
  if (collision(board, currentPiece, 0, 0)) {
    gameOver = true;
    finalScoreEl.textContent = score;
    gameOverOverlay.classList.remove('hidden');
  }
}

function lockAndSpawn() {
  lockPiece(board, currentPiece);
  const c = clearLines(board);
  if (c > 0) {
    lines += c;
    score += LINE_SCORES[c] * level;
    level = Math.floor(lines / 10) + 1;
    updateUI();
  }
  spawnNewPiece();
}

function moveLeft() {
  if (gameOver || paused) return;
  if (!collision(board, currentPiece, -1, 0)) {
    currentPiece.x--;
    draw();
  }
}

function moveRight() {
  if (gameOver || paused) return;
  if (!collision(board, currentPiece, 1, 0)) {
    currentPiece.x++;
    draw();
  }
}

function moveDown() {
  if (gameOver || paused) return;
  if (!collision(board, currentPiece, 0, 1)) {
    currentPiece.y++;
    draw();
  } else {
    lockAndSpawn();
    draw();
  }
}

function rotate() {
  if (gameOver || paused) return;
  const rotated = rotateMatrix(currentPiece.shape);
  if (!collision(board, currentPiece, 0, 0, rotated)) {
    currentPiece.shape = rotated;
    draw();
  }
}

function hardDrop() {
  if (gameOver || paused) return;
  while (!collision(board, currentPiece, 0, 1)) {
    currentPiece.y++;
  }
  lockAndSpawn();
  draw();
}

function togglePause() {
  if (gameOver) return;
  paused = !paused;
  if (paused) {
    pauseOverlay.classList.remove('hidden');
  } else {
    pauseOverlay.classList.add('hidden');
    lastDrop = performance.now();
  }
}

function restart() {
  board = createBoard();
  score = 0;
  level = 1;
  lines = 0;
  gameOver = false;
  paused = false;
  gameOverOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  updateUI();
  nextPiece = randomPiece();
  spawnNewPiece();
  lastDrop = performance.now();
  if (animationId) cancelAnimationFrame(animationId);
  loop(performance.now());
}

function updateUI() {
  scoreEl.textContent = score;
  levelEl.textContent = level;
  linesEl.textContent = lines;
}

function drawCell(ctx, x, y, colorIndex, size) {
  ctx.fillStyle = COLORS[colorIndex];
  ctx.fillRect(x * size, y * size, size - 1, size - 1);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x * size, y * size, size - 1, 3);
  ctx.fillRect(x * size, y * size, 3, size - 1);
}

function draw() {
  boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x]) {
        drawCell(boardCtx, x, y, board[y][x], CELL_SIZE);
      }
    }
  }

  if (currentPiece && !gameOver) {
    for (let y = 0; y < currentPiece.shape.length; y++) {
      for (let x = 0; x < currentPiece.shape[y].length; x++) {
        if (currentPiece.shape[y][x]) {
          const px = currentPiece.x + x;
          const py = currentPiece.y + y;
          if (py >= 0) {
            drawCell(boardCtx, px, py, currentPiece.type, CELL_SIZE);
          }
        }
      }
    }
  }

  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (nextPiece) {
    const shape = nextPiece.shape;
    const offsetX = (nextCanvas.width / PREVIEW_CELL - shape[0].length) / 2;
    const offsetY = (nextCanvas.height / PREVIEW_CELL - shape.length) / 2;
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x]) {
          drawCell(nextCtx, x + offsetX, y + offsetY, nextPiece.type, PREVIEW_CELL);
        }
      }
    }
  }
}

function loop(timestamp) {
  if (gameOver) return;
  if (!paused) {
    if (timestamp - lastDrop >= getDropInterval()) {
      if (!collision(board, currentPiece, 0, 1)) {
        currentPiece.y++;
      } else {
        lockAndSpawn();
      }
      draw();
      lastDrop = timestamp;
    }
  }
  animationId = requestAnimationFrame(loop);
}

document.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); moveLeft(); break;
    case 'ArrowRight': e.preventDefault(); moveRight(); break;
    case 'ArrowDown': e.preventDefault(); moveDown(); break;
    case 'ArrowUp': e.preventDefault(); rotate(); break;
    case ' ': e.preventDefault(); hardDrop(); break;
    case 'p': case 'P': e.preventDefault(); togglePause(); break;
  }
});

document.getElementById('restart-btn').addEventListener('click', restart);
document.getElementById('restart-overlay-btn').addEventListener('click', restart);

restart();
