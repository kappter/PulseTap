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
  // Also sync into Rehearsal Mode
  if (typeof applyRoomSettingsToRehearsal === "function") applyRoomSettingsToRehearsal(s);
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
  // Also sync into Rehearsal Mode
  if (typeof applyVizStateToRehearsal === "function") applyVizStateToRehearsal(state);
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
//  Playback Mode Engine
// ─────────────────────────────────────────────────────────────
const PART_LANES = ["Guitar", "Bass", "Drums", "Keys", "Vocals"];

// Default arrangement format
const DEFAULT_ARRANGEMENT = {
  title:    "Untitled",
  bpm:      120,
  key:      "C",
  mode:     "major",
  timeSig:  "4/4",
  sections: [
    { name: "Intro",  bars: 4,  slot: 1, notes: "" },
    { name: "Verse",  bars: 8,  slot: 2, notes: "" },
    { name: "Chorus", bars: 8,  slot: 3, notes: "" },
    { name: "Bridge", bars: 4,  slot: 4, notes: "" },
    { name: "Outro",  bars: 4,  slot: 5, notes: "" }
  ],
  // partLanes: per-part intensity per section [0-100]
  partLanes: {
    Guitar: [30, 60, 90, 70, 20],
    Bass:   [40, 70, 90, 60, 20],
    Drums:  [20, 50, 100, 80, 10],
    Keys:   [50, 40, 80, 90, 30],
    Vocals: [0,  60, 100, 70, 20]
  },
  notes: ""
};

let pbMode         = "live";      // "live" | "playback"
let pbArrangement  = JSON.parse(JSON.stringify(DEFAULT_ARRANGEMENT));
let pbPlaying      = false;
let pbSectionIndex = 0;
let pbBarCount     = 0;           // bars elapsed in current section
let pbBpm          = 120;
let pbTimer        = null;        // setInterval handle
let pbBeatsPerBar  = 4;
let pbBeatCount    = 0;           // beats elapsed in current section

// DOM refs (Playback Mode)
const modeLiveBtn       = document.getElementById("modeLiveBtn");
const modePlaybackBtn   = document.getElementById("modePlaybackBtn");
const playbackControls  = document.getElementById("playbackControls");
const partTimeline      = document.getElementById("partTimeline");
const timelineCanvas    = document.getElementById("timelineCanvas");
const timelinePlayhead  = document.getElementById("timelinePlayhead");
const pbPlayBtn         = document.getElementById("pbPlayBtn");
const pbRestartBtn      = document.getElementById("pbRestartBtn");
const pbSlowerBtn       = document.getElementById("pbSlowerBtn");
const pbFasterBtn       = document.getElementById("pbFasterBtn");
const pbBpmSlider       = document.getElementById("pbBpmSlider");
const pbBpmDisplay      = document.getElementById("pbBpmDisplay");
const pbImportBtn       = document.getElementById("pbImportBtn");
const pbExportBtn       = document.getElementById("pbExportBtn");
const ioModal           = document.getElementById("ioModal");
const ioModalTitle      = document.getElementById("ioModalTitle");
const ioModalClose      = document.getElementById("ioModalClose");
const ioModalTextarea   = document.getElementById("ioModalTextarea");
const ioModalConfirm    = document.getElementById("ioModalConfirm");
const ioModalCopy       = document.getElementById("ioModalCopy");
const ioModalStatus     = document.getElementById("ioModalStatus");

// ── Mode switch ───────────────────────────────────────────────
function switchMode(mode) {
  pbMode = mode;
  modeLiveBtn.classList.toggle("mode-btn-active",     mode === "live");
  modePlaybackBtn.classList.toggle("mode-btn-active", mode === "playback");
  playbackControls.classList.toggle("hidden",  mode !== "playback");
  partTimeline.classList.toggle("hidden",      mode !== "playback");
  if (mode === "playback") {
    pbBpm = pbArrangement.bpm || 120;
    pbBpmSlider.value = pbBpm;
    pbBpmDisplay.textContent = `${pbBpm} BPM`;
    pbBeatsPerBar = parseInt((pbArrangement.timeSig || "4/4").split("/")[0]) || 4;
    renderTimeline();
    pbGoToSection(0);
    setStatus("Playback Mode", "accent2");
  } else {
    pbStop();
    setStatus(isPlaying ? "Playing" : "Waiting…", isPlaying ? "ready" : "accent2");
  }
}
modeLiveBtn.addEventListener("click",     () => switchMode("live"));
modePlaybackBtn.addEventListener("click", () => switchMode("playback"));

