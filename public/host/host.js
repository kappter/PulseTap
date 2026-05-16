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
const startStopBtn = document.getElementById("startStopBtn");

const startAllLoopsBtn = document.createElement("button");
startAllLoopsBtn.className = "transport-btn start";
startAllLoopsBtn.textContent = "Launch Arrangement";

startStopBtn.insertAdjacentElement("afterend", startAllLoopsBtn);

// Transport
const bpmInput       = document.getElementById("bpmInput");
const bpmDown        = document.getElementById("bpmDown");
const bpmUp          = document.getElementById("bpmUp");
const beatsPerBarSel = document.getElementById("beatsPerBar");
const beatUnitSel    = document.getElementById("beatUnit");
const keySelect      = document.getElementById("keySelect");
const modeSelect     = document.getElementById("modeSelect");
const quantizeSelect = document.getElementById("quantizeSelect");
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
let globalLoopCountdownTimer = null;
let metroBarZeroTime = null;
let currentRoom   = null;
let isRunning     = false;
let metroBeat     = 0;
let metroTimer    = null;
let metroBeatsPerBar = 4;
const savedLoopStates = new Map();
// Full loop library: Map<loopId, full passed-loop payload>
const passedLoopsLibrary = new Map();

/** Map<playerId, { playerName, role, socketId, muted, volume, stripEl, meterEl, meterTimer }> */
const players = new Map();
const saveSessionBtn = document.createElement("button");
saveSessionBtn.className = "transport-btn";
saveSessionBtn.textContent = "Save";

const loadSessionBtn = document.createElement("button");
loadSessionBtn.className = "transport-btn";
loadSessionBtn.textContent = "Load";

startAllLoopsBtn.insertAdjacentElement("afterend", saveSessionBtn);
saveSessionBtn.insertAdjacentElement("afterend", loadSessionBtn);
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

function sbAssignLoopToSection(section, loopData) {
  if (!section || !loopData) return;

  // Ensure loopId exists
  if (!loopData.loopId) {
    loopData.loopId = `${loopData.playerId}_${loopData.slot || "slot"}_${Date.now()}`;
  }

  // Store full loop data in library by loopId
  passedLoopsLibrary.set(loopData.loopId, loopData);

  // Initialise section array if needed
  if (!Array.isArray(songBoardData[section])) {
    songBoardData[section] = [];
  }

  // Add loopId only if not already assigned to this section
  if (!songBoardData[section].includes(loopData.loopId)) {
    songBoardData[section].push(loopData.loopId);
  }

  saveSongBoard();
  sbRenderCards();

  log(`${loopData.playerName || "Player"} (${loopData.loopId}) → ${section}`, "system");
}
// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
const socket = io();
socket.on("host:loop-state", (loopState) => {
  savedLoopStates.set(loopState.playerId, loopState);

  updateLoopMirror(loopState);
  startHostLoopMirrorAnimation();
});
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

const loopInboxList = document.getElementById("loopInboxList");

socket.on("player:loop-state", (data) => {
  if (!loopInboxList) return;

  const {
    playerName,
    role,
    action,
    loopLengthMs,
    events,
    stepGridEvents
  } = data;

  const totalEvents =
    (events?.length || 0) + (stepGridEvents?.length || 0);

  const existing = loopInboxList.querySelector(`[data-player="${data.playerId}"]`);

const card = existing || document.createElement("div");
card.className = "loop-card";
card.dataset.player = data.playerId;

 card.innerHTML = `
  <strong>${escHtml(playerName)} · ${escHtml(role)}</strong>
    <span>${action}</span>
    <span>${totalEvents} events · ${Math.round(loopLengthMs)}ms</span>
  `;

  // newest on top
  if (!existing) {
  loopInboxList.prepend(card);
}

  // limit list size
  if (loopInboxList.children.length > 20) {
    loopInboxList.removeChild(loopInboxList.lastChild);
  }
});

// ── Arrangement Inbox: receive passed loops from players ─────
socket.on("host:passed-loop", (data) => {
  if (!loopInboxList) return;
  const {
    playerId, playerName, role, slot,
    loopLengthMs, loopEvents, stepGridEvents, instrument
  } = data;
  const totalEvents = (loopEvents?.length || 0) + (stepGridEvents?.length || 0);
  const lenSec = loopLengthMs ? (loopLengthMs / 1000).toFixed(2) + "s" : "—";
  // Generate unique loopId for this passed loop
  const loopId = data.loopId || `${playerId}_${slot || "slot"}_${Date.now()}`;
  data.loopId = loopId;

  const cardId = `passed_${loopId}`;
  let card = document.getElementById(cardId);
  if (!card) {
    card = document.createElement("div");
    card.id = cardId;
    card.className = "loop-card loop-card--passed";
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", cardId);
      e.dataTransfer.setData("application/json", JSON.stringify({
        loopId, playerId, playerName, role, slot,
        loopLengthMs, totalEvents, instrument
      }));
      card.classList.add("loop-card--dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("loop-card--dragging"));
    loopInboxList.prepend(card);
    if (loopInboxList.children.length > 20) loopInboxList.removeChild(loopInboxList.lastChild);
  }
  // Store full data on card and in library (keyed by loopId)
  card.dataset.loopJson = JSON.stringify(data);
  card.dataset.loopId = loopId;
  passedLoopsLibrary.set(loopId, data);

  card.innerHTML = `
    <div class="lc-top">
      <strong class="lc-name">${escHtml(playerName)}</strong>
      <span class="lc-role">${escHtml(role)}</span>
      <span class="lc-badge lc-badge--available">Available</span>
      <button class="lc-delete-btn" title="Delete loop">✕</button>
    </div>
    <div class="lc-meta">
      Slot ${slot ?? "—"} · ${totalEvents} events · ${lenSec}
      ${instrument ? `· ${escHtml(instrument)}` : ""}
    </div>
    <div class="lc-assign-row">
      <span class="lc-assign-label">Assign to:</span>
      ${arrangementSections.map(s =>
        `<button class="lc-assign-btn" data-section="${s.name}">${s.name}</button>`
      ).join("")}
    </div>
  `;
  // Wire assign buttons
  card.querySelectorAll(".lc-assign-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const section = btn.dataset.section;
      const loopData = JSON.parse(card.dataset.loopJson || "{}");
      sbAssignLoopToSection(section, loopData);
      card.querySelectorAll(".lc-assign-btn").forEach(b => b.classList.remove("lc-assign-btn--active"));
      btn.classList.add("lc-assign-btn--active");
      log(`${playerName} · Slot ${slot} → ${section}`, "system");
    });
  });
  // Wire delete button
  card.querySelector(".lc-delete-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    deletePassedLoop(loopId);
  });
  updateInboxCount();
  log(`${playerName} passed loop (Slot ${slot}, ${totalEvents} events)`, "remote");
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

