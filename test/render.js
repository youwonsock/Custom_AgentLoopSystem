const COLS = 10;
const ROWS = 20;
const BLOCK_SIZE = 30;

const TETROMINO_COLORS = {
    1: '#00f5ff',  // I
    2: '#0000ff',  // J
    3: '#ff8800',  // L
    4: '#ffff00',  // O
    5: '#00ff00',  // S
    6: '#aa00ff',  // T
    7: '#ff0000',  // Z
};

class Renderer {
    constructor(ctx1, ctx2, game1, game2) {
        this.ctx1 = ctx1;
        this.ctx2 = ctx2;
        this.game1 = game1;
        this.game2 = game2;
    }

    render() {
        this.renderBoard(this.ctx1, this.game1);
        this.renderBoard(this.ctx2, this.game2);
        this.updateUI();
    }

    renderBoard(ctx, game) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        this.drawGrid(ctx);
        this.drawBoard(ctx, game);
        if (game.currentPiece && game.active) {
            this.drawGhostPiece(ctx, game);
            this.drawCurrentPiece(ctx, game);
        }
        if (game.gameOver) {
            this.drawGameOver(ctx, game);
        }
    }

    drawGrid(ctx) {
        ctx.strokeStyle = '#1a1a3e';
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= COLS; x++) {
            ctx.beginPath();
            ctx.moveTo(x * BLOCK_SIZE, 0);
            ctx.lineTo(x * BLOCK_SIZE, ROWS * BLOCK_SIZE);
            ctx.stroke();
        }
        for (let y = 0; y <= ROWS; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * BLOCK_SIZE);
            ctx.lineTo(COLS * BLOCK_SIZE, y * BLOCK_SIZE);
            ctx.stroke();
        }
    }

    drawBoard(ctx, game) {
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                const cell = game.board[y][x];
                if (cell !== 0) {
                    this.drawBlock(ctx, x, y, TETROMINO_COLORS[cell] || '#ffffff');
                }
            }
        }
    }

    drawCurrentPiece(ctx, game) {
        if (!game.currentPiece) return;
        const piece = game.currentPiece;
        for (let y = 0; y < piece.shape.length; y++) {
            for (let x = 0; x < piece.shape[y].length; x++) {
                if (piece.shape[y][x]) {
                    const drawX = piece.x + x;
                    const drawY = piece.y + y;
                    if (drawY >= 0) {
                        this.drawBlock(ctx, drawX, drawY, piece.color);
                    }
                }
            }
        }
    }

    drawGhostPiece(ctx, game) {
        const ghost = game.getGhostPiece();
        if (!ghost) return;
        ctx.globalAlpha = 0.3;
        for (let y = 0; y < ghost.shape.length; y++) {
            for (let x = 0; x < ghost.shape[y].length; x++) {
                if (ghost.shape[y][x]) {
                    const drawX = ghost.x + x;
                    const drawY = ghost.y + y;
                    if (drawY >= 0) {
                        this.drawBlock(ctx, drawX, drawY, ghost.color);
                    }
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    drawBlock(ctx, x, y, color) {
        const px = x * BLOCK_SIZE;
        const py = y * BLOCK_SIZE;
        const padding = 1;

        ctx.fillStyle = color;
        ctx.fillRect(px + padding, py + padding, BLOCK_SIZE - 2 * padding, BLOCK_SIZE - 2 * padding);

        ctx.fillStyle = this.lightenColor(color, 40);
        ctx.fillRect(px + padding, py + padding, BLOCK_SIZE - 2 * padding, 4);

        ctx.fillStyle = this.lightenColor(color, 20);
        ctx.fillRect(px + padding, py + padding, 4, BLOCK_SIZE - 2 * padding);

        ctx.fillStyle = this.darkenColor(color, 40);
        ctx.fillRect(px + BLOCK_SIZE - padding - 4, py + padding, 4, BLOCK_SIZE - 2 * padding);

        ctx.fillStyle = this.darkenColor(color, 20);
        ctx.fillRect(px + padding, py + BLOCK_SIZE - padding - 4, BLOCK_SIZE - 2 * padding, 4);
    }

    lightenColor(color, amount) {
        const hex = color.replace('#', '');
        const r = Math.min(255, parseInt(hex.substr(0, 2), 16) + amount);
        const g = Math.min(255, parseInt(hex.substr(2, 2), 16) + amount);
        const b = Math.min(255, parseInt(hex.substr(4, 2), 16) + amount);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    darkenColor(color, amount) {
        const hex = color.replace('#', '');
        const r = Math.max(0, parseInt(hex.substr(0, 2), 16) - amount);
        const g = Math.max(0, parseInt(hex.substr(2, 2), 16) - amount);
        const b = Math.max(0, parseInt(hex.substr(4, 2), 16) - amount);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    drawGameOver(ctx, game) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(0, 0, COLS * BLOCK_SIZE, ROWS * BLOCK_SIZE);

        ctx.fillStyle = '#ff6b6b';
        ctx.font = 'bold 36px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GAME OVER', COLS * BLOCK_SIZE / 2, ROWS * BLOCK_SIZE / 2 - 30);

        ctx.fillStyle = '#eee';
        ctx.font = '18px "Courier New", monospace';
        ctx.fillText(`Score: ${game.score}`, COLS * BLOCK_SIZE / 2, ROWS * BLOCK_SIZE / 2 + 20);
    }

    updateUI() {
        document.getElementById('p1-score').textContent = `Score: ${this.game1.score}`;
        document.getElementById('p2-score').textContent = `Score: ${this.game2.score}`;

        const p1Next = document.getElementById('p1-next');
        const p2Next = document.getElementById('p2-next');

        if (this.game1.nextPieces.length > 0) {
            p1Next.innerHTML = 'Next: ' + this.game1.nextPieces[0].type;
        }
        if (this.game2.nextPieces.length > 0) {
            p2Next.innerHTML = 'Next: ' + this.game2.nextPieces[0].type;
        }

        const status = document.getElementById('status');
        const startBtn = document.getElementById('start-btn');
        const restartBtn = document.getElementById('restart-btn');

        if (this.game1.gameOver || this.game2.gameOver) {
            status.textContent = 'Game Over!';
            startBtn.style.display = 'none';
            restartBtn.style.display = 'block';
        } else if (!this.game1.active && !this.game2.active) {
            status.textContent = 'Press Start to Begin';
            startBtn.style.display = 'block';
            restartBtn.style.display = 'none';
        } else {
            status.textContent = 'Playing...';
            startBtn.style.display = 'none';
            restartBtn.style.display = 'none';
        }
    }
}