// ── Playback transport ────────────────────────────────────────

// ── Playback Engine (Rehearsal Mode) ──────────────────────────
let pbNextBarTime = 0;
let pbSectionTimeout = null;

function pbPlay() {
  if (pbPlaying) return;
  initVizAudio();
  pbPlaying = true;
  pbPlayBtn.textContent = "⏸";
  pbPlayBtn.title = "Pause";
  
  if (vizAudioCtx.state === "suspended") vizAudioCtx.resume();
  
  // Start scheduling from now
  pbNextBarTime = vizAudioCtx.currentTime + 0.1;
  pbBeatCount = 0;
  
  // Schedule first bar immediately
  pbScheduleBar();
}

function pbPause() {
  pbPlaying = false;
  pbPlayBtn.textContent = "▶";
  pbPlayBtn.title = "Play";
  if (pbSectionTimeout) clearTimeout(pbSectionTimeout);
  pbSectionTimeout = null;
}

function pbStop() {
  pbPause();
  pbBarCount = 0;
  pbBeatCount = 0;
}

function pbRestart() {
  pbStop();
  pbGoToSection(0);
}

function pbGoToSection(idx) {
  const secs = pbArrangement.songStructure || pbArrangement.sections || [];
  if (idx < 0 || idx >= secs.length) return;
  pbSectionIndex = idx;
  pbBarCount     = 0;
  pbBeatCount    = 0;
  const sec = secs[idx];
  updateSection(sec.name, secs[idx + 1] ? secs[idx + 1].name : "End",
                sec.bars, sec.slot || "—");
  setEnergyFromSection(sec.name);
  updatePlayhead();
  flashCanvas();
  updateReferencePanel();
}

function pbScheduleBar() {
  if (!pbPlaying) return;
  
  const secs = pbArrangement.songStructure || pbArrangement.sections || [];
  if (pbSectionIndex >= secs.length) {
    pbPause();
    setStatus("Playback complete", "accent2");
    updateSection("—", "—", 0, "—");
    return;
  }
  
  const sec = secs[pbSectionIndex];
  const barDuration = (60 / pbBpm) * pbBeatsPerBar;
  
  // Schedule audio for this bar
  scheduleSectionAudio(sec.name, pbNextBarTime, barDuration);
  
  // Visuals for this bar
  const msPerBeat = (60 / pbBpm) * 1000;
  let beatTime = 0;
  for (let i = 0; i < pbBeatsPerBar; i++) {
    setTimeout(() => {
      if (!pbPlaying) return;
      highlightBeat(i);
    }, beatTime);
    beatTime += msPerBeat;
  }
  
  pbBarCount++;
  const barsLeft = (sec.bars || 4) - pbBarCount;
  const nextSec = secs[pbSectionIndex + 1];
  updateSection(sec.name, nextSec ? nextSec.name : "End", barsLeft, sec.slot || "—");
  updatePlayhead();
  
  // Advance section if needed
  if (pbBarCount >= (sec.bars || 4)) {
    pbSectionIndex++;
    pbBarCount = 0;
    pbBeatCount = 0;
    if (pbSectionIndex < secs.length) {
      const next = secs[pbSectionIndex];
      setTimeout(() => {
        if (!pbPlaying) return;
        updateSection(next.name, secs[pbSectionIndex + 1] ? secs[pbSectionIndex + 1].name : "End",
                      next.bars, next.slot || "—");
        setEnergyFromSection(next.name);
        flashCanvas();
        updateReferencePanel();
      }, barDuration * 1000 - 50); // Just before the next bar starts
    }
  }
  
  // Schedule next bar
  pbNextBarTime += barDuration;
  const timeToNextBar = (pbNextBarTime - vizAudioCtx.currentTime) * 1000;
  pbSectionTimeout = setTimeout(pbScheduleBar, timeToNextBar - 100); // 100ms lookahead
}