// ── Song Board: subscribe to live song state from player ──
// player.js emits "player:viz-state" → server relays as "viz:state"
// to all room members including the host.
socket.on("viz:state", (payload) => {
  sbHandleVizState(payload);
});


loadSessionBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  loadSavedSession();
});

function updateInboxCount() {
  const countEl = document.getElementById("inboxCount");
  const list = document.getElementById("loopInboxList");
  if (countEl && list) countEl.textContent = list.children.length;
}

/** Remove a loop from the library, inbox, and all section assignments */
function deletePassedLoop(loopId) {
  // Remove from library
  passedLoopsLibrary.delete(loopId);

  // Remove from all section assignments
  arrangementSections.forEach(sec => {
    const section = sec.name;
    if (Array.isArray(songBoardData[section])) {
      songBoardData[section] = songBoardData[section].filter(id => id !== loopId);
      if (songBoardData[section].length === 0) {
        delete songBoardData[section];
      }
    }
  });
  saveSongBoard();

  // Remove inbox card
  const card = document.getElementById(`passed_${loopId}`);
  if (card) card.remove();
  updateInboxCount();

  // Re-render Song Board
  sbRenderCards();
  log(`Loop ${loopId} deleted`, "system");
}
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
  updateJoinQr();
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
function saveCurrentSession() {
  if (!currentRoom) return;

  const sessionSave = {
    savedAt: Date.now(),
    roomId: currentRoom,
    settings: {
      bpm: Number(bpmInput.value),
      beatsPerBar: Number(beatsPerBarSel.value),
      beatUnit: Number(beatUnitSel.value),
      key: keySelect.value,
      mode: modeSelect.value,
      quantize: quantizeSelect.value
    },
    players: Array.from(savedLoopStates.values())
  };

  localStorage.setItem("pulsetap_saved_session", JSON.stringify(sessionSave));
  log("Session saved", "system");
}

// ─────────────────────────────────────────────────────────────
//  .ptarr Arrangement Export / Import
// ─────────────────────────────────────────────────────────────

/** Build a .ptarr JSON object from current host state */
function buildArrangementFile() {
  const sectionStructure = arrangementSections.map((sec, idx) => {
    return {
      name: sec.name,
      slot: idx + 1,
      bars: sec.bars,
      feel: "",
      lyrics: sec.notes,
      energy: sec.energy,
      // Legacy fields kept null for v1.1
      assignedPlayerId: null,
      assignedPlayerName: null,
      assignedRole: null,
      assignedSlot: null,
      assignedLoopLengthMs: null
    };
  });
  const sections = arrangementSections.map(s => s.name);

  const loopLibrary = Array.from(passedLoopsLibrary.values()).map(loop => ({
    loopId:         loop.loopId || `${loop.playerId}_${loop.slot || "slot"}_export`,
    playerId:       loop.playerId,
    playerName:     loop.playerName,
    role:           loop.role,
    slot:           loop.slot,
    instrument:     loop.instrument     || "",
    loopLengthMs:   loop.loopLengthMs,
    loopEvents:     loop.loopEvents     || [],
    stepGridEvents: loop.stepGridEvents || [],
    stepGridSteps:  loop.stepGridSteps  || 16,
    settings:       loop.settings       || {}
  }));

  return {
    ptarrVersion: "1.1",
    exportedAt:   new Date().toISOString(),
    title:        currentRoom ? `PulseTap Room ${currentRoom}` : "PulseTap Arrangement",
    roomId:       currentRoom || "",
    metadata: {
      exportedBy:  "host",
      playerCount: players.size
    },
    settings: {
      bpm:         Number(bpmInput.value)         || 120,
      beatsPerBar: Number(beatsPerBarSel.value)   || 4,
      beatUnit:    Number(beatUnitSel.value)       || 4,
      key:         keySelect.value                || "C",
      mode:        modeSelect.value               || "major",
      quantize:    quantizeSelect.value           || "off",
      timeSig:     `${beatsPerBarSel.value || 4}/${beatUnitSel.value || 4}`
    },
    songStructure: sectionStructure,
    loopLibrary,
    // arrangementAssignments: section -> [loopId, ...]
    arrangementAssignments: Object.fromEntries(
      sections
        .filter(s => Array.isArray(songBoardData[s]) && songBoardData[s].length > 0)
        .map(s => [s, songBoardData[s]])
    )
  };
}

/** Trigger a .ptarr file download */
function exportArrangement() {
  const data = buildArrangementFile();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const title = (data.title || "arrangement").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  a.href     = url;
  a.download = `${title}.ptarr`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  log("Arrangement exported as .ptarr", "system");
}

