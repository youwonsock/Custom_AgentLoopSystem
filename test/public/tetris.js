const COLS = 10;
const ROWS = 20;
const EMPTY = 0;

const PIECES = {
  I: { shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], color: '#00f0f0' },
  O: { shape: [[1,1],[1,1]], color: '#f0f000' },
  T: { shape: [[0,1,0],[1,1,1],[0,0,0]], color: '#a000f0' },
  S: { shape: [[0,1,1],[1,1,0],[0,0,0]], color: '#00f000' },
  Z: { shape: [[1,1,0],[0,1,1],[0,0,0]], color: '#f00000' },
  J: { shape: [[1,0,0],[1,1,1],[0,0,0]], color: '#0000f0' },
  L: { shape: [[0,0,1],[1,1,1],[0,0,0]], color: '#f0a000' },
};

const PIECE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
}

function cloneBoard(board) {
  return board.map(row => [...row]);
}

function rotateMatrix(matrix) {
  const n = matrix.length;
  const result = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      result[c][n - 1 - r] = matrix[r][c];
    }
  }
  return result;
}

function checkCollision(board, shape, row, col) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const br = row + r;
      const bc = col + c;
      if (br < 0 || br >= ROWS || bc < 0 || bc >= COLS) return true;
      if (board[br][bc] !== EMPTY) return true;
    }
  }
  return false;
}

function lockPiece(board, shape, row, col, color) {
  const newBoard = cloneBoard(board);
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const br = row + r;
      const bc = col + c;
      if (br >= 0 && br < ROWS && bc >= 0 && bc < COLS) {
        newBoard[br][bc] = color;
      }
    }
  }
  return newBoard;
}

function clearLines(board) {
  let cleared = 0;
  const newBoard = board.filter(row => {
    const full = row.every(cell => cell !== EMPTY);
    if (full) cleared++;
    return !full;
  });
  while (newBoard.length < ROWS) {
    newBoard.unshift(Array(COLS).fill(EMPTY));
  }
  return { board: newBoard, lines: cleared };
}

class BagRandomizer {
  constructor() {
    this.bag = [];
  }