function scheduleSectionAudio(sectionName, startTime, barDuration) {
  if (!pbArrangement.arrangementAssignments || !pbArrangement.loopLibrary) return;
  
  const assignments = pbArrangement.arrangementAssignments[sectionName];
  if (!assignments) return;
  
  // Handle both v1.0 (object) and v1.1 (array of loopIds)
  let loopIds = [];
  if (Array.isArray(assignments)) {
    loopIds = assignments;
  } else if (assignments.playerId) {
    // Fallback for v1.0
    const loop = pbArrangement.loopLibrary.find(l => l.playerId === assignments.playerId);
    if (loop && loop.loopId) loopIds.push(loop.loopId);
  }
  
  loopIds.forEach(lid => {
    const loop = pbArrangement.loopLibrary.find(l => l.loopId === lid);
    if (!loop) return;
    
    // Calculate how many times this loop repeats in a bar
    const loopLenSec = loop.loopLengthMs / 1000;
    const repeats = Math.max(1, Math.round(barDuration / loopLenSec));
    
    for (let r = 0; r < repeats; r++) {
      const loopStart = startTime + (r * loopLenSec);
      
      // Schedule loopEvents
      if (loop.loopEvents) {
        loop.loopEvents.forEach(ev => {
          const evTime = loopStart + (ev.time / 1000);
          playVizSound(ev.degree, loop.instrument || "synth", evTime, ev.velocity);
        });
      }
      
      // Schedule stepGridEvents
      if (loop.stepGridEvents) {
        const stepDuration = loopLenSec / (loop.stepGridSteps || 16);
        loop.stepGridEvents.forEach(ev => {
          const evTime = loopStart + (ev.step * stepDuration);
          playVizSound(ev.degree, loop.instrument || "synth", evTime, ev.velocity);
        });
      }
    }
  });
}

// ── BPM controls ──────────────────────────────────────────────
function pbSetBpm(bpm) {
  pbBpm = Math.max(40, Math.min(240, bpm));
  pbBpmSlider.value   = pbBpm;
  pbBpmDisplay.textContent = `${pbBpm} BPM`;
  if (pbPlaying) { pbPause(); pbPlay(); }   // restart interval at new BPM
}
pbPlayBtn.addEventListener("click",    () => pbPlaying ? pbPause() : pbPlay());
pbRestartBtn.addEventListener("click", () => pbRestart());
pbSlowerBtn.addEventListener("click",  () => pbSetBpm(pbBpm - 5));
pbFasterBtn.addEventListener("click",  () => pbSetBpm(pbBpm + 5));
pbBpmSlider.addEventListener("input",  () => pbSetBpm(Number(pbBpmSlider.value)));

// ── Part Timeline renderer ────────────────────────────────────
const LANE_COLORS = {
  Guitar: "#00e5ff",
  Bass:   "#ff6b35",
  Drums:  "#ff3b6b",
  Keys:   "#a78bfa",
  Vocals: "#34d399"
};
const LANE_H    = 28;   // px per lane
const LABEL_W   = 64;   // px for lane label column
const SECTION_GAP = 2;  // px gap between sections

function renderTimeline() {
  if (!timelineCanvas) return;
  const secs    = pbArrangement.sections || [];
  const totalBars = secs.reduce((s, sec) => s + (sec.bars || 4), 0);
  const dpr     = window.devicePixelRatio || 1;
  const cssW    = timelineCanvas.parentElement.clientWidth || 800;
  const cssH    = PART_LANES.length * LANE_H + 24; // +24 for section labels row
  timelineCanvas.style.width  = cssW + "px";
  timelineCanvas.style.height = cssH + "px";
  timelineCanvas.width  = cssW * dpr;
  timelineCanvas.height = cssH * dpr;
  const ctx = timelineCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  const drawW = cssW - LABEL_W;
  const barW  = drawW / totalBars;

  // Draw section label row (top)
  let xCursor = LABEL_W;
  secs.forEach((sec) => {
    const secW = barW * sec.bars - SECTION_GAP;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(xCursor, 0, secW, 20);
    ctx.fillStyle = "#aaa";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(sec.name.toUpperCase(), xCursor + 4, 10);
    xCursor += barW * sec.bars;
  });

  // Draw lane rows
  PART_LANES.forEach((lane, laneIdx) => {
    const y = 24 + laneIdx * LANE_H;
    // Lane label
    ctx.fillStyle = "#666";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(lane, 4, y + LANE_H / 2);
    // Lane background
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(LABEL_W, y, drawW, LANE_H - 2);
    // Section intensity blocks
    let xc = LABEL_W;
    secs.forEach((sec, secIdx) => {
      const intensity = (pbArrangement.partLanes[lane] || [])[secIdx] ?? 50;
      const secW = barW * sec.bars - SECTION_GAP;
      const alpha = 0.15 + (intensity / 100) * 0.65;
      const color = LANE_COLORS[lane] || "#888";
      ctx.fillStyle = hexToRgba(color, alpha);
      ctx.fillRect(xc, y + 2, secW, LANE_H - 4);
      // Intensity text if block is wide enough
      if (secW > 28) {
        ctx.fillStyle = hexToRgba(color, 0.9);
        ctx.font = "9px system-ui, sans-serif";
        ctx.fillText(`${intensity}`, xc + 4, y + LANE_H / 2);
      }
      xc += barW * sec.bars;
    });
  });
  // Store for playhead
  timelineCanvas._totalBars = totalBars;
  timelineCanvas._barW      = barW;
  timelineCanvas._labelW    = LABEL_W;
}

