/**
 * ============================================================
 *  PulseTap  ·  Phase 1  ·  player.js
 * ============================================================
 *
 *  Design principle: the player's own tap ALWAYS plays immediately
 *  on their device. Socket.IO relay is fire-and-forget — network
 *  latency never blocks local audio.
 *
 *  Audio architecture
 *  ───────────────────
 *  AudioContext (latencyHint: "interactive")
 *    └── masterGain  (volume control)
 *          └── destination
 *
 *  Each tap creates a short-lived oscillator or noise node that
 *  is connected → masterGain → destination and then discarded.
 *
 *  Metronome
 *  ──────────
 *  The host sends a "metronome:start" event with a startTime
 *  (epoch ms). Each client independently schedules beats using
 *  the Web Audio clock (audioCtx.currentTime) offset from
 *  performance.now() to minimise drift. This gives tight local
 *  timing without requiring a perfectly synchronised server clock.
 * ============================================================
 */

"use strict";

// ─────────────────────────────────────────────────────────────
//  Scale definitions  (semitone offsets from root)
// ─────────────────────────────────────────────────────────────
const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11, 12],
  minor:      [0, 2, 3, 5, 7, 8, 10, 12],
  dorian:     [0, 2, 3, 5, 7, 9, 10, 12],
  phrygian:   [0, 1, 3, 5, 7, 8, 10, 12],
  lydian:     [0, 2, 4, 6, 7, 9, 11, 12],
  mixolydian: [0, 2, 4, 5, 7, 9, 10, 12],
  pentatonic: [0, 2, 4, 7, 9, 12, 14, 16],
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7]
};

/** MIDI note numbers for each key name at octave 4 */
const KEY_FREQ = {
  C: 261.63, "C#": 277.18, D: 293.66, "D#": 311.13,
  E: 329.63, F: 349.23, "F#": 369.99, G: 392.00,
  "G#": 415.30, A: 440.00, "A#": 466.16, B: 493.88
};

// ─────────────────────────────────────────────────────────────
//  DOM references
// ─────────────────────────────────────────────────────────────
const loopLengthSelect = document.getElementById("loopLengthSelect");
const quantizeSelect = document.getElementById("quantizeSelect");
const loopPlayhead = document.getElementById("loopPlayhead");
const currentStep = document.getElementById("currentStep");
const setupScreen    = document.getElementById("setupScreen");
const padScreen      = document.getElementById("padScreen");
const playerNameIn   = document.getElementById("playerName");
const roomCodeIn     = document.getElementById("roomCode");
const roleGrid       = document.getElementById("roleGrid");
const joinBtn        = document.getElementById("joinBtn");
const setupError     = document.getElementById("setupError");
const padRoomLabel   = document.getElementById("padRoomLabel");
const padPlayerLabel = document.getElementById("padPlayerLabel");
const connStatus     = document.getElementById("connStatus");
const connLabel      = document.getElementById("connLabel");
const dispKey        = document.getElementById("dispKey");
const dispMode       = document.getElementById("dispMode");
const dispBpm        = document.getElementById("dispBpm");
const dispQuantize   = document.getElementById("dispQuantize");
const beatBar        = document.getElementById("beatBar");
const instrumentSel  = document.getElementById("instrumentSelect");
const padGrid        = document.getElementById("padGrid");
const pads           = padGrid.querySelectorAll(".pad");
const muteOverlay    = document.getElementById("muteOverlay");
const leaveBtn       = document.getElementById("leaveBtn");
const recordLoopBtn = document.getElementById("recordLoopBtn");
const playLoopBtn   = document.getElementById("playLoopBtn");
const clearLoopBtn  = document.getElementById("clearLoopBtn");
const loopStatus    = document.getElementById("loopStatus");

