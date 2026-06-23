const assert = require('node:assert/strict');

/* ============================================================
   Extract the core pure-logic functions from test/index.html
   for unit testing in Node.js.
   ============================================================ */

// Constants
const COLS = 15;
const ROWS = 30;
const PIECE_TYPES = 7;

const BASE_SHAPES = {
  1: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  2: [[1,1],[1,1]],
  3: [[0,1,0],[1,1,1],[0,0,0]],
  4: [[0,1,1],[1,1,0],[0,0,0]],
  5: [[1,1,0],[0,1,1],[0,0,0]],
  6: [[1,0,0],[1,1,1],[0,0,0]],
  7: [[0,0,1],[1,1,1],[0,0,0]],
};

// -----------------------------------------------
// Pure functions
// -----------------------------------------------
function rotateMatrix(m) {
  const n = m.length;
  const r = [];
  for (let i = 0; i < n; i++) {
    r[i] = [];
    for (let j = 0; j < n; j++) r[i][j] = m[n - 1 - j][i];
  }
  return r;
}

function cloneBoard(b) { return b.map(row => [...row]); }

function createBoard() { return Array.from({length: ROWS}, () => Array(COLS).fill(0)); }

class BagRandomizer {
  constructor() { this.bag = []; }
  next() {
    if (this.bag.length === 0) {
      this.bag = [1,2,3,4,5,6,7];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
}

// TetrisGame extracted (no DOM / canvas usage)
class TetrisGame {
  constructor() {
    this.reset();
  }
  reset() {
    this.board = createBoard();
    this.bag = new BagRandomizer();
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.skillsRemaining = 3;
    this.gameOver = false;
    this.currentPiece = null;
    this.position = {x: 0, y: 0};
    this.rotation = 0;
    this.nextPiece = null;
    this.dropTimer = 0;
    this.dropInterval = 1000;
    this.lastMoveWasLock = false;
    this.spawnPiece();
  }
  spawnPiece() {
    if (this.nextPiece === null) this.nextPiece = this.bag.next();
    this.currentPiece = this.nextPiece;
    this.nextPiece = this.bag.next();
    this.rotation = 0;
    const shape = BASE_SHAPES[this.currentPiece];
    const w = shape[0].length;
    this.position = {x: Math.floor((COLS - w) / 2), y: 0};
    if (!this.isValid(this.currentPiece, this.position.x, this.position.y, 0)) {
      this.gameOver = true;
      this.currentPiece = null;
    }
  }
  getShape(type, rot) {
    let s = BASE_SHAPES[type].map(r => [...r]);
    for (let i = 0; i < rot; i++) s = rotateMatrix(s);
    return s;
  }
  isValid(type, px, py, rot) {
    const s = this.getShape(type, rot);
    for (let r = 0; r < s.length; r++) {
      for (let c = 0; c < s[r].length; c++) {
        if (!s[r][c]) continue;
        const bx = px + c, by = py + r;
        if (bx < 0 || bx >= COLS || by >= ROWS) return false;
        if (by < 0) continue;
        if (this.board[by][bx] !== 0) return false;
      }
    }
    return true;
  }
  lockPiece() {
    if (!this.currentPiece) return;
    const s = this.getShape(this.currentPiece, this.rotation);
    const {x, y} = this.position;
    for (let r = 0; r < s.length; r++) {
      for (let c = 0; c < s[r].length; c++) {
        if (!s[r][c]) continue;
        const by = y + r;
        if (by < 0) continue;
        if (by >= ROWS) continue;
        this.board[by][x + c] = this.currentPiece;
      }
    }
    this.clearLines();
    this.spawnPiece();
    this.lastMoveWasLock = true;
  }
  clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.board[r].every(c => c !== 0)) {
        this.board.splice(r, 1);
        this.board.unshift(Array(COLS).fill(0));
        cleared++;
        r++;
      }
    }
    if (cleared > 0) {
      const pts = [0, 100, 300, 500, 800][Math.min(cleared, 4)];
      this.score += pts * this.level;
      this.lines += cleared;
      this.level = Math.floor(this.lines / 10) + 1;
      this.dropInterval = Math.max(100, 1000 - (this.level - 1) * 80);
    }
  }
  ghostY() {
    if (!this.currentPiece) return this.position.y;
    let gy = this.position.y;
    while (this.isValid(this.currentPiece, this.position.x, gy + 1, this.rotation)) gy++;
    return gy;
  }
  moveLeft()  { if (this.currentPiece && this.isValid(this.currentPiece, this.position.x - 1, this.position.y, this.rotation)) { this.position.x--; return true; } return false; }
  moveRight() { if (this.currentPiece && this.isValid(this.currentPiece, this.position.x + 1, this.position.y, this.rotation)) { this.position.x++; return true; } return false; }
  moveDown() {
    if (!this.currentPiece) return false;
    if (this.isValid(this.currentPiece, this.position.x, this.position.y + 1, this.rotation)) {
      this.position.y++;
      return true;
    }
    this.lockPiece();
    return false;
  }
  rotatePiece() {
    if (!this.currentPiece) return false;
    const newRot = (this.rotation + 1) % 4;
    const kicks = [{dx:0,dy:0},{dx:-1,dy:0},{dx:1,dy:0},{dx:-2,dy:0},{dx:2,dy:0},{dx:0,dy:-1}];
    for (const k of kicks) {
      if (this.isValid(this.currentPiece, this.position.x + k.dx, this.position.y + k.dy, newRot)) {
        this.position.x += k.dx;
        this.position.y += k.dy;
        this.rotation = newRot;
        return true;
      }
    }
    return false;
  }
  hardDrop() {
    if (!this.currentPiece) return;
    this.position.y = this.ghostY();
    this.lockPiece();
  }
  fireSkill() {
    if (this.skillsRemaining <= 0 || this.gameOver) return false;
    this.skillsRemaining--;
    return true;
  }
  handleChangeBlock() {
    if (this.gameOver) return;
    const filled = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (this.board[r][c] !== 0) filled.push({r, c});
      }
    }
    if (filled.length === 0) return;
    const pick = filled[Math.floor(Math.random() * filled.length)];
    let newType;
    do {
      newType = Math.floor(Math.random() * PIECE_TYPES) + 1;
    } while (newType === this.board[pick.r][pick.c]);
    this.board[pick.r][pick.c] = newType;
  }
  update(dt) {
    if (this.gameOver || !this.currentPiece) return;
    this.dropTimer += dt;
    if (this.dropTimer >= this.dropInterval) {
      this.dropTimer = 0;
      if (!this.isValid(this.currentPiece, this.position.x, this.position.y + 1, this.rotation)) {
        this.lockPiece();
      } else {
        this.position.y++;
      }
    }
  }
}

