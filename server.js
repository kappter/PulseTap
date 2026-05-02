/**
 * ============================================================
 *  PulseTap  ·  Phase 1  ·  server.js
 *  Node/Express + Socket.IO backend
 * ============================================================
 *
 *  Responsibilities
 *  ─────────────────
 *  • Serve static HTML/CSS/JS for /player and /host pages.
 *  • Manage rooms: create, join, leave, list players.
 *  • Relay tap events between all sockets in a room.
 *  • Relay metronome state (BPM, signature, start/stop) from host.
 *  • Relay session settings (key, mode, quantize) from host.
 *
 *  Room data model
 *  ─────────────────
 *  rooms = Map<roomId, {
 *    hostSocketId: string | null,
 *    settings: { bpm, key, mode, quantize, running },
 *    players: Map<socketId, { playerId, playerName, role, muted, volume }>
 *  }>
 *
 *  Socket events (client → server)
 *  ─────────────────────────────────
 *  host:create       { roomId }
 *  host:join         { roomId }
 *  player:join       { roomId, playerId, playerName, role }
 *  player:tap        { roomId, playerId, playerName, role, padNumber,
 *                      timestamp, soundType, frequency, instrument }
 *  host:settings     { roomId, bpm, key, mode, quantize }
 *  host:metronome    { roomId, action: "start"|"stop", bpm, beatsPerBar,
 *                      beatUnit, startTime }
 *  host:mute         { roomId, targetPlayerId, muted }
 *  host:volume       { roomId, targetPlayerId, volume }
 *
 *  Socket events (server → client)
 *  ─────────────────────────────────
 *  room:state        Full room snapshot → host only
 *  room:settings     { bpm, key, mode, quantize, running } → all in room
 *  player:joined     { playerId, playerName, role } → host
 *  player:left       { playerId } → host
 *  tap:event         Full tap payload → all in room except sender
 *  metronome:tick    { beat, bar, totalBeats, startTime, bpm,
 *                      beatsPerBar, beatUnit } → all in room
 *  metronome:stop    {} → all in room
 *  host:mute:ack     { targetPlayerId, muted } → all in room
 *  host:volume:ack   { targetPlayerId, volume } → all in room
 *  error             { message } → sender
 * ============================================================
 */

"use strict";

const express   = require("express");
const http      = require("http");
const { Server } = require("socket.io");
const path      = require("path");

// ─────────────────────────────────────────────────────────────
//  Server setup
// ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  // Allow cross-origin requests during local dev / tunnelling
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
//  Static routes
// ─────────────────────────────────────────────────────────────
// Serve root landing page and app pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Serve /player  →  public/player/index.html
app.use("/player", express.static(path.join(__dirname, "public", "player")));
// Serve /host    →  public/host/index.html
app.use("/host",   express.static(path.join(__dirname, "public", "host")));
// Serve shared assets (CSS, fonts, icons)
app.use("/shared", express.static(path.join(__dirname, "public", "shared")));

// ─────────────────────────────────────────────────────────────
//  Room state
// ─────────────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, RoomState>
 *
 * RoomState = {
 *   hostSocketId: string | null,
 *   settings: SessionSettings,
 *   players: Map<socketId, PlayerInfo>
 * }
 */
const rooms = new Map();

/** Default session settings applied when a room is first created. */
const DEFAULT_SETTINGS = {
  bpm: 120,
  key: "C",
  mode: "major",
  quantize: "none",
  running: false,
  beatsPerBar: 4,
  beatUnit: 4
};

/**
 * Returns an existing room or creates a new one.
 * @param {string} roomId
 * @returns {object} RoomState
 */
function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostSocketId: null,
      settings:     { ...DEFAULT_SETTINGS },
      players:      new Map()
    });
  }
  return rooms.get(roomId);
}

/**
 * Serialises a room's player map into a plain array for transmission.
 * @param {Map} playerMap
 * @returns {Array}
 */
function serializePlayers(playerMap) {
  return Array.from(playerMap.values());
}

