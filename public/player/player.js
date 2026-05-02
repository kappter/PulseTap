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
const stepSequencer = document.getElementById("stepSequencer");
const soloModeToggle = document.getElementById("soloModeToggle");
const soloControls = document.getElementById("soloControls");
const soloBpm = document.getElementById("soloBpm");
const soloKey = document.getElementById("soloKey");
const soloMode = document.getElementById("soloMode");
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
let isSoloMode = false;
let playerVolume = 1.0;
let playerLoopCountdownTimer = null;
let loopVisualAnimationId = null;
let loopVisualStartMs = 0;
let loopVisualLengthMs = 2000;
let selectedRole = "Melody";
let isMuted      = false;
let sessionSettings = { key: "C", mode: "major", bpm: 120, quantize: "none" };
const importLoopBtn = document.getElementById("importLoopBtn");

const saveLoopBtn = document.getElementById("saveLoopBtn");

saveLoopBtn?.addEventListener("click", () => {
  const data = getCurrentLoopData();
  localStorage.setItem("pulsetap_loop", JSON.stringify(data));
  loopStatus.textContent = "Loop saved";
});

const loadLoopBtn = document.getElementById("loadLoopBtn");

loadLoopBtn?.addEventListener("click", () => {
  try {
    const raw = localStorage.getItem("pulsetap_loop");

    if (!raw) {
      loopStatus.textContent = "No saved loop found";
      return;
    }

    applyLoopData(JSON.parse(raw));
    loopStatus.textContent = "Loop loaded";
  } catch (err) {
    loopStatus.textContent = "Could not load loop";
  }
});

const shareLoopBtn = document.getElementById("shareLoopBtn");

shareLoopBtn?.addEventListener("click", async () => {
  const data = getCurrentLoopData();

  const encoded = btoa(JSON.stringify(data));

  await navigator.clipboard.writeText(encoded);

  loopStatus.textContent = "Loop copied (share it!)";
});

importLoopBtn?.addEventListener("click", importLoopFromClipboard);

const slotButtons = document.querySelectorAll(".slot-btn");

slotButtons.forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();

    const slot = btn.dataset.slot;
    const key = `pulsetap_loop_slot_${slot}`;

    if (e.shiftKey) {
      const data = getCurrentLoopData();
      localStorage.setItem(key, JSON.stringify(data));

      btn.classList.add("saved");

// ensure all saved slots stay marked
document.querySelectorAll(".slot-btn").forEach(b => {
  const key = `pulsetap_loop_slot_${b.dataset.slot}`;
  if (localStorage.getItem(key)) {
    b.classList.add("saved");
  }
});
      loopStatus.textContent = `Saved to slot ${slot}`;
    } else {
      try {
        const raw = localStorage.getItem(key);

        if (!raw) {
          loopStatus.textContent = `Slot ${slot} empty`;
          return;
        }

        applyLoopData(JSON.parse(raw));

        document.querySelectorAll(".slot-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        loopStatus.textContent = `Loaded slot ${slot}`;
      } catch {
        loopStatus.textContent = `Error loading slot ${slot}`;
      }
    }
  });
});

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
  masterGain.gain.value = playerVolume;
  masterGain.connect(audioCtx.destination);
}

// Unlock audio on first touch (iOS Safari requirement)
document.body.addEventListener("pointerdown", initAudio, { once: true });
document.body.addEventListener("touchstart",  initAudio, { once: true, passive: true });
function isAccentStep(step) {
  const beatsPerBar = metroBeatsPerBar || 4;
  const stepsPerBeat = stepGridSteps / beatsPerBar;

  if (!Number.isInteger(stepsPerBeat)) return false;

  return step % stepsPerBeat === 0;
}

