const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const PORT = process.env.PORT || 10000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const TICK_MS = 33;
const WINNING_SCORE = 5;

function roomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const player of room.players) {
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(msg);
    }
  }
}
function publicState(room) {
  return {
    type: "state",
    roomId: room.id,
    status: room.status,
    scores: room.scores,
    players: room.players.map((p, i) => p ? { name: p.name, connected: !!p.ws, player: i + 1 } : null),
    game: {
      width: 640, height: 320,
      p1: { x: 20, y: room.paddles[0] },
      p2: { x: 610, y: room.paddles[1] },
      ball: { ...room.ball }
    },
    winner: room.winner
  };
}
function emitState(room) { broadcast(room, publicState(room)); }
function createRoom(ws, name) {
  let id = roomCode();
  while (rooms.has(id)) id = roomCode();
  const room = {
    id, status: "waiting", scores: [0, 0], winner: null,
    players: [{ ws, name: name || "Player 1" }, null],
    paddles: [125, 125],
    input: [0, 0],
    ball: { x: 320, y: 160, vx: 210, vy: 115, r: 7 },
    lastTick: Date.now(),
    interval: null
  };
  rooms.set(id, room);
  ws.roomId = id;
  ws.playerIndex = 0;
  send(ws, { type: "joined", roomId: id, player: 1 });
  startRoomLoop(room);
  emitState(room);
}
function joinRoom(ws, id, name) {
  const room = rooms.get(String(id || "").toUpperCase());
  if (!room) return send(ws, { type: "error", message: "Room not found. Check the code or create a new room." });
  if (room.players[1] && room.players[1].ws) {
    return send(ws, { type: "error", message: "This room already has two players." });
  }
  if (room.players[1] && !room.players[1].ws) {
    room.players[1] = { ws, name: name || "Player 2" };
  } else {
    room.players[1] = { ws, name: name || "Player 2" };
  }
  ws.roomId = room.id;
  ws.playerIndex = 1;
  send(ws, { type: "joined", roomId: room.id, player: 2 });
  emitState(room);
}
function resetBall(room, direction = 1) {
  room.ball = {
    x: 320, y: 160,
    vx: 210 * direction,
    vy: (Math.random() * 180 - 90) || 65,
    r: 7
  };
}
function resetMatch(room) {
  room.scores = [0, 0];
  room.winner = null;
  room.paddles = [125, 125];
  room.input = [0, 0];
  room.status = room.players[1] && room.players[1].ws ? "ready" : "waiting";
  resetBall(room, Math.random() < 0.5 ? -1 : 1);
}
function startRoomLoop(room) {
  if (room.interval) clearInterval(room.interval);
  room.interval = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - room.lastTick) / 1000, 0.05);
    room.lastTick = now;

    if (room.status === "playing" && room.players[0] && room.players[1]) {
      const paddleH = 70, paddleSpeed = 300, H = 320, W = 640;
      room.paddles[0] += room.input[0] * paddleSpeed * dt;
      room.paddles[1] += room.input[1] * paddleSpeed * dt;
      room.paddles[0] = Math.max(0, Math.min(H - paddleH, room.paddles[0]));
      room.paddles[1] = Math.max(0, Math.min(H - paddleH, room.paddles[1]));

      const b = room.ball;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.y - b.r <= 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
      if (b.y + b.r >= H) { b.y = H - b.r; b.vy = -Math.abs(b.vy); }

      // Player 1 paddle
      if (b.vx < 0 && b.x - b.r <= 30 && b.x + b.r >= 20 &&
          b.y + b.r >= room.paddles[0] && b.y - b.r <= room.paddles[0] + paddleH) {
        b.x = 30 + b.r;
        b.vx = Math.abs(b.vx) * 1.035;
        b.vy = ((b.y - (room.paddles[0] + paddleH / 2)) / (paddleH / 2)) * 240;
      }
      // Player 2 paddle
      if (b.vx > 0 && b.x + b.r >= 610 && b.x - b.r <= 620 &&
          b.y + b.r >= room.paddles[1] && b.y - b.r <= room.paddles[1] + paddleH) {
        b.x = 610 - b.r;
        b.vx = -Math.abs(b.vx) * 1.035;
        b.vy = ((b.y - (room.paddles[1] + paddleH / 2)) / (paddleH / 2)) * 240;
      }

      if (b.x + b.r < 0) {
        room.scores[1]++;
        if (room.scores[1] >= WINNING_SCORE) {
          room.winner = 2; room.status = "finished";
        } else resetBall(room, 1);
      } else if (b.x - b.r > W) {
        room.scores[0]++;
        if (room.scores[0] >= WINNING_SCORE) {
          room.winner = 1; room.status = "finished";
        } else resetBall(room, -1);
      }
    }
    emitState(room);
  }, TICK_MS);
}
function disconnect(ws) {
  const id = ws.roomId;
  if (!id) return;
  const room = rooms.get(id);
  if (!room) return;
  const idx = ws.playerIndex;
  if (idx === 0 || idx === 1) {
    if (room.players[idx] && room.players[idx].ws === ws) {
      room.players[idx].ws = null;
      room.input[idx] = 0;
    }
  }
  if (!room.players[0]?.ws && !room.players[1]?.ws) {
    clearInterval(room.interval);
    rooms.delete(id);
  } else {
    room.status = "waiting";
    emitState(room);
  }
}
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: "error", message: "Invalid message." }); }
    if (msg.type === "create") return createRoom(ws, String(msg.name || "Player 1").slice(0, 24));
    if (msg.type === "join") return joinRoom(ws, msg.roomId, String(msg.name || "Player 2").slice(0, 24));

    const room = rooms.get(ws.roomId);
    if (!room || (ws.playerIndex !== 0 && ws.playerIndex !== 1)) return;
    if (msg.type === "input") {
      const dir = Number(msg.dir);
      room.input[ws.playerIndex] = dir === -1 ? -1 : dir === 1 ? 1 : 0;
    } else if (msg.type === "start" && ws.playerIndex === 0) {
      if (room.players[1] && room.players[1].ws && room.status !== "finished") {
        room.status = "playing";
      }
    } else if (msg.type === "pause" && ws.playerIndex === 0) {
      if (room.status === "playing") room.status = "paused";
    } else if (msg.type === "restart" && ws.playerIndex === 0) {
      resetMatch(room);
    }
    emitState(room);
  });
  ws.on("close", () => disconnect(ws));
  ws.on("error", () => disconnect(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PPS Sparky Pong multiplayer server listening on port ${PORT}`);
});
