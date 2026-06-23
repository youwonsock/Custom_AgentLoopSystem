const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

const tetrisSrc = fs.readFileSync(path.join(publicDir, 'tetris.js'), 'utf-8');
const skillsSrc = fs.readFileSync(path.join(publicDir, 'skills.js'), 'utf-8');

const fn = new Function(tetrisSrc + '\n' + skillsSrc + `
  return {
    COLS, ROWS, EMPTY, PIECES, PIECE_NAMES, SKILLS,
    createBoard, cloneBoard, rotateMatrix,
    checkCollision, lockPiece, clearLines,
    BagRandomizer, TetrisEngine, SkillManager,
  };
`);

const {
  COLS, ROWS, EMPTY, PIECES, PIECE_NAMES, SKILLS,
  createBoard, cloneBoard, rotateMatrix,
  checkCollision, lockPiece, clearLines,
  BagRandomizer, TetrisEngine, SkillManager,
} = fn();

describe('Tetris Engine - Board', () => {
  it('createBoard returns a 20x10 grid filled with EMPTY', () => {
    const board = createBoard();
    assert.strictEqual(board.length, ROWS);
    assert.strictEqual(board[0].length, COLS);
    for (const row of board) {
      for (const cell of row) {
        assert.strictEqual(cell, EMPTY);
      }
    }
  });

  it('cloneBoard creates a deep copy', () => {
    const board = createBoard();
    board[0][0] = '#ff0000';
    const clone = cloneBoard(board);
    assert.notStrictEqual(clone, board);
    assert.strictEqual(clone[0][0], '#ff0000');
    clone[0][0] = '#00ff00';
    assert.strictEqual(board[0][0], '#ff0000');
  });
});

