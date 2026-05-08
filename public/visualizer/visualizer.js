/**
 * ============================================================
 *  PulseTap Visualizer Mode — Phase 1
 *  visualizer.js
 *
 *  Read-only passive client. Subscribes to session state from
 *  the server. Zero audio playback. Zero loop scheduling.
 *
 *  Socket events consumed (server → visualizer):
 *    room:settings     { bpm, key, mode, quantize, beatsPerBar, beatUnit }
 *    metronome:start   { bpm, beatsPerBar, beatUnit, startTime }
 *    metronome:stop    {}
 *    loop:transport    { action: "start"|"stop", startTime }
 *    section:play      { section, playerIds, startTime }
 *    viz:state         { section, upcoming, barsLeft, slot, bpm, key, mode,
 *                        timeSig, energy, songActive }  ← new server relay
 *
 *  Socket events emitted (visualizer → server):
 *    viz:join          { roomId }   — joins the room as a passive observer
 * ============================================================
 */
"use strict";

// ─────────────────────────────────────────────────────────────
//  DOM refs
// ─────────────────────────────────────────────────────────────
const joinOverlay   = document.getElementById("joinOverlay");
const vizCanvas     = document.getElementById("vizCanvas");
const vizRoomInput  = document.getElementById("vizRoomCode");
const joinVizBtn    = document.getElementById("joinVizBtn");
const joinError     = document.getElementById("joinError");

const vizRoom       = document.getElementById("vizRoom");
const vizBpm        = document.getElementById("vizBpm");
const vizKey        = document.getElementById("vizKey");
const vizTimeSig    = document.getElementById("vizTimeSig");
const vizStatus     = document.getElementById("vizStatus");

const vizSection    = document.getElementById("vizSection");
const vizSlot       = document.getElementById("vizSlot");
const vizUpcoming   = document.getElementById("vizUpcoming");
const vizCountdown  = document.getElementById("vizCountdown");
const vizCountdownText = document.getElementById("vizCountdownText");
const vizBarsWrap   = document.getElementById("vizBarsWrap");
const vizBarsVal    = document.getElementById("vizBarsRemaining");
const vizBarsTrack  = document.getElementById("vizBarsTrack");

const energyFill    = document.getElementById("energyFill");
const energyLevel   = document.getElementById("energyLevel");
const vizBeatBar    = document.getElementById("vizBeatBar");
const beatRing      = document.getElementById("beatRing");

// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────
let currentRoom     = "";
let metroBpm        = 120;
let metroBeatsPerBar = 4;
let metroTimer      = null;
let metroBeat       = 0;
let metroStartEpoch = 0;
let isPlaying       = false;
let songActive      = false;

// Energy: derived from section name heuristic + tap density
let energyValue     = 0;   // 0–100
let tapTimestamps   = [];  // recent tap epoch ms for density calc

// ─────────────────────────────────────────────────────────────
//  Socket
// ─────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect",    () => setStatus("Connected · waiting for room…", "accent2"));
socket.on("disconnect", () => setStatus("Disconnected", "warn"));

// ── Join ─────────────────────────────────────────────────────
joinVizBtn.addEventListener("click", joinRoom);
vizRoomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  const code = vizRoomInput.value.trim().toUpperCase();
  if (!code) { showJoinError("Enter a room code."); return; }
  currentRoom = code;
  socket.emit("viz:join", { roomId: code });
  // Optimistically show canvas; server will push state immediately
  joinOverlay.classList.add("hidden");
  vizCanvas.classList.remove("hidden");
  vizRoom.textContent = `ROOM ${code}`;
  setStatus("Joining…", "accent2");
}

function showJoinError(msg) {
  joinError.textContent = msg;
  joinError.classList.remove("hidden");
}

// ── Session settings ─────────────────────────────────────────
socket.on("room:settings", (s) => {
  if (s.bpm)        { metroBpm = Number(s.bpm); vizBpm.textContent = s.bpm; }
  if (s.key || s.mode) {
    vizKey.textContent = `${s.key || "—"} ${s.mode || ""}`.trim();
  }
  if (s.beatsPerBar) {
    metroBeatsPerBar = Number(s.beatsPerBar);
    const bu = s.beatUnit || 4;
    vizTimeSig.textContent = `${s.beatsPerBar}/${bu}`;
    buildBeatDots(metroBeatsPerBar);
  }
});

// ── Metronome ─────────────────────────────────────────────────
socket.on("metronome:start", ({ bpm, beatsPerBar, beatUnit, startTime }) => {
  metroBpm         = Number(bpm)         || 120;
  metroBeatsPerBar = Number(beatsPerBar) || 4;
  metroStartEpoch  = startTime           || Date.now();
  vizBpm.textContent  = metroBpm;
  vizTimeSig.textContent = `${metroBeatsPerBar}/${beatUnit || 4}`;
  buildBeatDots(metroBeatsPerBar);
  startMetronomeViz(metroBpm, metroBeatsPerBar, metroStartEpoch);
  setStatus("Live", "ready");
});