/**
 * Builds a full room snapshot suitable for sending to the host.
 * @param {string} roomId
 * @param {object} room
 * @returns {object}
 */
function roomSnapshot(roomId, room) {
  return {
    roomId,
    settings: room.settings,
    players:  serializePlayers(room.players)
  };
}

// ─────────────────────────────────────────────────────────────
//  Socket.IO connection handler
// ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[connect]  ${socket.id}`);

  // ── HOST: create or take over a room ──────────────────────
  socket.on("host:create", ({ roomId }) => {
    if (!roomId) return socket.emit("error", { message: "roomId required" });
    const room = getOrCreateRoom(roomId);
    room.hostSocketId = socket.id;
    socket.join(roomId);
    socket.join(`${roomId}:host`);   // host-only sub-room
    socket.emit("room:state", roomSnapshot(roomId, room));
    console.log(`[host:create]  room=${roomId}  host=${socket.id}`);
  });

  // ── HOST: rejoin an existing room (page reload) ───────────
  socket.on("host:join", ({ roomId }) => {
    if (!roomId) return socket.emit("error", { message: "roomId required" });
    const room = getOrCreateRoom(roomId);
    room.hostSocketId = socket.id;
    socket.join(roomId);
    socket.join(`${roomId}:host`);
    socket.emit("room:state", roomSnapshot(roomId, room));
    console.log(`[host:join]  room=${roomId}  host=${socket.id}`);
  });

  // ── PLAYER: join a room ───────────────────────────────────
  socket.on("player:join", ({ roomId, playerId, playerName, role }) => {
    if (!roomId || !playerId) {
      return socket.emit("error", { message: "roomId and playerId required" });
    }
    const room = getOrCreateRoom(roomId);
    const playerInfo = {
      socketId:   socket.id,
      playerId,
      playerName: playerName || "Player",
      role:       role       || "Melody",
      muted:      false,
      volume:     1.0,
      lastTap:    null
    };
    room.players.set(socket.id, playerInfo);
    socket.join(roomId);

    // Send current session settings to the new player
    socket.emit("room:settings", room.settings);

    // Notify the host
    io.to(`${roomId}:host`).emit("player:joined", playerInfo);

    // Send full room state snapshot to host (refreshes channel strips)
    io.to(`${roomId}:host`).emit("room:state", roomSnapshot(roomId, room));

    console.log(`[player:join]  room=${roomId}  player=${playerName}  role=${role}`);
  });

  // ── HOST: global loop transport ───────────────────────────