/** Load a .ptarr JSON object into the host */
function importArrangement(data) {
  if (!data || !["1.0", "1.1"].includes(data.ptarrVersion)) {
    log("Invalid .ptarr file (version mismatch)", "error");
    return;
  }

  // 1. Restore global settings
  if (data.settings) {
    bpmInput.value          = data.settings.bpm         || 120;
    beatsPerBarSel.value    = data.settings.beatsPerBar  || 4;
    beatUnitSel.value       = data.settings.beatUnit     || 4;
    keySelect.value         = data.settings.key          || "C";
    modeSelect.value        = data.settings.mode         || "major";
    quantizeSelect.value    = data.settings.quantize     || "off";
    broadcastSettings();
  }

  // 2. Restore loop library into passedLoopsLibrary and Inbox UI
  passedLoopsLibrary.clear();
  (data.loopLibrary || []).forEach(loop => {
    // Ensure loopId exists for imported loops
    if (!loop.loopId) {
      loop.loopId = `${loop.playerId}_${loop.slot || "slot"}_imported`;
    }
    passedLoopsLibrary.set(loop.loopId, loop);
    // Re-render inbox card
    if (loopInboxList) {
      const importLoopId = loop.loopId;
      const cardId = `passed_${importLoopId}`;
      let card = document.getElementById(cardId);
      if (!card) {
        card = document.createElement("div");
        card.id = cardId;
        card.className = "loop-card loop-card--passed";
        card.draggable = true;
        card.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", cardId);
          e.dataTransfer.setData("application/json", JSON.stringify({
            loopId:      importLoopId,
            playerId:    loop.playerId,
            playerName:  loop.playerName,
            role:        loop.role,
            slot:        loop.slot,
            loopLengthMs: loop.loopLengthMs,
            totalEvents: (loop.loopEvents?.length || 0) + (loop.stepGridEvents?.length || 0),
            instrument:  loop.instrument
          }));
          card.classList.add("loop-card--dragging");
        });
        card.addEventListener("dragend", () => card.classList.remove("loop-card--dragging"));
        loopInboxList.prepend(card);
      }
      card.dataset.loopJson = JSON.stringify(loop);
      card.dataset.loopId = importLoopId;
      const totalEvents = (loop.loopEvents?.length || 0) + (loop.stepGridEvents?.length || 0);
      const lenSec = loop.loopLengthMs ? (loop.loopLengthMs / 1000).toFixed(2) + "s" : "—";
      card.innerHTML = `
        <div class="lc-top">
          <strong class="lc-name">${escHtml(loop.playerName || "")}</strong>
          <span class="lc-role">${escHtml(loop.role || "")}</span>
          <span class="lc-badge lc-badge--available">Imported</span>
          <button class="lc-delete-btn" title="Delete loop">✕</button>
        </div>
        <div class="lc-meta">
          Slot ${loop.slot ?? "—"} · ${totalEvents} events · ${lenSec}
          ${loop.instrument ? `· ${escHtml(loop.instrument)}` : ""}
        </div>
        <div class="lc-assign-row">
          <span class="lc-assign-label">Assign to:</span>
          ${["Intro","Verse","Chorus","Bridge","Outro"].map(s =>
            `<button class="lc-assign-btn" data-section="${s}">${s}</button>`
          ).join("")}
        </div>
      `;
      card.querySelectorAll(".lc-assign-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const loopData = JSON.parse(card.dataset.loopJson || "{}");
          sbAssignLoopToSection(btn.dataset.section, loopData);
          btn.classList.add("lc-assign-btn--done");
          btn.textContent = "✓ " + btn.dataset.section;
        });
      });
      card.querySelector(".lc-delete-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deletePassedLoop(importLoopId);
      });
    }
  });
  updateInboxCount();

  // 3. Restore song structure (arrangementSections)
  if (data.songStructure && data.songStructure.length > 0) {
    arrangementSections = data.songStructure.map(sec => ({
      id: generateSectionId(),
      name: sec.name,
      bars: sec.bars || 4,
      notes: sec.lyrics || "",
      energy: sec.energy || null
    }));
  }

  // 4. Restore Song Board assignments as loopId arrays
  songBoardData = {};
  Object.entries(data.arrangementAssignments || {}).forEach(([section, assignment]) => {
    // New format: assignment is an array of loopIds
    if (Array.isArray(assignment)) {
      songBoardData[section] = assignment;
    } else if (assignment && assignment.loopId) {
      // Single-loopId object (v1.1+)
      songBoardData[section] = [assignment.loopId];
    } else if (assignment && assignment.playerId) {
      // Legacy single-assignment object: synthesise a loopId
      const lid = `${assignment.playerId}_${assignment.slot || "slot"}_imported`;
      songBoardData[section] = [lid];
      // Ensure the loop is in the library if not already
      if (!passedLoopsLibrary.has(lid)) {
        passedLoopsLibrary.set(lid, { ...assignment, loopId: lid });
      }
    }
  });
  saveSongBoard();
  sbRenderCards();

  log(`Arrangement "${data.title}" imported · ${(data.loopLibrary || []).length} loops · ${Object.keys(data.arrangementAssignments || {}).length} assignments`, "system");
}

/** Wire the Export Arrangement button */
const exportArrBtn = document.getElementById("exportArrBtn");
if (exportArrBtn) {
  exportArrBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    exportArrangement();
  });
}

/** Wire the Open Arrangement button (hidden file input) */
const openArrBtn   = document.getElementById("openArrBtn");
const openArrInput = document.getElementById("openArrInput");
if (openArrBtn && openArrInput) {
  openArrBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    openArrInput.click();
  });
  openArrInput.addEventListener("change", () => {
    const file = openArrInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        importArrangement(data);
      } catch (err) {
        log("Failed to parse .ptarr file: " + err.message, "error");
      }
    };
    reader.readAsText(file);
    openArrInput.value = "";
  });
}
// ─────────────────────────────────────────────────────────────
//  Transport — settings broadcast
// ─────────────────────────────────────────────────────────────
function startGlobalLoopCountdown(startTime) {
  clearInterval(globalLoopCountdownTimer);

  startAllLoopsBtn.disabled = true;

  function updateCountdown() {
    const remainingMs = startTime - Date.now();
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

    startAllLoopsBtn.textContent = remainingSec > 0
      ? `Starting in ${remainingSec}`
      : "Launching...";

    if (remainingMs <= 0) {
      clearInterval(globalLoopCountdownTimer);
      globalLoopCountdownTimer = null;

      startAllLoopsBtn.textContent = "Launch Arrangement";
      startAllLoopsBtn.disabled = false;
    }
  }

  updateCountdown();
  globalLoopCountdownTimer = setInterval(updateCountdown, 100);
}
function broadcastSettings() {
  if (!currentRoom) return;
  socket.emit("host:settings", {
  roomId: currentRoom,
  bpm: Number(bpmInput.value),
  key: keySelect.value,
  mode: modeSelect.value,
  quantize: quantizeSelect.value,
  beatsPerBar: Number(beatsPerBarSel.value),
  beatUnit: Number(beatUnitSel.value)
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

startAllLoopsBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!currentRoom) return;

  const startTime = getNextBarStartTime();

  socket.emit("host:loop-transport", {
    roomId: currentRoom,
    action: "start",
    startTime
  });
  startGlobalLoopCountdown(startTime);

  log("Global loop start queued for next bar", "system");
  
});

function updateJoinQr() {
  const qrEl = document.getElementById("joinQr");
  const urlText = document.getElementById("joinUrlText");

  if (!qrEl || !currentRoom) return;

  const joinUrl = `${window.location.origin}/player?room=${encodeURIComponent(currentRoom)}`;

  qrEl.innerHTML = "";

  new QRCode(qrEl, {
    text: joinUrl,
    width: 72,
    height: 72,
    correctLevel: QRCode.CorrectLevel.H
  });

  if (urlText) urlText.textContent = joinUrl;
}

