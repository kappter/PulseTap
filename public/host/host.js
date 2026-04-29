/**
 * ============================================================
 *  PulseTap  ·  Phase 1  ·  host.js
 * ============================================================
 *
 *  The host page acts as the DAW-style master board.
 *  It does NOT play audio itself (Phase 1). Instead it:
 *    • Creates / manages the room via Socket.IO
 *    • Displays connected players as channel strips
 *    • Broadcasts session settings (key, mode, BPM, quantize)
 *    • Starts / stops the shared metronome
 *    • Animates per-channel VU meters on tap events
 *    • Provides mute and volume controls per player
 * ============================================================
 */

"use strict";

// ─────────────────────────────────────────────────────────────
//  DOM references
// ─────────────────────────────────────────────────────────────
const setupScreen    = document.getElementById("setupScreen");
const mixerScreen    = document.getElementById("mixerScreen");
const roomCodeInput  = document.getElementById("roomCodeInput");
const genRoomBtn     = document.getElementById("genRoomBtn");
const openRoomBtn    = document.getElementById("openRoomBtn");
const hostSetupError = document.getElementById("hostSetupError");
const roomDisplay    = document.getElementById("roomDisplay");
const copyRoomBtn    = document.getElementById("copyRoomBtn");
const hostConnDot    = document.getElementById("hostConnDot");
const hostConnLabel  = document.getElementById("hostConnLabel");

// Transport
const bpmInput       = document.getElementById("bpmInput");
const bpmDown        = document.getElementById("bpmDown");
const bpmUp          = document.getElementById("bpmUp");
const beatsPerBarSel = document.getElementById("beatsPerBar");
const beatUnitSel    = document.getElementById("beatUnit");
const keySelect      = document.getElementById("keySelect");
const modeSelect     = document.getElementById("modeSelect");
const quantizeSelect = document.getElementById("quantizeSelect");
const startStopBtn   = document.getElementById("startStopBtn");
const recordBtn      = document.getElementById("recordBtn");

// Mixer
const channelStrips  = document.getElementById("channelStrips");
const emptyState     = document.getElementById("emptyState");
const emptyRoomCode  = document.getElementById("emptyRoomCode");
const hostBeatBar    = document.getElementById("hostBeatBar");
const hostLog        = document.getElementById("hostLog");

let hostLoopMirrorAnimationId = null;
// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────
let currentRoom   = null;
let isRunning     = false;
let metroBeat     = 0;
let metroTimer    = null;
let metroBeatsPerBar = 4;

/** Map<playerId, { playerName, role, socketId, muted, volume, stripEl, meterEl, meterTimer }> */
const players = new Map();

// ─────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────
function log(msg, kind = "system") {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const line = document.createElement("span");
  line.className = `log-line log-${kind}`;
  line.textContent = `[${time}] ${msg}  `;
  hostLog.insertBefore(line, hostLog.firstChild);
  while (hostLog.children.length > 40) hostLog.removeChild(hostLog.lastChild);
}

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  hostConnDot.className   = "conn-dot connected";
  hostConnLabel.textContent = "Connected";
  // Re-join room on reconnect
  if (currentRoom) socket.emit("host:join", { roomId: currentRoom });
});

socket.on("disconnect", () => {
  hostConnDot.className   = "conn-dot disconnected";
  hostConnLabel.textContent = "Reconnecting…";
});

/** Full room snapshot — rebuild all channel strips */
socket.on("room:state", (state) => {
  // Sync settings controls
  if (state.settings) {
    bpmInput.value          = state.settings.bpm      || 120;
    keySelect.value         = state.settings.key      || "C";
    modeSelect.value        = state.settings.mode     || "major";
    quantizeSelect.value    = state.settings.quantize || "none";
    isRunning               = state.settings.running  || false;
    updateStartStopBtn();
  }
  // Rebuild strips from player list
  state.players.forEach(p => ensureStrip(p));
  // Remove strips for players no longer in room
  for (const [pid] of players) {
    if (!state.players.find(p => p.playerId === pid)) removeStrip(pid);
  }
  refreshEmptyState();
});