function renderStepGrid() {
  if (!stepSequencer) return;

 stepSequencer.innerHTML = "";
stepSequencer.style.setProperty("--step-count", stepGridSteps);

  for (let degree = 0; degree < 8; degree++) {
    const row = document.createElement("div");
    row.className = "step-row";

    const label = document.createElement("div");
    label.className = "step-label";
    label.textContent = `Pad ${degree + 1}`;
    row.appendChild(label);

    for (let step = 0; step < stepGridSteps; step++) {
      const cell = document.createElement("button");
      cell.className = "step-cell";
cell.type = "button";
cell.dataset.degree = degree;
cell.dataset.step = step;

      const isActive = stepGridEvents.some(
        ev => ev.degree === degree && ev.step === step
      );

      cell.classList.toggle("active", isActive);
      cell.classList.toggle("accent-step", isAccentStep(step));

      cell.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        toggleStepEvent(degree, step);
      });

      row.appendChild(cell);
    }

    stepSequencer.appendChild(row);
  }
}

function getNextLocalBarStartTime() {
  const bpm = Number(sessionSettings.bpm) || 120;
  const beatsPerBar = metroBeatsPerBar || 4;

  const msPerBeat = 60000 / bpm;
  const msPerBar = msPerBeat * beatsPerBar;

  const now = Date.now();

  if (!metroStartEpoch) {
    return now + 500;
  }

  const elapsedSinceStart = now - metroStartEpoch;
  const phaseInBar = elapsedSinceStart % msPerBar;
  const untilNextBar = msPerBar - phaseInBar;

  return now + untilNextBar;
}

soloModeToggle?.addEventListener("change", () => {
  isSoloMode = soloModeToggle.checked;
  soloControls?.classList.toggle("hidden", !isSoloMode);

  if (isSoloMode) {
    applySoloSettings();
    loopStatus.textContent = "Solo Mode · local practice";
  }
});

[soloBpm, soloKey, soloMode].forEach(el => {
  el?.addEventListener("change", applySoloSettings);
});

function applySoloSettings() {
  if (!isSoloMode) return;

  sessionSettings = {
    ...sessionSettings,
    bpm: Number(soloBpm.value) || 120,
    key: soloKey.value,
    mode: soloMode.value
  };

  dispBpm.textContent = sessionSettings.bpm;
  dispKey.textContent = sessionSettings.key;
  dispMode.textContent = sessionSettings.mode;
}

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

function getCurrentLoopData() {
  return {
    version: 1,
    instrument: instrumentSel.value,
    loopLengthMs: currentLoopLengthMs,
    stepGridSteps,
    stepResolution: stepResolutionSelect?.value || "16",
    loopEvents,
    stepGridEvents,
    settings: {
      key: sessionSettings.key,
      mode: sessionSettings.mode,
      bpm: sessionSettings.bpm,
      quantize: sessionSettings.quantize
    }
  };
}
function applyLoopData(data) {
  if (!data) return;

  // restore instrument
  instrumentSel.value = data.instrument || "sine";

  // restore loop timing (safe — does NOT change global clock)
  currentLoopLengthMs = data.loopLengthMs || getLoopLengthMs();

  // restore step grid
  stepGridSteps = Number(data.stepGridSteps || 16);
  loopEvents = Array.isArray(data.loopEvents) ? data.loopEvents : [];
  stepGridEvents = Array.isArray(data.stepGridEvents) ? data.stepGridEvents : [];

  // restore session settings locally (Solo-safe)
  sessionSettings = {
    ...sessionSettings,
    ...(data.settings || {})
  };

  // update UI controls (THIS is what you're currently missing)
if (stepResolutionSelect && data.stepResolution) {
  stepResolutionSelect.value = String(data.stepResolution);
}

  // re-render visuals
  renderStepGrid();
  updateLoopUI();
}
async function importLoopFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
const data = JSON.parse(atob(text.trim()));

applyLoopData(data);