// ─────────────────────────────────────────────────────────────
//  Transport — start / stop
// ─────────────────────────────────────────────────────────────
function updateStartStopBtn() {
  startStopBtn.textContent = isRunning ? "■ Stop Session Clock" : "▶ Start Session Clock";
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

function getNextBarStartTime() {
  const bpm = Number(bpmInput.value) || 120;
  const beatsPerBar = Number(beatsPerBarSel.value) || 4;

  const msPerBeat = 60000 / bpm;
  const msPerBar = msPerBeat * beatsPerBar;

  const now = Date.now();

  if (!isRunning || !metroBarZeroTime) {
    return now + 1000;
  }

  const elapsedSinceBarZero = now - metroBarZeroTime;
  const phaseInBar = elapsedSinceBarZero % msPerBar;
  const untilNextBar = msPerBar - phaseInBar;

  return now + untilNextBar;
}

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
  const startTime = Date.now() + 300;
  metroBarZeroTime = startTime;
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

const now = Date.now();
let delay = Math.max(0, startTime - now);

if (delay === 0) {
  const elapsed = now - startTime;
  const phase = elapsed % intervalMs;
  delay = phase > 0 ? intervalMs - phase : 0;
}

function tick() {
  const beat = metroBeat % beatsPerBar;
  highlightBeat(beat);
  metroBeat++;
}

setTimeout(() => {
  tick();
  metroTimer = setInterval(tick, intervalMs);
}, delay);
  log(`Metronome started · ${bpm} BPM · ${beatsPerBar}/${beatUnit}`, "system");
}

function stopMetronome() {
  clearInterval(metroTimer);
  metroTimer = null;
  metroBarZeroTime = null;
  hostBeatBar.querySelectorAll(".beat-dot").forEach(d => {
    d.classList.remove("beat-active", "beat-accent");
  });
  if (currentRoom) {
    socket.emit("host:metronome", { roomId: currentRoom, action: "stop" });
  }
}

function updateLoopMirror(loopState) {
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
  const events = loopState.events || [];
  const loopLength = loopState.loopLengthMs || 2000;

  mirror.dataset.loopLengthMs = loopLength;
  mirror.dataset.action = loopState.action || "update";

  if (loopState.action === "play-start") {
    mirror.dataset.startedAt = performance.now();
  }

  if (!mirror.dataset.startedAt) {
    mirror.dataset.startedAt = performance.now();
  }

  if (loopState.action === "clear") {
    mirror.dataset.startedAt = performance.now();
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = "";

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

beatsPerBarSel.addEventListener("change", () => {
  broadcastSettings();
  if (isRunning) restartMetronome();
});

beatUnitSel.addEventListener("change", () => {
  broadcastSettings();
  if (isRunning) restartMetronome();
});

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

function loadSavedSession() {
  const raw = localStorage.getItem("pulsetap_saved_session");
  if (!raw) {
    log("No saved session found", "system");
    return;
  }

  const sessionSave = JSON.parse(raw);

  if (sessionSave.settings) {
    bpmInput.value = sessionSave.settings.bpm || 120;
    beatsPerBarSel.value = sessionSave.settings.beatsPerBar || 4;
    beatUnitSel.value = sessionSave.settings.beatUnit || 4;
    keySelect.value = sessionSave.settings.key || "C";
    modeSelect.value = sessionSave.settings.mode || "major";
    quantizeSelect.value = sessionSave.settings.quantize || "off";

    broadcastSettings();
  }

  savedLoopStates.clear();

  (sessionSave.players || []).forEach(loopState => {
    savedLoopStates.set(loopState.playerId, loopState);
    updateLoopMirror(loopState);
  });

  // Backward compat: restore songBoardData if present in legacy save
  if (sessionSave.songBoardData) {
    songBoardData = sessionSave.songBoardData;
    saveSongBoard();
    sbRenderCards();
  }

  startHostLoopMirrorAnimation();
  log("Session loaded on host", "system");
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
saveSessionBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  saveCurrentSession();
});




// ═══════════════════════════════════════════════════════════════
//  Song Board Phase 1
//  Read-only sync from player Song Mode via viz:state events.
//  Provides: section cards, live highlighting, transport controls,
//  status strip (BPM / key / mode / bars remaining).
// ═══════════════════════════════════════════════════════════════

// Dynamic arrangement sections
let arrangementSections = [
  { id: "sec_intro",  name: "Intro",  bars: 4, notes: "", energy: null },
  { id: "sec_verse",  name: "Verse",  bars: 4, notes: "", energy: null },
  { id: "sec_chorus", name: "Chorus", bars: 4, notes: "", energy: null },
  { id: "sec_bridge", name: "Bridge", bars: 4, notes: "", energy: null },
  { id: "sec_outro",  name: "Outro",  bars: 4, notes: "", energy: null }
];

const ARR_TEMPLATES = {
  "basic": [
    { name: "Intro", bars: 4 },
    { name: "Verse", bars: 8 },
    { name: "Chorus", bars: 8 },
    { name: "Bridge", bars: 4 },
    { name: "Outro", bars: 4 }
  ],
  "rock_pop": [
    { name: "Intro", bars: 4 },
    { name: "Verse 1", bars: 8 },
    { name: "Chorus 1", bars: 8 },
    { name: "Verse 2", bars: 8 },
    { name: "Chorus 2", bars: 8 },
    { name: "Bridge", bars: 8 },
    { name: "Chorus 3", bars: 8 },
    { name: "Outro", bars: 4 }
  ],
  "jam_session": [
    { name: "Warmup", bars: 8 },
    { name: "Groove A", bars: 16 },
    { name: "Groove B", bars: 16 },
    { name: "Breakdown", bars: 8 },
    { name: "Climax", bars: 16 }
  ],
  "classroom_abc": [
    { name: "Part A", bars: 4 },
    { name: "Part B", bars: 4 },
    { name: "Part C", bars: 4 },
    { name: "All Together", bars: 8 }
  ],
  "energy_build": [
    { name: "Ambient", bars: 8 },
    { name: "Pulse", bars: 8 },
    { name: "Drive", bars: 8 },
    { name: "Peak", bars: 8 },
    { name: "Fade", bars: 8 }
  ]
};

function generateSectionId() {
  return "sec_" + Math.random().toString(36).substring(2, 9);
}

function loadTemplate(templateKey) {
  const tpl = ARR_TEMPLATES[templateKey];
  if (!tpl) return;
  
  // Warn if we have existing assignments
  const hasAssignments = Object.keys(songBoardData).length > 0;
  if (hasAssignments && !confirm("Loading a template will rebuild sections. Assignments for matching section names will be kept, but others may be lost. Continue?")) {
    return;
  }

  // Preserve assignments for names that still exist in the new template
  const newNames = tpl.map(s => s.name);
  Object.keys(songBoardData).forEach(oldName => {
    if (!newNames.includes(oldName)) {
      delete songBoardData[oldName];
    }
  });

  arrangementSections = tpl.map(s => ({
    id: generateSectionId(),
    name: s.name,
    bars: s.bars,
    notes: "",
    energy: null
  }));

  saveSongBoard();
  sbRenderCards();
  log(`Template loaded: ${templateKey}`, "system");
}


// Live state received from player
let sbState = {
  section:    null,   // current section name
  upcoming:   null,   // next section name
  barsLeft:   null,   // bars remaining in current section
  slot:       null,   // active slot number
  bpm:        null,
  key:        null,
  mode:       null,
  timeSig:    null,
  songActive: false
};

// Legacy drag-and-drop data (preserved from Phase 0)
let songBoardData = JSON.parse(localStorage.getItem("pulsetap_song_board") || "{}");

// ── Render section cards ──────────────────────────────────────
function sbRenderCards() {
  const container = document.getElementById("songBoardSections");
  if (!container) return;
  container.innerHTML = "";

  arrangementSections.forEach((sec, idx) => {
    const section = sec.name;
    const card = document.createElement("div");
    card.className = "sb-card";
    card.dataset.section = section;
    card.dataset.sectionId = sec.id;

    // Header row with slot badge and controls
    const headerRow = document.createElement("div");
    headerRow.className = "sb-card-header";
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.marginBottom = "8px";

    const slotBadge = document.createElement("div");
    slotBadge.className = "sb-card-slot";
    slotBadge.textContent = `Sec ${idx + 1}`;

    const controls = document.createElement("div");
    controls.className = "sb-card-controls";
    controls.innerHTML = `
      <button class="sb-ctrl-btn" onclick="editSection('${sec.id}')" title="Edit Section">✎</button>
      <button class="sb-ctrl-btn" onclick="duplicateSection('${sec.id}')" title="Duplicate Section">+</button>
      <button class="sb-ctrl-btn" onclick="deleteSection('${sec.id}')" title="Delete Section">✕</button>
    `;
    controls.style.display = "flex";
    controls.style.gap = "4px";

    headerRow.appendChild(slotBadge);
    headerRow.appendChild(controls);

    // Section name
    const nameEl = document.createElement("div");
    nameEl.className = "sb-card-name";
    nameEl.textContent = section;

    // Bars label
    const barsEl = document.createElement("div");
    barsEl.className = "sb-card-bars";
    barsEl.id = `sbCardBars_${section}`;
    barsEl.textContent = `${sec.bars} bars`;

    // Notes preview
    const notesEl = document.createElement("div");
    notesEl.className = "sb-card-notes";
    notesEl.id = `sbCardNotes_${section}`;
    notesEl.textContent = sec.notes ? sec.notes.split("\n")[0].slice(0, 60) : "";

    // Active/next indicator pill
    const pillEl = document.createElement("div");
    pillEl.className = "sb-card-pill";
    pillEl.id = `sbCardPill_${section}`;

    card.appendChild(headerRow);
    card.appendChild(nameEl);
    card.appendChild(barsEl);
    card.appendChild(notesEl);
    card.appendChild(pillEl);
    // Drop zone for dragged inbox cards
    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("sb-card--drop-hover"); });
    card.addEventListener("dragleave", () => card.classList.remove("sb-card--drop-hover"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("sb-card--drop-hover");
      try {
        const dragData = JSON.parse(e.dataTransfer.getData("application/json") || "{}");
        // Prefer full loop from library if loopId is present
        const loopData = (dragData.loopId && passedLoopsLibrary.has(dragData.loopId))
          ? passedLoopsLibrary.get(dragData.loopId)
          : dragData;
        if (loopData.playerId || loopData.loopId) {
          sbAssignLoopToSection(card.dataset.section, loopData);
          log(`${loopData.playerName || "Loop"} → ${card.dataset.section}`, "system");
        }
      } catch {}
    });
    // Restore saved assignments (array of loopIds)
    const assignedIds = Array.isArray(songBoardData[card.dataset.section])
      ? songBoardData[card.dataset.section]
      : (songBoardData[card.dataset.section] ? [songBoardData[card.dataset.section].playerId].filter(Boolean) : []);

    if (assignedIds.length > 0) {
      card.classList.add("sb-card--has-loop");
      const assignList = document.createElement("div");
      assignList.className = "sb-card-assign-list";

      assignedIds.forEach(lid => {
        const loop = passedLoopsLibrary.get(lid);
        const row = document.createElement("div");
        row.className = "sb-assigned-row";

        if (loop) {
          const lenSec = loop.loopLengthMs ? (loop.loopLengthMs / 1000).toFixed(2) + "s" : "—";
          row.innerHTML = `
            <span class="sb-assigned-name">${escHtml(loop.playerName || "")}</span>
            <span class="sb-assigned-meta">${escHtml(loop.role || "")} · Slot ${loop.slot ?? "—"} · ${lenSec}</span>
            <button class="sb-remove-btn" data-loop-id="${escHtml(lid)}" data-section="${escHtml(card.dataset.section)}" title="Remove from section">✕</button>
          `;
        } else {
          // Loop was deleted from library but still referenced
          row.innerHTML = `
            <span class="sb-assigned-name sb-assigned-missing">[deleted]</span>
            <button class="sb-remove-btn" data-loop-id="${escHtml(lid)}" data-section="${escHtml(card.dataset.section)}" title="Remove">✕</button>
          `;
        }
        assignList.appendChild(row);
      });

      card.appendChild(assignList);
    }
    container.appendChild(card);
  });
}