// ─────────────────────────────────────────────────────────────
//  Session state
// ─────────────────────────────────────────────────────────────
let playerLoopCountdownTimer = null;
let loopVisualAnimationId = null;
let loopVisualStartMs = 0;
let loopVisualLengthMs = 2000;
let selectedRole = "Melody";
let isMuted      = false;
let sessionSettings = { key: "C", mode: "major", bpm: 120, quantize: "none" };

// Stable per-device ID stored in localStorage
const playerId = (() => {
  let id = localStorage.getItem("pt_player_id");
  if (!id) {
    id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    localStorage.setItem("pt_player_id", id);
  }
  return id;
})();

// ─────────────────────────────────────────────────────────────
//  Audio context
// ─────────────────────────────────────────────────────────────
let audioCtx   = null;
let masterGain = null;

function initAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.8;
  masterGain.connect(audioCtx.destination);
}

// Unlock audio on first touch (iOS Safari requirement)
document.body.addEventListener("pointerdown", initAudio, { once: true });
document.body.addEventListener("touchstart",  initAudio, { once: true, passive: true });



// ─────────────────────────────────────────────────────────────
//  Frequency helpers
// ─────────────────────────────────────────────────────────────
function semitoneToHz(rootHz, semitones) {
  return rootHz * Math.pow(2, semitones / 12);
}

function padFrequency(degree) {
  const root  = KEY_FREQ[sessionSettings.key] || 261.63;
  const scale = SCALES[sessionSettings.mode]  || SCALES.major;
  return semitoneToHz(root, scale[degree] ?? 0);
}

// ─────────────────────────────────────────────────────────────
//  Audio synthesis
// ─────────────────────────────────────────────────────────────
function makeNoiseBuffer(dur) {
  const n    = Math.floor(audioCtx.sampleRate * dur);
  const buf  = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function synthTone(frequency, type) {
  const now  = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.40, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.25);
}

function synthKick() {
  const now  = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(130, now);
  osc.frequency.exponentialRampToValueAtTime(45, now + 0.12);
  gain.gain.setValueAtTime(0.9, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.25);
}

function synthSnare() {
  const now    = audioCtx.currentTime;
  const noise  = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const gain   = audioCtx.createGain();
  noise.buffer       = makeNoiseBuffer(0.18);
  filter.type        = "bandpass";
  filter.frequency.value = 1800;
  filter.Q.value     = 0.8;
  gain.gain.setValueAtTime(0.50, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  noise.start(now);
  noise.stop(now + 0.18);
}

function synthHiHat() {
  const now    = audioCtx.currentTime;
  const noise  = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const gain   = audioCtx.createGain();
  noise.buffer           = makeNoiseBuffer(0.08);
  filter.type            = "highpass";
  filter.frequency.value = 7000;
  gain.gain.setValueAtTime(0.30, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  noise.start(now);
  noise.stop(now + 0.08);
}

function synthTom(frequency) {
  const now  = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency * 0.5, now);
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.25, now + 0.18);
  gain.gain.setValueAtTime(0.60, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.28);
}

/**
 * Plays a sound for the given pad degree and instrument type.
 * @param {number} degree  - Scale degree (0–7)
 * @param {string} instrument
 */
function playSound(degree, instrument) {
  if (!audioCtx) initAudio();
  const freq = padFrequency(degree);
  switch (instrument) {
    case "sine":     synthTone(freq, "sine");      break;
    case "triangle": synthTone(freq, "triangle");  break;
    case "square":   synthTone(freq, "square");    break;
    case "sawtooth": synthTone(freq, "sawtooth");  break;
    case "kick":     synthKick();                  break;
    case "snare":    synthSnare();                 break;
    case "hi-hat":   synthHiHat();                 break;
    case "tom":      synthTom(freq);               break;
    default:         synthTone(freq, "sine");
  }
}

// ─────────────────────────────────────────────────────────────
//  Metronome (client-side scheduler)
// ─────────────────────────────────────────────────────────────
let metroTimer      = null;
let metroBeat       = 0;
let metroBeatsPerBar = 4;
let metroBpm        = 120;
let metroStartEpoch = 0;   // epoch ms when beat 0 fired

