const COLS = 10;
const ROWS = 20;
const BLOCK_SIZE = 30;

const TETROMINOES = {
    I: { shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], color: '#00f5ff' },
    J: { shape: [[2,0,0],[2,2,2],[0,0,0]], color: '#0000ff' },
    L: { shape: [[0,0,3],[3,3,3],[0,0,0]], color: '#ff8800' },
    O: { shape: [[4,4],[4,4]], color: '#ffff00' },
    S: { shape: [[0,5,5],[5,5,0],[0,0,0]], color: '#00ff00' },
    T: { shape: [[0,6,0],[6,6,6],[0,0,0]], color: '#aa00ff' },
    Z: { shape: [[7,7,0],[0,7,7],[0,0,0]], color: '#ff0000' }
};

const TETROMINO_KEYS = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

const SRS_KICKS = {
    JLSTZ: [
        [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
        [[0,0],[1,0],[1,-1],[0,2],[1,2]],
        [[0,0],[1,0],[1,-1],[0,2],[1,2]],
        [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]]
    ],
    I: [
        [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
        [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
        [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
        [[0,0],[1,0],[-2,0],[1,-2],[-2,1]]
    ],
    O: [[[0,0]]]
};

class TetrisGame {
    constructor(playerId) {
        this.playerId = playerId;
        this.board = this.createEmptyBoard();
        this.currentPiece = null;
        this.nextPieces = [];
        this.score = 0;
        this.level = 1;
        this.linesCleared = 0;
        this.skillsRemaining = 3;
        this.active = false;
        this.gameOver = false;
        this.gravityTimer = 0;
        this.gravityInterval = 1000;
        this.lastMoveTime = 0;
        this.moveDelay = 100;
        this.lastRotateTime = 0;
        this.rotateDelay = 150;
        this.rotationState = 0;
        
        this.initializeNextPieces();
    }
    
    createEmptyBoard() {
        return Array(ROWS).fill(null).map(() => Array(COLS).fill(0));
    }
    
    initializeNextPieces() {
        this.fillNextPieces();
    }
    
    fillNextPieces() {
        while (this.nextPieces.length < 5) {
            this.nextPieces.push(this.randomTetromino());
        }
    }
    
    randomTetromino() {
        const key = TETROMINO_KEYS[Math.floor(Math.random() * TETROMINO_KEYS.length)];
        const data = TETROMINOES[key];
        return {
            type: key,
            shape: data.shape.map(row => [...row]),
            color: data.color,
            x: Math.floor(COLS / 2) - Math.ceil(data.shape[0].length / 2),
            y: 0
        };
    }
    
    spawnPiece() {
        this.currentPiece = this.nextPieces.shift();
        this.fillNextPieces();
        this.rotationState = 0;
        
        if (this.checkCollision(this.currentPiece, 0, 0)) {
            this.gameOver = true;
            this.active = false;
            return false;
        }
        return true;
    }
    
    checkCollision(piece, dx, dy, shape = null) {
        const testShape = shape || piece.shape;
        for (let y = 0; y < testShape.length; y++) {
            for (let x = 0; x < testShape[y].length; x++) {
                if (testShape[y][x]) {
                    const newX = piece.x + x + dx;
                    const newY = piece.y + y + dy;
                    
                    if (newX < 0 || newX >= COLS || newY >= ROWS) {
                        return true;
                    }
                    if (newY >= 0 && this.board[newY][newX]) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    
    rotatePiece(piece, direction = 1) {
        const isI = piece.type === 'I';
        const isO = piece.type === 'O';
        if (isO) return piece.shape;
        
        const kicks = isI ? SRS_KICKS.I : SRS_KICKS.JLSTZ;
        const newRotationState = (this.rotationState + direction + 4) % 4;
        const kickIndex = this.rotationState;
        const kickTests = kicks[kickIndex];
        
        let rotatedShape;
        if (direction === 1) {
            rotatedShape = this.rotateMatrixCW(piece.shape);
        } else {
            rotatedShape = this.rotateMatrixCCW(piece.shape);
        }
        
        for (const [kx, ky] of kickTests) {
            if (!this.checkCollision(piece, kx, ky, rotatedShape)) {
                this.rotationState = newRotationState;
                piece.x += kx;
                piece.y += ky;
                return rotatedShape;
            }
        }
        return null;
    }
    
    rotateMatrixCW(matrix) {
        const rows = matrix.length;
        const cols = matrix[0].length;
        const result = Array(cols).fill(null).map(() => Array(rows).fill(0));
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                result[x][rows - 1 - y] = matrix[y][x];
            }
        }
        return result;
    }
    
    rotateMatrixCCW(matrix) {
        const rows = matrix.length;
        const cols = matrix[0].length;
        const result = Array(cols).fill(null).map(() => Array(rows).fill(0));
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                result[cols - 1 - x][y] = matrix[y][x];
            }
        }
        return result;
    }
    
    moveLeft() {
        const now = Date.now();
        if (now - this.lastMoveTime < this.moveDelay) return;
        if (!this.checkCollision(this.currentPiece, -1, 0)) {
            this.currentPiece.x--;
            this.lastMoveTime = now;
        }
    }
    
    moveRight() {
        const now = Date.now();
        if (now - this.lastMoveTime < this.moveDelay) return;
        if (!this.checkCollision(this.currentPiece, 1, 0)) {
            this.currentPiece.x++;
            this.lastMoveTime = now;
        }
    }
    
    moveDown() {
        if (!this.checkCollision(this.currentPiece, 0, 1)) {
            this.currentPiece.y++;
            this.score += 1;
        } else {
            this.lockPiece();
        }
    }
    
    hardDrop() {
        let dropDistance = 0;
        while (!this.checkCollision(this.currentPiece, 0, 1)) {
            this.currentPiece.y++;
            dropDistance++;
        }
        this.score += dropDistance * 2;
        this.lockPiece();
    }
    
    rotate() {
        const now = Date.now();
        if (now - this.lastRotateTime < this.rotateDelay) return;
        const rotated = this.rotatePiece(this.currentPiece, 1);
        if (rotated) {
            this.currentPiece.shape = rotated;
            this.lastRotateTime = now;
        }
    }
    
    lockPiece() {
        for (let y = 0; y < this.currentPiece.shape.length; y++) {
            for (let x = 0; x < this.currentPiece.shape[y].length; x++) {
                if (this.currentPiece.shape[y][x]) {
                    const boardY = this.currentPiece.y + y;
                    const boardX = this.currentPiece.x + x;
                    if (boardY >= 0 && boardY < ROWS && boardX >= 0 && boardX < COLS) {
                        this.board[boardY][boardX] = this.currentPiece.shape[y][x];
                    }
                }
            }
        }
        this.clearLines();
        this.spawnPiece();
    }
    
    clearLines() {
        let linesCleared = 0;
        for (let y = ROWS - 1; y >= 0; y--) {
            if (this.board[y].every(cell => cell !== 0)) {
                this.board.splice(y, 1);
                this.board.unshift(Array(COLS).fill(0));
                linesCleared++;
                y++;
            }
        }
        
        if (linesCleared > 0) {
            const points = [0, 100, 300, 500, 800];
            this.score += points[linesCleared] * this.level;
            this.linesCleared += linesCleared;
            this.level = Math.floor(this.linesCleared / 10) + 1;
            this.gravityInterval = Math.max(100, 1000 - (this.level - 1) * 100);
        }
    }
    
    getGhostPiece() {
        if (!this.currentPiece) return null;
        const ghost = { ...this.currentPiece, shape: this.currentPiece.shape.map(row => [...row]) };
        while (!this.checkCollision(ghost, 0, 1)) {
            ghost.y++;
        }
        return ghost;
    }
    
    applySkill(targetPieceType) {
        const filledCells = [];
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                if (this.board[y][x] !== 0) {
                    filledCells.push({ x, y, type: this.board[y][x] });
                }
            }
        }
        
        if (filledCells.length === 0) return false;
        
        const target = filledCells[Math.floor(Math.random() * filledCells.length)];
        const availableTypes = [1,2,3,4,5,6,7].filter(t => t !== target.type);
        const newType = availableTypes[Math.floor(Math.random() * availableTypes.length)];
        
        this.board[target.y][target.x] = newType;
        return { x: target.x, y: target.y, newType };
    }
    
    update(deltaTime) {
        if (!this.active || this.gameOver) return;
        
        this.gravityTimer += deltaTime;
        if (this.gravityTimer >= this.gravityInterval) {
            this.gravityTimer = 0;
            if (!this.checkCollision(this.currentPiece, 0, 1)) {
                this.currentPiece.y++;
            } else {
                this.lockPiece();
            }
        }
    }
    
    reset() {
        this.board = this.createEmptyBoard();
        this.currentPiece = null;
        this.nextPieces = [];
        this.score = 0;
        this.level = 1;
        this.linesCleared = 0;
        this.skillsRemaining = 3;
        this.gameOver = false;
        this.gravityTimer = 0;
        this.gravityInterval = 1000;
        this.rotationState = 0;
        this.initializeNextPieces();
        this.spawnPiece();
    }
    
    getState() {
        return {
            board: this.board.map(row => [...row]),
            currentPiece: this.currentPiece ? { ...this.currentPiece, shape: this.currentPiece.shape.map(r => [...r]) } : null,
            nextPieces: this.nextPieces.map(p => ({ ...p, shape: p.shape.map(r => [...r]) })),
            score: this.score,
            level: this.level,
            linesCleared: this.linesCleared,
            skillsRemaining: this.skillsRemaining,
            gameOver: this.gameOver,
            active: this.active
        };
    }
    
    setState(state) {
        this.board = state.board.map(row => [...row]);
        this.currentPiece = state.currentPiece ? { ...state.currentPiece, shape: state.currentPiece.shape.map(r => [...r]) } : null;
        this.nextPieces = state.nextPieces.map(p => ({ ...p, shape: p.shape.map(r => [...r]) }));
        this.score = state.score;
        this.level = state.level;
        this.linesCleared = state.linesCleared;
        this.skillsRemaining = state.skillsRemaining;
        this.gameOver = state.gameOver;
        this.active = state.active;
    }
}