// ── Delegated remove-from-section listener ───────────────────
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".sb-remove-btn");
  if (!btn) return;
  const loopId  = btn.dataset.loopId;
  const section = btn.dataset.section;
  if (!loopId || !section) return;
  if (Array.isArray(songBoardData[section])) {
    songBoardData[section] = songBoardData[section].filter(id => id !== loopId);
    if (songBoardData[section].length === 0) delete songBoardData[section];
  }
  saveSongBoard();
  sbRenderCards();
  log(`Loop removed from ${section}`, "system");
});

// ── Highlight current and next section ───────────────────────
function sbHighlight(currentSection, nextSection) {
  document.querySelectorAll(".sb-card").forEach(card => {
    const s = card.dataset.section;
    card.classList.toggle("sb-card--active", s === currentSection);
    card.classList.toggle("sb-card--next",   s === nextSection && s !== currentSection);
    card.classList.toggle("sb-card--idle",   s !== currentSection && s !== nextSection);

    const pill = card.querySelector(".sb-card-pill");
    if (!pill) return;
    if (s === currentSection) {
      pill.textContent = "PLAYING";
      pill.className = "sb-card-pill sb-pill--active";
    } else if (s === nextSection && s !== currentSection) {
      pill.textContent = "NEXT";
      pill.className = "sb-card-pill sb-pill--next";
    } else {
      pill.textContent = "";
      pill.className = "sb-card-pill";
    }
  });
}