/** A new player joined */
socket.on("player:joined", (p) => {
  ensureStrip(p);
  refreshEmptyState();
  log(`${p.playerName} joined as ${p.role}`, "remote");
});

/** A player left */
socket.on("player:left", ({ playerId }) => {
  removeStrip(playerId);
  refreshEmptyState();
  log(`Player left`, "system");
});

/** Meter pulse from a player tap */
socket.on("player:tap:meter", ({ playerId, role, padNumber }) => {
  const p = players.get(playerId);
  if (!p || !p.meterEl) return;
  pulseMeter(p.meterEl, role);
  log(`${p.playerName} · pad ${padNumber + 1}`, "remote");
});

// ─────────────────────────────────────────────────────────────
//  Room setup
// ─────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

genRoomBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  roomCodeInput.value = generateRoomCode();
});

openRoomBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const code = roomCodeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) { hostSetupError.textContent = "Enter a room code."; return; }
  hostSetupError.textContent = "";
  currentRoom = code;

  socket.emit("host:create", { roomId: code });

  roomDisplay.textContent  = code;
  emptyRoomCode.textContent = code;

  setupScreen.classList.add("hidden");
  mixerScreen.classList.remove("hidden");
  log(`Room "${code}" opened`, "system");
});

copyRoomBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(currentRoom).then(() => log("Room code copied", "system"));
  }
});

// ─────────────────────────────────────────────────────────────
//  Transport — settings broadcast
// ─────────────────────────────────────────────────────────────
function broadcastSettings() {
  if (!currentRoom) return;
  socket.emit("host:settings", {
    roomId:   currentRoom,
    bpm:      Number(bpmInput.value),
    key:      keySelect.value,
    mode:     modeSelect.value,
    quantize: quantizeSelect.value
  });
}

[keySelect, modeSelect, quantizeSelect].forEach(el => {
  el.addEventListener("change", broadcastSettings);
});

bpmInput.addEventListener("change", broadcastSettings);

bpmDown.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  bpmInput.value = Math.max(40, Number(bpmInput.value) - 1);
  broadcastSettings();
  if (isRunning) restartMetronome();
});

bpmUp.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  bpmInput.value = Math.min(240, Number(bpmInput.value) + 1);
  broadcastSettings();
  if (isRunning) restartMetronome();
});

// ─────────────────────────────────────────────────────────────
//  Transport — start / stop
// ─────────────────────────────────────────────────────────────
function updateStartStopBtn() {
  startStopBtn.textContent = isRunning ? "■ Stop" : "▶ Start";
  startStopBtn.classList.toggle("stop", isRunning);
  startStopBtn.classList.toggle("start", !isRunning);
}

startStopBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!currentRoom) return;
  isRunning = !isRunning;
  updateStartStopBtn();
  if (isRunning) {
    startMetronome();
  } else {
    stopMetronome();
  }
});

recordBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  log("Record is a Phase 2 feature.", "system");
});

// ─────────────────────────────────────────────────────────────
//  Metronome
// ─────────────────────────────────────────────────────────────
function buildBeatDots(count) {
  hostBeatBar.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("div");
    dot.className = "beat-dot";
    dot.dataset.beat = i;
    hostBeatBar.appendChild(dot);
  }
}

function highlightBeat(beat) {
  hostBeatBar.querySelectorAll(".beat-dot").forEach((d, i) => {
    d.classList.toggle("beat-active", i === beat);
    d.classList.toggle("beat-accent", i === 0 && beat === 0);
  });
}

function startMetronome() {
  stopMetronome();
  const bpm         = Number(bpmInput.value) || 120;
  const beatsPerBar = Number(beatsPerBarSel.value) || 4;
  const beatUnit    = Number(beatUnitSel.value)    || 4;
  const startTime   = Date.now();
  metroBeatsPerBar  = beatsPerBar;
  metroBeat         = 0;

  buildBeatDots(beatsPerBar);

  // Broadcast to all players
  socket.emit("host:metronome", {
    roomId: currentRoom,
    action: "start",
    bpm,
    beatsPerBar,
    beatUnit,
    startTime
  });

  const intervalMs = (60 / bpm) * 1000;
  function tick() {
    const beat = metroBeat % beatsPerBar;
    highlightBeat(beat);
    metroBeat++;
  }
  tick();
  metroTimer = setInterval(tick, intervalMs);
  log(`Metronome started · ${bpm} BPM · ${beatsPerBar}/${beatUnit}`, "system");
}