/* ============================================================
   TESTS
   ============================================================ */

// ------ rotateMatrix ------
{
  const id = 'rotateMatrix — 2×2';
  const m = [[1,2],[3,4]];
  const r = rotateMatrix(m);
  assert.deepEqual(r, [[3,1],[4,2]], id);
  // verify original unmodified
  assert.deepEqual(m, [[1,2],[3,4]], id + ' — original unchanged');
}
{
  const id = 'rotateMatrix — 3×3';
  const m = [[1,2,3],[4,5,6],[7,8,9]];
  const r = rotateMatrix(m);
  assert.deepEqual(r, [[7,4,1],[8,5,2],[9,6,3]], id);
}
{
  const id = 'rotateMatrix — 4×4 identity';
  const m = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  const r = rotateMatrix(m);
  // after 4 rotations should be back
  let x = rotateMatrix(rotateMatrix(rotateMatrix(r)));
  assert.deepEqual(x, m, id);
}
{
  const id = 'rotateMatrix — 0 empty';
  assert.deepEqual(rotateMatrix([]), [], id);
}
{
  const id = 'rotateMatrix — I-piece rotation (piece type 1)';
  const s = BASE_SHAPES[1];
  const r = rotateMatrix(s);
  // I-piece rotated 90°: row becomes column
  // Original row-1 = [1,1,1,1]; rotated should have column 2 all 1s
  assert.equal(r[0][2], 1, id + ' col 2, row 0');
  assert.equal(r[1][2], 1, id + ' col 2, row 1');
  assert.equal(r[2][2], 1, id + ' col 2, row 2');
  assert.equal(r[3][2], 1, id + ' col 2, row 3');
}
console.log('PASS: rotateMatrix');