socket.on("metronome:stop", () => {
  stopMetronomeViz();
  setStatus("Stopped", "accent2");
  resetBeatDots();
});

// ── Transport ─────────────────────────────────────────────────
socket.on("loop:transport", ({ action }) => {
  isPlaying = action === "start";
  setStatus(isPlaying ? "Playing" : "Stopped", isPlaying ? "ready" : "accent2");
});

// ── Section play ──────────────────────────────────────────────
socket.on("section:play", ({ section }) => {
  if (section) {
    updateSection(section, null, null, null);
    flashCanvas();
  }
});

// ── Visualizer state (new relay event from server) ────────────
socket.on("viz:state", (state) => {
  applyVizState(state);
});

// ── Tap events (for energy density) ──────────────────────────
socket.on("tap:event", () => {
  tapTimestamps.push(Date.now());
  // Keep only last 5 seconds
  const cutoff = Date.now() - 5000;
  tapTimestamps = tapTimestamps.filter(t => t > cutoff);
  updateEnergyFromTaps();
});

// ─────────────────────────────────────────────────────────────
//  Apply full viz state (from viz:state relay)
// ─────────────────────────────────────────────────────────────
function applyVizState(state) {
  if (!state) return;

  if (state.bpm)  { metroBpm = Number(state.bpm); vizBpm.textContent = state.bpm; }
  if (state.key || state.mode) {
    vizKey.textContent = `${state.key || "—"} ${state.mode || ""}`.trim();
  }
  if (state.timeSig) vizTimeSig.textContent = state.timeSig;

  songActive = !!state.songActive;

  updateSection(
    state.section  || null,
    state.upcoming || null,
    state.barsLeft != null ? state.barsLeft : null,
    state.slot     || null
  );

  if (state.energy != null) setEnergyDirect(state.energy);

  if (state.songActive) {
    setStatus("Song Running", "ready");
  } else if (isPlaying) {
    setStatus("Playing", "ready");
  }
}

// ─────────────────────────────────────────────────────────────
//  Section / countdown display
// ─────────────────────────────────────────────────────────────
let lastSection = null;

function updateSection(section, upcoming, barsLeft, slot) {
  // Section name
  if (section && section !== "—") {
    if (section !== lastSection) {
      // Animate transition
      vizSection.style.opacity = "0";
      setTimeout(() => {
        vizSection.textContent = section.toUpperCase();
        vizSection.style.opacity = "1";
        vizSection.style.transition = "opacity 0.4s ease";
      }, 200);
      lastSection = section;
      flashCanvas();
    }
  } else if (section === "—" || section === null) {
    vizSection.textContent = "—";
  }

  // Slot label
  if (slot) {
    vizSlot.textContent = `Slot ${slot}`;
  }

  // Upcoming
  if (upcoming != null) {
    vizUpcoming.textContent = upcoming !== "—" ? upcoming.toUpperCase() : "—";
  }

  // Bars remaining
  if (barsLeft != null && barsLeft !== "—") {
    const n = Number(barsLeft);
    vizBarsWrap.classList.remove("hidden");
    vizBarsVal.textContent = n;
    buildBarsTrack(n);

    // Countdown pill: show when ≤ 2 bars left and song is active
    if (songActive && n <= 2 && upcoming && upcoming !== "—" && upcoming !== "End") {
      vizCountdown.classList.remove("hidden");
      vizCountdownText.textContent = `${upcoming.toUpperCase()} IN ${n} BAR${n !== 1 ? "S" : ""}`;
    } else if (songActive && n <= 2 && (upcoming === "End" || !upcoming)) {
      vizCountdown.classList.remove("hidden");
      vizCountdownText.textContent = `ENDING IN ${n} BAR${n !== 1 ? "S" : ""}`;
    } else {
      vizCountdown.classList.add("hidden");
    }
  } else {
    vizBarsWrap.classList.add("hidden");
    vizCountdown.classList.add("hidden");
  }
}

// ─────────────────────────────────────────────────────────────
//  Bars track (pip row)
// ─────────────────────────────────────────────────────────────
let lastTotalBars = 0;

function buildBarsTrack(remaining) {
  const total = Math.max(remaining, lastTotalBars);
  lastTotalBars = total;

  // Rebuild if pip count changed
  if (vizBarsTrack.children.length !== total) {
    vizBarsTrack.innerHTML = "";
    for (let i = 0; i < total; i++) {
      const pip = document.createElement("div");
      pip.className = "bar-pip";
      vizBarsTrack.appendChild(pip);
    }
  }

  // Fill pips from left = remaining
  Array.from(vizBarsTrack.children).forEach((pip, i) => {
    pip.classList.toggle("filled", i < remaining);
  });
}

