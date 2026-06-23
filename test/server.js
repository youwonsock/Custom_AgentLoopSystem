const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const rooms = new Map();
const nextId = (() => { let i = 0; return () => ++i; })();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function broadcast(room, sender, message) {
  const players = rooms.get(room);
  if (!players) return;
  const data = JSON.stringify(message);
  for (const p of players) {
    if (p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function broadcastTo(room, ws, message) {
  const players = rooms.get(room);
  if (!players) return;
  const data = JSON.stringify(message);
  for (const p of players) {
    if (p.ws === ws && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function broadcastOthers(room, sender, message) {
  const players = rooms.get(room);
  if (!players) return;
  const data = JSON.stringify(message);
  for (const p of players) {
    if (p.id !== sender && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function findPlayerByWs(ws) {
  for (const [room, players] of rooms) {
    for (const p of players) {
      if (p.ws === ws) return { room, player: p };
    }
  }
  return null;
}

function removePlayer(ws) {
  const entry = findPlayerByWs(ws);
  if (!entry) return;
  const { room, player } = entry;
  const players = rooms.get(room);
  if (!players) return;

  const idx = players.indexOf(player);
  if (idx !== -1) players.splice(idx, 1);

  if (players.length === 0) {
    rooms.delete(room);
  } else {
    for (const p of players) {
      if (p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({ type: 'opponent_left' }));
      }
    }
  }
}

wss.on('connection', (ws) => {
  const playerId = nextId();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        let room = msg.room;
        if (room) {
          room = room.toUpperCase();
          if (rooms.has(room) && rooms.get(room).length >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }
        } else {
          room = generateRoomCode();
          while (rooms.has(room)) {
            room = generateRoomCode();
          }
        }

        if (!rooms.has(room)) {
          rooms.set(room, []);
        }

        const players = rooms.get(room);
        const player = { id: playerId, ws, board: null, score: 0 };
        players.push(player);

        ws.send(JSON.stringify({ type: 'joined', room, playerId }));

        if (players.length === 2) {
          broadcast(room, null, { type: 'game_start' });
        }
        break;
      }

      case 'input': {
        const entry = findPlayerByWs(ws);
        if (!entry) return;
        broadcastOthers(entry.room, entry.player.id, {
          type: 'opponent_input',
          action: msg.action,
        });
        break;
      }

      case 'skill': {
        const entry = findPlayerByWs(ws);
        if (!entry) return;
        broadcastOthers(entry.room, entry.player.id, {
          type: 'opponent_skill',
          skill: msg.skill,
        });
        break;
      }

      case 'state': {
        const entry = findPlayerByWs(ws);
        if (!entry) return;
        broadcastOthers(entry.room, entry.player.id, {
          type: 'opponent_state',
          board: msg.board,
          score: msg.score,
          currentPiece: msg.currentPiece,
          position: msg.position,
        });
        break;
      }

      case 'game_over': {
        const entry = findPlayerByWs(ws);
        if (!entry) return;
        broadcastOthers(entry.room, entry.player.id, {
          type: 'opponent_game_over',
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    removePlayer(ws);
  });

  ws.on('error', () => {
    removePlayer(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