// ------ createBoard / cloneBoard ------
{
  const id = 'createBoard — dimensions';
  const b = createBoard();
  assert.equal(b.length, ROWS, id + ' rows');
  assert.equal(b[0].length, COLS, id + ' cols');
  assert.equal(b[ROWS - 1][COLS - 1], 0, id + ' cells are zero');
}
{
  const id = 'cloneBoard — deep copy';
  const b = createBoard();
  b[5][3] = 42;
  const c = cloneBoard(b);
  assert.equal(c[5][3], 42, id + ' value copied');
  c[5][3] = 99;
  assert.equal(b[5][3], 42, id + ' original unchanged');
}
console.log('PASS: createBoard / cloneBoard');

// ------ BagRandomizer ------
{
  const id = 'BagRandomizer — produces 7 unique pieces before repeating';
  const bag = new BagRandomizer();
  const set1 = new Set();
  for (let i = 0; i < 7; i++) set1.add(bag.next());
  assert.equal(set1.size, 7, id + ' first 7 are unique');
  const set2 = new Set();
  for (let i = 0; i < 7; i++) set2.add(bag.next());
  assert.equal(set2.size, 7, id + ' next 7 are unique');
}
{
  const id = 'BagRandomizer — values in 1..7';
  const bag = new BagRandomizer();
  for (let i = 0; i < 21; i++) {
    const v = bag.next();
    assert.ok(v >= 1 && v <= 7, id + ' value ' + v + ' out of range');
  }
}
console.log('PASS: BagRandomizer');

// ------ TetrisGame construction ------
{
  const id = 'TetrisGame — construction resets state';
  const g = new TetrisGame();
  assert.equal(g.gameOver, false, id);
  assert.equal(g.score, 0, id);
  assert.equal(g.lines, 0, id);
  assert.equal(g.level, 1, id);
  assert.equal(g.skillsRemaining, 3, id);
  assert.equal(g.dropInterval, 1000, id);
  assert.ok(g.currentPiece !== null, id + ' has current piece');
  assert.ok(g.nextPiece !== null, id + ' has next piece');
  assert.ok(g.currentPiece >= 1 && g.currentPiece <= 7, id + ' valid piece type');
}
console.log('PASS: TetrisGame construction');

// ------ getShape ------
{
  const id = 'getShape — piece at rotation 0 matches base';
  const g = new TetrisGame();
  for (let t = 1; t <= 7; t++) {
    const s = g.getShape(t, 0);
    assert.deepEqual(s, BASE_SHAPES[t], id + ' type ' + t);
  }
}
{
  const id = 'getShape — rotation 4 equals rotation 0';
  const g = new TetrisGame();
  for (let t = 1; t <= 7; t++) {
    assert.deepEqual(g.getShape(t, 4), g.getShape(t, 0), id + ' type ' + t);
  }
}
console.log('PASS: getShape');