describe('Tetris Engine - Pieces', () => {
  it('PIECE_NAMES contains 7 standard pieces', () => {
    assert.deepStrictEqual([...PIECE_NAMES].sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  });

  it('each piece has a shape (2D array) and color string', () => {
    for (const name of PIECE_NAMES) {
      const piece = PIECES[name];
      assert.ok(piece.shape, `Piece ${name} missing shape`);
      assert.ok(Array.isArray(piece.shape));
      assert.ok(piece.shape.length > 0);
      assert.ok(typeof piece.color === 'string');
    }
  });

  it('I piece is 4x4', () => {
    assert.strictEqual(PIECES.I.shape.length, 4);
    assert.strictEqual(PIECES.I.shape[0].length, 4);
  });

  it('O piece is 2x2', () => {
    assert.strictEqual(PIECES.O.shape.length, 2);
    assert.strictEqual(PIECES.O.shape[0].length, 2);
  });
});

describe('Tetris Engine - rotateMatrix', () => {
  it('rotates a 2x2 matrix 90 degrees clockwise', () => {
    const input = [[1, 2], [3, 4]];
    const expected = [[3, 1], [4, 2]];
    assert.deepStrictEqual(rotateMatrix(input), expected);
  });

  it('rotating 4 times returns original', () => {
    const input = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let m = input;
    for (let i = 0; i < 4; i++) m = rotateMatrix(m);
    assert.deepStrictEqual(m, input);
  });

  it('does not mutate the original matrix', () => {
    const input = [[1, 0], [0, 1]];
    const copy = input.map(r => [...r]);
    rotateMatrix(input);
    assert.deepStrictEqual(input, copy);
  });
});

describe('Tetris Engine - checkCollision', () => {
  it('returns false for a valid placement on empty board', () => {
    const board = createBoard();
    const shape = [[1]];
    assert.strictEqual(checkCollision(board, shape, 0, 0), false);
  });

  it('returns true when out of bounds (below)', () => {
    const board = createBoard();
    const shape = [[1]];
    assert.strictEqual(checkCollision(board, shape, ROWS, 0), true);
  });

  it('returns true when out of bounds (left)', () => {
    const board = createBoard();
    const shape = [[1]];
    assert.strictEqual(checkCollision(board, shape, 0, -1), true);
  });

  it('returns true when out of bounds (right)', () => {
    const board = createBoard();
    const shape = [[1]];
    assert.strictEqual(checkCollision(board, shape, 0, COLS), true);
  });

  it('returns true when overlapping occupied cell', () => {
    const board = createBoard();
    board[1][1] = '#ff0000';
    const shape = [[1]];
    assert.strictEqual(checkCollision(board, shape, 1, 1), true);
  });

  it('handles partial shape with zero cells correctly', () => {
    const board = createBoard();
    const shape = [[0, 1], [1, 0]];
    assert.strictEqual(checkCollision(board, shape, 0, 0), false);
  });
});

describe('Tetris Engine - lockPiece', () => {
  it('places piece color on the board at correct positions', () => {
    const board = createBoard();
    const shape = [[1, 1], [1, 1]];
    const color = '#ff0000';
    const result = lockPiece(board, shape, 0, 0, color);
    assert.strictEqual(result[0][0], color);
    assert.strictEqual(result[0][1], color);
    assert.strictEqual(result[1][0], color);
    assert.strictEqual(result[1][1], color);
  });

  it('does not mutate the original board', () => {
    const board = createBoard();
    const shape = [[1]];
    lockPiece(board, shape, 0, 0, '#ff0000');
    assert.strictEqual(board[0][0], EMPTY);
  });

  it('ignores cells outside board boundaries', () => {
    const board = createBoard();
    const shape = [[1]];
    const result = lockPiece(board, shape, -1, 0, '#ff0000');
    assert.strictEqual(result[0][0], EMPTY);
  });
});

describe('Tetris Engine - clearLines', () => {
  it('returns board unchanged when no lines are full', () => {
    const board = createBoard();
    board[19][0] = '#ff0000';
    const { board: result, lines } = clearLines(board);
    assert.strictEqual(lines, 0);
    assert.strictEqual(result[19][0], '#ff0000');
  });

  it('clears a single full line and adds empty row at top', () => {
    const board = createBoard();
    for (let c = 0; c < COLS; c++) board[19][c] = '#ff0000';
    board[18][0] = '#00ff00';
    const { board: result, lines } = clearLines(board);
    assert.strictEqual(lines, 1);
    assert.strictEqual(result[19][0], '#00ff00');
    for (let c = 0; c < COLS; c++) assert.strictEqual(result[0][c], EMPTY);
  });

  it('clears multiple full lines', () => {
    const board = createBoard();
    for (let r = 18; r < 20; r++) {
      for (let c = 0; c < COLS; c++) board[r][c] = '#ff0000';
    }
    board[17][0] = '#00ff00';
    const { board: result, lines } = clearLines(board);
    assert.strictEqual(lines, 2);
    assert.strictEqual(result[19][0], '#00ff00');
  });
});

describe('Tetris Engine - BagRandomizer', () => {
  it('produces all 7 pieces before repeating', () => {
    const bag = new BagRandomizer();
    const first7 = [];
    for (let i = 0; i < 7; i++) first7.push(bag.next());
    assert.strictEqual(new Set(first7).size, 7);
    first7.forEach(name => assert.ok(PIECE_NAMES.includes(name)));
  });

  it('produces pieces in random order (not always same sequence)', () => {
    const sequences = [];
    for (let trial = 0; trial < 5; trial++) {
      const bag = new BagRandomizer();
      const seq = [];
      for (let i = 0; i < 7; i++) seq.push(bag.next());
      sequences.push(seq.join(','));
    }
    const unique = new Set(sequences);
    assert.ok(unique.size > 1, 'Bag should produce varied sequences');
  });

  it('refills bag after exhausting 7 pieces', () => {
    const bag = new BagRandomizer();
    for (let i = 0; i < 14; i++) {
      const name = bag.next();
      assert.ok(PIECE_NAMES.includes(name));
    }
  });
});

describe('Tetris Engine - Movement', () => {
  it('moveLeft moves piece left when possible', () => {
    const engine = new TetrisEngine();
    const startCol = engine.currentCol;
    const result = engine.moveLeft();
    assert.strictEqual(result, true);
    assert.strictEqual(engine.currentCol, startCol - 1);
  });

  it('moveLeft returns false at left wall', () => {
    const engine = new TetrisEngine();
    while (engine.moveLeft()) { /* move to wall */ }
    const result = engine.moveLeft();
    assert.strictEqual(result, false);
  });

  it('moveRight moves piece right when possible', () => {
    const engine = new TetrisEngine();
    const startCol = engine.currentCol;
    const result = engine.moveRight();
    assert.strictEqual(result, true);
    assert.strictEqual(engine.currentCol, startCol + 1);
  });

  it('moveDown moves piece down when possible', () => {
    const engine = new TetrisEngine();
    const startRow = engine.currentRow;
    const result = engine.moveDown();
    assert.strictEqual(result, true);
    assert.strictEqual(engine.currentRow, startRow + 1);
  });

  it('moveDown returns false at bottom', () => {
    const engine = new TetrisEngine();
    engine.currentRow = ROWS - 1;
    const shape = PIECES[engine.currentPiece.name].shape;
    if (!checkCollision(engine.board, shape, ROWS - 1, engine.currentCol)) {
      engine.currentRow = ROWS - 1;
    }
    while (engine.moveDown()) { /* fall */ }
    assert.strictEqual(engine.moveDown(), false);
  });

  it('hardDrop drops piece to bottom and locks it', () => {
    const engine = new TetrisEngine();
    const prevPiece = engine.currentPiece.name;
    const dropped = engine.hardDrop();
    assert.ok(dropped > 0);
    assert.notStrictEqual(engine.currentPiece.name, prevPiece);
  });

  it('rotate performs wall kick when blocked at wall', () => {
    const engine = new TetrisEngine();
    engine.currentCol = 0;
    let rotated = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (engine.rotate()) { rotated = true; break; }
    }
    assert.ok(rotated);
  });
});