  next() {
    if (this.bag.length === 0) {
      this.bag = [...PIECE_NAMES];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
}

class TetrisEngine {
  constructor() {
    this.board = createBoard();
    this.score = 0;
    this.lines = 0;
    this.bag = new BagRandomizer();
    this.currentPiece = null;
    this.currentRow = 0;
    this.currentCol = 0;
    this.nextPiece = null;
    this.gameOver = false;
    this.dropInterval = 1000;
    this.lastDrop = 0;
    this.lockDelay = 500;
    this.lockTimer = 0;
    this.isLocking = false;
    this.lockMoves = 0;
    this.maxLockMoves = 15;

    this.spawnPiece();
  }

  spawnPiece() {
    const name = this.nextPiece || this.bag.next();
    this.nextPiece = this.bag.next();
    const piece = PIECES[name];
    this.currentPiece = { name, shape: piece.shape.map(r => [...r]), color: piece.color };
    this.currentCol = Math.floor((COLS - this.currentPiece.shape[0].length) / 2);
    this.currentRow = 0;

    if (checkCollision(this.board, this.currentPiece.shape, this.currentRow, this.currentCol)) {
      this.gameOver = true;
    }

    this.isLocking = false;
    this.lockTimer = 0;
    this.lockMoves = 0;
  }

  moveLeft() {
    if (!this.currentPiece || this.gameOver) return false;
    if (!checkCollision(this.board, this.currentPiece.shape, this.currentRow, this.currentCol - 1)) {
      this.currentCol--;
      if (this.isLocking) this.lockMoves++;
      return true;
    }
    return false;
  }

  moveRight() {
    if (!this.currentPiece || this.gameOver) return false;
    if (!checkCollision(this.board, this.currentPiece.shape, this.currentRow, this.currentCol + 1)) {
      this.currentCol++;
      if (this.isLocking) this.lockMoves++;
      return true;
    }
    return false;
  }

  moveDown() {
    if (!this.currentPiece || this.gameOver) return false;
    if (!checkCollision(this.board, this.currentPiece.shape, this.currentRow + 1, this.currentCol)) {
      this.currentRow++;
      return true;
    }
    return false;
  }

  hardDrop() {
    if (!this.currentPiece || this.gameOver) return 0;
    let dropped = 0;
    while (!checkCollision(this.board, this.currentPiece.shape, this.currentRow + 1, this.currentCol)) {
      this.currentRow++;
      dropped++;
    }
    this.lock();
    return dropped;
  }

  rotate() {
    if (!this.currentPiece || this.gameOver) return false;
    const rotated = rotateMatrix(this.currentPiece.shape);
    if (!checkCollision(this.board, rotated, this.currentRow, this.currentCol)) {
      this.currentPiece.shape = rotated;
      if (this.isLocking) this.lockMoves++;
      return true;
    }
    const kicks = [[0,-1],[0,1],[-1,0],[-1,-1],[-1,1]];
    for (const [dr, dc] of kicks) {
      if (!checkCollision(this.board, rotated, this.currentRow + dr, this.currentCol + dc)) {
        this.currentPiece.shape = rotated;
        this.currentRow += dr;
        this.currentCol += dc;
        if (this.isLocking) this.lockMoves++;
        return true;
      }
    }
    return false;
  }

  getGhostRow() {
    if (!this.currentPiece) return 0;
    let row = this.currentRow;
    while (!checkCollision(this.board, this.currentPiece.shape, row + 1, this.currentCol)) {
      row++;
    }
    return row;
  }

  lock() {
    if (!this.currentPiece) return;
    this.board = lockPiece(this.board, this.currentPiece.shape, this.currentRow, this.currentCol, this.currentPiece.color);
    const result = clearLines(this.board);
    this.board = result.board;
    if (result.lines > 0) {
      const lineScores = [0, 100, 300, 500, 800];
      const addScore = lineScores[result.lines] || 0;
      this.score += addScore;
      this.lines += result.lines;
    }
    this.spawnPiece();
    this.lastDrop = performance.now();
  }

  update(now) {
    if (this.gameOver) return;

    if (!this.isLocking) {
      if (checkCollision(this.board, this.currentPiece.shape, this.currentRow + 1, this.currentCol)) {
        this.isLocking = true;
        this.lockTimer = now;
        this.lockMoves = 0;
      }
    }

    if (this.isLocking) {
      if (this.lockMoves >= this.maxLockMoves) {
        this.lock();
        return;
      }
      if (!checkCollision(this.board, this.currentPiece.shape, this.currentRow + 1, this.currentCol)) {
        this.isLocking = false;
        this.lockTimer = 0;
      } else if (now - this.lockTimer >= this.lockDelay) {
        this.lock();
        return;
      }
    }

    if (now - this.lastDrop >= this.dropInterval) {
      if (!checkCollision(this.board, this.currentPiece.shape, this.currentRow + 1, this.currentCol)) {
        this.currentRow++;
        this.lastDrop = now;
      }
    }
  }

  getState() {
    return {
      board: this.board,
      score: this.score,
      lines: this.lines,
      gameOver: this.gameOver,
      currentPiece: this.currentPiece ? {
        name: this.currentPiece.name,
        shape: this.currentPiece.shape,
        color: this.currentPiece.color,
      } : null,
      currentRow: this.currentRow,
      currentCol: this.currentCol,
      ghostRow: this.getGhostRow(),
      nextPiece: this.nextPiece ? {
        name: this.nextPiece,
        shape: PIECES[this.nextPiece].shape.map(r => [...r]),
        color: PIECES[this.nextPiece].color,
      } : null,
    };
  }

  applySkillEffect(skill, data) {
    switch (skill) {
      case 'block_swap': {
        if (data.pieceName && PIECES[data.pieceName]) {
          const piece = PIECES[data.pieceName];
          this.currentPiece = {
            name: data.pieceName,
            shape: piece.shape.map(r => [...r]),
            color: piece.color,
          };
          this.currentCol = Math.floor((COLS - this.currentPiece.shape[0].length) / 2);
          this.currentRow = 0;
          if (checkCollision(this.board, this.currentPiece.shape, this.currentRow, this.currentCol)) {
            this.gameOver = true;
          }
          this.isLocking = false;
          this.lockTimer = 0;
          this.lockMoves = 0;
        }
        break;
      }
      case 'column_clear': {
        const col = Math.floor(Math.random() * COLS);
        for (let r = 0; r < ROWS; r++) {
          this.board[r][col] = EMPTY;
        }
        break;
      }
      case 'chaos': {
        const cells = [];
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (this.board[r][c] !== EMPTY) {
              cells.push({ r, c, color: this.board[r][c] });
              this.board[r][c] = EMPTY;
            }
          }
        }
        for (const cell of cells) {
          let pr, pc;
          do {
            pr = Math.floor(Math.random() * ROWS);
            pc = Math.floor(Math.random() * COLS);
          } while (this.board[pr][pc] !== EMPTY);
          this.board[pr][pc] = cell.color;
        }
        break;
      }
      case 'gravity_well': {
        for (let c = 0; c < COLS; c++) {
          let writeRow = ROWS - 1;
          for (let r = ROWS - 1; r >= 0; r--) {
            if (this.board[r][c] !== EMPTY) {
              this.board[writeRow][c] = this.board[r][c];
              writeRow--;
            }
          }
          for (let r = writeRow; r >= 0; r--) {
            this.board[r][c] = EMPTY;
          }
        }
        break;
      }
      case 'mirror': {
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < Math.floor(COLS / 2); c++) {
            const tmp = this.board[r][c];
            this.board[r][c] = this.board[r][COLS - 1 - c];
            this.board[r][COLS - 1 - c] = tmp;
          }
        }
        break;
      }
    }
  }
}