// ------ isValid ------
{
  const id = 'isValid — empty board accepts piece';
  const g = new TetrisGame();
  // reset with empty board
  g.board = createBoard();
  assert.ok(g.isValid(1, 5, 0, 0), id);
}
{
  const id = 'isValid — rejects OOB left';
  const g = new TetrisGame();
  g.board = createBoard();
  assert.equal(g.isValid(2, -1, 5, 0), false, id); // O-piece (2x2) at x=-1
}
{
  const id = 'isValid — rejects OOB right';
  const g = new TetrisGame();
  g.board = createBoard();
  assert.equal(g.isValid(2, COLS - 1, 5, 0), false, id);
}
{
  const id = 'isValid — rejects OOB bottom';
  const g = new TetrisGame();
  g.board = createBoard();
  assert.equal(g.isValid(2, 5, ROWS - 1, 0), false, id);
}
{
  const id = 'isValid — allows above top (by < 0)';
  const g = new TetrisGame();
  g.board = createBoard();
  const s = g.getShape(1, 0);
  // place I piece such that some rows are above board
  assert.ok(g.isValid(1, 5, -1, 0), id);
}
{
  const id = 'isValid — blocks occupied cell';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[1][5] = 1;
  // O-piece (2x2) — blocks at (5,1) should collide
  assert.equal(g.isValid(2, 4, 0, 0), false, id);
}
console.log('PASS: isValid');

// ------ moveLeft / moveRight / moveDown ------
{
  const id = 'moveLeft — moves piece left';
  const g = new TetrisGame();
  g.board = createBoard();
  g.spawnPiece();
  const x0 = g.position.x;
  g.moveLeft();
  assert.equal(g.position.x, x0 - 1, id);
}
{
  const id = 'moveLeft — blocked by wall';
  const g = new TetrisGame();
  g.board = createBoard();
  // Force piece to left wall
  g.currentPiece = 2; // O-piece (2x2)
  g.position = {x: 0, y: 0};
  g.rotation = 0;
  assert.equal(g.moveLeft(), false, id);
  assert.equal(g.position.x, 0, id + ' position unchanged');
}
{
  const id = 'moveRight — moves piece right';
  const g = new TetrisGame();
  g.board = createBoard();
  g.spawnPiece();
  const x0 = g.position.x;
  g.moveRight();
  assert.equal(g.position.x, x0 + 1, id);
}
{
  const id = 'moveDown — gravity';
  const g = new TetrisGame();
  g.board = createBoard();
  g.spawnPiece();
  const y0 = g.position.y;
  g.moveDown();
  assert.equal(g.position.y, y0 + 1, id);
}
{
  const id = 'moveDown — locks piece at bottom';
  const g = new TetrisGame();
  g.board = createBoard();
  // Place a piece very close to the bottom
  g.currentPiece = 2; // O-piece (2x2)
  g.position = {x: 5, y: ROWS - 2};
  g.rotation = 0;
  // Now moveDown should lock it
  g.moveDown();
  assert.equal(g.board[ROWS - 2][5], 2, id + ' piece locked at bottom row');
  assert.equal(g.board[ROWS - 2][6], 2, id + ' piece locked at bottom col+1');
  assert.equal(g.board[ROWS - 1][5], 2, id + ' piece locked at very bottom');
  assert.equal(g.board[ROWS - 1][6], 2, id + ' piece locked at very bottom col+1');
}
console.log('PASS: moveLeft / moveRight / moveDown');

// ------ rotatePiece ------
{
  const id = 'rotatePiece — basic rotation';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 3; // T-piece (3x3)
  g.position = {x: 5, y: 5};
  g.rotation = 0;
  assert.ok(g.rotatePiece(), id);
  assert.equal(g.rotation, 1, id + ' rotation incremented');
}
{
  const id = 'rotatePiece — wall kick when blocked';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 1; // I-piece (4x4)
  g.position = {x: 0, y: 5};
  g.rotation = 0;
  // rotating I-piece at left wall should kick
  assert.ok(g.rotatePiece(), id + ' should succeed with kick');
}
{
  const id = 'rotatePiece — returns false when fully blocked';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 3; // T-piece
  g.position = {x: 3, y: 3};
  g.rotation = 0;
  // Fill a large area to block all kicks
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (r === 3 && c === 4) continue; // T at rot0: (3,4) is top-center
      if (r === 4 && (c === 3 || c === 4 || c === 5)) continue; // T at rot0: (4,3),(4,4),(4,5) is middle row
      g.board[r][c] = 7;
    }
  }
  assert.equal(g.rotatePiece(), false, id);
}
console.log('PASS: rotatePiece');