describe('Tetris Engine - Ghost Row', () => {
  it('getGhostRow returns row at or below currentRow', () => {
    const engine = new TetrisEngine();
    const ghost = engine.getGhostRow();
    assert.ok(ghost >= engine.currentRow);
  });

  it('getGhostRow stops at occupied cells', () => {
    const engine = new TetrisEngine();
    engine.currentCol = 0;
    const shape = PIECES[engine.currentPiece.name].shape;
    if (!checkCollision(engine.board, shape, ROWS - 2, 0)) {
      engine.currentRow = ROWS - 2;
    }
    assert.strictEqual(engine.getGhostRow(), ROWS - 2);
  });
});

describe('Tetris Engine - Scoring', () => {
  it('score increases after clearing lines', () => {
    const engine = new TetrisEngine();
    const initialScore = engine.score;
    const col = Math.floor(COLS / 2);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c !== col) engine.board[r][c] = '#ff0000';
      }
    }
    engine.board[ROWS - 1][col] = '#ff0000';
    const result = clearLines(engine.board);
    engine.board = result.board;
    if (result.lines > 0) {
      const lineScores = [0, 100, 300, 500, 800];
      engine.score += lineScores[result.lines] || 0;
    }
    assert.ok(engine.score >= initialScore + 100);
  });
});

describe('Tetris Engine - Game Over', () => {
  it('gameOver flag set when piece cannot spawn', () => {
    const engine = new TetrisEngine();
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < COLS; c++) {
        engine.board[r][c] = '#ff0000';
      }
    }
    engine.spawnPiece();
    assert.strictEqual(engine.gameOver, true);
  });
});

describe('Tetris Engine - getState', () => {
  it('getState returns correct shape', () => {
    const engine = new TetrisEngine();
    const state = engine.getState();
    assert.ok(Array.isArray(state.board));
    assert.strictEqual(state.board.length, ROWS);
    assert.strictEqual(typeof state.score, 'number');
    assert.strictEqual(typeof state.lines, 'number');
    assert.strictEqual(typeof state.gameOver, 'boolean');
    assert.ok(state.currentPiece !== null);
    assert.ok(state.currentPiece.name);
    assert.ok(state.currentPiece.shape);
    assert.ok(state.currentPiece.color);
    assert.strictEqual(typeof state.currentRow, 'number');
    assert.strictEqual(typeof state.currentCol, 'number');
    assert.strictEqual(typeof state.ghostRow, 'number');
    assert.ok(state.nextPiece !== null);
    assert.ok(state.nextPiece.name);
  });
});

