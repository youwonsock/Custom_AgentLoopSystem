const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "tetris", "tetris.js"), "utf8");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    fail++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
  }
}

function extractFn(srcCode, fnName) {
  const match = srcCode.match(new RegExp(`function ${fnName}\\b[\\s\\S]*?\\n}`));
  if (!match) throw new Error(`Cannot find function ${fnName}`);
  return match[0];
}

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

globalThis.COLS = COLS;
globalThis.ROWS = ROWS;
globalThis.PIECES = PIECES;

const rotateMatrix = new Function(`${extractFn(src, 'rotateMatrix')}; return rotateMatrix;`)();
const createBoard = new Function(`${extractFn(src, 'createBoard')}; return createBoard;`)();
const collision = new Function(`${extractFn(src, 'collision')}; return collision;`)();
const lockPiece = new Function(`${extractFn(src, 'lockPiece')}; return lockPiece;`)();
const clearLines = new Function(`${extractFn(src, 'clearLines')}; return clearLines;`)();
const randomPiece = new Function(`${extractFn(src, 'randomPiece')}; return randomPiece;`)();

function makePiece(type, shape, x, y) {
  return { type, shape: shape.map(row => [...row]), x, y };
}

function makeBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

// ====== TESTS ======

console.log("=== rotateMatrix ===");

test("rotates I piece 90 CW", () => {
  const iShape = [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]];
  const rotated = rotateMatrix(iShape);
  assert.deepStrictEqual(rotated, [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]]);
});

test("rotates O piece (unchanged)", () => {
  assert.deepStrictEqual(rotateMatrix([[2,2],[2,2]]), [[2,2],[2,2]]);
});

test("rotates T piece 90 CW", () => {
  assert.deepStrictEqual(
    rotateMatrix([[0,3,0],[3,3,3],[0,0,0]]),
    [[0,3,0],[0,3,3],[0,3,0]]
  );
});

test("rotates S piece 90 CW", () => {
  assert.deepStrictEqual(
    rotateMatrix([[0,4,4],[4,4,0],[0,0,0]]),
    [[0,4,0],[0,4,4],[0,0,4]]
  );
});

test("rotates Z piece 90 CW", () => {
  assert.deepStrictEqual(
    rotateMatrix([[5,5,0],[0,5,5],[0,0,0]]),
    [[0,0,5],[0,5,5],[0,5,0]]
  );
});

test("rotates J piece 90 CW", () => {
  assert.deepStrictEqual(
    rotateMatrix([[0,0,7],[7,7,7],[0,0,0]]),
    [[0,7,0],[0,7,0],[0,7,7]]
  );
});

test("rotates L piece 90 CW", () => {
  assert.deepStrictEqual(
    rotateMatrix([[6,0,0],[6,6,6],[0,0,0]]),
    [[0,6,6],[0,6,0],[0,6,0]]
  );
});

test("four rotations return to original", () => {
  const shapes = PIECES.map(p => p.shape.map(r => [...r]));
  for (const s of shapes) {
    let cur = s.map(r => [...r]);
    for (let i = 0; i < 4; i++) cur = rotateMatrix(cur);
    assert.deepStrictEqual(cur, s);
  }
});

test("does not mutate input", () => {
  const input = [[1,2,3],[4,5,6],[7,8,9]];
  const copy = input.map(r => [...r]);
  rotateMatrix(input);
  assert.deepStrictEqual(input, copy);
});

test("1x1 matrix", () => {
  assert.deepStrictEqual(rotateMatrix([[5]]), [[5]]);
});

console.log("\n=== createBoard ===");

test("correct dimensions", () => {
  const b = createBoard();
  assert.strictEqual(b.length, ROWS);
  assert.strictEqual(b[0].length, COLS);
});

test("all zeros", () => {
  const b = createBoard();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      assert.strictEqual(b[r][c], 0);
});

test("rows are independent arrays", () => {
  const b = createBoard();
  b[0][0] = 1;
  assert.strictEqual(b[1][0], 0);
});

console.log("\n=== collision (wall & block detection) ===");

test("no collision on empty board", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], 4, 0), 0, 0), false);
});

test("left wall", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], -1, 5), 0, 0), true);
});

test("right wall", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], 9, 5), 0, 0), true);
});

test("bottom wall", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(2, [[2,2],[2,2]], 4, 19), 0, 1), true);
});

test("above-board cells (y<0) do not trigger collision", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(6, [[6,0,0],[6,6,6],[0,0,0]], 4, -1), 0, 0), false);
});