// ------ hardDrop & ghostY ------
{
  const id = 'ghostY — on empty board drops to bottom';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 2; // O-piece (2x2)
  g.position = {x: 5, y: 0};
  g.rotation = 0;
  const gy = g.ghostY();
  assert.equal(gy, ROWS - 2, id + ' O-piece ghost at bottom-1');
}
{
  const id = 'hardDrop — lands at ghostY and locks';
  const g = new TetrisGame();
  g.board = createBoard();
  // Fill some rows near bottom
  g.currentPiece = 5; // Z-piece (3x3)
  g.position = {x: 5, y: 0};
  g.rotation = 0;
  const gy = g.ghostY();
  g.hardDrop();
  // After lockPiece the current piece is consumed and a new piece spawns
  assert.ok(g.currentPiece !== null, id + ' new piece spawned');
}
console.log('PASS: hardDrop / ghostY');

// ------ clearLines ------
{
  const id = 'clearLines — no lines cleared on empty board';
  const g = new TetrisGame();
  g.board = createBoard();
  g.score = 0;
  g.clearLines();
  assert.equal(g.score, 0, id);
  assert.equal(g.lines, 0, id);
}
{
  const id = 'clearLines — single line cleared';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.score = 0;
  g.lines = 0;
  g.level = 1;
  g.clearLines();
  assert.equal(g.lines, 1, id);
  assert.equal(g.score, 100, id + ' 100 pts for 1 line');
  // bottom row should now be empty (new row added)
  assert.equal(g.board[ROWS - 1].every(c => c === 0), true, id + ' bottom row cleared');
}
{
  const id = 'clearLines — double line = 300 pts';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.board[ROWS - 2] = Array(COLS).fill(2);
  g.score = 0;
  g.level = 1;
  g.clearLines();
  assert.equal(g.lines, 2, id);
  assert.equal(g.score, 300, id);
}
{
  const id = 'clearLines — triple line = 500 pts';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.board[ROWS - 2] = Array(COLS).fill(2);
  g.board[ROWS - 3] = Array(COLS).fill(3);
  g.score = 0;
  g.level = 1;
  g.clearLines();
  assert.equal(g.lines, 3, id);
  assert.equal(g.score, 500, id);
}
{
  const id = 'clearLines — tetris (4 lines) = 800 pts';
  const g = new TetrisGame();
  g.board = createBoard();
  for (let r = ROWS - 4; r < ROWS; r++) g.board[r] = Array(COLS).fill(r);
  g.score = 0;
  g.level = 1;
  g.clearLines();
  assert.equal(g.lines, 4, id);
  assert.equal(g.score, 800, id);
}
{
  const id = 'clearLines — level multiplier applied';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.score = 0;
  g.level = 3;
  g.clearLines();
  assert.equal(g.score, 100 * 3, id);
}
{
  const id = 'clearLines — dropInterval decreases with level';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.lines = 9;
  g.level = Math.floor(g.lines / 10) + 1;
  g.clearLines();
  assert.equal(g.level, 2, id + ' level advanced');
  assert.equal(g.dropInterval, Math.max(100, 1000 - (2 - 1) * 80), id + ' drop interval decreased');
}
console.log('PASS: clearLines');