function updatePlayhead() {
  if (!timelineCanvas || !timelinePlayhead) return;
  const secs = pbArrangement.sections || [];
  const totalBars = secs.reduce((s, sec) => s + (sec.bars || 4), 0);
  if (totalBars === 0) return;
  // Bars elapsed = bars in completed sections + current section bars elapsed
  let barsElapsed = 0;
  for (let i = 0; i < pbSectionIndex; i++) barsElapsed += secs[i].bars || 4;
  barsElapsed += pbBarCount;
  const cssW  = timelineCanvas.clientWidth || 800;
  const drawW = cssW - LABEL_W;
  const barW  = drawW / totalBars;
  const x     = LABEL_W + barsElapsed * barW;
  timelinePlayhead.style.left   = x + "px";
  timelinePlayhead.style.height = timelineCanvas.style.height;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Re-render timeline on resize
window.addEventListener("resize", () => {
  if (pbMode === "playback") { renderTimeline(); updatePlayhead(); }
});

// ── Import / Export ───────────────────────────────────────────
function openImportModal() {
  ioModalTitle.textContent   = "Import Arrangement";
  ioModalTextarea.value      = "";
  ioModalTextarea.readOnly   = false;
  ioModalConfirm.textContent = "Load";
  ioModalConfirm.classList.remove("hidden");
  ioModalCopy.classList.add("hidden");
  ioModalStatus.textContent  = "";
  ioModal.classList.remove("hidden");
  ioModalTextarea.focus();
}
function openExportModal() {
  // Collect notes from rehearsal panel if available
  try {
    const rhCards = document.querySelectorAll(".rh-section-card");
    rhCards.forEach(card => {
      const name = card.dataset.section;
      const ta   = card.querySelector(".rh-section-notes");
      const entry = pbArrangement.sections.find(s => s.name === name);
      if (entry && ta) entry.notes = ta.value;
    });
    const rhNotes = document.getElementById("rhArrangementNotes");
    if (rhNotes) pbArrangement.notes = rhNotes.value;
  } catch(e) {}
  ioModalTitle.textContent   = "Export Arrangement";
  ioModalTextarea.value      = JSON.stringify(pbArrangement, null, 2);
  ioModalTextarea.readOnly   = true;
  ioModalConfirm.classList.add("hidden");
  ioModalCopy.classList.remove("hidden");
  ioModalStatus.textContent  = "";
  ioModal.classList.remove("hidden");
}
function closeIoModal() {
  ioModal.classList.add("hidden");
}
function loadArrangementFromJson(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.songStructure && !parsed.sections) throw new Error("Missing arrangement structure");
    
    // Normalize .ptarr format to internal playback format
    pbArrangement = parsed;
    if (!pbArrangement.sections && pbArrangement.songStructure) {
      pbArrangement.sections = pbArrangement.songStructure;
    }
    
    // Ensure partLanes exists for timeline
    if (!pbArrangement.partLanes) pbArrangement.partLanes = {};
    pbArrangement = Object.assign(JSON.parse(JSON.stringify(DEFAULT_ARRANGEMENT)), parsed);
    // Ensure partLanes has all lanes
    PART_LANES.forEach(lane => {
      if (!pbArrangement.partLanes[lane]) {
        pbArrangement.partLanes[lane] = pbArrangement.sections.map(() => 50);
      }
    });
    pbBpm = pbArrangement.bpm || 120;
    pbBpmSlider.value = pbBpm;
    pbBpmDisplay.textContent = `${pbBpm} BPM`;
    pbBeatsPerBar = parseInt((pbArrangement.timeSig || "4/4").split("/")[0]) || 4;
    renderTimeline();
    pbGoToSection(0);
    // Sync meta bar
    vizBpm.textContent = pbBpm;
    vizKey.textContent = `${pbArrangement.key || "—"} ${pbArrangement.mode || ""}`.trim();
    vizTimeSig.textContent = pbArrangement.timeSig || "4/4";
    buildBeatDots(pbBeatsPerBar);
    ioModalStatus.textContent = "Loaded!";
    setTimeout(closeIoModal, 800);
    return true;
  } catch(e) {
    ioModalStatus.textContent = "Error: " + e.message;
    return false;
  }
}