function buildBeatDots(count) {
  beatBar.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("div");
    dot.className = "beat-dot";
    dot.dataset.beat = i;
    beatBar.appendChild(dot);
  }
}

function highlightBeat(beatIndex) {
  const dots = beatBar.querySelectorAll(".beat-dot");
  dots.forEach((d, i) => {
    d.classList.toggle("beat-active",  i === beatIndex);
    d.classList.toggle("beat-accent",  i === 0 && beatIndex === 0);
  });
}

/** Tick sound: high click on beat 1, low click on others */
function tickSound(isAccent) {
  if (!audioCtx) return;
  const now  = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = isAccent ? 1200 : 800;
  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.05);
}

function startMetronome({ bpm, beatsPerBar, startTime }) {
  stopMetronome();
  metroBpm        = bpm        || 120;
  metroBeatsPerBar = beatsPerBar || 4;
  metroStartEpoch = startTime  || Date.now();
  metroBeat       = 0;

  buildBeatDots(metroBeatsPerBar);

  const intervalMs = (60 / metroBpm) * 1000;

  // Calculate how far into the first beat we already are
  const elapsed = Date.now() - metroStartEpoch;
  const phase   = elapsed % intervalMs;
  const delay   = phase > 0 ? intervalMs - phase : 0;

  setTimeout(() => {
    tick();
    metroTimer = setInterval(tick, intervalMs);
  }, delay);

  function tick() {
    const beat = metroBeat % metroBeatsPerBar;
    highlightBeat(beat);
    tickSound(beat === 0);
    if (navigator.vibrate && beat === 0) navigator.vibrate(6);
    metroBeat++;
  }
}

function stopMetronome() {
  clearInterval(metroTimer);
  clearTimeout(metroTimer);
  metroTimer = null;
  beatBar.querySelectorAll(".beat-dot").forEach(d => {
    d.classList.remove("beat-active", "beat-accent");
  });
}

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
const socket = io();

function setConnected(ok) {
  connStatus.className = "conn-dot " + (ok ? "connected" : "disconnected");
  connLabel.textContent = ok ? "Connected" : "Reconnecting…";
}

function emitLoopState(action = "update", extra = {}) {
  socket.emit("player:loop-state", {
    roomId: roomCodeIn.value.trim().toUpperCase(),
    playerId,
    playerName: playerNameIn.value.trim() || "Player",
    role: selectedRole,
    action,
    loopLengthMs: currentLoopLengthMs,
    events: loopEvents,
    ...extra
  });
}

loopLengthSelect?.addEventListener("change", () => {
  if (isLoopPlaying) {
    stopLoopPlayback();
    startLoopPlayback();
  }
});

quantizeSelect?.addEventListener("change", () => {
  // affects future recording only — no restart needed
});

socket.on("connect",    () => setConnected(true));
socket.on("disconnect", () => setConnected(false));

/** Host updated session settings */
socket.on("room:settings", (s) => {
  sessionSettings = { ...sessionSettings, ...s };
  dispKey.textContent      = s.key      || sessionSettings.key;
  dispMode.textContent     = s.mode     || sessionSettings.mode;
  dispBpm.textContent      = s.bpm      || sessionSettings.bpm;
  dispQuantize.textContent = s.quantize === "none" ? "off" : (s.quantize || "off");
});
socket.on("loop:transport", ({ action, startTime }) => {
  if (action === "start") {
    startLoopPlaybackSynced(startTime);
  }

  if (action === "stop") {
    stopLoopPlayback();
  }
});
/** Metronome start from host */
socket.on("metronome:start", (data) => {
  startMetronome(data);
});

/** Metronome stop from host */
socket.on("metronome:stop", () => {
  stopMetronome();
});

