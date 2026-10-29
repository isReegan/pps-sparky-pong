const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PPS Sparky Pong",
    websocket: "/ws"
  });
});

// WebSocket server
const wss = new WebSocket.Server({
  noServer: true
});

// Existing rooms are held in memory.
// Replace this basic example with your original room/game logic
// if your existing server already manages multiplayer games.
const rooms = new Map();

// Log HTTP requests to help diagnose connectivity.
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// Explicit WebSocket upgrade handling.
server.on("upgrade", (req, socket, head) => {
  console.log(`[HTTP UPGRADE] Request: ${req.url}`);

  if (req.url.split("?")[0] !== "/ws") {
    console.log(`[HTTP UPGRADE] Rejected path: ${req.url}`);
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  console.log(`[WS] Client connected: ${req.url}`);

  ws.on("error", (err) => {
    console.error("[WS] Client error:", err.message);
  });

  ws.on("message", (rawMessage) => {
    const text = rawMessage.toString();
    console.log("[WS] Received:", text);

    let message;

    try {
      message = JSON.parse(text);
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Invalid JSON"
      }));
      return;
    }

    if (message.type === "spectate") {
      const roomId = String(message.roomId || "")
        .trim()
        .toUpperCase();

      if (!roomId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "Room code is required"
        }));
        return;
      }

      const room = rooms.get(roomId);

      if (!room) {
        ws.send(JSON.stringify({
          type: "error",
          message: `Room ${roomId} is not available on this server`
        }));
        return;
      }

      room.spectators.add(ws);
      ws.roomId = roomId;

      ws.send(JSON.stringify({
        type: "watching",
        roomId
      }));

      if (room.state) {
        ws.send(JSON.stringify(room.state));
      }

      console.log(`[WS] Spectator watching room: ${roomId}`);
      return;
    }

    ws.send(JSON.stringify({
      type: "error",
      message: `Unsupported message type: ${message.type || "unknown"}`
    }));
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");

    if (ws.roomId) {
      const room = rooms.get(ws.roomId);

      if (room) {
        room.spectators.delete(ws);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PPS Sparky Pong server listening on port ${PORT}`);
  console.log("WebSocket endpoint: /ws");
});