pbImportBtn.addEventListener("click", openImportModal);
pbExportBtn.addEventListener("click", openExportModal);
ioModalClose.addEventListener("click", closeIoModal);
ioModalConfirm.addEventListener("click", () => {
  loadArrangementFromJson(ioModalTextarea.value.trim());
});
ioModalCopy.addEventListener("click", () => {
  navigator.clipboard.writeText(ioModalTextarea.value).then(() => {
    ioModalStatus.textContent = "Copied!";
  }).catch(() => {
    ioModalStatus.textContent = "Copy failed — select all and copy manually.";
  });
});
// Close modal on backdrop click
ioModal.addEventListener("click", (e) => {
  if (e.target === ioModal) closeIoModal();
});

// ─────────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────────
buildBeatDots(4);
renderEnergy(0);

// ── URL room-code pre-fill ────────────────────────────────────
(function prefillRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room") || params.get("ROOM");
  if (roomParam) {
    const code = roomParam.trim().toUpperCase();
    vizRoomInput.value = code;
    // Also pre-fill rehearsal room input if present
    const rhInput = document.getElementById("rhRoomCode");
    if (rhInput) rhInput.value = code;
  }
})();

// ── Host/Player viz-launch button wiring (host.js / player.js
//    set window.__pulsetapRoomCode before opening the visualizer)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  Rehearsal Mode
// ─────────────────────────────────────────────────────────────
const rehearsalPanel    = document.getElementById("rehearsalPanel");
const rehearsalModeBtn  = document.getElementById("rehearsalModeBtn");
const rhCloseBtn        = document.getElementById("rhCloseBtn");
const rhSectionList     = document.getElementById("rhSectionList");
const rhLoadBtn         = document.getElementById("rhLoadBtn");
const rhLoadStatus      = document.getElementById("rhLoadStatus");
const rhRoomCodeInput   = document.getElementById("rhRoomCode");
const rhArrangementNotes = document.getElementById("rhArrangementNotes");

// Rehearsal state – populated from live room or manual entry
let rehearsalData = {
  title:   "Untitled Arrangement",
  bpm:     "—",
  key:     "—",
  mode:    "—",
  timeSig: "—",
  sections: []  // [{ name, slot, bars, notes }]
};

// Open / close
if (rehearsalModeBtn) {
  rehearsalModeBtn.addEventListener("click", () => {
    // Hide join overlay, show rehearsal panel
    joinOverlay.classList.add("hidden");
    rehearsalPanel.classList.remove("hidden");
    renderRehearsalSections();
  });
}
if (rhCloseBtn) {
  rhCloseBtn.addEventListener("click", () => {
    rehearsalPanel.classList.add("hidden");
    joinOverlay.classList.remove("hidden");
  });
}

// Load arrangement from a live room
if (rhLoadBtn) {
  rhLoadBtn.addEventListener("click", () => {
    const code = (rhRoomCodeInput ? rhRoomCodeInput.value.trim().toUpperCase() : "") ||
                 vizRoomInput.value.trim().toUpperCase();
    if (!code) { rhLoadStatus.textContent = "Enter a room code first."; return; }
    rhLoadStatus.textContent = "Connecting…";
    // Join as viz observer to pull room:settings
    currentRoom = code;
    socket.emit("viz:join", { roomId: code });
    rhLoadStatus.textContent = "Waiting for room state…";
    // room:settings will fire and populate rehearsalData via applyRoomSettingsToRehearsal()
  });
}

// Sync room:settings into rehearsal meta bar
function applyRoomSettingsToRehearsal(s) {
  if (s.bpm)  { rehearsalData.bpm = String(s.bpm); document.getElementById("rhBpm").textContent = s.bpm; }
  if (s.key)  { rehearsalData.key = s.key;  document.getElementById("rhKey").textContent = s.key; }
  if (s.mode) { rehearsalData.mode = s.mode; document.getElementById("rhMode").textContent = s.mode; }
  if (s.beatsPerBar) {
    const bu = s.beatUnit || 4;
    rehearsalData.timeSig = `${s.beatsPerBar}/${bu}`;
    document.getElementById("rhTimeSig").textContent = rehearsalData.timeSig;
  }
  rhLoadStatus.textContent = "Room state loaded.";
}