socket.on("host:loop-transport", ({ roomId, action, startTime }) => {
  const room = rooms.get(roomId);
  if (!room) return;

  io.to(roomId).emit("loop:transport", {
    action,
    startTime: startTime || Date.now()
  });
});

  // ── HOST: section play ───────────────────────────────────
  socket.on("host:section-play", ({ roomId, section, playerIds, startTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    // Relay to every player in the room; each player decides whether to
    // start or stop based on whether their playerId is in the list.
    io.to(roomId).emit("section:play", {
      section,
      playerIds: playerIds || [],
      startTime: startTime || Date.now()
    });
    console.log(`[section:play]  room=${roomId}  section=${section}  players=${(playerIds||[]).join(",")}`);
  });

  // ── PLAYER: tap event ─────────────────────────────────────
  socket.on("player:tap", (payload) => {
    const { roomId } = payload;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Update last-tap timestamp for the player (used for meter animation)
    const player = room.players.get(socket.id);
    if (player) {
      player.lastTap = Date.now();
      payload.playerName = player.playerName;   // authoritative name
      payload.role       = player.role;
    }

    // Relay to everyone in the room EXCEPT the sender
    // (the sender already played the sound locally)
    socket.to(roomId).emit("tap:event", payload);

    // Also send a lightweight meter-pulse to the host
    io.to(`${roomId}:host`).emit("player:tap:meter", {
      socketId: socket.id,
      playerId: payload.playerId,
      padNumber: payload.padNumber,
      role:     payload.role,
      ts:       Date.now()
    });
  });

  // ── PLAYER: loop state update ─────────────────────────────
socket.on("player:loop-state", (payload) => {
  const { roomId } = payload;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const player = room.players.get(socket.id);
  if (player) {
    payload.playerName = player.playerName;
    payload.role = player.role;
    payload.playerId = player.playerId;
  }

  io.to(`${roomId}:host`).emit("host:loop-state", {
    ...payload,
    ts: Date.now()
  });
});

  // ── HOST: update session settings ─────────────────────────
 socket.on("host:settings", ({ roomId, bpm, key, mode, quantize, beatsPerBar, beatUnit }) => {
  const room = rooms.get(roomId);
  if (!room) return;

  if (bpm !== undefined) room.settings.bpm = bpm;
  if (key !== undefined) room.settings.key = key;
  if (mode !== undefined) room.settings.mode = mode;
  if (quantize !== undefined) room.settings.quantize = quantize;
  if (beatsPerBar !== undefined) room.settings.beatsPerBar = beatsPerBar;
  if (beatUnit !== undefined) room.settings.beatUnit = beatUnit;

  io.to(roomId).emit("room:settings", room.settings);
});

  // ── HOST: metronome start ─────────────────────────────────
  socket.on("host:metronome", ({ roomId, action, bpm, beatsPerBar, beatUnit, startTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (action === "start") {
      room.settings.bpm     = bpm     || room.settings.bpm;
      room.settings.running = true;
      room.settings.beatsPerBar = beatsPerBar || room.settings.beatsPerBar || 4;
room.settings.beatUnit = beatUnit || room.settings.beatUnit || 4;
      io.to(roomId).emit("metronome:start", {
        bpm:        room.settings.bpm,
        beatsPerBar: beatsPerBar || 4,
        beatUnit:    beatUnit    || 4,
        // startTime is the server-adjusted epoch ms when beat 1 fires.
        // The host calculates this and sends it so all clients can align.
        startTime:  startTime || Date.now()
      });
    } else {
      room.settings.running = false;
      io.to(roomId).emit("metronome:stop", {});
    }
    io.to(`${roomId}:host`).emit("room:state", roomSnapshot(roomId, room));
  });

  // ── HOST: mute a player ───────────────────────────────────
  socket.on("host:mute", ({ roomId, targetPlayerId, muted }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [, p] of room.players) {
      if (p.playerId === targetPlayerId) {
        p.muted = muted;
        break;
      }
    }
    io.to(roomId).emit("host:mute:ack", { targetPlayerId, muted });
  });

  // ── HOST: set player volume ───────────────────────────────
  socket.on("host:volume", ({ roomId, targetPlayerId, volume }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [, p] of room.players) {
      if (p.playerId === targetPlayerId) {
        p.volume = volume;
        break;
      }
    }
    io.to(roomId).emit("host:volume:ack", { targetPlayerId, volume });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[disconnect]  ${socket.id}`);
    // Remove the player from any room they were in
    for (const [roomId, room] of rooms) {
      if (room.players.has(socket.id)) {
        const player = room.players.get(socket.id);
        room.players.delete(socket.id);
        io.to(`${roomId}:host`).emit("player:left",  { playerId: player.playerId });
        io.to(`${roomId}:host`).emit("room:state",   roomSnapshot(roomId, room));
        console.log(`[player:left]  room=${roomId}  player=${player.playerName}`);
      }
      // If the host disconnected, clear the host reference
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        console.log(`[host:left]  room=${roomId}`);
      }
      // Clean up empty rooms
      if (room.players.size === 0 && !room.hostSocketId) {
        rooms.delete(roomId);
        console.log(`[room:deleted]  room=${roomId}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  PulseTap Phase 1 server running`);
  console.log(`  Player  →  http://localhost:${PORT}/player`);
  console.log(`  Host    →  http://localhost:${PORT}/host\n`);
});