// ─────────────────────────────────────────────────────────────
//  Beat dots
// ─────────────────────────────────────────────────────────────
function buildBeatDots(count) {
  vizBeatBar.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("div");
    dot.className = "viz-beat-dot";
    vizBeatBar.appendChild(dot);
  }
}

function highlightBeat(beat) {
  const dots = vizBeatBar.querySelectorAll(".viz-beat-dot");
  dots.forEach((d, i) => {
    d.classList.toggle("beat-active",  i === beat && beat !== 0);
    d.classList.toggle("beat-accent",  i === beat && beat === 0);
  });
  // Beat ring pulse
  beatRing.className = "beat-ring";
  // Force reflow
  void beatRing.offsetWidth;
  beatRing.className = beat === 0 ? "beat-ring beat1" : "beat-ring pulse";
}

function resetBeatDots() {
  vizBeatBar.querySelectorAll(".viz-beat-dot").forEach(d => {
    d.classList.remove("beat-active", "beat-accent");
  });
  beatRing.className = "beat-ring";
}

// ─────────────────────────────────────────────────────────────
//  Metronome visualizer (client-side, no audio)
// ─────────────────────────────────────────────────────────────
function startMetronomeViz(bpm, beatsPerBar, startTime) {
  stopMetronomeViz();
  metroBeat = 0;
  const intervalMs = (60 / bpm) * 1000;
  const now = Date.now();
  let delay = Math.max(0, startTime - now);
  if (delay === 0) {
    const elapsed = now - startTime;
    const phase   = elapsed % intervalMs;
    delay = phase > 0 ? intervalMs - phase : 0;
  }
  setTimeout(() => {
    tick();
    metroTimer = setInterval(tick, intervalMs);
  }, delay);

  function tick() {
    const beat = metroBeat % beatsPerBar;
    highlightBeat(beat);
    metroBeat++;
  }
}

function stopMetronomeViz() {
  clearInterval(metroTimer);
  clearTimeout(metroTimer);
  metroTimer = null;
}

// ─────────────────────────────────────────────────────────────
//  Energy meter
// ─────────────────────────────────────────────────────────────
const ENERGY_SECTION_MAP = {
  intro:   20, verse: 40, "pre-chorus": 55,
  chorus:  80, bridge: 60, drop: 90,
  outro:   25, break: 30, solo: 70, hook: 75
};

function updateEnergyFromTaps() {
  // Tap density: taps in last 5s → 0-100 scale (cap at 20 taps = 100)
  const density = Math.min(tapTimestamps.length / 20, 1) * 100;
  // Blend with section heuristic
  energyValue = Math.round(density * 0.7 + energyValue * 0.3);
  renderEnergy(energyValue);
}

function setEnergyFromSection(sectionName) {
  if (!sectionName) return;
  const key = sectionName.toLowerCase();
  for (const [k, v] of Object.entries(ENERGY_SECTION_MAP)) {
    if (key.includes(k)) { energyValue = v; renderEnergy(v); return; }
  }
  // Default mid
  energyValue = 50; renderEnergy(50);
}

function setEnergyDirect(value) {
  energyValue = Math.max(0, Math.min(100, Number(value)));
  renderEnergy(energyValue);
}

function renderEnergy(value) {
  energyFill.style.width = `${value}%`;
  let label, color;
  if (value < 35)      { label = "Low";    color = "var(--energy-low)"; }
  else if (value < 65) { label = "Medium"; color = "var(--energy-med)"; }
  else                 { label = "High";   color = "var(--energy-hi)"; }
  energyFill.style.background = color;
  energyLevel.textContent = label;
  energyLevel.style.color  = color;
}

// ─────────────────────────────────────────────────────────────
//  Status helper
// ─────────────────────────────────────────────────────────────
function setStatus(text, type) {
  vizStatus.textContent = text;
  vizStatus.style.color = type === "ready"   ? "var(--energy-low)"
                        : type === "warn"    ? "var(--energy-hi)"
                        : "var(--accent2)";
}

// ─────────────────────────────────────────────────────────────
//  Canvas flash on section change
// ─────────────────────────────────────────────────────────────
function flashCanvas() {
  vizCanvas.classList.remove("section-flash");
  void vizCanvas.offsetWidth;
  vizCanvas.classList.add("section-flash");
  setTimeout(() => vizCanvas.classList.remove("section-flash"), 600);
}

// ─────────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────────
buildBeatDots(4);
renderEnergy(0);