socket.on("host:loop-state", (loopState) => {
  updateLoopMirror(loopState);
  startHostLoopMirrorAnimation();
});

function stopMetronome() {
  clearInterval(metroTimer);
  metroTimer = null;
  hostBeatBar.querySelectorAll(".beat-dot").forEach(d => {
    d.classList.remove("beat-active", "beat-accent");
  });
  if (currentRoom) {
    socket.emit("host:metronome", { roomId: currentRoom, action: "stop" });
  }
}

function updateLoopMirror(loopState) {
  const loopLength = loopState.loopLengthMs || 2000;
  mirror.dataset.loopLengthMs = loopLength;
mirror.dataset.startedAt = mirror.dataset.startedAt || performance.now();
  const p = players.get(loopState.playerId);
  if (!p || !p.stripEl) return;

  let mirror = p.stripEl.querySelector(".loop-mirror");

  if (!mirror) {
    mirror = document.createElement("div");
    mirror.className = "loop-mirror";

    mirror.innerHTML = `
      <div class="loop-mirror-label">Loop</div>
      <div class="loop-mirror-grid"></div>
    `;

    p.stripEl.appendChild(mirror);
  }

  const grid = mirror.querySelector(".loop-mirror-grid");
  grid.innerHTML = "";

  const events = loopState.events || [];
  const loopLength = loopState.loopLengthMs || 2000;

  for (let i = 0; i < 16; i++) {
    const cell = document.createElement("div");
    cell.className = "loop-mirror-cell";

    const stepStart = (i / 16) * loopLength;
    const stepEnd = ((i + 1) / 16) * loopLength;

    const hasEvent = events.some(ev => ev.timeMs >= stepStart && ev.timeMs < stepEnd);

    if (hasEvent) {
      cell.classList.add("has-event");
    }

    grid.appendChild(cell);
  }

  mirror.dataset.action = loopState.action || "update";
  if (loopState.action === "clear") {
  mirror.dataset.startedAt = performance.now();
}
}

function startHostLoopMirrorAnimation() {
  if (hostLoopMirrorAnimationId !== null) return;

  animateHostLoopMirrors();
}

function animateHostLoopMirrors() {
  const now = performance.now();

  players.forEach((p) => {
    const mirror = p.stripEl?.querySelector(".loop-mirror");
    if (!mirror) return;

    const loopLength = Number(mirror.dataset.loopLengthMs || 2000);
    const startedAt = Number(mirror.dataset.startedAt || now);
    const progress = ((now - startedAt) % loopLength) / loopLength;
    const activeStep = Math.floor(progress * 16);

    mirror.querySelectorAll(".loop-mirror-cell").forEach((cell, index) => {
      cell.classList.toggle("mirror-active", index === activeStep);
      cell.classList.toggle("mirror-passed", index < activeStep);
    });
  });

  hostLoopMirrorAnimationId = requestAnimationFrame(animateHostLoopMirrors);
}

function restartMetronome() {
  stopMetronome();
  startMetronome();
}

beatsPerBarSel.addEventListener("change", () => { if (isRunning) restartMetronome(); });
beatUnitSel.addEventListener("change",    () => { if (isRunning) restartMetronome(); });

// ─────────────────────────────────────────────────────────────
//  Channel strips
// ─────────────────────────────────────────────────────────────
/** Role → accent colour class */
const ROLE_CLASS = {
  Melody:     "role-melody",
  Bass:       "role-bass",
  Percussion: "role-perc",
  Chords:     "role-chords",
  FX:         "role-fx"
};

/**
 * Creates or updates a channel strip for a player.
 * @param {{ playerId, playerName, role, muted, volume }} p
 */