// ------ spawnPiece / game over ------
{
  const id = 'spawnPiece — game over when blocked';
  const g = new TetrisGame();
  g.board = createBoard();
  // Fill top of board to prevent spawning
  for (let c = 0; c < COLS; c++) g.board[0][c] = 1;
  // Force spawn at row 0 with a 2-wide piece
  g.currentPiece = null;
  g.nextPiece = 2; // O-piece (2x2)
  g.spawnPiece();
  assert.equal(g.gameOver, true, id);
  assert.equal(g.currentPiece, null, id + ' no current piece');
}
{
  const id = 'spawnPiece — places piece at center top';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = null;
  g.nextPiece = 2; // O-piece (2x2)
  g.spawnPiece();
  assert.equal(g.gameOver, false, id);
  assert.equal(g.currentPiece, 2, id);
  assert.equal(g.position.x, Math.floor((COLS - 2) / 2), id + ' centered');
  assert.equal(g.position.y, 0, id + ' at top');
}
console.log('PASS: spawnPiece / game over');

// ------ fireSkill ------
{
  const id = 'fireSkill — decrements counter and returns true';
  const g = new TetrisGame();
  g.board = createBoard();
  g.skillsRemaining = 3;
  assert.ok(g.fireSkill(), id);
  assert.equal(g.skillsRemaining, 2, id + ' counter decremented');
}
{
  const id = 'fireSkill — returns false when 0 remaining';
  const g = new TetrisGame();
  g.skillsRemaining = 0;
  assert.equal(g.fireSkill(), false, id);
}
{
  const id = 'fireSkill — returns false when game over';
  const g = new TetrisGame();
  g.skillsRemaining = 3;
  g.gameOver = true;
  assert.equal(g.fireSkill(), false, id);
}
console.log('PASS: fireSkill');

// ------ handleChangeBlock ------
{
  const id = 'handleChangeBlock — changes a filled cell';
  const g = new TetrisGame();
  g.board = createBoard();
  // Fill one cell with known type
  g.board[10][5] = 1;
  g.board[10][6] = 1;
  g.handleChangeBlock();
  // One of those two cells should have changed
  const cells = [g.board[10][5], g.board[10][6]];
  const changed = cells.filter(v => v !== 1);
  assert.ok(changed.length > 0, id + ' cell type changed');
  assert.ok(changed.every(v => v >= 2 && v <= 7), id + ' new type is different (2-7)');
}
{
  const id = 'handleChangeBlock — no-op on empty board';
  const g = new TetrisGame();
  g.board = createBoard();
  g.handleChangeBlock(); // should not throw
  assert.equal(g.board.every(row => row.every(c => c === 0)), true, id + ' board still empty');
}
{
  const id = 'handleChangeBlock — no-op when game over';
  const g = new TetrisGame();
  g.board = createBoard();
  g.board[5][5] = 3;
  g.gameOver = true;
  g.handleChangeBlock();
  assert.equal(g.board[5][5], 3, id + ' cell unchanged');
}
{
  const id = 'handleChangeBlock — ensures new type differs from original';
  // Run 50 times to verify statistical property
  const g = new TetrisGame();
  for (let iter = 0; iter < 50; iter++) {
    g.board = createBoard();
    g.board[15][7] = 1;
    g.gameOver = false;
    g.handleChangeBlock();
    assert.notEqual(g.board[15][7], 1, id + ' iter ' + iter + ': type changed from 1');
    assert.ok(g.board[15][7] >= 2 && g.board[15][7] <= 7, id + ' iter ' + iter + ': new type valid');
  }
}
console.log('PASS: handleChangeBlock');