test("collision with existing block", () => {
  const b = makeBoard();
  b[10][5] = 1;
  assert.strictEqual(collision(b, makePiece(2, [[2,2],[2,2]], 4, 9), 0, 1), true);
});

test("collision via dx offset towards blocked cell", () => {
  const b = makeBoard();
  b[5][7] = 1;
  // L piece at (4,5) has cells at cols 4,5,6 in row 6; dx=3 moves col 6 → 9 (safe), dx=4 moves col 6 → 10 (right wall safe since 10 >= COLS)
  // Actually check: shape [[6,0,0],[6,6,6],[0,0,0]] at (4,5)
  // Row 0 (y=5): cell (4,5) → with dx=3: (7,5) OK
  // Row 1 (y=6): cells at (4,6), (5,6), (6,6) → with dx=3: (7,6),(8,6),(9,6) → (9,6) is last column, OK for dx=3
  // with dx=4: (8,6),(9,6),(10,6) → (10,6) is bx=10 >= COLS → collision with right wall!
  assert.strictEqual(collision(b, makePiece(6, [[6,0,0],[6,6,6],[0,0,0]], 4, 5), 4, 0), true);
});

test("collision via dy offset towards blocked cell", () => {
  const b = makeBoard();
  // L piece at (3,5). Shape row 0 cell at (3,5), row 1 at (3,6),(4,6),(5,6).
  // With dy=0, cells at y=5,6: no collision with board[7][4].
  // With dy=2: cells at y=7,8. Row 0 at (3,7)=6, row 1 at (3,8),(4,8),(5,8)=6.
  // board[7][4]=1 is at (4,7), different from (3,7). No collision.
  b[7][4] = 1;
  assert.strictEqual(collision(b, makePiece(6, [[6,0,0],[6,6,6],[0,0,0]], 3, 5), 0, 2), false);
  // Place block at (3,7) → shape[0][0]=6 at (3,7) collides with board[7][3]=1
  b[7][3] = 1;
  assert.strictEqual(collision(b, makePiece(6, [[6,0,0],[6,6,6],[0,0,0]], 3, 5), 0, 2), true);
});

test("collision uses provided shape (for rotation checks)", () => {
  const b = makeBoard();
  const p = makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], 3, 18);
  const rotated = [[0,3,0],[0,3,3],[0,3,0]];
  // original shape at (3,18) row 2 at y=20 → bottom wall collision with dy=0? No, dy=0 means same position.
  // Row 0 of original at y=18: (4,18)=3
  // Row 1 at y=19: (3,19),(4,19),(5,19)=3 → y=19 < ROWS=20, OK
  // Row 2 at y=20: all zeros, no cells.
  assert.strictEqual(collision(b, p, 0, 0), false);
  // rotated has row 2 at y=20: (4,20)=3 → by=20 >= ROWS → collision!
  assert.strictEqual(collision(b, p, 0, 0, rotated), true);
});

test("collision at spawn (blocked start position)", () => {
  const b = makeBoard();
  b[0][4] = b[0][5] = 1;
  // T piece at (3,0): row 0 cell at (4,0) collides with board[0][4]
  assert.strictEqual(collision(b, makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], 3, 0), 0, 0), true);
});

test("I piece left wall bounds", () => {
  const b = makeBoard();
  assert.strictEqual(collision(b, makePiece(1, [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], -1, 0), 0, 0), true);
  assert.strictEqual(collision(b, makePiece(1, [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], 0, 0), 0, 0), false);
});

test("no mutation during collision check", () => {
  const b = makeBoard();
  b[5][5] = 9;
  const snapshot = JSON.stringify(b);
  collision(b, makePiece(2, [[2,2],[2,2]], 4, 4), 0, 1);
  assert.strictEqual(JSON.stringify(b), snapshot);
});

console.log("\n=== lockPiece ===");

test("locks T piece", () => {
  const b = makeBoard();
  lockPiece(b, makePiece(3, [[0,3,0],[3,3,3],[0,0,0]], 4, 0));
  assert.strictEqual(b[0][5], 3);
  assert.strictEqual(b[1][4], 3);
  assert.strictEqual(b[1][5], 3);
  assert.strictEqual(b[1][6], 3);
});

test("locks O piece at bottom", () => {
  const b = makeBoard();
  lockPiece(b, makePiece(2, [[2,2],[2,2]], 4, 18));
  assert.strictEqual(b[18][4], 2);
  assert.strictEqual(b[18][5], 2);
  assert.strictEqual(b[19][4], 2);
  assert.strictEqual(b[19][5], 2);
});