// Sync viz:state song sections into rehearsal section list
function applyVizStateToRehearsal(state) {
  if (!state) return;
  // Update meta
  if (state.bpm)  document.getElementById("rhBpm").textContent  = state.bpm;
  if (state.key)  document.getElementById("rhKey").textContent  = state.key;
  if (state.mode) document.getElementById("rhMode").textContent = state.mode;
  if (state.timeSig) document.getElementById("rhTimeSig").textContent = state.timeSig;
  // Build or update section entry for the current section
  if (state.section && state.section !== "—") {
    let entry = rehearsalData.sections.find(s => s.name === state.section);
    if (!entry) {
      entry = { name: state.section, slot: state.slot || "—", bars: state.barsLeft || "—", notes: "" };
      rehearsalData.sections.push(entry);
    } else {
      if (state.slot)    entry.slot = state.slot;
      if (state.barsLeft !== undefined) entry.bars = state.barsLeft;
    }
    renderRehearsalSections();
    // Highlight active section
    highlightRehearsalSection(state.section);
  }
}

// Render section cards
function renderRehearsalSections() {
  if (!rhSectionList) return;
  // Preserve existing notes from inputs before re-render
  rhSectionList.querySelectorAll(".rh-section-card").forEach(card => {
    const name = card.dataset.section;
    const textarea = card.querySelector(".rh-section-notes");
    if (name && textarea) {
      const entry = rehearsalData.sections.find(s => s.name === name);
      if (entry) entry.notes = textarea.value;
    }
  });
  // If no sections yet, show placeholder
  if (rehearsalData.sections.length === 0) {
    rhSectionList.innerHTML = '<div class="rh-empty">No sections loaded yet. Load from a room or connect to a live session.</div>';
    return;
  }
  rhSectionList.innerHTML = rehearsalData.sections.map((sec, i) => `
    <div class="rh-section-card" data-section="${sec.name}" data-index="${i}">
      <div class="rh-section-head">
        <span class="rh-section-name">${sec.name}</span>
        <span class="rh-section-meta">Slot ${sec.slot} · ${sec.bars} bars</span>
      </div>
      <textarea class="rh-section-notes" placeholder="Cues, notes, lyrics sketch…" rows="2">${sec.notes || ""}</textarea>
    </div>
  `).join("");
  // Auto-save notes on input
  rhSectionList.querySelectorAll(".rh-section-notes").forEach(ta => {
    ta.addEventListener("input", saveRehearsalToLocalStorage);
  });
}

// Highlight active section card
function highlightRehearsalSection(sectionName) {
  if (!rhSectionList) return;
  rhSectionList.querySelectorAll(".rh-section-card").forEach(card => {
    card.classList.toggle("rh-section-active", card.dataset.section === sectionName);
  });
}

// Persist rehearsal data to localStorage
function saveRehearsalToLocalStorage() {
  // Collect notes from DOM
  rhSectionList.querySelectorAll(".rh-section-card").forEach(card => {
    const name = card.dataset.section;
    const ta = card.querySelector(".rh-section-notes");
    const entry = rehearsalData.sections.find(s => s.name === name);
    if (entry && ta) entry.notes = ta.value;
  });
  if (rhArrangementNotes) rehearsalData.arrangementNotes = rhArrangementNotes.value;
  try {
    localStorage.setItem("pulsetap_rehearsal_data", JSON.stringify(rehearsalData));
  } catch(e) {}
}

// Restore rehearsal data from localStorage
(function loadRehearsalFromLocalStorage() {
  try {
    const saved = localStorage.getItem("pulsetap_rehearsal_data");
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(rehearsalData, parsed);
      // Restore meta bar
      if (rehearsalData.bpm)    document.getElementById("rhBpm").textContent    = rehearsalData.bpm;
      if (rehearsalData.key)    document.getElementById("rhKey").textContent    = rehearsalData.key;
      if (rehearsalData.mode)   document.getElementById("rhMode").textContent   = rehearsalData.mode;
      if (rehearsalData.timeSig) document.getElementById("rhTimeSig").textContent = rehearsalData.timeSig;
      if (rehearsalData.title)  document.getElementById("rhTitle").textContent  = rehearsalData.title;
      if (rehearsalData.arrangementNotes && rhArrangementNotes)
        rhArrangementNotes.value = rehearsalData.arrangementNotes;
    }
  } catch(e) {}
})();

// Wire arrangement notes auto-save
if (rhArrangementNotes) {
  rhArrangementNotes.addEventListener("input", saveRehearsalToLocalStorage);
}

// ── Visualizer Audio Layer ──────────────────────────────────
let vizAudioCtx = null;
let vizMasterGain = null;