// ------ update (auto-drop) ------
{
  const id = 'update — no-op when game over';
  const g = new TetrisGame();
  g.gameOver = true;
  const posY = g.position.y;
  g.update(2000); // large dt
  assert.equal(g.position.y, posY, id);
}
{
  const id = 'update — drops piece after dropInterval elapses';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 2;
  g.position = {x: 5, y: 0};
  g.rotation = 0;
  g.dropTimer = 0;
  g.dropInterval = 500;
  const y0 = g.position.y;
  g.update(500);
  assert.equal(g.position.y, y0 + 1, id + ' moved down');
  // Timer resets
  assert.ok(g.dropTimer < 500, id + ' timer reset');
}
{
  const id = 'update — locks piece when blocked below';
  const g = new TetrisGame();
  g.board = createBoard();
  // Fill bottom row — this will be cleared when lock triggers clearLines
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.currentPiece = 2; // O-piece 2x2
  g.position = {x: 5, y: ROWS - 3};
  g.rotation = 0;
  g.dropTimer = 0;
  g.dropInterval = 100;
  g.update(100);
  // The O-piece at y=ROWS-3 locks at rows ROWS-3, ROWS-2 (rows 27, 28)
  // Then clearLines clears full bottom row (old row 29), shifting board:
  // old[27]->new[28], old[28]->new[29]
  // So the 0-piece block 2 values end up in rows 28 and 29
  const found = [].concat(...g.board).filter(v => v === 2);
  assert.ok(found.length === 4, id + ' found ' + found.length + ' O-piece cells (expected 4)');
  // Score should be updated for the line clear (1 line = 100 pts at level 1)
  assert.equal(g.score, 100, id + ' scored 100 for line clear');
  assert.equal(g.lines, 1, id + ' 1 line cleared');
}
console.log('PASS: update');

// ------ Edge: lockPiece fills board correctly ------
{
  const id = 'lockPiece — cells written at correct positions';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 2; // O-piece 2x2
  g.position = {x: 3, y: 7};
  g.rotation = 0;
  g.lockPiece();
  assert.equal(g.board[7][3], 2, id + ' (7,3)');
  assert.equal(g.board[7][4], 2, id + ' (7,4)');
  assert.equal(g.board[8][3], 2, id + ' (8,3)');
  assert.equal(g.board[8][4], 2, id + ' (8,4)');
}
{
  const id = 'lockPiece — T-piece shape locked correctly';
  const g = new TetrisGame();
  g.board = createBoard();
  g.currentPiece = 3; // T-piece
  g.position = {x: 5, y: 5};
  g.rotation = 0;
  g.lockPiece();
  // T-piece at rotation 0:
  // [0,1,0]
  // [1,1,1]
  assert.equal(g.board[5][6], 3, id + ' top center');
  assert.equal(g.board[6][5], 3, id + ' mid left');
  assert.equal(g.board[6][6], 3, id + ' mid center');
  assert.equal(g.board[6][7], 3, id + ' mid right');
}
console.log('PASS: lockPiece');

// ------ Edge: skill counter persists ------
{
  const id = 'fireSkill — three uses then exhausted';
  const g = new TetrisGame();
  g.board = createBoard();
  g.skillsRemaining = 3;
  assert.ok(g.fireSkill(), 'use 1');
  assert.ok(g.fireSkill(), 'use 2');
  assert.ok(g.fireSkill(), 'use 3');
  assert.equal(g.fireSkill(), false, 'use 4 blocked');
  assert.equal(g.skillsRemaining, 0);
}
console.log('PASS: skill persistence');

// ------ Edge: clearLines max 4 lines = 800 points ------
{
  const id = 'clearLines — more than 4 lines still scores 800';
  const g = new TetrisGame();
  g.board = createBoard();
  for (let r = ROWS - 5; r < ROWS; r++) g.board[r] = Array(COLS).fill(1);
  g.score = 0;
  g.level = 1;
  g.clearLines();
  assert.equal(g.lines, 5, id);
  assert.equal(g.score, 800, id + ' clamped to 800');
}
console.log('PASS: max clear line scoring');

// ------ Edge: dropInterval floor 100ms ------
{
  const id = 'dropInterval — minimum 100ms';
  const g = new TetrisGame();
  g.board = createBoard();
  g.lines = 99;
  g.level = Math.floor(g.lines / 10) + 1; // level 10
  // Fill one row to trigger level-up
  g.board[ROWS - 1] = Array(COLS).fill(1);
  g.clearLines();
  assert.ok(g.dropInterval >= 100, id + ' not below 100');
}
console.log('PASS: dropInterval floor');

console.log('\n=== ALL TESTS PASSED ===');