test("skips above-board cells (negative y)", () => {
  const b = makeBoard();
  lockPiece(b, makePiece(1, [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], 3, -1));
  assert.strictEqual(b[0][3], 1);
  assert.strictEqual(b[0][4], 1);
  assert.strictEqual(b[0][5], 1);
  assert.strictEqual(b[0][6], 1);
});

test("skips out-of-bounds cells (negative x)", () => {
  const b = makeBoard();
  lockPiece(b, makePiece(2, [[2,2],[2,2]], -1, 0));
  assert.strictEqual(b[0][0], 2);
});

test("overwrites cells when locking on top of existing blocks", () => {
  const b = makeBoard();
  b[5][5] = 9;
  lockPiece(b, makePiece(2, [[2,2],[2,2]], 4, 4));
  assert.strictEqual(b[5][5], 2, "lockPiece should overwrite existing cells");
  assert.strictEqual(b[4][4], 2);
});

test("accumulates from multiple locks (no overlap)", () => {
  const b = makeBoard();
  lockPiece(b, makePiece(2, [[2,2],[2,2]], 0, 18));
  lockPiece(b, makePiece(2, [[2,2],[2,2]], 2, 18));
  assert.strictEqual(b[18][0], 2);
  assert.strictEqual(b[18][1], 2);
  assert.strictEqual(b[18][2], 2);
  assert.strictEqual(b[18][3], 2);
  assert.strictEqual(b[19][0], 2);
  assert.strictEqual(b[19][1], 2);
  assert.strictEqual(b[19][2], 2);
  assert.strictEqual(b[19][3], 2);
});

console.log("\n=== clearLines ===");

test("0 lines when none full", () => {
  const b = makeBoard();
  b[19][0] = 1;
  assert.strictEqual(clearLines(b), 0);
});

test("1 full line at bottom", () => {
  const b = makeBoard();
  for (let c = 0; c < COLS; c++) b[19][c] = 5;
  assert.strictEqual(clearLines(b), 1);
  assert.ok(b[19].every(c => c === 0));
});

test("4 full lines (tetris)", () => {
  const b = makeBoard();
  for (let r = 16; r < 20; r++)
    for (let c = 0; c < COLS; c++) b[r][c] = 3;
  assert.strictEqual(clearLines(b), 4);
  for (let r = 16; r < 20; r++)
    assert.ok(b[r].every(c => c === 0), `Row ${r} not cleared`);
});

test("rows above cleared lines shift downward", () => {
  const b = makeBoard();
  b[10][3] = 9; // marker
  for (let c = 0; c < COLS; c++) b[19][c] = 1;
  const n = clearLines(b);
  assert.strictEqual(n, 1);
  assert.strictEqual(b[11][3], 9, "Marker should shift down 1 row");
  assert.strictEqual(b[10][3], 0);
});

test("no crash on empty board", () => {
  assert.strictEqual(clearLines(makeBoard()), 0);
});

test("no crash on full board", () => {
  const b = makeBoard();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) b[r][c] = 1;
  assert.strictEqual(clearLines(b), ROWS);
});

test("clears non-adjacent full lines", () => {
  const b = makeBoard();
  for (let c = 0; c < COLS; c++) {
    b[15][c] = 2;
    b[18][c] = 2;
  }
  b[16][3] = 5; // partial row, should survive somewhere
  const n = clearLines(b);
  assert.strictEqual(n, 2);
  // Two full rows were removed. The filler at (16,3) should still be present.
  const found = b.some(row => row[3] === 5);
  assert.ok(found, "Filler block should still exist on board");
});

test("clears mixed-type line", () => {
  const b = makeBoard();
  for (let c = 0; c < 4; c++) b[19][c] = 1;
  for (let c = 4; c < 8; c++) b[19][c] = 3;
  for (let c = 8; c < 10; c++) b[19][c] = 7;
  assert.strictEqual(clearLines(b), 1);
});

console.log("\n=== randomPiece ===");

test("valid piece shape", () => {
  const p = randomPiece();
  assert.ok(p.type >= 1 && p.type <= 7);
  assert.ok(Array.isArray(p.shape));
  assert.strictEqual(p.y, 0);
  assert.strictEqual(typeof p.x, "number");
});