// ── Update status strip ───────────────────────────────────────
function sbUpdateStatus(state) {
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v != null ? String(v) : "\u2014";
  };
  setVal("sbBpm",      state.bpm);
  setVal("sbKey",      state.key);
  setVal("sbMode",     state.mode);
  setVal("sbBarsLeft", state.barsLeft != null ? `${state.barsLeft} bars` : "\u2014");

  const badge = document.getElementById("sbSongStatus");
  if (badge) {
    if (state.songActive) {
      badge.textContent = "RUNNING";
      badge.className = "sb-badge sb-badge--running";
    } else {
      badge.textContent = "Idle";
      badge.className = "sb-badge";
    }
  }

  // Update transport button states
  const startBtn = document.getElementById("sbStartSongBtn");
  const stopBtn  = document.getElementById("sbStopSongBtn");
  const nextBtn  = document.getElementById("sbNextSectionBtn");
  if (startBtn) startBtn.disabled = !!state.songActive;
  if (stopBtn)  stopBtn.disabled  = !state.songActive;
  if (nextBtn)  nextBtn.disabled  = !state.songActive;
}

// ── Handle incoming viz:state payload ────────────────────────
function sbHandleVizState(payload) {
  if (!payload) return;
  sbState = { ...sbState, ...payload };
  sbHighlight(sbState.section, sbState.upcoming);
  sbUpdateStatus(sbState);

  // Update bars-remaining on the active card
  if (sbState.section && sbState.barsLeft != null) {
    const barsEl = document.getElementById(`sbCardBars_${sbState.section}`);
    if (barsEl) barsEl.textContent = `${sbState.barsLeft} bars`;
  }
}

// ── Transport: Start Song ─────────────────────────────────────
// Tells the room to start Song Mode by emitting a host:song-start event.
// The player handles the actual Song Mode start; host is a conductor.
document.getElementById("sbStartSongBtn")?.addEventListener("pointerdown", (e) => {
  e.preventDefault();

  if (cpActive) {
    log("Arrangement already running", "system");
    return;
  }

  if (!currentRoom) {
    log("Open a room first", "system");
    return;
  }

  socket.emit("host:song-start", { roomId: currentRoom });
  startCentralArrangementPlayback();
});

// ── Transport: Next Section ───────────────────────────────────
// Asks the player to advance to the next section immediately.
document.getElementById("sbNextSectionBtn")?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!currentRoom) return;
  socket.emit("host:song-next", { roomId: currentRoom });
  if (cpActive) {
    if (cpTimer) clearTimeout(cpTimer);
    cpSectionIndex++;
    scheduleCentralSection(cpSectionIndex);
    log("\u23ed Next section forced locally", "system");
  } else {
    log("\u23ed Next section requested", "system");
  }
});

// ── Save drag-and-drop board data (legacy) ────────────────────
function saveSongBoard() {
  localStorage.setItem("pulsetap_song_board", JSON.stringify(songBoardData));
}

// ── Initialize on load ────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  sbRenderCards();
  sbUpdateStatus(sbState);

  // Make inbox cards draggable (legacy Phase 0 feature, preserved)
  const inbox = document.getElementById("loopInboxList");
  if (inbox) {
    const observer = new MutationObserver(() => makeLoopCardsDraggable());
    observer.observe(inbox, { childList: true });
    makeLoopCardsDraggable();
  }
});

// Make inbox cards draggable (legacy helper, preserved)
function makeLoopCardsDraggable() {
  document.querySelectorAll(".loop-card").forEach(card => {
    if (card.dataset.draggableSet) return;
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      const playerId = card.dataset.player;
      const playerName = card.querySelector("strong").textContent.split(" \u00b7 ")[0];
      const role = card.querySelector("strong").textContent.split(" \u00b7 ")[1];
      const loopId = `${playerId}-${Date.now()}`;
      e.dataTransfer.setData("text/plain", loopId);
      e.dataTransfer.setData("application/json", JSON.stringify({ playerId, playerName, role }));
    });
    card.dataset.draggableSet = "true";
  });
};


// ═══════════════════════════════════════════════════════════════
//  Central Playback Engine (Phase 1.5)
//  Plays imported/passed arrangement through Host Web Audio.
//  Works with zero connected players.
// ═══════════════════════════════════════════════════════════════

let hostAudioCtx = null;
let hostMasterGain = null;

function initHostAudio() {
  if (hostAudioCtx) {
    if (hostAudioCtx.state === "suspended") hostAudioCtx.resume();
    return;
  }
  hostAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  hostMasterGain = hostAudioCtx.createGain();
  hostMasterGain.gain.value = 0.8;
  hostMasterGain.connect(hostAudioCtx.destination);
}

document.body.addEventListener("pointerdown", initHostAudio, { once: true });

// ── Scale / frequency tables ──────────────────────────────────
const HOST_SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11, 12],
  minor:      [0, 2, 3, 5, 7, 8, 10, 12],
  dorian:     [0, 2, 3, 5, 7, 9, 10, 12],
  phrygian:   [0, 1, 3, 5, 7, 8, 10, 12],
  lydian:     [0, 2, 4, 6, 7, 9, 11, 12],
  mixolydian: [0, 2, 4, 5, 7, 9, 10, 12],
  pentatonic: [0, 2, 4, 7, 9, 12, 14, 16],
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7]
};
const HOST_KEY_FREQ = {
  C: 261.63, "C#": 277.18, D: 293.66, "D#": 311.13,
  E: 329.63, F: 349.23, "F#": 369.99, G: 392.00,
  "G#": 415.30, A: 440.00, "A#": 466.16, B: 493.88
};

function hostSemitoneToHz(rootHz, semitones) {
  return rootHz * Math.pow(2, semitones / 12);
}

function hostPadFrequency(degree) {
  const root  = HOST_KEY_FREQ[keySelect.value] || 261.63;
  const scale = HOST_SCALES[modeSelect.value]  || HOST_SCALES.major;
  return hostSemitoneToHz(root, scale[degree] ?? 0);
}