function ensureStrip(p) {
  if (players.has(p.playerId)) {
    // Update existing strip labels
    const existing = players.get(p.playerId);
    existing.playerName = p.playerName;
    existing.role       = p.role;
    const nameEl = existing.stripEl.querySelector(".strip-name");
    const roleEl = existing.stripEl.querySelector(".strip-role");
    if (nameEl) nameEl.textContent = p.playerName;
    if (roleEl) { roleEl.textContent = p.role; roleEl.className = `strip-role ${ROLE_CLASS[p.role] || ""}`; }
    return;
  }

  const strip = document.createElement("div");
  strip.className = "channel-strip";
  strip.dataset.playerId = p.playerId;

  strip.innerHTML = `
    <div class="strip-header">
      <span class="strip-name">${escHtml(p.playerName)}</span>
      <span class="strip-role ${ROLE_CLASS[p.role] || ""}">${escHtml(p.role)}</span>
    </div>

    <div class="meter-wrap">
      <div class="meter-bar">
        <div class="meter-fill" data-meter></div>
      </div>
      <div class="meter-bar">
        <div class="meter-fill meter-fill-2" data-meter2></div>
      </div>
    </div>

    <div class="strip-controls">
      <label class="strip-vol-label">VOL</label>
      <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="${p.volume ?? 1}" />
      <span class="vol-value">${Math.round((p.volume ?? 1) * 100)}</span>
    </div>

    <div class="strip-buttons">
      <button class="strip-btn mute-btn ${p.muted ? "active" : ""}">M</button>
      <button class="strip-btn solo-btn" title="Solo (Phase 2)" disabled>S</button>
    </div>

    <div class="strip-activity">
      <div class="activity-ring" data-ring></div>
    </div>
  `;

  // Volume slider
  const volSlider = strip.querySelector(".vol-slider");
  const volValue  = strip.querySelector(".vol-value");
  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value);
    volValue.textContent = Math.round(v * 100);
    socket.emit("host:volume", { roomId: currentRoom, targetPlayerId: p.playerId, volume: v });
  });

  // Mute button
  const muteBtn = strip.querySelector(".mute-btn");
  muteBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const nowMuted = !muteBtn.classList.contains("active");
    muteBtn.classList.toggle("active", nowMuted);
    socket.emit("host:mute", { roomId: currentRoom, targetPlayerId: p.playerId, muted: nowMuted });
    log(`${p.playerName} ${nowMuted ? "muted" : "unmuted"}`, "system");
  });

  channelStrips.appendChild(strip);

  players.set(p.playerId, {
    ...p,
    stripEl:  strip,
    meterEl:  strip.querySelector("[data-meter]"),
    meter2El: strip.querySelector("[data-meter2]"),
    ringEl:   strip.querySelector("[data-ring]"),
    meterTimer: null
  });
}

function removeStrip(playerId) {
  const p = players.get(playerId);
  if (!p) return;
  clearTimeout(p.meterTimer);
  p.stripEl.remove();
  players.delete(playerId);
}

function refreshEmptyState() {
  const hasPayers = players.size > 0;
  emptyState.classList.toggle("hidden", hasPayers);
  channelStrips.classList.toggle("has-players", hasPayers);
}

// ─────────────────────────────────────────────────────────────
//  VU Meter animation
// ─────────────────────────────────────────────────────────────
/** Role → meter peak colour */
const METER_COLOR = {
  Melody:     "#f0b84d",
  Bass:       "#65d6ce",
  Percussion: "#ff6b6b",
  Chords:     "#a78bfa",
  FX:         "#34d399"
};

function pulseMeter(meterEl, role) {
  if (!meterEl) return;
  const color  = METER_COLOR[role] || "#f0b84d";
  const height = 60 + Math.random() * 40;   // 60–100 %

  meterEl.style.height     = height + "%";
  meterEl.style.background = color;
  meterEl.style.boxShadow  = `0 0 8px ${color}`;

  // Decay
  setTimeout(() => {
    meterEl.style.height    = "4%";
    meterEl.style.boxShadow = "none";
  }, 120);
}

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Pre-fill a random room code on load
roomCodeInput.value = generateRoomCode();