test("centering: I piece at x=3, O piece at x=4, others at x=3", () => {
  const cents = {};
  for (let i = 0; i < 200; i++) {
    const p = randomPiece();
    if (!cents[p.type]) cents[p.type] = p.x;
  }
  assert.strictEqual(cents[1], 3);
  assert.strictEqual(cents[2], 4);
  assert.strictEqual(cents[3], 3);
  assert.strictEqual(cents[4], 3);
  assert.strictEqual(cents[5], 3);
  assert.strictEqual(cents[6], 3);
  assert.strictEqual(cents[7], 3);
});

test("generates all 7 types", () => {
  const types = new Set();
  for (let i = 0; i < 500; i++) types.add(randomPiece().type);
  assert.strictEqual(types.size, 7);
});

test("does not mutate PIECES templates", () => {
  const before = PIECES.map(p => p.shape.map(r => [...r]));
  randomPiece();
  PIECES.forEach((p, i) => {
    assert.deepStrictEqual(p.shape, before[i]);
  });
});

console.log("\n=== getDropInterval ===");

const getDropInterval = new Function("level", "return Math.max(100, 1000 - (level - 1) * 100);");

test("level 1 = 1000ms", () => assert.strictEqual(getDropInterval(1), 1000));
test("level 5 = 600ms", () => assert.strictEqual(getDropInterval(5), 600));
test("level 10 capped at 100ms", () => assert.strictEqual(getDropInterval(10), 100));
test("level 100 capped at 100ms", () => assert.strictEqual(getDropInterval(100), 100));
test("monotonically decreasing", () => {
  for (let l = 1; l < 10; l++) assert.ok(getDropInterval(l) > getDropInterval(l + 1));
});

console.log("\n=== Integration ===");

test("drop-to-bottom distance in empty board", () => {
  const b = makeBoard();
  const p = makePiece(2, [[2,2],[2,2]], 4, 0);
  let dist = 0;
  while (!collision(b, p, 0, dist + 1)) dist++;
  assert.strictEqual(dist, ROWS - 2, "2-row piece should drop to row 18");
});

test("drop-to-bottom past partial row", () => {
  const b = makeBoard();
  b[19][4] = 1;
  const p = makePiece(2, [[2,2],[2,2]], 4, 0);
  let dist = 0;
  while (!collision(b, p, 0, dist + 1)) dist++;
  // O piece (2 tall) drops to y=17 (rows 17-18). board[19][4] blocked.
  // At y=18 (dy=18), bottom row 19 collides with block at col 4.
  // Max safe dy is 17.
  assert.strictEqual(dist, 17);
});

test("line clear creates space for pieces", () => {
  const b = makeBoard();
  for (let c = 0; c < COLS; c++) b[19][c] = 1;
  b[18][0] = 1;
  const p = makePiece(2, [[2,2],[2,2]], 0, 17);
  assert.strictEqual(collision(b, p, 0, 1), true, "Blocked before clear");
  clearLines(b);
  assert.strictEqual(b[19][0], 1, "Row 18 marker shifted to row 19");
  assert.strictEqual(b[18][0], 0, "Row 18 now empty");
  // Now O piece at (0, 17) should be able to drop to (0, 17) without colliding
  assert.strictEqual(collision(b, p, 0, 0), false, "No collision after clear");
});

test("complete play cycle: spawn -> rotate -> drop -> lock -> clear", () => {
  const b = makeBoard();
  // Fill rows 14-19 to create a floor at row 13
  for (let r = 14; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) b[r][c] = 5;

  // Spawn I piece, rotate, drop
  let p = makePiece(1, [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], 3, 0);
  // Rotate vertical
  p.shape = rotateMatrix(p.shape);
  assert.deepStrictEqual(p.shape, [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]]);
  // 1-wide vertical at x=3 (col 3). Drop distance: bottom cell at shape row 3.
  // Floor starts at row 14, so max y for piece bottom is 13. dist = 13 - 0 = 10.
  let dist = 0;
  while (!collision(b, p, 0, dist + 1)) dist++;
  assert.strictEqual(dist, 10, "I piece vertical should drop to row 10");
  p.y = dist;
  lockPiece(b, p);
  // I piece vertical has cells at shape[][2] → bx = 3+2 = 5
  for (let r = 10; r < 14; r++)
    assert.strictEqual(b[r][5], 1, `I piece vertical cell at row ${r}`);
  assert.strictEqual(b[14][5], 5, "Below should remain the floor");
});

// ====== RESULTS ======

console.log(`\n=== RESULTS ===\nPass: ${pass}\nFail: ${fail}`);
if (fail > 0) process.exit(1);