// ── Synth voices ──────────────────────────────────────────────
function hostSynthTone(freq, type, velocity, time) {
  const osc = hostAudioCtx.createOscillator();
  const gain = hostAudioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  gain.gain.setValueAtTime(0.4 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  osc.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.25);
}
function hostSynthKick(time) {
  const osc = hostAudioCtx.createOscillator();
  const gain = hostAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.1);
  gain.gain.setValueAtTime(1.0, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
  osc.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.13);
}
function hostSynthSnare(time) {
  const noise = hostAudioCtx.createBufferSource();
  const buffer = hostAudioCtx.createBuffer(1, hostAudioCtx.sampleRate * 0.2, hostAudioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.buffer = buffer;
  const filter = hostAudioCtx.createBiquadFilter();
  filter.type = "highpass"; filter.frequency.value = 1000;
  const gain = hostAudioCtx.createGain();
  gain.gain.setValueAtTime(0.7, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  noise.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  noise.start(time); noise.stop(time + 0.2);
}
function hostSynthHiHat(time) {
  const noise = hostAudioCtx.createBufferSource();
  const buffer = hostAudioCtx.createBuffer(1, hostAudioCtx.sampleRate * 0.05, hostAudioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.buffer = buffer;
  const filter = hostAudioCtx.createBiquadFilter();
  filter.type = "highpass"; filter.frequency.value = 5000;
  const gain = hostAudioCtx.createGain();
  gain.gain.setValueAtTime(0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  noise.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  noise.start(time); noise.stop(time + 0.05);
}
function hostSynthTom(freq, time) {
  const osc = hostAudioCtx.createOscillator();
  const gain = hostAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  osc.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.25);
}
function hostSynthBass(freq, velocity, time) {
  const osc = hostAudioCtx.createOscillator();
  const filter = hostAudioCtx.createBiquadFilter();
  const gain = hostAudioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(freq / 2, time);
  filter.type = "lowpass"; filter.frequency.setValueAtTime(400 + velocity * 800, time);
  gain.gain.setValueAtTime(0.6 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.25);
  osc.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.3);
}
function hostSynthPluck(freq, velocity, time) {
  const osc = hostAudioCtx.createOscillator();
  const filter = hostAudioCtx.createBiquadFilter();
  const gain = hostAudioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "highpass"; filter.frequency.setValueAtTime(800 + velocity * 800, time);
  gain.gain.setValueAtTime(0.7 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  osc.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.12);
}
function hostSynthBell(freq, velocity, time) {
  const osc1 = hostAudioCtx.createOscillator();
  const osc2 = hostAudioCtx.createOscillator();
  const gain = hostAudioCtx.createGain();
  osc1.type = "sine"; osc2.type = "sine";
  osc1.frequency.setValueAtTime(freq, time);
  osc2.frequency.setValueAtTime(freq * 2.01, time);
  gain.gain.setValueAtTime(0.5 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.2);
  osc1.connect(gain); osc2.connect(gain); gain.connect(hostMasterGain);
  osc1.start(time); osc2.start(time);
  osc1.stop(time + 1.3); osc2.stop(time + 1.3);
}
function hostSynthPad(freq, velocity, time) {
  const osc = hostAudioCtx.createOscillator();
  const filter = hostAudioCtx.createBiquadFilter();
  const gain = hostAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "lowpass"; filter.frequency.setValueAtTime(800 + velocity * 1200, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.3 * velocity, time + 0.3);
  gain.gain.linearRampToValueAtTime(0.0001, time + 1.5);
  osc.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 1.6);
}
function hostSynthLead(freq, velocity, time) {
  const osc = hostAudioCtx.createOscillator();
  const filter = hostAudioCtx.createBiquadFilter();
  const gain = hostAudioCtx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "bandpass"; filter.frequency.setValueAtTime(freq * (1.5 + velocity), time);
  gain.gain.setValueAtTime(0.5 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
  osc.connect(filter); filter.connect(gain); gain.connect(hostMasterGain);
  osc.start(time); osc.stop(time + 0.35);
}

function playHostSound(degree, instrument, time, velocity = 1) {
  if (!hostAudioCtx) return;
  const freq = hostPadFrequency(degree);
  switch (instrument) {
    case "sine":     hostSynthTone(freq, "sine",     velocity, time); break;
    case "triangle": hostSynthTone(freq, "triangle", velocity, time); break;
    case "square":   hostSynthTone(freq, "square",   velocity, time); break;
    case "sawtooth": hostSynthTone(freq, "sawtooth", velocity, time); break;
    case "bass":     hostSynthBass(freq, velocity, time);  break;
    case "pluck":    hostSynthPluck(freq, velocity, time); break;
    case "bell":     hostSynthBell(freq, velocity, time);  break;
    case "pad":      hostSynthPad(freq, velocity, time);   break;
    case "lead":     hostSynthLead(freq, velocity, time);  break;
    case "kick":     hostSynthKick(time);              break;
    case "snare":    hostSynthSnare(time);             break;
    case "hi-hat":   hostSynthHiHat(time);             break;
    case "tom":      hostSynthTom(freq, time);         break;
    case "kit":
      switch (degree) {
        case 0: hostSynthKick(time);       break;
        case 1: hostSynthSnare(time);      break;
        case 2: hostSynthHiHat(time);      break;
        case 3: hostSynthTom(220, time);   break;
        case 4: hostSynthTom(180, time);   break;
        case 5: hostSynthHiHat(time);      break;
        case 6: hostSynthSnare(time);      break;
        case 7: hostSynthKick(time);       break;
        default: hostSynthKick(time);
      }
      break;
    default: hostSynthTone(freq, "sine", velocity, time);
  }
}

// ── Normalise loop events ─────────────────────────────────────
function getEventsFromLoop(loopData) {
  const events = [];
  const loopLenMs = loopData.loopLengthMs || 2000;
  (loopData.loopEvents || []).forEach(ev => {
    events.push({ timeMs: ev.timeMs, degree: ev.degree, instrument: ev.instrument || loopData.instrument });
  });
  (loopData.stepGridEvents || []).forEach(ev => {
    const steps = loopData.stepGridSteps || 16;
    events.push({ timeMs: (ev.step / steps) * loopLenMs, degree: ev.degree, instrument: ev.instrument || loopData.instrument });
  });
  return events;
}

// ── Playback state ────────────────────────────────────────────
let cpActive = false;
let cpSectionIndex = 0;
let cpTimer = null;

function startCentralArrangementPlayback() {
  if (cpActive) return;  // guard: ignore repeated calls while running
  if (!hostAudioCtx) initHostAudio();
  if (hostAudioCtx.state === "suspended") hostAudioCtx.resume();
  cpActive = true;
  cpSectionIndex = 0;
  const startBtn = document.getElementById("sbStartSongBtn");
  const stopBtn  = document.getElementById("sbStopSongBtn");
  const nextBtn  = document.getElementById("sbNextSectionBtn");
  if (startBtn) { startBtn.disabled = true; }
  if (stopBtn)  { stopBtn.disabled  = false; }
  if (nextBtn)  { nextBtn.disabled  = false; }
  sbUpdateStatus({ ...sbState, songActive: true });
  log("Central Playback started", "system");
  scheduleCentralSection(cpSectionIndex);
}

function stopCentralArrangementPlayback() {
  cpActive = false;
  if (cpTimer) clearTimeout(cpTimer);
  cpTimer = null;
  const startBtn = document.getElementById("sbStartSongBtn");
  const stopBtn  = document.getElementById("sbStopSongBtn");
  const nextBtn  = document.getElementById("sbNextSectionBtn");
  if (startBtn) { startBtn.disabled = false; }
  if (stopBtn)  { stopBtn.disabled  = true; }
  if (nextBtn)  { nextBtn.disabled  = true; }
  sbUpdateStatus({ ...sbState, songActive: false });
  sbHighlight(null, null);
  log("Central Playback stopped", "system");
}

function scheduleCentralSection(idx) {
  if (!cpActive) return;
  const sec = arrangementSections[idx];
  if (!sec) { stopCentralArrangementPlayback(); return; }
  const sectionName = sec.name;
  const bars = sec.bars;
  const bpm = Number(bpmInput.value) || 120;
  const beatsPerBar = Number(beatsPerBarSel.value) || 4;
  const msPerBar = (60000 / bpm) * beatsPerBar;
  const sectionDurationMs = msPerBar * bars;

  const nextSectionName = arrangementSections[idx + 1]?.name || null;
  sbHighlight(sectionName, nextSectionName);
  sbState.section = sectionName;
  sbState.upcoming = nextSectionName;
  sbState.barsLeft = bars;
  sbUpdateStatus(sbState);

  // ── Layered multi-loop scheduling ────────────────────────────
  const assignedIds = Array.isArray(songBoardData[sectionName]) ? songBoardData[sectionName] : [];
  const startTime = hostAudioCtx.currentTime + 0.1;

  assignedIds.forEach(loopId => {
    const loopData = passedLoopsLibrary.get(loopId);
    if (!loopData) return;
    const events = getEventsFromLoop(loopData);
    const loopLenMs = loopData.loopLengthMs || msPerBar;
    const loopsNeeded = Math.ceil(sectionDurationMs / loopLenMs);

    for (let i = 0; i < loopsNeeded; i++) {
      const loopOffset = i * (loopLenMs / 1000);
      events.forEach(ev => {
        const evTime = startTime + loopOffset + (ev.timeMs / 1000);
        if (evTime < startTime + (sectionDurationMs / 1000)) {
          playHostSound(ev.degree, ev.instrument, evTime);
        }
      });
    }
  });

  // ── Bar countdown + auto-advance ─────────────────────────────
  let currentBar = 0;
  const tick = () => {
    if (!cpActive || sbState.section !== sectionName) return;
    sbState.barsLeft = bars - currentBar;
    const barsLabel = document.getElementById(`sbCardBars_${sectionName}`);
    if (barsLabel) barsLabel.textContent = `${sbState.barsLeft} bars`;
    currentBar++;
    if (currentBar < bars) {
      cpTimer = setTimeout(tick, msPerBar);
    } else {
      cpTimer = setTimeout(() => {
        cpSectionIndex++;
        scheduleCentralSection(cpSectionIndex);
      }, msPerBar);
    }
  };
  tick();
}


// ── Section CRUD ──────────────────────────────────────────────
window.editSection = function(id) {
  const sec = arrangementSections.find(s => s.id === id);
  if (!sec) return;
  const newName = prompt("Section Name:", sec.name);
  if (newName === null) return;
  const newBarsStr = prompt("Bars:", sec.bars);
  if (newBarsStr === null) return;
  const newBars = parseInt(newBarsStr) || 4;
  
  // If name changed, migrate assignments
  if (newName.trim() && newName !== sec.name) {
    if (songBoardData[sec.name]) {
      songBoardData[newName] = songBoardData[sec.name];
      delete songBoardData[sec.name];
    }
    sec.name = newName.trim();
  }
  sec.bars = newBars;
  saveSongBoard();
  sbRenderCards();
};

window.duplicateSection = function(id) {
  const idx = arrangementSections.findIndex(s => s.id === id);
  if (idx === -1) return;
  const sec = arrangementSections[idx];
  
  // Find a unique name
  let newName = sec.name + " (Copy)";
  let counter = 1;
  while (arrangementSections.some(s => s.name === newName)) {
    counter++;
    newName = `${sec.name} (Copy ${counter})`;
  }

  const newSec = {
    id: generateSectionId(),
    name: newName,
    bars: sec.bars,
    notes: sec.notes,
    energy: sec.energy
  };

  // Copy assignments
  if (songBoardData[sec.name]) {
    songBoardData[newName] = [...songBoardData[sec.name]];
  }

  arrangementSections.splice(idx + 1, 0, newSec);
  saveSongBoard();
  sbRenderCards();
};

window.deleteSection = function(id) {
  const idx = arrangementSections.findIndex(s => s.id === id);
  if (idx === -1) return;
  const sec = arrangementSections[idx];
  if (!confirm(`Delete section "${sec.name}"?`)) return;
  
  delete songBoardData[sec.name];
  arrangementSections.splice(idx, 1);
  saveSongBoard();
  sbRenderCards();
};

window.addSection = function() {
  const newName = prompt("New Section Name:", "New Section");
  if (!newName || !newName.trim()) return;
  if (arrangementSections.some(s => s.name === newName.trim())) {
    alert("Section name must be unique.");
    return;
  }
  arrangementSections.push({
    id: generateSectionId(),
    name: newName.trim(),
    bars: 4,
    notes: "",
    energy: null
  });
  saveSongBoard();
  sbRenderCards();
};

// ── Template Picker UI ────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const sbHeader = document.querySelector(".sb-header") || document.getElementById("songBoardSections")?.parentElement;
  if (sbHeader && !document.getElementById("templatePicker")) {
    const tplDiv = document.createElement("div");
    tplDiv.style.marginBottom = "10px";
    tplDiv.style.display = "flex";
    tplDiv.style.gap = "8px";
    tplDiv.innerHTML = `
      <select id="templatePicker" class="transport-select">
        <option value="">-- Load Template --</option>
        <option value="basic">Basic Song</option>
        <option value="rock_pop">Rock/Pop</option>
        <option value="jam_session">Jam Session</option>
        <option value="classroom_abc">Classroom A/B/C</option>
        <option value="energy_build">Energy Build</option>
      </select>
      <button class="transport-btn" onclick="addSection()">+ Add Section</button>
    `;
    
    // Insert before the sections container
    const container = document.getElementById("songBoardSections");
    if (container) {
      container.parentNode.insertBefore(tplDiv, container);
    }
    
    document.getElementById("templatePicker")?.addEventListener("change", (e) => {
      if (e.target.value) {
        loadTemplate(e.target.value);
        e.target.value = "";
      }
    });
  }
});