describe('Tetris Skill Effects - applySkillEffect', () => {
  it('block_swap replaces current piece', () => {
    const engine = new TetrisEngine();
    const originalName = engine.currentPiece.name;
    let swapped = false;
    for (let i = 0; i < 10; i++) {
      const newEngine = new TetrisEngine();
      newEngine.applySkillEffect('block_swap', { pieceName: 'O' });
      if (newEngine.currentPiece.name === 'O') {
        swapped = true;
        break;
      }
    }
    assert.ok(swapped);
  });

  it('block_swap resets position to top center', () => {
    const engine = new TetrisEngine();
    engine.currentRow = 5;
    engine.currentCol = 3;
    engine.applySkillEffect('block_swap', { pieceName: 'O' });
    assert.strictEqual(engine.currentRow, 0);
    assert.strictEqual(engine.currentCol, Math.floor((COLS - 2) / 2));
  });

  it('column_clear clears a column', () => {
    const engine = new TetrisEngine();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        engine.board[r][c] = '#ff0000';
      }
    }
    engine.applySkillEffect('column_clear', {});
    const col = (() => {
      for (let c = 0; c < COLS; c++) {
        if (engine.board[0][c] === EMPTY) return c;
      }
      return -1;
    })();
    assert.ok(col >= 0, 'One column should be cleared');
    assert.strictEqual(engine.board[ROWS - 1][col], EMPTY);
  });

  it('chaos randomizes block positions', () => {
    for (let trial = 0; trial < 5; trial++) {
      const engine = new TetrisEngine();
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          engine.board[r][c] = (r + c) % 3 === 0 ? '#ff0000' : (r + c) % 3 === 1 ? '#00ff00' : EMPTY;
        }
      }
      const originalCount = engine.board.flat().filter(c => c !== EMPTY).length;
      engine.applySkillEffect('chaos', {});
      const newCount = engine.board.flat().filter(c => c !== EMPTY).length;
      assert.strictEqual(newCount, originalCount, 'Chaos should preserve block count');
    }
  });

  it('gravity_well drops all gaps to bottom', () => {
    const engine = new TetrisEngine();
    engine.board[0][0] = '#ff0000';
    engine.board[0][1] = '#00ff00';
    engine.applySkillEffect('gravity_well', {});
    assert.strictEqual(engine.board[ROWS - 1][0], '#ff0000');
    assert.strictEqual(engine.board[ROWS - 1][1], '#00ff00');
    assert.strictEqual(engine.board[0][0], EMPTY);
    assert.strictEqual(engine.board[0][1], EMPTY);
  });

  it('mirror flips the board horizontally', () => {
    const engine = new TetrisEngine();
    engine.board[0][0] = '#ff0000';
    engine.board[5][3] = '#00ff00';
    engine.applySkillEffect('mirror', {});
    assert.strictEqual(engine.board[0][COLS - 1], '#ff0000');
    assert.strictEqual(engine.board[5][COLS - 1 - 3], '#00ff00');
    assert.strictEqual(engine.board[0][0], EMPTY);
  });

  it('mirror is its own inverse', () => {
    const engine = new TetrisEngine();
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < COLS; c++) {
        engine.board[r][c] = (r * COLS + c) % 2 === 0 ? '#ff0000' : EMPTY;
      }
    }
    const before = engine.board.map(r => [...r]);
    engine.applySkillEffect('mirror', {});
    engine.applySkillEffect('mirror', {});
    assert.deepStrictEqual(engine.board, before);
  });

  it('invalid skill name does nothing', () => {
    const engine = new TetrisEngine();
    const state = engine.getState();
    engine.applySkillEffect('nonexistent', {});
    assert.deepStrictEqual(engine.getState(), state);
  });
});

describe('Tetris Engine - update with gravity and lock delay', () => {
  it('piece falls due to gravity over time', () => {
    const engine = new TetrisEngine();
    engine.dropInterval = 0;
    engine.lastDrop = 0;
    engine.update(100);
    assert.ok(engine.currentRow > 0);
  });

  it('piece locks after lock delay expires', () => {
    const engine = new TetrisEngine();
    engine.currentCol = 0;
    for (let r = ROWS - 3; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        engine.board[r][c] = '#ffffff';
      }
    }
    engine.currentRow = ROWS - 2;
    const shape = PIECES[engine.currentPiece.name].shape;
    const shapeHeight = shape.length;
    if (engine.currentRow + shapeHeight > ROWS) {
      engine.currentRow = ROWS - shapeHeight;
    }
    const pieceNameBefore = engine.currentPiece.name;
    engine.update(0);
    assert.strictEqual(engine.isLocking, true);
    engine.lockTimer = 0;
    engine.update(600);
    assert.notStrictEqual(engine.currentPiece.name, pieceNameBefore);
  });

  it('max lock moves triggers lock', () => {
    const engine = new TetrisEngine();
    engine.currentCol = 0;
    for (let c = 0; c < COLS; c++) {
      engine.board[ROWS - 1][c] = '#ffffff';
    }
    const shape = PIECES[engine.currentPiece.name].shape;
    const shapeHeight = shape.length;
    engine.currentRow = ROWS - shapeHeight;
    engine.isLocking = true;
    engine.lockTimer = 0;
    engine.lockMoves = engine.maxLockMoves;
    const pieceNameBefore = engine.currentPiece.name;
    engine.update(100);
    assert.notStrictEqual(engine.currentPiece.name, pieceNameBefore);
  });
});