loopStatus.textContent = "Loop imported";
  } catch (e) {
    loopStatus.textContent = "Invalid loop data";
  }
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
      case "kit": playDrumKitSound(degree); break;
    case "kick":     synthKick();                  break;
    case "snare":    synthSnare();                 break;
    case "hi-hat":   synthHiHat();                 break;
    case "tom":      synthTom(freq);               break;
    default:         synthTone(freq, "sine");
  }
}
function playDrumKitSound(degree) {
  switch (degree) {
    case 0: synthKick(); break;
    case 1: synthSnare(); break;
    case 2: synthHiHat(); break;
    case 3: synthTom(220); break;
    case 4: synthTom(180); break;
    case 5: synthHiHat(); break;
    case 6: synthSnare(); break;
    case 7: synthKick(); break;
    default: synthKick();
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
  const now = Date.now();
let delay = Math.max(0, startTime - now);

if (delay === 0) {
  const elapsed = now - startTime;
  const phase = elapsed % intervalMs;
  delay = phase > 0 ? intervalMs - phase : 0;
}

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

let stepGridEvents = [];
let stepGridSteps = 16;
const stepResolutionSelect = document.getElementById("stepResolution");

function getStepGridStepsFromResolution() {
  const division = Number(stepResolutionSelect?.value || 16);
  const beatsPerBar = Number(metroBeatsPerBar || 4);

  // Assumes quarter-note beat for now: 4/4, 5/4, 3/4, etc.
  return beatsPerBar * (division / 4);
}

stepResolutionSelect?.addEventListener("change", () => {
  const wasPlaying = isLoopPlaying;

  if (wasPlaying) {
    stopLoopPlayback();
  }

  stepGridSteps = getStepGridStepsFromResolution();
  renderStepGrid();
  updateLoopUI();

  if (wasPlaying) {
    startLoopPlayback();
  }
});
function toggleStepEvent(degree, step) {
  const existingIndex = stepGridEvents.findIndex(
    ev => ev.degree === degree && ev.step === step
  );

  if (existingIndex >= 0) {
    stepGridEvents.splice(existingIndex, 1);
  } else {
    stepGridEvents.push({
      degree,
      step,
      instrument: instrumentSel.value
    });
  }

  renderStepGrid();
updateLoopUI();
emitLoopState("update");
}

function stepToTimeMs(step, loopLengthMs) {
  return (step / stepGridSteps) * loopLengthMs;
}

function convertStepGridToLoopEvents() {
  const loopLength = currentLoopLengthMs || getLoopLengthMs();

  return stepGridEvents.map(ev => ({
    degree: ev.degree,
    instrument: ev.instrument,
    timeMs: stepToTimeMs(ev.step, loopLength)
  }));
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
    stepGridEvents,
    stepGridSteps,
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
  if (isSoloMode) return;
  sessionSettings = { ...sessionSettings, ...s };

  dispKey.textContent = s.key || sessionSettings.key;
  dispMode.textContent = s.mode || sessionSettings.mode;
  dispBpm.textContent = s.bpm || sessionSettings.bpm;
  dispQuantize.textContent = s.quantize === "none" ? "off" : (s.quantize || "off");

 if (s.beatsPerBar) {
  const wasPlaying = isLoopPlaying;

  if (wasPlaying) {
    stopLoopPlayback();
  }

  metroBeatsPerBar = Number(s.beatsPerBar);
  stepGridSteps = getStepGridStepsFromResolution();
  buildBeatDots(metroBeatsPerBar);
  renderStepGrid();
  updateLoopUI();

  if (wasPlaying) {
    startLoopPlayback();
  }
}
});
socket.on("loop:transport", ({ action, startTime }) => {
  if (action === "start") {
    startPlayerLoopCountdown(startTime);
    startLoopPlaybackSynced(startTime);
  }

  if (action === "stop") {
    clearInterval(playerLoopCountdownTimer);
    playerLoopCountdownTimer = null;
    stopLoopPlayback();
  }
});
/** Section play from host — start loop if this player is in the section, stop if not */
socket.on("section:play", ({ section, playerIds, startTime }) => {
  const inSection = playerIds.includes(playerId);
  if (inSection) {
    // Reuse the same synced start path as "Start All Loops"
    startPlayerLoopCountdown(startTime);
    startLoopPlaybackSynced(startTime);
    console.log(`[section:play] ${section}: loop starting at next bar`);
  } else {
    // Silence players not in this section
    clearInterval(playerLoopCountdownTimer);
    playerLoopCountdownTimer = null;
    stopLoopPlayback();
    console.log(`[section:play] ${section}: not in section — loop stopped`);
  }
});

/** Metronome start from host */
socket.on("metronome:start", (data) => {
  startMetronome(data);
  renderStepGrid(); // 🔥 ADD THIS
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

socket.on("host:volume:ack", ({ targetPlayerId, volume }) => {
  if (targetPlayerId === playerId) {
    playerVolume = Number(volume);
    if (masterGain) {
      masterGain.gain.value = playerVolume;
    }
  }
});

function startLoopPlaybackSynced(startTime) {
if (!loopEvents.length && !stepGridEvents.length) return;
  stopLoopPlayback();

  const delay = Math.max(0, (startTime || Date.now()) - Date.now());

 setTimeout(() => {
  if (!loopEvents.length && !stepGridEvents.length) return;
  startLoopPlayback(startTime || Date.now());
}, delay);
}

function startLoopVisuals(loopLengthMs, anchorMs = Date.now()) {
  if (loopVisualAnimationId !== null) return;

  loopVisualStartMs = anchorMs;
  loopVisualLengthMs = loopLengthMs;

  animateLoopVisuals();
}

function animateLoopVisuals() {
  const elapsed = (Date.now() - loopVisualStartMs) % loopVisualLengthMs;
  const progress = elapsed / loopVisualLengthMs;

  // Progress bar
  if (loopPlayhead) {
    loopPlayhead.style.width = `${progress * 100}%`;
  }

  // 16-step counter
 const bars = Number(loopLengthSelect?.value || 1);
const totalSteps = stepGridSteps * bars;
const step = Math.floor(progress * totalSteps) + 1;

  if (currentStep) {
    currentStep.textContent = step;
  }

  updateStepBoxes(step);
  updateStepGridPlayhead(step);

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
  updateStepGridPlayhead(1);
}

function updateStepBoxes(activeStep) {
  const boxes = document.querySelectorAll(".time-box");

  boxes.forEach((box, index) => {
    box.classList.toggle("active", index + 1 === activeStep);
    box.classList.toggle("passed", index + 1 < activeStep);
  });
}
function updateStepGridPlayhead(activeStep) {
  const sequencerStep = (activeStep - 1) % stepGridSteps;

  document.querySelectorAll(".step-cell").forEach((cell) => {
    const cellStep = Number(cell.dataset.step);
    cell.classList.toggle("playhead", cellStep === sequencerStep);
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
let loopPlaybackAnchorMs = 0;

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

  const hasLoopContent = loopEvents.length > 0 || stepGridEvents.length > 0;

playLoopBtn.disabled = !hasLoopContent;
clearLoopBtn.disabled = !hasLoopContent && !isLoopRecording;

  if (isLoopRecording) {
    loopStatus.textContent = `Recording · ${loopEvents.length} event${loopEvents.length === 1 ? "" : "s"}`;
  } else if (isLoopPlaying) {
    loopStatus.textContent = `Playing · ${loopEvents.length} event${loopEvents.length === 1 ? "" : "s"} · ${Math.round(currentLoopLengthMs)}ms`;
  } else if (hasLoopContent) {
    const totalEvents = loopEvents.length + stepGridEvents.length;
   loopStatus.textContent = `Ready · ${totalEvents} event${totalEvents === 1 ? "" : "s"} · one-bar loop`;
  } else {
    loopStatus.textContent = "Empty · one-bar loop";
  }
}

function startLoopRecording() {
  stopLoopPlayback(); // already stops visuals too

  loopEvents = [];
  emitLoopState("record-start");
  currentLoopLengthMs = getLoopLengthMs();
  loopStartMs = Date.now();

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
  stepGridEvents = [];

  renderStepGrid();

  emitLoopState("clear");
  updateLoopUI();
}

function scheduleLoopCycle(cycleIndex = 0) {
  if (!isLoopPlaying || (!loopEvents.length && !stepGridEvents.length)) return;

  const now = Date.now();
  const cycleStart = loopPlaybackAnchorMs + cycleIndex * currentLoopLengthMs;
  const nextCycleStart = loopPlaybackAnchorMs + (cycleIndex + 1) * currentLoopLengthMs;

  // If this cycle is already over, jump to the correct cycle.
  if (nextCycleStart <= now) {
    const correctedIndex = Math.floor((now - loopPlaybackAnchorMs) / currentLoopLengthMs);
    scheduleLoopCycle(correctedIndex);
    return;
  }

  loopTimeouts.forEach(clearTimeout);
  loopTimeouts = [];

  const sequencerEvents = convertStepGridToLoopEvents();
  const sorted = [...loopEvents, ...sequencerEvents].sort((a, b) => a.timeMs - b.timeMs);

  for (const event of sorted) {
    const eventTime = cycleStart + event.timeMs;
    const delay = eventTime - now;

    if (delay < -30) continue;

    const t = setTimeout(() => {
      if (!isLoopPlaying) return;

      triggerTap(event.degree, event.instrument, {
        fromLoop: true,
        record: false,
        emit: !isSoloMode
      });

      flashStepRow(event.degree);
    }, Math.max(0, delay));

    loopTimeouts.push(t);
  }

  const next = setTimeout(() => {
    scheduleLoopCycle(cycleIndex + 1);
  }, Math.max(0, nextCycleStart - now));

  loopTimeouts.push(next);
}

function startLoopPlayback(anchorMs = Date.now()) {
  if (!loopEvents.length && !stepGridEvents.length) return;

  isLoopRecording = false;
  isLoopPlaying = true;
  currentLoopLengthMs = getLoopLengthMs();

  const startedAt = performance.now();

loopPlaybackAnchorMs = anchorMs;
startLoopVisuals(currentLoopLengthMs, loopPlaybackAnchorMs);

if (!isSoloMode) {
  emitLoopState("play-start", {
    startedAt,
    loopLengthMs: currentLoopLengthMs
  });
}

updateLoopUI();
scheduleLoopCycle();
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

  if (isLoopPlaying) {
    stopLoopPlayback();
  } else {
    const startTime = getNextLocalBarStartTime();
    startPlayerLoopCountdown(startTime);
    startLoopPlaybackSynced(startTime);
  }
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

function flashStepRow(degree) {
  document.querySelectorAll(`.step-cell[data-degree="${degree}"]`).forEach(cell => {
    cell.classList.add("row-trigger");
  });

  setTimeout(() => {
    document.querySelectorAll(`.step-cell[data-degree="${degree}"]`).forEach(cell => {
      cell.classList.remove("row-trigger");
    });
  }, 120);
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
    let rel = (Date.now() - loopStartMs) % loopLength;
    rel = quantizeLoopTime(rel, loopLength);
    if (rel >= loopLength) rel = 0;

   const recordedEvent = { degree, instrument, timeMs: rel };

const quantizeOn = quantizeSelect?.value && quantizeSelect.value !== "off";

if (quantizeOn) {
  const step = Math.round((rel / loopLength) * stepGridSteps) % stepGridSteps;

  const alreadyExists = stepGridEvents.some(
    ev => ev.degree === degree && ev.step === step
  );

  if (!alreadyExists) {
    stepGridEvents.push({
      degree,
      step,
      instrument
    });
  }
} else {
  loopEvents.push(recordedEvent);
}

renderStepGrid();
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
  buildBeatDots(metroBeatsPerBar || 4);
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

const urlParams = new URLSearchParams(window.location.search);
const roomFromUrl = urlParams.get("room");

if (roomFromUrl && roomCodeIn) {
  roomCodeIn.value = roomFromUrl.trim().toUpperCase();
}

// Pre-fill name from localStorage if available
const savedName = localStorage.getItem("pt_player_name");
if (savedName) playerNameIn.value = savedName;
playerNameIn.addEventListener("input", () => {
  localStorage.setItem("pt_player_name", playerNameIn.value.trim());
});
renderStepGrid();
// mark saved slots on load
document.querySelectorAll(".slot-btn").forEach((btn) => {
  const slot = btn.dataset.slot;
  const key = `pulsetap_loop_slot_${slot}`;

  if (localStorage.getItem(key)) {
    btn.classList.add("saved");
  }
});