function initVizAudio() {
  if (vizAudioCtx) {
    if (vizAudioCtx.state === "suspended") vizAudioCtx.resume();
    return;
  }
  vizAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  vizMasterGain = vizAudioCtx.createGain();
  vizMasterGain.gain.value = 0.8;
  vizMasterGain.connect(vizAudioCtx.destination);
}

document.body.addEventListener("pointerdown", initVizAudio, { once: true });

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

function vizPadFrequency(degree) {
  const root  = HOST_KEY_FREQ[pbArrangement.key] || 261.63;
  const scale = HOST_SCALES[pbArrangement.mode]  || HOST_SCALES.major;
  return hostSemitoneToHz(root, scale[degree] ?? 0);
}

// ── Synth voices ──────────────────────────────────────────────
function vizSynthTone(freq, type, velocity, time) {
  const osc = vizAudioCtx.createOscillator();
  const gain = vizAudioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  gain.gain.setValueAtTime(0.4 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  osc.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.25);
}
function hostSynthKick(time) {
  const osc = vizAudioCtx.createOscillator();
  const gain = vizAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.1);
  gain.gain.setValueAtTime(1.0, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
  osc.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.13);
}
function hostSynthSnare(time) {
  const noise = vizAudioCtx.createBufferSource();
  const buffer = vizAudioCtx.createBuffer(1, vizAudioCtx.sampleRate * 0.2, vizAudioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.buffer = buffer;
  const filter = vizAudioCtx.createBiquadFilter();
  filter.type = "highpass"; filter.frequency.value = 1000;
  const gain = vizAudioCtx.createGain();
  gain.gain.setValueAtTime(0.7, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  noise.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  noise.start(time); noise.stop(time + 0.2);
}
function hostSynthHiHat(time) {
  const noise = vizAudioCtx.createBufferSource();
  const buffer = vizAudioCtx.createBuffer(1, vizAudioCtx.sampleRate * 0.05, vizAudioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.buffer = buffer;
  const filter = vizAudioCtx.createBiquadFilter();
  filter.type = "highpass"; filter.frequency.value = 5000;
  const gain = vizAudioCtx.createGain();
  gain.gain.setValueAtTime(0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  noise.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  noise.start(time); noise.stop(time + 0.05);
}
function hostSynthTom(freq, time) {
  const osc = vizAudioCtx.createOscillator();
  const gain = vizAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
  osc.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.25);
}
function hostSynthBass(freq, velocity, time) {
  const osc = vizAudioCtx.createOscillator();
  const filter = vizAudioCtx.createBiquadFilter();
  const gain = vizAudioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(freq / 2, time);
  filter.type = "lowpass"; filter.frequency.setValueAtTime(400 + velocity * 800, time);
  gain.gain.setValueAtTime(0.6 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.25);
  osc.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.3);
}
function hostSynthPluck(freq, velocity, time) {
  const osc = vizAudioCtx.createOscillator();
  const filter = vizAudioCtx.createBiquadFilter();
  const gain = vizAudioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "highpass"; filter.frequency.setValueAtTime(800 + velocity * 800, time);
  gain.gain.setValueAtTime(0.7 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  osc.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.12);
}
function hostSynthBell(freq, velocity, time) {
  const osc1 = vizAudioCtx.createOscillator();
  const osc2 = vizAudioCtx.createOscillator();
  const gain = vizAudioCtx.createGain();
  osc1.type = "sine"; osc2.type = "sine";
  osc1.frequency.setValueAtTime(freq, time);
  osc2.frequency.setValueAtTime(freq * 2.01, time);
  gain.gain.setValueAtTime(0.5 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.2);
  osc1.connect(gain); osc2.connect(gain); gain.connect(vizMasterGain);
  osc1.start(time); osc2.start(time);
  osc1.stop(time + 1.3); osc2.stop(time + 1.3);
}
function hostSynthPad(freq, velocity, time) {
  const osc = vizAudioCtx.createOscillator();
  const filter = vizAudioCtx.createBiquadFilter();
  const gain = vizAudioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "lowpass"; filter.frequency.setValueAtTime(800 + velocity * 1200, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.3 * velocity, time + 0.3);
  gain.gain.linearRampToValueAtTime(0.0001, time + 1.5);
  osc.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 1.6);
}
function hostSynthLead(freq, velocity, time) {
  const osc = vizAudioCtx.createOscillator();
  const filter = vizAudioCtx.createBiquadFilter();
  const gain = vizAudioCtx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, time);
  filter.type = "bandpass"; filter.frequency.setValueAtTime(freq * (1.5 + velocity), time);
  gain.gain.setValueAtTime(0.5 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
  osc.connect(filter); filter.connect(gain); gain.connect(vizMasterGain);
  osc.start(time); osc.stop(time + 0.35);
}

function playVizSound(degree, instrument, time, velocity = 1) {
  if (!vizAudioCtx) return;
  const freq = vizPadFrequency(degree);
  switch (instrument) {
    case "sine":     vizSynthTone(freq, "sine",     velocity, time); break;
    case "triangle": vizSynthTone(freq, "triangle", velocity, time); break;
    case "square":   vizSynthTone(freq, "square",   velocity, time); break;
    case "sawtooth": vizSynthTone(freq, "sawtooth", velocity, time); break;
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
    default: vizSynthTone(freq, "sine", velocity, time);
  }
}



// ── Musician Reference Panel ──────────────────────────────────
const vizRefPanel = document.getElementById("vizRefPanel");
const refScaleNotes = document.getElementById("refScaleNotes");
const refPianoMap = document.getElementById("refPianoMap");
const refGuitarMap = document.getElementById("refGuitarMap");

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MODES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 2, 3, 5, 7, 8, 10],
  lydian:     [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian:    [0, 2, 4, 6, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
  blues:      [0, 3, 5, 6, 7, 10]
};

const GUITAR_STRINGS = [4, 11, 7, 2, 9, 4]; // E, B, G, D, A, E (0-indexed from C)

function getScaleIndices(key, mode) {
  if (!key || !mode) return [];
  const rootIdx = NOTES.indexOf(key.replace("m", "").trim());
  if (rootIdx === -1) return [];
  const intervals = MODES[mode.toLowerCase()] || MODES.major;
  return intervals.map(i => (rootIdx + i) % 12);
}

function updateReferencePanel() {
  if (pbMode !== "playback") {
    if (vizRefPanel) vizRefPanel.classList.add("hidden");
    return;
  }
  
  if (vizRefPanel) vizRefPanel.classList.remove("hidden");
  
  const key = pbArrangement.key || "C";
  const mode = pbArrangement.mode || "major";
  const scaleIndices = getScaleIndices(key, mode);
  
  if (scaleIndices.length === 0) {
    if (refScaleNotes) refScaleNotes.textContent = "—";
    return;
  }
  
  // 1. Scale Notes
  const scaleNames = scaleIndices.map(i => NOTES[i]);
  if (refScaleNotes) {
    refScaleNotes.innerHTML = scaleNames.map((n, i) => 
      `<span class="${i === 0 ? 'root-note' : ''}">${n}</span>`
    ).join(" - ");
  }
  
  // 2. Piano Map (2 octaves)
  if (refPianoMap) {
    let html = "";
    for (let i = 0; i < 24; i++) {
      const noteIdx = i % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(noteIdx);
      const inScale = scaleIndices.includes(noteIdx);
      const isRoot = noteIdx === scaleIndices[0];
      
      let classes = isBlack ? "key-black" : "key-white";
      if (inScale) classes += " in-scale";
      if (isRoot) classes += " is-root";
      
      html += `<div class="${classes}"></div>`;
    }
    refPianoMap.innerHTML = html;
  }
  
  // 3. Guitar Map (first 12 frets)
  if (refGuitarMap) {
    let html = `<div class="fretboard">`;
    // Nut/Fret markers
    html += `<div class="fret-markers">`;
    for (let f = 0; f <= 12; f++) {
      html += `<div class="fret-marker ${f === 0 ? 'nut' : ''} ${[3,5,7,9,12].includes(f) ? 'dot' : ''}"></div>`;
    }
    html += `</div>`;
    
    // Strings
    GUITAR_STRINGS.forEach(openString => {
      html += `<div class="string">`;
      for (let fret = 0; fret <= 12; fret++) {
        const noteIdx = (openString + fret) % 12;
        const inScale = scaleIndices.includes(noteIdx);
        const isRoot = noteIdx === scaleIndices[0];
        
        if (inScale) {
          html += `<div class="note-dot ${isRoot ? 'is-root' : ''}" style="left: ${(fret / 12) * 100}%">${NOTES[noteIdx]}</div>`;
        }
      }
      html += `</div>`;
    });
    html += `</div>`;
    refGuitarMap.innerHTML = html;
  }
}

// Hook into mode switch
const originalSwitchMode = switchMode;
switchMode = function(mode) {
  originalSwitchMode(mode);
  updateReferencePanel();
};