/** Remote tap from another player */
socket.on("tap:event", (event) => {
  // Play the sound locally using the event's instrument and degree
  playSound(event.padNumber, event.instrument || "sine");
  // Flash the corresponding pad cyan (remote colour)
  const pad = padGrid.querySelector(`.pad[data-degree="${event.padNumber}"]`);
  if (pad) flashPad(pad, "active-remote");
});

/** Host muted/unmuted this player */
socket.on("host:mute:ack", ({ targetPlayerId, muted }) => {
  if (targetPlayerId === playerId) {
    isMuted = muted;
    muteOverlay.classList.toggle("hidden", !muted);
  }
});

socket.on("loop:transport", ({ action, startTime }) => {
  if (action === "start") {
    startLoopPlaybackSynced(startTime);
  }

  if (action === "stop") {
    stopLoopPlayback();
  }
});

function startLoopPlaybackSynced(startTime) {
  if (!loopEvents.length) return;

  stopLoopPlayback();

  const delay = Math.max(0, (startTime || Date.now()) - Date.now());

  setTimeout(() => {
    if (!loopEvents.length) return;
    startLoopPlayback();
  }, delay);
}

function startLoopVisuals(loopLengthMs) {
  if (loopVisualAnimationId !== null) return;

  loopVisualStartMs = performance.now();
  loopVisualLengthMs = loopLengthMs;

  animateLoopVisuals();
}

function animateLoopVisuals() {
  const elapsed = (performance.now() - loopVisualStartMs) % loopVisualLengthMs;
  const progress = elapsed / loopVisualLengthMs;

  // Progress bar
  if (loopPlayhead) {
    loopPlayhead.style.width = `${progress * 100}%`;
  }

  // 16-step counter
 const totalSteps = 16 * Number(loopLengthSelect?.value || 1);
const step = Math.floor(progress * totalSteps) + 1;

  if (currentStep) {
    currentStep.textContent = step;
  }

  updateStepBoxes(step);

  loopVisualAnimationId = requestAnimationFrame(animateLoopVisuals);
}

function stopLoopVisuals() {
  if (loopVisualAnimationId !== null) {
    cancelAnimationFrame(loopVisualAnimationId);
    loopVisualAnimationId = null;
  }

  if (loopPlayhead) {
    loopPlayhead.style.width = "0%";
  }

  if (currentStep) {
    currentStep.textContent = "1";
  }

  updateStepBoxes(1);
}

function updateStepBoxes(activeStep) {
  const boxes = document.querySelectorAll(".time-box");

  boxes.forEach((box, index) => {
    box.classList.toggle("active", index + 1 === activeStep);
    box.classList.toggle("passed", index + 1 < activeStep);
  });
}


// ─────────────────────────────────────────────────────────────
//  Loop Mode v1
// ─────────────────────────────────────────────────────────────
// Local-first one-bar looping. The player hears their own tap instantly.
// Recorded loop playback also emits normal tap events so the host board
// can respond and other connected players can hear the loop.
let loopEvents = [];
let isLoopRecording = false;
let isLoopPlaying = false;
let loopStartMs = 0;
let loopTimeouts = [];
let currentLoopLengthMs = 2000;

function getLoopLengthMs() {
  const bpm = Number(sessionSettings.bpm) || 120;
  const beatsPerBar = metroBeatsPerBar || 4;
const bars = Number(loopLengthSelect?.value || 1);

return Math.round((60 / bpm) * 1000 * beatsPerBar * bars);
}

function quantizeLoopTime(ms, loopLengthMs) {
 const q = quantizeSelect?.value;

if (!q || q === "off") return ms;

const steps = Number(q); // 4, 8, 16, 32
const grid = loopLengthMs / steps;

return Math.round(ms / grid) * grid;
}

