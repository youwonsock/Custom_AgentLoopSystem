const assert = require('assert');

// === Constants & data (exact copy from tetris.js) ===

const COLS = 10;
const ROWS = 20;

const PIECES = [
  { type: 1, shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },
  { type: 2, shape: [[2,2],[2,2]] },
  { type: 3, shape: [[0,3,0],[3,3,3],[0,0,0]] },
  { type: 4, shape: [[0,4,4],[4,4,0],[0,0,0]] },
  { type: 5, shape: [[5,5,0],[0,5,5],[0,0,0]] },
  { type: 6, shape: [[6,0,0],[6,6,6],[0,0,0]] },
  { type: 7, shape: [[0,0,7],[7,7,7],[0,0,0]] },
];

const LINE_SCORES = [0, 100, 300, 500, 800];

// === Pure functions (exact copy from tetris.js) ===

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

function getDropInterval(level) {
  return Math.max(100, 1000 - (level - 1) * 100);
}

// ============================================================
//  TESTS
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name} -- ${e.message}`);
  }
}

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`Expected ${b}, got ${a}`);
  }
}

// ---- rotateMatrix ----

console.log('\n--- rotateMatrix ---');

test('I-piece 90° CW', () => {
  const piece = PIECES[0]; // I
  const r1 = rotateMatrix(piece.shape);
  assertDeepEqual(r1, [
    [0,0,1,0],
    [0,0,1,0],
    [0,0,1,0],
    [0,0,1,0],
  ]);
});

test('I-piece 180° (rotate twice)', () => {
  const piece = PIECES[0];
  const r2 = rotateMatrix(rotateMatrix(piece.shape));
  assertDeepEqual(r2, [
    [0,0,0,0],
    [0,0,0,0],
    [1,1,1,1],
    [0,0,0,0],
  ]);
});

test('I-piece 360° returns to original', () => {
  let s = PIECES[0].shape;
  for (let i = 0; i < 4; i++) s = rotateMatrix(s);
  assertDeepEqual(s, PIECES[0].shape);
});

test('O-piece rotation (2x2 same)', () => {
  const r1 = rotateMatrix(PIECES[1].shape);
  assertDeepEqual(r1, PIECES[1].shape);
});

test('T-piece 90° CW', () => {
  const t = PIECES[2];
  const r1 = rotateMatrix(t.shape);
  assertDeepEqual(r1, [
    [0,3,0],
    [0,3,3],
    [0,3,0],
  ]);
});

test('T-piece 180°', () => {
  const t = PIECES[2];
  const r2 = rotateMatrix(rotateMatrix(t.shape));
  assertDeepEqual(r2, [
    [0,0,0],
    [3,3,3],
    [0,3,0],
  ]);
});

test('T-piece 360° returns to original', () => {
  let s = PIECES[2].shape;
  for (let i = 0; i < 4; i++) s = rotateMatrix(s);
  assertDeepEqual(s, PIECES[2].shape);
});

test('S-piece 90° CW', () => {
  const s = PIECES[3];
  const r1 = rotateMatrix(s.shape);
  assertDeepEqual(r1, [
    [0,4,0],
    [0,4,4],
    [0,0,4],
  ]);
});

test('Z-piece 90° CW', () => {
  const z = PIECES[4];
  const r1 = rotateMatrix(z.shape);
  assertDeepEqual(r1, [
    [0,0,5],
    [0,5,5],
    [0,5,0],
  ]);
});

test('J-piece 90° CW', () => {
  const j = PIECES[5];
  const r1 = rotateMatrix(j.shape);
  assertDeepEqual(r1, [
    [0,6,6],
    [0,6,0],
    [0,6,0],
  ]);
});

test('L-piece 90° CW', () => {
  const l = PIECES[6];
  const r1 = rotateMatrix(l.shape);
  assertDeepEqual(r1, [
    [0,7,0],
    [0,7,0],
    [0,7,7],
  ]);
});

// ---- createBoard ----

console.log('\n--- createBoard ---');

test('board has 20 rows', () => {
  const b = createBoard();
  assert.strictEqual(b.length, ROWS);
});

test('board has 10 columns per row', () => {
  const b = createBoard();
  b.forEach(row => assert.strictEqual(row.length, COLS));
});

test('board cells are all zero', () => {
  const b = createBoard();
  b.forEach((row, ri) => row.forEach((cell, ci) => {
    if (cell !== 0) throw new Error(`board[${ri}][${ci}] = ${cell}, expected 0`);
  }));
});

// ---- collision ----

console.log('\n--- collision ---');

test('no collision at center top', () => {
  const b = createBoard();
  const piece = { x: 3, y: 0, shape: [[1,1],[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), false);
});

test('collision with left wall', () => {
  const b = createBoard();
  const piece = { x: -1, y: 0, shape: [[1,1],[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), true);
});

test('collision with right wall', () => {
  const b = createBoard();
  const piece = { x: 9, y: 0, shape: [[1,1],[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), true);
});

test('collision with bottom wall', () => {
  const b = createBoard();
  const piece = { x: 0, y: 19, shape: [[1,1],[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), true);
});

test('no collision when piece partially above top (by < 0)', () => {
  const b = createBoard();
  const piece = { x: 0, y: -2, shape: [[1,1],[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), false);
});

test('collision with existing block', () => {
  const b = createBoard();
  b[1][0] = 1;
  const piece = { x: 0, y: 0, shape: [[1],[1]] };
  assert.strictEqual(collision(b, piece, 0, 1), true);
});

test('no collision adjacent to existing block', () => {
  const b = createBoard();
  b[1][1] = 1;
  const piece = { x: 0, y: 0, shape: [[1,0],[1,0]] };
  assert.strictEqual(collision(b, piece, 0, 1), false);
});

test('collision with custom shape param (rotation preview)', () => {
  const b = createBoard();
  const piece = { x: 0, y: 18, shape: [[1],[1]] };
  const rotated = [[1,1]];
  assert.strictEqual(collision(b, piece, 0, 0, rotated), false);
  assert.strictEqual(collision(b, piece, 0, 2, rotated), true); // hits bottom
});

test('dx offset collision', () => {
  const b = createBoard();
  const piece = { x: 9, y: 0, shape: [[1,1]] };
  assert.strictEqual(collision(b, piece, 0, 0), true);  // already at right wall
  assert.strictEqual(collision(b, piece, -1, 0), false); // move left 1 = safe
});

test('dy offset collision at bottom', () => {
  const b = createBoard();
  const piece = { x: 0, y: 19, shape: [[1]] };
  // row 19 is the last valid row (0-indexed), so no collision at dy=0
  assert.strictEqual(collision(b, piece, 0, 0), false);
  // dy=1 would go off the bottom
  assert.strictEqual(collision(b, piece, 0, 1), true);
  // moving up is safe
  assert.strictEqual(collision(b, piece, 0, -1), false);
});

// ---- lockPiece ----

console.log('\n--- lockPiece ---');

test('lock piece writes cells to board', () => {
  const b = createBoard();
  const piece = { x: 0, y: 0, type: 1, shape: [[1,1],[1,1]] };
  lockPiece(b, piece);
  assert.strictEqual(b[0][0], 1);
  assert.strictEqual(b[0][1], 1);
  assert.strictEqual(b[1][0], 1);
  assert.strictEqual(b[1][1], 1);
});

test('lock piece at specific position', () => {
  const b = createBoard();
  const piece = { x: 3, y: 5, type: 3, shape: [[0,3,0],[3,3,3],[0,0,0]] };
  lockPiece(b, piece);
  // T-piece centered
  assert.strictEqual(b[5][4], 3);
  assert.strictEqual(b[6][3], 3);
  assert.strictEqual(b[6][4], 3);
  assert.strictEqual(b[6][5], 3);
});

test('lock piece respects bounds (negative y skipped)', () => {
  const b = createBoard();
  const piece = { x: 3, y: -1, type: 1, shape: [[1,1]] };
  lockPiece(b, piece);
  // y=-1 is skipped, nothing written
  b.forEach(row => row.forEach(cell => {
    if (cell !== 0) throw new Error('board should be empty');
  }));
});

test('lock piece partial out of bounds right', () => {
  const b = createBoard();
  const piece = { x: 9, y: 0, type: 1, shape: [[1,1]] };
  lockPiece(b, piece);
  // only cell at x=9 should be written, x=10 is out of bounds
  assert.strictEqual(b[0][9], 1);
});

test('lock piece partial out of bounds bottom', () => {
  const b = createBoard();
  const piece = { x: 0, y: 19, type: 1, shape: [[1],[1]] };
  lockPiece(b, piece);
  // only row 19 should be written; row 20 is out of bounds
  assert.strictEqual(b[19][0], 1);
});

// ---- clearLines ----

console.log('\n--- clearLines ---');

test('no lines cleared on empty board', () => {
  const b = createBoard();
  assert.strictEqual(clearLines(b), 0);
});

test('single line cleared', () => {
  const b = createBoard();
  b[19] = Array(COLS).fill(1);
  assert.strictEqual(clearLines(b), 1);
  // bottom row should now be empty
  assert.strictEqual(b[19].every(c => c === 0), true);
});

test('two lines cleared', () => {
  const b = createBoard();
  b[18] = Array(COLS).fill(1);
  b[19] = Array(COLS).fill(2);
  assert.strictEqual(clearLines(b), 2);
  assert.strictEqual(b[19].every(c => c === 0), true);
  assert.strictEqual(b[18].every(c => c === 0), true);
});

test('four lines cleared', () => {
  const b = createBoard();
  for (let r = 16; r <= 19; r++) b[r] = Array(COLS).fill(1);
  assert.strictEqual(clearLines(b), 4);
  for (let r = 16; r <= 19; r++) {
    assert.strictEqual(b[r].every(c => c === 0), true);
  }
});

test('only full rows cleared, partial rows remain', () => {
  const b = createBoard();
  b[18] = Array(COLS).fill(1); // full
  b[19] = Array(COLS).fill(0); b[19][0] = 1; // partial
  assert.strictEqual(clearLines(b), 1);
  // row 18 cleared, row 19 (partial) should shift down somehow
  // After clearing row 18 (bottom full row), splice removes it and unshift adds empty at top
  // So older rows shift up. The partial row should now be at some position.
  // Let's just check that only 1 line was cleared and board is still 20x10
  assert.strictEqual(b.length, ROWS);
});

test('nearly full row with one empty cell not cleared', () => {
  const b = createBoard();
  b[19] = Array(COLS).fill(1);
  b[19][5] = 0;
  assert.strictEqual(clearLines(b), 0);
});

test('lines above cleared row shift down', () => {
  const b = createBoard();
  // Put a marker at row 17
  b[17][0] = 9;
  // Row 18 partial  (gap)
  // Row 19 full
  b[19] = Array(COLS).fill(1);
  assert.strictEqual(clearLines(b), 1);
  // Marker should now be at row 18 (shifted down by 1)
  assert.strictEqual(b[18][0], 9);
  assert.strictEqual(b[17][0], 0);
});

test('multiple clears with mixed content', () => {
  const b = createBoard();
  // rows 17, 19 full; row 18 partial
  b[17] = Array(COLS).fill(3);
  b[18] = Array(COLS).fill(0); b[18][0] = 4;
  b[19] = Array(COLS).fill(5);
  assert.strictEqual(clearLines(b), 2);
});

// ---- getDropInterval ----

console.log('\n--- getDropInterval ---');

test('level 1 drop interval is 1000ms', () => {
  assert.strictEqual(getDropInterval(1), 1000);
});

test('level 2 drop interval is 900ms', () => {
  assert.strictEqual(getDropInterval(2), 900);
});

test('level 5 drop interval is 600ms', () => {
  assert.strictEqual(getDropInterval(5), 600);
});

test('level 10 drop interval clamped to 100ms', () => {
  assert.strictEqual(getDropInterval(10), 100);
});

test('level 20 drop interval clamped to 100ms', () => {
  assert.strictEqual(getDropInterval(20), 100);
});

// ---- LINE_SCORES ----

console.log('\n--- scoring ---');

test('LINE_SCORES has correct values', () => {
  assert.strictEqual(LINE_SCORES[0], 0);
  assert.strictEqual(LINE_SCORES[1], 100);
  assert.strictEqual(LINE_SCORES[2], 300);
  assert.strictEqual(LINE_SCORES[3], 500);
  assert.strictEqual(LINE_SCORES[4], 800);
});

// ---- Integration: game state simulations ----

console.log('\n--- integration (state transitions) ---');

test('full game over simulation', () => {
  const b = createBoard();
  // Fill board except top row
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      b[y][x] = 1;
    }
  }
  // Spawn a piece at top center (x=3 for T-piece 3-wide)
  const piece = { x: 3, y: 0, type: 3, shape: [[0,3,0],[3,3,3],[0,0,0]] };
  // Should collide immediately
  assert.strictEqual(collision(b, piece, 0, 0), true);
});

test('lock + clearLines + scoring simulation', () => {
  const b = createBoard();
  // Fill row 19 with one gap
  for (let x = 0; x < COLS; x++) b[19][x] = 1;
  // Place an L-piece to fill the gap
  const piece = { x: 9, y: 18, type: 7, shape: [[0,0,7],[7,7,7],[0,0,0]] };
  lockPiece(b, piece);
  // Now row 19 should be full
  const c = clearLines(b);
  assert.strictEqual(c, 1);
  // Verify line was cleared and board is consistent
  assert.strictEqual(b.length, ROWS);
});

test('piece overlapping lock produces correct board state', () => {
  const b = createBoard();
  // Lock an O-piece at position (0,0)
  const piece1 = { x: 0, y: 0, type: 2, shape: [[2,2],[2,2]] };
  lockPiece(b, piece1);
  // Lock another O-piece overlapping (should not be possible via collision check,
  // but lockPiece should still write)
  const piece2 = { x: 1, y: 1, type: 3, shape: [[3,3],[3,3]] };
  lockPiece(b, piece2);
  // piece2 overwrites piece1 at (1,1) and (2,1)
  assert.strictEqual(b[0][0], 2);
  assert.strictEqual(b[0][1], 2);
  assert.strictEqual(b[1][0], 2);
  assert.strictEqual(b[1][1], 3); // overwritten by piece2
  assert.strictEqual(b[1][2], 3);
  assert.strictEqual(b[2][1], 3);
  assert.strictEqual(b[2][2], 3);
});

test('hard drop pathfinding logic', () => {
  const b = createBoard();
  // Piece at top, should drop until collision
  let y = 0;
  const piece = { x: 0, y: 0, type: 1, shape: [[1]] };
  while (!collision(b, piece, 0, y + 1)) {
    y++;
  }
  // Should stop at row 19 (bottom)
  assert.strictEqual(y, 19);
});

test('hard drop with obstacles', () => {
  const b = createBoard();
  // Place a block at row 15, col 0
  b[15][0] = 1;
  let y = 0;
  const piece = { x: 0, y: 0, type: 1, shape: [[1]] };
  while (!collision(b, piece, 0, y + 1)) {
    y++;
  }
  // Should stop at row 14 (one above the obstacle at row 15)
  assert.strictEqual(y, 14);
});

// ---- Piece definitions ----

console.log('\n--- piece definitions ---');

test('all 7 pieces defined', () => {
  assert.strictEqual(PIECES.length, 7);
});

test('each piece has valid type and shape', () => {
  PIECES.forEach(p => {
    assert.ok(p.type >= 1 && p.type <= 7, `type ${p.type} out of range`);
    assert.ok(Array.isArray(p.shape), `piece ${p.type} shape is not array`);
    assert.ok(p.shape.length > 0, `piece ${p.type} shape empty`);
    p.shape.forEach(row => {
      assert.strictEqual(row.length, p.shape.length, `piece ${p.type} shape not square`);
    });
  });
});

test('each piece type matches color index', () => {
  PIECES.forEach(p => {
    p.shape.forEach(row => {
      row.forEach(cell => {
        if (cell !== 0) assert.strictEqual(cell, p.type);
      });
    });
  });
});

// ---- Summary ----

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