function startPlayerLoopCountdown(startTime) {
  clearInterval(playerLoopCountdownTimer);

  function updateCountdown() {
    const remainingMs = startTime - Date.now();
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

    if (remainingMs > 0) {
      loopStatus.textContent = `Global start in ${remainingSec}...`;
    } else {
      clearInterval(playerLoopCountdownTimer);
      playerLoopCountdownTimer = null;
      loopStatus.textContent = "Launching...";
    }
  }

  updateCountdown();
  playerLoopCountdownTimer = setInterval(updateCountdown, 100);
}

function updateLoopUI() {
  recordLoopBtn.classList.toggle("recording", isLoopRecording);
  playLoopBtn.classList.toggle("playing", isLoopPlaying);

  recordLoopBtn.textContent = isLoopRecording ? "Stop Recording" : "Record Loop";
  playLoopBtn.textContent = isLoopPlaying ? "Stop Loop" : "Play Loop";

  playLoopBtn.disabled = loopEvents.length === 0;
  clearLoopBtn.disabled = loopEvents.length === 0 && !isLoopRecording;

  if (isLoopRecording) {
    loopStatus.textContent = `Recording · ${loopEvents.length} event${loopEvents.length === 1 ? "" : "s"}`;
  } else if (isLoopPlaying) {
    loopStatus.textContent = `Playing · ${loopEvents.length} event${loopEvents.length === 1 ? "" : "s"} · ${Math.round(currentLoopLengthMs)}ms`;
  } else if (loopEvents.length) {
    loopStatus.textContent = `Ready · ${loopEvents.length} event${loopEvents.length === 1 ? "" : "s"} · one-bar loop`;
  } else {
    loopStatus.textContent = "Empty · one-bar loop";
  }
}

function startLoopRecording() {
  stopLoopPlayback(); // already stops visuals too

  loopEvents = [];
  emitLoopState("record-start");
  currentLoopLengthMs = getLoopLengthMs();
  loopStartMs = performance.now();

  isLoopRecording = true;

  updateLoopUI();
}

function stopLoopRecording() {
  isLoopRecording = false;
  emitLoopState("record-stop");
  updateLoopUI();
}

function clearLoop() {
  stopLoopPlayback();
  isLoopRecording = false;
  loopEvents = [];
  emitLoopState("clear");
  updateLoopUI();
}

function scheduleLoopCycle() {
  if (!isLoopPlaying || !loopEvents.length) return;

  loopTimeouts.forEach(clearTimeout);
  loopTimeouts = [];

  const sorted = [...loopEvents].sort((a, b) => a.timeMs - b.timeMs);
  for (const event of sorted) {
    const t = setTimeout(() => {
      if (!isLoopPlaying) return;
      triggerTap(event.degree, event.instrument, { fromLoop: true, record: false, emit: true });
    }, Math.max(0, event.timeMs));
    loopTimeouts.push(t);
  }

  const next = setTimeout(scheduleLoopCycle, currentLoopLengthMs);
  loopTimeouts.push(next);
}

function startLoopPlayback() {
  if (!loopEvents.length) return;

  isLoopRecording = false;
  isLoopPlaying = true;
  currentLoopLengthMs = getLoopLengthMs();

  const startedAt = performance.now();

startLoopVisuals(currentLoopLengthMs);

emitLoopState("play-start", {
  startedAt,
  loopLengthMs: currentLoopLengthMs
});

updateLoopUI();
scheduleLoopCycle();
}

function startLoopPlaybackSynced(startTime) {
  if (!loopEvents.length) return;

  stopLoopPlayback();

  const delay = Math.max(0, (startTime || Date.now()) - Date.now());

  setTimeout(() => {
    if (!loopEvents.length) return;
    startLoopPlayback();
  }, delay);
}

function stopLoopPlayback() {
  isLoopPlaying = false;

  loopTimeouts.forEach(clearTimeout);
  loopTimeouts = [];

  stopLoopVisuals();

  updateLoopUI();
}

recordLoopBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (isLoopRecording) stopLoopRecording();
  else startLoopRecording();
});

playLoopBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (isLoopPlaying) stopLoopPlayback();
  else startLoopPlayback();
});

clearLoopBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  clearLoop();
});

updateLoopUI();

// ─────────────────────────────────────────────────────────────
//  Pad interaction
// ─────────────────────────────────────────────────────────────
function flashPad(pad, cls) {
  pad.classList.add(cls);
  setTimeout(() => pad.classList.remove(cls), 130);
}

function emitTapEvent(degree, instrument, source = "live") {
  socket.emit("player:tap", {
    roomId:     roomCodeIn.value.trim().toUpperCase(),
    playerId,
    playerName: playerNameIn.value.trim() || "Player",
    role:       selectedRole,
    padNumber:  degree,
    timestamp:  Date.now(),
    soundType:  sessionSettings.mode,
    instrument,
    frequency:  padFrequency(degree),
    source
  });
}

function triggerTap(degree, instrument, options = {}) {
  const { fromLoop = false, record = true, emit = true } = options;
  if (isMuted) return;
  initAudio();

  // ── IMMEDIATE local playback ──────────────────────────
  playSound(degree, instrument);
  const pad = padGrid.querySelector(`.pad[data-degree="${degree}"]`);
  if (pad) flashPad(pad, fromLoop ? "active-remote" : "active-local");
  if (!fromLoop && navigator.vibrate) navigator.vibrate(10);

  // ── Record to one-bar loop if Loop Mode is recording ───
  if (record && isLoopRecording) {
    const loopLength = currentLoopLengthMs || getLoopLengthMs();
    let rel = (performance.now() - loopStartMs) % loopLength;
    rel = quantizeLoopTime(rel, loopLength);
    if (rel >= loopLength) rel = 0;

   loopEvents.push({ degree, instrument, timeMs: rel });

    updateLoopUI();
    emitLoopState("update");
  }

  // ── Relay to server ───────────────────────────────────
  if (emit) {
    emitTapEvent(degree, instrument, fromLoop ? "loop" : "live");
  }
}

pads.forEach((pad) => {
  pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const degree = Number(pad.dataset.degree);
    triggerTap(degree, instrumentSel.value, { fromLoop: false, record: true, emit: true });
  });
});

// ─────────────────────────────────────────────────────────────
//  Role selector
// ─────────────────────────────────────────────────────────────
roleGrid.querySelectorAll(".role-btn").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    roleGrid.querySelectorAll(".role-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedRole = btn.dataset.role;
  });
});

// ─────────────────────────────────────────────────────────────
//  Join / Leave
// ─────────────────────────────────────────────────────────────
joinBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const name = playerNameIn.value.trim();
  const room = roomCodeIn.value.trim().toUpperCase();

  if (!name) { setupError.textContent = "Please enter your name."; return; }
  if (!room) { setupError.textContent = "Please enter a room code."; return; }
  setupError.textContent = "";

  initAudio();

  socket.emit("player:join", {
    roomId:     room,
    playerId,
    playerName: name,
    role:       selectedRole
  });

  // Update top bar labels
  padRoomLabel.textContent   = room;
  padPlayerLabel.textContent = name + " · " + selectedRole;

  // Switch screens
  setupScreen.classList.add("hidden");
  padScreen.classList.remove("hidden");

  // Build default beat dots
  buildBeatDots(4);
});

leaveBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  stopMetronome();
  stopLoopPlayback();
  socket.disconnect();
  padScreen.classList.add("hidden");
  setupScreen.classList.remove("hidden");
  // Reconnect socket for next session
  socket.connect();
});

// Pre-fill name from localStorage if available
const savedName = localStorage.getItem("pt_player_name");
if (savedName) playerNameIn.value = savedName;
playerNameIn.addEventListener("input", () => {
  localStorage.setItem("pt_player_name", playerNameIn.value.trim());
});
