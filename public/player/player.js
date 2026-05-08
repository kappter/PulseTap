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
//  Sample Packs  — predefined loop data for slots 1-5
//  Format matches the applyLoopData / buildLoopObject schema.
// ─────────────────────────────────────────────────────────────
const SAMPLE_PACKS = {
  // ── 1. Blues Jam ─────────────────────────────────────────
  // Teaches: layering, call-and-response, 12-bar feel
  // Key: E  Mode: pentatonic  BPM: 90  Time: 4/4
  // loopLengthMs = (60000/90)*4 = 2667ms  (1 bar)
  "Blues Jam": {
    label: "Blues Jam",
    desc:  "Blues Jam \u00b7 teaches layering and call-response",
    settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" },
    slots: [
      // Slot 1 \u2014 Intro: root-fifth bass walk (I chord feel)
      {
        instrument: "bass",
        loopLengthMs: 2667,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "bass" },
          { step: 4,  degree: 2, instrument: "bass" },
          { step: 8,  degree: 0, instrument: "bass" },
          { step: 10, degree: 2, instrument: "bass" },
          { step: 12, degree: 4, instrument: "bass" },
          { step: 14, degree: 2, instrument: "bass" }
        ],
        settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" }
      },
      // Slot 2 \u2014 Verse: shuffle kick + hi-hat groove
      {
        instrument: "kick",
        loopLengthMs: 2667,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "kick" },
          { step: 6,  degree: 0, instrument: "kick" },
          { step: 8,  degree: 0, instrument: "kick" },
          { step: 13, degree: 0, instrument: "kick" }
        ],
        settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" }
      },
      // Slot 3 \u2014 Chorus: call phrase (lead melody, pentatonic)
      {
        instrument: "lead",
        loopLengthMs: 2667,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "lead" },
          { step: 2,  degree: 2, instrument: "lead" },
          { step: 4,  degree: 4, instrument: "lead" },
          { step: 6,  degree: 2, instrument: "lead" },
          { step: 8,  degree: 0, instrument: "lead" }
        ],
        settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" }
      },
      // Slot 4 \u2014 Bridge: response phrase (higher register answer)
      {
        instrument: "pluck",
        loopLengthMs: 2667,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 8,  degree: 4, instrument: "pluck" },
          { step: 10, degree: 5, instrument: "pluck" },
          { step: 12, degree: 4, instrument: "pluck" },
          { step: 14, degree: 2, instrument: "pluck" }
        ],
        settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" }
      },
      // Slot 5 \u2014 Outro: snare backbeat + sparse pad resolve
      {
        instrument: "snare",
        loopLengthMs: 2667,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 4,  degree: 0, instrument: "snare" },
          { step: 12, degree: 0, instrument: "snare" }
        ],
        settings: { key: "E", mode: "pentatonic", bpm: 90, quantize: "8" }
      }
    ]
  },

  // ── 2. Synthwave Drive ────────────────────────────────────
  // Teaches: four-on-the-floor, arpeggiation, energy build
  // Key: A  Mode: minor  BPM: 118  Time: 4/4
  // loopLengthMs = (60000/118)*4 = 2034ms  (1 bar)
  "Synthwave Drive": {
    label: "Synthwave Drive",
    desc:  "Synthwave Drive \u00b7 teaches energy build and arpeggiation",
    settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" },
    slots: [
      // Slot 1 \u2014 Intro: sparse arp seed (just root + fifth)
      {
        instrument: "bell",
        loopLengthMs: 2034,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "bell" },
          { step: 8,  degree: 4, instrument: "bell" }
        ],
        settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" }
      },
      // Slot 2 \u2014 Verse: sawtooth bass pulse (root on every beat)
      {
        instrument: "sawtooth",
        loopLengthMs: 2034,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "sawtooth" },
          { step: 4,  degree: 0, instrument: "sawtooth" },
          { step: 8,  degree: 3, instrument: "sawtooth" },
          { step: 12, degree: 2, instrument: "sawtooth" }
        ],
        settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" }
      },
      // Slot 3 \u2014 Chorus: four-on-the-floor kick + full arp
      {
        instrument: "kick",
        loopLengthMs: 2034,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "kick" },
          { step: 4,  degree: 0, instrument: "kick" },
          { step: 8,  degree: 0, instrument: "kick" },
          { step: 12, degree: 0, instrument: "kick" }
        ],
        settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" }
      },
      // Slot 4 \u2014 Bridge: gated snare + lead stab
      {
        instrument: "lead",
        loopLengthMs: 2034,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "lead" },
          { step: 2,  degree: 0, instrument: "lead" },
          { step: 4,  degree: 3, instrument: "lead" },
          { step: 6,  degree: 2, instrument: "lead" },
          { step: 8,  degree: 0, instrument: "lead" },
          { step: 10, degree: 0, instrument: "lead" },
          { step: 12, degree: 5, instrument: "lead" },
          { step: 14, degree: 4, instrument: "lead" }
        ],
        settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" }
      },
      // Slot 5 \u2014 Outro: snare + pad resolve (energy drops back)
      {
        instrument: "pad",
        loopLengthMs: 2034,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "pad" },
          { step: 8,  degree: 3, instrument: "pad" }
        ],
        settings: { key: "A", mode: "minor", bpm: 118, quantize: "16" }
      }
    ]
  },

  // ── 3. Ambient Build ─────────────────────────────────────
  // Teaches: texture layering, slow harmonic movement, space
  // Key: D  Mode: dorian  BPM: 72  Time: 4/4
  // loopLengthMs = (60000/72)*4 = 3333ms  (1 bar)
  "Ambient Build": {
    label: "Ambient Build",
    desc:  "Ambient Build \u00b7 teaches texture layering and harmonic space",
    settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" },
    slots: [
      // Slot 1 \u2014 Intro: single root drone (just the tonic)
      {
        instrument: "pad",
        loopLengthMs: 3333,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0, degree: 0, instrument: "pad" }
        ],
        settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" }
      },
      // Slot 2 \u2014 Verse: pad wash + sparse bell tones (add texture)
      {
        instrument: "bell",
        loopLengthMs: 3333,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 2, instrument: "bell" },
          { step: 5,  degree: 4, instrument: "bell" },
          { step: 11, degree: 7, instrument: "bell" }
        ],
        settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" }
      },
      // Slot 3 \u2014 Chorus: sine bass + hi-hat pulse (rhythm enters)
      {
        instrument: "sine",
        loopLengthMs: 3333,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "sine" },
          { step: 4,  degree: 0, instrument: "sine" },
          { step: 8,  degree: 3, instrument: "sine" },
          { step: 12, degree: 0, instrument: "sine" }
        ],
        settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" }
      },
      // Slot 4 \u2014 Bridge: pluck melody (harmonic peak, most notes)
      {
        instrument: "pluck",
        loopLengthMs: 3333,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 0,  degree: 0, instrument: "pluck" },
          { step: 4,  degree: 2, instrument: "pluck" },
          { step: 8,  degree: 4, instrument: "pluck" },
          { step: 10, degree: 5, instrument: "pluck" },
          { step: 12, degree: 4, instrument: "pluck" },
          { step: 14, degree: 2, instrument: "pluck" }
        ],
        settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" }
      },
      // Slot 5 \u2014 Outro: soft hi-hat fade (rhythm dissolves)
      {
        instrument: "hi-hat",
        loopLengthMs: 3333,
        stepGridSteps: 16,
        stepResolution: "16",
        loopLengthBars: 1,
        loopEvents: [],
        stepGridEvents: [
          { step: 2,  degree: 0, instrument: "hi-hat" },
          { step: 10, degree: 0, instrument: "hi-hat" }
        ],
        settings: { key: "D", mode: "dorian", bpm: 72, quantize: "4" }
      }
    ]
  }
};

// ─────────────────────────────────────────────────────────────
//  Demo Song configs — Song Mode section bar counts + notes
//  Keyed to SAMPLE_PACKS names.
// ─────────────────────────────────────────────────────────────
const DEMO_SONGS = {
  "Blues Jam": {
    sections: [
      { section: "Intro",  slot: 1, bars: 4,
        notes: "Root-fifth bass walk. Just the bass — let it breathe.\nTeaches: single-layer entry." },
      { section: "Verse",  slot: 2, bars: 8,
        notes: "Shuffle kick enters. Feel the swing — don\u2019t rush.\nTeaches: adding rhythm under melody." },
      { section: "Chorus", slot: 3, bars: 8,
        notes: "Call phrase on lead. This is the question.\nTeaches: melodic call-and-response." },
      { section: "Bridge", slot: 4, bars: 4,
        notes: "Response phrase answers the call. Higher register.\nTeaches: harmonic conversation between layers." },
      { section: "Outro",  slot: 5, bars: 4,
        notes: "Snare backbeat only. Strip it back to close.\nTeaches: arrangement resolution." }
    ]
  },
  "Synthwave Drive": {
    sections: [
      { section: "Intro",  slot: 1, bars: 4,
        notes: "Sparse arp seed: root + fifth only. Space is intentional.\nTeaches: restraint and anticipation." },
      { section: "Verse",  slot: 2, bars: 8,
        notes: "Sawtooth bass enters. Feel the pulse lock in.\nTeaches: bass as rhythmic anchor." },
      { section: "Chorus", slot: 3, bars: 8,
        notes: "Four-on-the-floor kick drops. Energy peaks here.\nTeaches: kick as energy driver." },
      { section: "Bridge", slot: 4, bars: 4,
        notes: "Lead melody stabs over the groove. Contrast moment.\nTeaches: melodic contrast in arrangement." },
      { section: "Outro",  slot: 5, bars: 4,
        notes: "Pad resolves. Kick drops out. Energy returns to intro level.\nTeaches: energy arc and resolution." }
    ]
  },
  "Ambient Build": {
    sections: [
      { section: "Intro",  slot: 1, bars: 4,
        notes: "Single root drone. Just one note. Listen to the space.\nTeaches: silence as a musical element." },
      { section: "Verse",  slot: 2, bars: 8,
        notes: "Bell tones enter. Sparse, unhurried. Let notes ring.\nTeaches: texture as a layer, not clutter." },
      { section: "Chorus", slot: 3, bars: 8,
        notes: "Bass and hi-hat pulse. Rhythm finally arrives.\nTeaches: delayed rhythmic entry for impact." },
      { section: "Bridge", slot: 4, bars: 8,
        notes: "Pluck melody at the harmonic peak. Most active moment.\nTeaches: building to a melodic climax." },
      { section: "Outro",  slot: 5, bars: 4,
        notes: "Hi-hat fades. Rhythm dissolves. Return to stillness.\nTeaches: graceful arrangement exit." }
    ]
  }
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
const clearBankBtn = document.getElementById("clearBankBtn");
const soloBeatsPerBar = document.getElementById("soloBeatsPerBar");
const startSongBtn = document.getElementById("startSongBtn");

// ─────────────────────────────────────────────────────────────
//  Session state
// ─────────────────────────────────────────────────────────────
let currentLoopSlot = null;
let isSoloMode = false;
let playerVolume = 1.0;
let playerLoopCountdownTimer = null;
let loopVisualAnimationId = null;
let loopVisualStartMs = 0;
let loopVisualLengthMs = 2000;
let selectedRole = "Melody";
let isMuted      = false;
let queuedLoopData = null;
let queuedSlotNumber = null;
let sessionSettings = { key: "C", mode: "major", bpm: 120, quantize: "none" };
const importLoopBtn = document.getElementById("importLoopBtn");
const exportMidiBtn = document.getElementById("exportMidiBtn");
const playBankBtn = document.getElementById("playBankBtn");
let isBankPlaying = false;
// Transport Authority: true when host metronome is running
let transportRunning = false;
let bankTimeouts = [];
let bankPlaybackAnchorMs = 0;
let songModeActive = false;
let songSections = [];
let songIndex = 0;
let songBarsRemaining = 0;

const saveLoopBtn = document.getElementById("saveLoopBtn");
const duplicateLoopBtn = document.getElementById("duplicateLoopBtn");
function queueLoopData(data, slot) {
  queuedLoopData = data;
  queuedSlotNumber = slot;

  document.querySelectorAll(".slot-btn").forEach(b => b.classList.remove("queued"));
  document.querySelector(`.slot-btn[data-slot="${slot}"]`)?.classList.add("queued");

  setLoopStatus(`⏳ Slot ${slot} queued · fires at next bar`, "queued");
  updateSongContext({ queued: `Slot ${slot}` });
}
// ─────────────────────────────────────────────────────────────
//  Song Mode helper — used by slot buttons AND section buttons
// ─────────────────────────────────────────────────────────────
/**
 * Load or queue a saved loop slot.
 * - If a loop is currently playing: queues for next bar boundary.
 * - If stopped: loads immediately and marks slot active.
 * Returns true on success, false if slot is empty.
 */
function queueSlotForNextBar(slot) {
  const key = `pulsetap_loop_slot_${slot}`;
  const raw = localStorage.getItem(key);

  if (!raw) {
    setLoopStatus(`Slot ${slot} empty · shift+tap a slot to save first`, "empty");
    return false;
  }

  try {
    const data = JSON.parse(raw);

    if (isLoopPlaying) {
      queueLoopData(data, slot);
    } else {
      applyLoopData(data);
      currentLoopSlot   = Number(slot);
      queuedLoopData    = null;
      queuedSlotNumber  = null;

      document.querySelectorAll(".slot-btn").forEach(b =>
        b.classList.remove("active", "queued")
      );
      document.querySelector(`.slot-btn[data-slot="${slot}"]`)
        ?.classList.add("active");

      setLoopStatus(`✓ Slot ${slot} loaded · ready to play`, "ready");
      updateSongContext({ active: `Slot ${slot}`, queued: "—" });
      updateEditingBanner(Number(slot));
    }
    return true;
  } catch {
    setLoopStatus(`Slot ${slot} load error`, "empty");
    return false;
  }
}
duplicateLoopBtn?.addEventListener("pointerdown", (e) => {
  e.preventDefault();

  const data = getCurrentLoopData();

  const active = document.querySelector(".slot-btn.active");
const start = active ? Number(active.dataset.slot) + 1 : 1;

for (let i = 0; i < 8; i++) {
  const n = ((start + i - 1) % 8) + 1;
    const key = `pulsetap_loop_slot_${n}`;

    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify(data));

      const btn = document.querySelector(`.slot-btn[data-slot="${n}"]`);
      btn?.classList.add("saved");
      // UX: flash the duplicate button green briefly
      duplicateLoopBtn?.classList.add("dup-flash");
      setTimeout(() => duplicateLoopBtn?.classList.remove("dup-flash"), 420);
      setLoopStatus(`✓ Copied to slot ${n}`, "ready");
      return;
    }
  }

  setLoopStatus("All slots full · clear one first", "empty");
});
saveLoopBtn?.addEventListener("click", () => {
  const data = getCurrentLoopData();
  localStorage.setItem("pulsetap_loop", JSON.stringify(data));
  setLoopStatus("✓ Loop saved to slot", "ready");
});

const loadLoopBtn = document.getElementById("loadLoopBtn");

loadLoopBtn?.addEventListener("click", () => {
  try {
    const raw = localStorage.getItem("pulsetap_loop");

    if (!raw) {
      setLoopStatus("Slot empty · record something first", "empty");
      return;
    }

    applyLoopData(JSON.parse(raw));
    setLoopStatus("✓ Loop loaded · ready to play", "ready");
  } catch (err) {
    setLoopStatus("Load failed · slot may be corrupt", "empty");
  }
});

const shareLoopBtn = document.getElementById("shareLoopBtn");

shareLoopBtn?.addEventListener("click", async () => {
  const data = getCurrentLoopData();

  const encoded = btoa(JSON.stringify(data));

  await navigator.clipboard.writeText(encoded);

  setLoopStatus("✓ Loop URL copied · share it!", "ready");
});

importLoopBtn?.addEventListener("click", importLoopFromClipboard);
exportMidiBtn?.addEventListener("pointerdown", (e) => { e.preventDefault(); exportMidi(); });

const slotButtons = document.querySelectorAll(".slot-btn");

slotButtons.forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();

    const slot = btn.dataset.slot;
    const key = `pulsetap_loop_slot_${slot}`;

    if (e.shiftKey) {
  const data = getCurrentLoopData();
  localStorage.setItem(key, JSON.stringify(data));

  currentLoopSlot = Number(slot);

  btn.classList.add("saved");
  document.querySelectorAll(".slot-btn").forEach(b =>
    b.classList.remove("active", "queued")
  );
  btn.classList.add("active");

  setLoopStatus(`✓ Saved to slot ${slot}`, "ready");
  clearUnsaved();
  return;
}

    // Delegate to shared helper (also used by Song Mode section buttons)
    queueSlotForNextBar(slot);
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

function buildSongSectionsFromUI() {
  const sections = [];

  document.querySelectorAll(".song-section-row").forEach((row) => {
    const btn = row.querySelector(".song-section-btn");
    const select = row.querySelector(".song-bars-select");

    const slot = Number(btn.dataset.slot);
    const bars = Number(select.value);

    sections.push({
      slot,
      bars,
      name: btn.textContent.trim()
    });
  });

  return sections;
}

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

      // Scroll-guard: only toggle if pointer moved < 8px (prevents
      // accidental step edits while horizontally scrolling on mobile)
      cell.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        const onMove = (me) => {
          if (Math.abs(me.clientX - startX) > 8 || Math.abs(me.clientY - startY) > 8) {
            moved = true;
            cell.removeEventListener("pointermove", onMove);
          }
        };
        const onUp = () => {
          cell.removeEventListener("pointermove", onMove);
          cell.removeEventListener("pointerup",   onUp);
          cell.removeEventListener("pointercancel", onUp);
          if (!moved) toggleStepEvent(degree, step);
        };
        cell.addEventListener("pointermove",   onMove);
        cell.addEventListener("pointerup",     onUp);
        cell.addEventListener("pointercancel", onUp);
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

/**
 * Returns the epoch-ms timestamp of the next bar boundary
 * aligned to the HOST transport clock (metroStartEpoch).
 *
 * When transportRunning is true, this guarantees that all players
 * who call this function at roughly the same time will receive the
 * SAME next-bar timestamp, so their loops start in perfect sync.
 *
 * Falls back to getNextLocalBarStartTime() if no epoch is set.
 */
function getNextGlobalBarStartTime() {
  if (!metroStartEpoch) {
    // No host clock yet — fall back to local
    return getNextLocalBarStartTime();
  }
  const bpm         = Number(sessionSettings.bpm) || metroBpm || 120;
  const beatsPerBar = metroBeatsPerBar || 4;
  const msPerBeat   = 60000 / bpm;
  const msPerBar    = msPerBeat * beatsPerBar;
  const now         = Date.now();
  const elapsed     = now - metroStartEpoch;
  // How far through the current bar are we?
  const phaseInBar  = ((elapsed % msPerBar) + msPerBar) % msPerBar;
  const untilNext   = msPerBar - phaseInBar;
  // Add a small scheduling buffer (50 ms) so the setTimeout
  // in startLoopPlaybackSynced has time to fire before the bar.
  const buffer = 50;
  return now + untilNext + (untilNext < buffer ? msPerBar : 0);
}

soloModeToggle?.addEventListener("change", () => {
  isSoloMode = soloModeToggle.checked;
  soloControls?.classList.toggle("hidden", !isSoloMode);
  // UX: toggle body class for Solo Mode visual separation
  document.body.classList.toggle("solo-active", isSoloMode);
  if (isSoloMode) {
    applySoloSettings();
    setLoopStatus("Solo · local practice · loop sync paused", "solo");
  } else {
    updateLoopUI();
  }
});

[soloBpm, soloKey, soloMode, soloBeatsPerBar].forEach(el => {
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
  // Wire Solo time signature into the shared metro/grid state
  if (soloBeatsPerBar) {
    metroBeatsPerBar = Number(soloBeatsPerBar.value) || 4;
    stepGridSteps    = getStepGridStepsFromResolution();
    buildBeatDots(metroBeatsPerBar);
    renderStepGrid();
renderTimeGrid();
updateLoopUI();
  }
}

function startSongMode() {
  songSections = buildSongSectionsFromUI();
  // ── Conflict guard: stop Bank if it was running ───────
  if (isBankPlaying) {
    stopBankPlayback();
    setLoopStatus("Bank stopped — Song starting", "ready");
  }
  if (!songSections.length) {
    setLoopStatus("Song Mode: no sections configured", "empty");
    return;
  }
  // Validate that the first slot has content
  const firstKey = `pulsetap_loop_slot_${songSections[0].slot}`;
  if (!localStorage.getItem(firstKey)) {
    setLoopStatus(`Song Mode: Slot ${songSections[0].slot} is empty`, "empty");
    return;
  }
  songModeActive = true;
  songIndex = 0;
  const first = songSections[0];
  songBarsRemaining = first.bars;
  ctxCurrentSection = first.name;
  // Highlight the first section button
  document.querySelectorAll(".song-section-btn").forEach(b =>
    b.classList.remove("section-active")
  );
  document.querySelector(`.song-section-btn[data-slot="${first.slot}"]`)
    ?.classList.add("section-active");
  // Start Song button → Stop Song
  const startBtn = document.getElementById("startSongBtn");
  if (startBtn) { startBtn.textContent = "Stop Song ■"; startBtn.dataset.songRunning = "1"; }
  // Start playback if not already playing
  if (!isLoopPlaying) {
    const ok = queueSlotForNextBar(first.slot);
    if (!ok) { songModeActive = false; return; }
    const startTime = getNextLocalBarStartTime();
    startPlayerLoopCountdown(startTime);
    startLoopPlaybackSynced(startTime);
  } else {
    queueSlotForNextBar(first.slot);
  }
  setLoopStatus(`Song running · ${first.name} · ${first.bars} bars`, "playing");
  const upcoming0 = songSections.length > 1 ? songSections[1].name : "End";
  updateSongContext({ part: first.name, barsLeft: first.bars, upcoming: upcoming0 });
  ctxLoadSectionNotes(first.name);
}
function stopSongMode() {
  songModeActive = false;
  songIndex = 0;
  songBarsRemaining = 0;
  stopLoopPlayback();
  const startBtn = document.getElementById("startSongBtn");
  if (startBtn) { startBtn.textContent = "Start Song ▶ Arrangement"; delete startBtn.dataset.songRunning; }
  document.querySelectorAll(".song-section-btn").forEach(b =>
    b.classList.remove("section-active")
  );
  setLoopStatus("Song stopped", "ready");
  updateSongContext({ part: "—", barsLeft: "—", upcoming: "—", queued: "—" });
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
    instrument: instrumentSel.value || "sine",
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
  if (data.instrument && [...instrumentSel.options].some(o => o.value === data.instrument)) {
  instrumentSel.value = data.instrument;
}

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
renderTimeGrid();
updateLoopUI();
}
async function importLoopFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
const data = JSON.parse(atob(text.trim()));

applyLoopData(data);

setLoopStatus("✓ Loop imported · ready to play", "ready");
  } catch (e) {
    setLoopStatus("Import failed · invalid loop data", "empty");
  }
}
// ─────────────────────────────────────────────────────────────
//  Base synth + drums (REQUIRED)
// ─────────────────────────────────────────────────────────────

function synthTone(freq, type = "sine", velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.4 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.25);
}

function synthKick() {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);

  gain.gain.setValueAtTime(1.0, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.13);
}

function synthSnare() {
  const now = audioCtx.currentTime;

  const noise = audioCtx.createBufferSource();
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  noise.buffer = buffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.7, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  noise.start(now);
  noise.stop(now + 0.2);
}

function synthHiHat() {
  const now = audioCtx.currentTime;

  const noise = audioCtx.createBufferSource();
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.05, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  noise.buffer = buffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 5000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  noise.start(now);
  noise.stop(now + 0.05);
}

function synthTom(freq) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.25);
}
// ─────────────────────────────────────────────────────────────
//  Audio synthesis
// ─────────────────────────────────────────────────────────────
function synthBass(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(freq / 2, now);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(400 + velocity * 800, now);

  gain.gain.setValueAtTime(0.6 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.3);
}

function synthPluck(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, now);

  filter.type = "highpass";
  filter.frequency.setValueAtTime(800 + velocity * 800, now);

  gain.gain.setValueAtTime(0.7 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.12);
}

function synthBell(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc1.type = "sine";
  osc2.type = "sine";

  osc1.frequency.setValueAtTime(freq, now);
  osc2.frequency.setValueAtTime(freq * 2.01, now);

  gain.gain.setValueAtTime(0.5 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(masterGain);

  osc1.start(now);
  osc2.start(now);

  osc1.stop(now + 1.3);
  osc2.stop(now + 1.3);
}

function synthPad(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, now);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(800 + velocity * 1200, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.3 * velocity, now + 0.3);
  gain.gain.linearRampToValueAtTime(0.0001, now + 1.5);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 1.6);
}

function synthLead(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(freq, now);

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(freq * (1.5 + velocity), now);

  gain.gain.setValueAtTime(0.5 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.35);
}

function synthOrgan(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc1.type = "triangle";
  osc2.type = "triangle";

  osc1.frequency.setValueAtTime(freq, now);
  osc2.frequency.setValueAtTime(freq * 2, now);

  gain.gain.setValueAtTime(0.4 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(masterGain);

  osc1.start(now);
  osc2.start(now);

  osc1.stop(now + 0.9);
  osc2.stop(now + 0.9);
}

function synthChip(freq, velocity = 1) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.5 * velocity, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + 0.1);
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
// ─────────────────────────────────────────────────────────────
//  Dynamic Time Grid
// ─────────────────────────────────────────────────────────────
function renderTimeGrid() {
  const timeGrid = document.getElementById("timeGrid");
  if (!timeGrid) return;

  const bars = Number(loopLengthSelect?.value || 1);
  const totalBoxes = stepGridSteps * bars;

  if (timeGrid.children.length === totalBoxes) {
    applyTimeGridAccents(timeGrid);
    return;
  }

  timeGrid.innerHTML = "";

  for (let i = 0; i < totalBoxes; i++) {
    const box = document.createElement("div");
    box.className = "time-box";
    timeGrid.appendChild(box);
  }

  timeGrid.style.setProperty("--time-box-count", totalBoxes);
  applyTimeGridAccents(timeGrid);
}

function applyTimeGridAccents(timeGrid) {
  const stepsPerBeat = Math.max(1, stepGridSteps / (metroBeatsPerBar || 4));

  Array.from(timeGrid.children).forEach((box, i) => {
    box.classList.toggle("beat-1", i % stepsPerBeat === 0);
  });
}
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
renderTimeGrid();
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
markUnsaved();
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
  // Sync transport authority state from host settings
  if (s.running !== undefined) transportRunning = !!s.running;

  dispKey.textContent = s.key || sessionSettings.key;
  dispMode.textContent = s.mode || sessionSettings.mode;
  dispBpm.textContent = s.bpm || sessionSettings.bpm;
  updateSongContext({ key: s.key || sessionSettings.key, mode: s.mode || sessionSettings.mode, bpm: s.bpm || sessionSettings.bpm });
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
  transportRunning = true;
  startMetronome(data);
  renderStepGrid();
  renderTimeGrid();
});

/** Metronome stop from host */
socket.on("metronome:stop", () => {
  transportRunning = false;
  stopMetronome();
  renderStepGrid();
  renderTimeGrid();
});

/** Remote tap from another player */
socket.on("tap:event", (event) => {
  // Play the sound locally using the event's instrument and degree
  const vel = event.velocity || 1;
playSound(event.padNumber, event.instrument || "sine", vel);
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

function getSavedBankLoops() {
  const loops = [];

  for (let slot = 1; slot <= 8; slot++) {
    const raw = localStorage.getItem(`pulsetap_loop_slot_${slot}`);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      loops.push({ slot, data });
    } catch {
      console.warn(`Bad loop data in slot ${slot}`);
    }
  }

  return loops;
}

function getLoopEventsFromData(data) {
  const loopLength = data.loopLengthMs || getLoopLengthMs();
  const steps = data.stepGridSteps || 16;

  const freeEvents = Array.isArray(data.loopEvents) ? data.loopEvents : [];

  const stepEvents = Array.isArray(data.stepGridEvents)
    ? data.stepGridEvents.map(ev => ({
        degree: ev.degree,
        instrument: ev.instrument || data.instrument || "sine",
        timeMs: (ev.step / steps) * loopLength
      }))
    : [];

  return [...freeEvents, ...stepEvents];
}

function startBankPlayback(anchorMs = Date.now()) {

  const bankLoops = getSavedBankLoops();

  if (!bankLoops.length) {
    setLoopStatus("No saved slots to play", "empty");
    return;
  }

  const lengths = bankLoops.map(l => l.data.loopLengthMs);
  const mismatch = lengths.some(l => l !== lengths[0]);

  if (mismatch) {
    setLoopStatus("Mixed loop lengths in bank", "queued");
  }

  stopBankPlayback();
  stopLoopPlayback();
  // ── Conflict guard: stop Song Mode if it was running ──
  if (songModeActive) {
    songModeActive = false;
    songIndex = 0;
    songBarsRemaining = 0;
    const _sb = document.getElementById("startSongBtn");
    if (_sb) { _sb.textContent = "Start Song ▶ Arrangement"; delete _sb.dataset.songRunning; }
    document.querySelectorAll(".song-section-btn").forEach(b => b.classList.remove("section-active"));
    setLoopStatus("Song stopped — Bank starting", "ready");
  }
  isBankPlaying = true;
  bankPlaybackAnchorMs = anchorMs;
  playBankBtn?.classList.add("playing");
  playBankBtn.textContent = "Stop Bank ■";

  setLoopStatus(`Playing bank · ${bankLoops.length} slot${bankLoops.length === 1 ? "" : "s"}`, "playing");
  updateSongContext({ bank: "Playing" });

  scheduleBankCycle(0);
}

function scheduleBankCycle(cycleIndex = 0) {
  if (!isBankPlaying) return;

  const bankLoops = getSavedBankLoops();
  if (!bankLoops.length) {
    stopBankPlayback();
    return;
  }

  const loopLength = getLoopLengthMs();
  const now = Date.now();
  const cycleStart = bankPlaybackAnchorMs + cycleIndex * loopLength;
  const nextCycleStart = bankPlaybackAnchorMs + (cycleIndex + 1) * loopLength;

  bankTimeouts.forEach(clearTimeout);
  bankTimeouts = [];

  for (const { slot, data } of bankLoops) {
    const events = getLoopEventsFromData(data);

    for (const event of events) {
      const eventTime = cycleStart + event.timeMs;
      const delay = eventTime - now;

      if (delay < -30) continue;

      const t = setTimeout(() => {
        if (!isBankPlaying) return;

        triggerTap(event.degree, event.instrument || data.instrument || "sine", {
          fromLoop: true,
          record: false,
          emit: !isSoloMode
        });
      }, Math.max(0, delay));

      bankTimeouts.push(t);
    }
  }

  const next = setTimeout(() => {
    scheduleBankCycle(cycleIndex + 1);
  }, Math.max(0, nextCycleStart - now));

  bankTimeouts.push(next);
}

function stopBankPlayback() {
  isBankPlaying = false;

  bankTimeouts.forEach(clearTimeout);
  bankTimeouts = [];

  playBankBtn?.classList.remove("playing");
  if (playBankBtn) playBankBtn.textContent = "Play Bank ▶ All Slots";
  updateSongContext({ bank: "Stopped" });

  updateLoopUI();
}

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

  loopVisualStartMs = anchorMs || (performance.timeOrigin + performance.now());
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
    box.classList.toggle("active",  index + 1 === activeStep);
    box.classList.toggle("passed",  index + 1 < activeStep);
    // UX: accent beat-1 of each bar (every 4th box starting at 1)
    box.classList.toggle("beat-1",  index % 4 === 0);
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
// ─────────────────────────────────────────────────────────────
//  Song Context Panel — update display
// ─────────────────────────────────────────────────────────────
let ctxCurrentSection = null;  // tracks the active section name for notes

function updateSongContext(overrides = {}) {
  const settings = sessionSettings || {};
  const key      = overrides.key      ?? settings.key     ?? (dispKey?.textContent)  ?? "—";
  const mode     = overrides.mode     ?? settings.mode    ?? (dispMode?.textContent) ?? "—";
  const bpm      = overrides.bpm      ?? settings.bpm     ?? (dispBpm?.textContent)  ?? "—";
  const timeSig  = overrides.timeSig  ?? (metroBeatsPerBar || 4) + "/4";
  const active   = overrides.active   ?? (currentLoopSlot ? `Slot ${currentLoopSlot}` : "—");
  const queued   = overrides.queued   ?? (queuedSlotNumber ? `Slot ${queuedSlotNumber}` : "—");
  const bank     = overrides.bank     ?? (isBankPlaying ? "Playing" : "Stopped");
  const part     = overrides.part     ?? ctxCurrentSection ?? "—";

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  // Song Flow Engine fields
  const upcoming = overrides.upcoming ?? (() => {
    if (!songModeActive) return "—";
    const nextIdx = songIndex + 1;
    return nextIdx < songSections.length ? songSections[nextIdx].name : "End";
  })();
  const barsLeft = overrides.barsLeft ?? (songModeActive ? songBarsRemaining : "—");
  set("ctxSongPart",    part);
  set("ctxKey",         key);
  set("ctxMode",        mode);
  set("ctxBpm",         bpm);
  set("ctxTimeSig",     timeSig);
  set("ctxActiveSlot",  active);
  set("ctxQueuedSlot",  queued);
  set("ctxBankStatus",  bank);
  set("ctxUpcoming",    upcoming);
  set("ctxBarsLeft",    barsLeft);
  // Bars Remaining inline display (in song-panel-header)
  const barsEl = document.getElementById("songBarsRemainingDisplay");
  if (barsEl) {
    if (songModeActive) {
      barsEl.textContent = `Bars Remaining: ${songBarsRemaining}`;
      barsEl.classList.remove("hidden");
    } else {
      barsEl.classList.add("hidden");
    }
  }
  // ── Visualizer relay ─────────────────────────────────
  // Emit player:viz-state so the server can relay it to
  // any connected /visualizer clients.
  if (typeof socket !== "undefined" && socket.connected) {
    const _roomId = (typeof roomCodeIn !== "undefined" && roomCodeIn)
      ? roomCodeIn.value.trim().toUpperCase() : "";
    if (_roomId) {
      socket.emit("player:viz-state", {
        roomId:     _roomId,
        section:    part     || "—",
        upcoming:   upcoming || "—",
        barsLeft:   barsLeft,
        slot:       currentLoopSlot || null,
        bpm:        bpm,
        key:        key,
        mode:       mode,
        timeSig:    timeSig,
        energy:     null,
        songActive: songModeActive
      });
    }
  }
}

function ctxLoadSectionNotes(sectionName) {
  const ta = document.getElementById("ctxSectionNotes");
  if (!ta) return;
  const key = sectionName ? `pulsetap_section_notes_${sectionName}` : null;
  ta.value = key ? (localStorage.getItem(key) || "") : "";
  ta.dataset.sectionKey = key || "";
}

function ctxInitNotesSave() {
  const ta = document.getElementById("ctxSectionNotes");
  if (!ta) return;
  ta.addEventListener("input", () => {
    if (ta.dataset.sectionKey) {
      localStorage.setItem(ta.dataset.sectionKey, ta.value);
    }
  });
}

function ctxToggleCollapse() {
  const body   = document.getElementById("songCtxBody");
  const toggle = document.getElementById("songCtxToggle");
  if (!body || !toggle) return;
  const collapsed = body.style.display === "none";
  body.style.display   = collapsed ? "" : "none";
  toggle.textContent   = collapsed ? "▲" : "▼";
}

// ─────────────────────────────────────────────────────────────
//  Editing Banner — shows which slot is being edited
// ─────────────────────────────────────────────────────────────
function updateEditingBanner(slotNumber) {
  const label   = document.getElementById("editingSlotLabel");
  const unsaved = document.getElementById("editingUnsaved");
  if (!label) return;
  if (slotNumber != null) {
    label.textContent = `Editing: Slot ${slotNumber}`;
  } else {
    label.textContent = "Editing: Unsaved Loop";
  }
  // Clear unsaved indicator whenever banner label changes
  if (unsaved) unsaved.classList.add("hidden");
}
function markUnsaved() {
  const unsaved = document.getElementById("editingUnsaved");
  if (unsaved) unsaved.classList.remove("hidden");
}
function clearUnsaved() {
  const unsaved = document.getElementById("editingUnsaved");
  if (unsaved) unsaved.classList.add("hidden");
}
function setLoopStatus(message, state = "") {

  if (!loopStatus) return;

  loopStatus.textContent = message;

  loopStatus.classList.remove(
    "status-recording",
    "status-playing",
    "status-queued",
    "status-ready",
    "status-empty",
    "status-solo"
  );

  if (state) {
    loopStatus.classList.add(`status-${state}`);
  }
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
  markUnsaved();
}

function clearLoop() {
  stopLoopPlayback();

  isLoopRecording = false;
  loopEvents = [];
  stepGridEvents = [];

  renderStepGrid();

  emitLoopState("clear");
  updateLoopUI();
  updateEditingBanner(null);
  clearUnsaved();
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
    if (songModeActive) {
  songBarsRemaining--;

  if (songBarsRemaining <= 0) {
    songIndex++;

    if (songIndex >= songSections.length) {
      // ── Song complete ──
      songModeActive = false;
      const startBtnC = document.getElementById("startSongBtn");
      if (startBtnC) { startBtnC.textContent = "Start Song ▶ Arrangement"; delete startBtnC.dataset.songRunning; }
      document.querySelectorAll(".song-section-btn").forEach(b =>
        b.classList.remove("section-active")
      );
      stopLoopPlayback();
      setLoopStatus("Song complete", "ready");
      updateSongContext({ part: "—", barsLeft: "—", upcoming: "—", queued: "—" });
      return;
    }

    const nextSection = songSections[songIndex];
    queueSlotForNextBar(nextSection.slot);
    songBarsRemaining = nextSection.bars;
    ctxCurrentSection = nextSection.name;

    // update UI highlight
    document.querySelectorAll(".song-section-btn").forEach(b =>
      b.classList.remove("section-active")
    );
    document
      .querySelector(`.song-section-btn[data-slot="${nextSection.slot}"]`)
      ?.classList.add("section-active");

    // Sync Song Context
    const afterNext = songIndex + 1 < songSections.length
      ? songSections[songIndex + 1].name : "End";
    updateSongContext({ part: nextSection.name, barsLeft: nextSection.bars, upcoming: afterNext });
    ctxLoadSectionNotes(nextSection.name);
    setLoopStatus(`Song running · ${nextSection.name} · ${nextSection.bars} bars`, "playing");
  } else {
    // Still in current section — update bars remaining
    updateSongContext({ barsLeft: songBarsRemaining });
  }
}
  if (queuedLoopData) {
  applyLoopData(queuedLoopData);

  currentLoopSlot = Number(queuedSlotNumber);

  document.querySelectorAll(".slot-btn").forEach(b => {
    b.classList.remove("queued", "active");
  });

  document
    .querySelector(`.slot-btn[data-slot="${queuedSlotNumber}"]`)
    ?.classList.add("active");

  queuedLoopData = null;
  queuedSlotNumber = null;
  updateEditingBanner(currentLoopSlot);

  currentLoopLengthMs = getLoopLengthMs();
loopPlaybackAnchorMs = nextCycleStart;
loopVisualStartMs = nextCycleStart;
loopVisualLengthMs = currentLoopLengthMs;

scheduleLoopCycle(0);
return;
}

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
  queuedLoopData = null;
  queuedSlotNumber = null;
  document.querySelectorAll(".slot-btn").forEach(b =>
    b.classList.remove("queued")
  );
  // If song mode was running, reset it cleanly
  if (songModeActive) {
    songModeActive = false;
    const startBtnS = document.getElementById("startSongBtn");
    if (startBtnS) { startBtnS.textContent = "Start Song ▶ Arrangement"; delete startBtnS.dataset.songRunning; }
    document.querySelectorAll(".song-section-btn").forEach(b =>
      b.classList.remove("section-active")
    );
    const barsEl = document.getElementById("songBarsRemainingDisplay");
    if (barsEl) barsEl.classList.add("hidden");
  }
  updateLoopUI();
}

playBankBtn?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (isBankPlaying) {
    stopBankPlayback();
  } else {
    // Use global bar boundary when host transport is running
    const startTime = transportRunning
      ? getNextGlobalBarStartTime()
      : getNextLocalBarStartTime();
    startBankPlayback(startTime);
  }
});

clearBankBtn?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!confirm("Clear all 8 loop slots? This cannot be undone.")) return;
  // Stop any active playback first
  stopBankPlayback();
  stopLoopPlayback();
  // Remove all 8 slots from localStorage
  for (let i = 1; i <= 8; i++) {
    localStorage.removeItem(`pulsetap_loop_slot_${i}`);
  }
  // Clear visual state on all slot buttons
  document.querySelectorAll(".slot-btn").forEach(btn => {
    btn.classList.remove("saved", "active", "queued");
  });
  // Clear queued slot state
  queuedLoopData   = null;
  queuedSlotNumber = null;
  setLoopStatus("Bank cleared", "ready");
  updateSongContext({ active: "—", queued: "—", bank: "Stopped" });
});

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
    if (transportRunning) {
      // ── Transport Authority: arm to next GLOBAL bar boundary ──
      const startTime = getNextGlobalBarStartTime();
      // Show "Armed for next bar" status while waiting
      setLoopStatus("Armed for next bar ⏳", "queued");
      playLoopBtn.textContent = "Armed…";
      playLoopBtn.disabled = true;
      startLoopPlaybackSynced(startTime);
      // Re-enable button once the loop actually starts
      const armDelay = Math.max(0, startTime - Date.now());
      setTimeout(() => {
        playLoopBtn.disabled = false;
        updateLoopUI();
      }, armDelay + 50);
    } else {
      // ── No host transport: local fallback ──
      const startTime = getNextLocalBarStartTime();
      setLoopStatus("Local start — no host transport", "ready");
      startLoopPlaybackSynced(startTime);
    }
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
function playSound(degree, instrument, velocity = 1) {
  if (!audioCtx) initAudio();
  const freq = padFrequency(degree);

  switch (instrument) {
    case "sine":     synthTone(freq, "sine", velocity);      break;
case "triangle": synthTone(freq, "triangle", velocity);  break;
case "square":   synthTone(freq, "square", velocity);    break;
case "sawtooth": synthTone(freq, "sawtooth", velocity);  break;

    case "bass":  synthBass(freq, velocity);  break;
    case "pluck": synthPluck(freq, velocity); break;
    case "bell":  synthBell(freq, velocity);  break;
    case "pad":   synthPad(freq, velocity);   break;
    case "lead":  synthLead(freq, velocity);  break;
    case "organ": synthOrgan(freq, velocity); break;
    case "chip":  synthChip(freq, velocity);  break;

    case "kit":    playDrumKitSound(degree); break;
    case "kick":   synthKick();              break;
    case "snare":  synthSnare();             break;
    case "hi-hat": synthHiHat();             break;
    case "tom":    synthTom(freq);           break;

    default: synthTone(freq, "sine", velocity);
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
    roomId: roomCodeIn.value.trim().toUpperCase(),
    playerId,
    playerName: playerNameIn.value.trim() || "Player",
    role: selectedRole,
    padNumber: degree,
    timestamp: Date.now(),
    soundType: sessionSettings.mode,
    instrument,
    frequency: padFrequency(degree),
    source
  });
}

function triggerTap(degree, instrument, options = {}) {
  const { fromLoop = false, record = true, emit = true } = options;
  if (isMuted) return;

  initAudio();

  // ── IMMEDIATE local playback ──────────────────────────
  const vel = 0.6 + Math.random() * 0.4;
  playSound(degree, instrument, vel);

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

      const exists = stepGridEvents.some(
        ev => ev.degree === degree && ev.step === step
      );

      if (exists) {
        stepGridEvents = stepGridEvents.filter(
          ev => !(ev.degree === degree && ev.step === step)
        );
      } else {
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
    triggerTap(degree, instrumentSel.value, {
      fromLoop: false,
      record: true,
      emit: true
    });
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
  // Song Context panel init
  ctxInitNotesSave();
  document.getElementById("songCtxToggle")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ctxToggleCollapse();
  });
  updateSongContext();
  updateEditingBanner(currentLoopSlot);
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
renderTimeGrid();
// mark saved slots on load
document.querySelectorAll(".slot-btn").forEach((btn) => {
  const slot = btn.dataset.slot;
  const key = `pulsetap_loop_slot_${slot}`;

  if (localStorage.getItem(key)) {
    btn.classList.add("saved");
  }
});

startSongBtn?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (startSongBtn.dataset.songRunning) {
    stopSongMode();
  } else {
    startSongMode();
  }
});

// ─────────────────────────────────────────────────────────────
//  Song Mode — section button listeners
// ─────────────────────────────────────────────────────────────
document.querySelectorAll(".song-section-btn").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const slot = Number(btn.dataset.slot);
    const ok = queueSlotForNextBar(slot);
    if (ok) {
      // Highlight the active section button
      document.querySelectorAll(".song-section-btn").forEach(b =>
        b.classList.remove("section-active")
      );
      btn.classList.add("section-active");
      ctxCurrentSection = btn.dataset.section || btn.textContent.trim().split("\n")[0].trim();
      updateSongContext({ part: ctxCurrentSection });
      ctxLoadSectionNotes(ctxCurrentSection);
    }
  });
});

// ─────────────────────────────────────────────────────────────
//  Sample Packs — load predefined loops into slots 1-5
// ─────────────────────────────────────────────────────────────
document.querySelectorAll(".sample-pack-btn").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();

    const packName = btn.dataset.pack;
    const pack = SAMPLE_PACKS[packName];
    if (!pack) return;

    pack.slots.forEach((loopData, i) => {
      const slot = i + 1;                                   // slots 1-5
      const key  = `pulsetap_loop_slot_${slot}`;
      localStorage.setItem(key, JSON.stringify(loopData));

      // Mark the corresponding slot button as saved
      const slotBtn = document.querySelector(`.slot-btn[data-slot="${slot}"]`);
      if (slotBtn) {
        slotBtn.classList.remove("active", "queued");
        slotBtn.classList.add("saved");
      }
    });

    // Visual feedback on the pack buttons
    document.querySelectorAll(".sample-pack-btn").forEach(b =>
      b.classList.remove("pack-active")
    );
    btn.classList.add("pack-active");

    setLoopStatus(`✓ Loaded ${pack.label} · tap a slot to play`, "ready");
    updateEditingBanner(null);
  });
});


// ─────────────────────────────────────────────────────────────
//  Demo Song loader — populates slots + sets Song Mode sections
// ─────────────────────────────────────────────────────────────
function loadDemoPack(packName) {
  const pack = SAMPLE_PACKS[packName];
  const demo = DEMO_SONGS[packName];
  if (!pack || !demo) return;

  // 1. Write slots 1-5 to localStorage
  pack.slots.forEach((loopData, i) => {
    const slot = i + 1;
    localStorage.setItem(`pulsetap_loop_slot_${slot}`, JSON.stringify(loopData));
    const slotBtn = document.querySelector(`.slot-btn[data-slot="${slot}"]`);
    if (slotBtn) {
      slotBtn.classList.remove('active', 'queued');
      slotBtn.classList.add('saved');
    }
  });

  // 2. Set Song Mode bar counts in the UI
  demo.sections.forEach(({ section, bars }) => {
    const row = [...document.querySelectorAll('.song-section-row')]
      .find(r => r.querySelector('.song-section-btn')?.dataset.section === section);
    if (!row) return;
    const sel = row.querySelector('.song-bars-select');
    if (sel) sel.value = String(bars);
  });

  // 3. Save section notes to localStorage
  demo.sections.forEach(({ section, notes }) => {
    if (notes) {
      localStorage.setItem(`pulsetap_section_notes_${section}`, notes);
    }
  });

  // 4. Apply pack settings to session (Solo-safe)
  sessionSettings = { ...sessionSettings, ...pack.settings };

  // 5. Highlight the active pack button
  document.querySelectorAll('.sample-pack-btn').forEach(b => b.classList.remove('pack-active'));
  document.querySelector(`.sample-pack-btn[data-pack="${packName}"]`)?.classList.add('pack-active');

  // 6. Update editing banner and status
  updateEditingBanner(null);
  setLoopStatus(`✓ ${pack.label} loaded · tap a slot to play · Start Song to run arrangement`, 'ready');

  // 7. Sync Song Context
  updateSongContext({ key: pack.settings.key, mode: pack.settings.mode, bpm: pack.settings.bpm });
}

// Demo Song button handler
document.querySelectorAll('.demo-song-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const packName = btn.dataset.pack;
    loadDemoPack(packName);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  MIDI EXPORT  — pure inline encoder, no external library
//  Converts the currently loaded loop to a standard MIDI Type-0 file.
//
//  Key mapping:
//    KEY_MIDI_ROOT maps each key name to the MIDI note number of that note
//    at octave 4 (e.g. C4 = 60, A4 = 69).
//    SCALES[mode] gives semitone offsets from the root for each pad degree.
//    degreeToMidi(degree) = KEY_MIDI_ROOT[key] + SCALES[mode][degree]
//
//  Event sources (priority: stepGridEvents > loopEvents):
//    stepGridEvents: { step, degree, instrument }
//      → time = (step / stepGridSteps) * loopLengthMs
//    loopEvents:     { degree, instrument, timeMs }
//      → time = timeMs
// ═══════════════════════════════════════════════════════════════════════════

/** MIDI note numbers for each key at octave 4 (C4 = 60) */
const KEY_MIDI_ROOT = {
  C: 60, "C#": 61, D: 62, "D#": 63,
  E: 64, F: 65, "F#": 66, G: 67,
  "G#": 68, A: 69, "A#": 70, B: 71
};

/**
 * Convert a pad degree to a MIDI note number using current session settings.
 * Percussion instruments (kick, snare, hi-hat, tom) are mapped to GM drum
 * channel notes on channel 10 (0-indexed: 9).
 */
const DRUM_NOTES = {
  kick:    36,   // Bass Drum 1
  snare:   38,   // Acoustic Snare
  "hi-hat": 42,  // Closed Hi-Hat
  tom:     45    // Low Floor Tom
};

const MELODIC_INSTRUMENTS = new Set([
  "sine", "triangle", "square", "sawtooth",
  "bass", "pluck", "bell", "pad", "lead", "organ", "chip"
]);

function degreeToMidi(degree, instrument, key, mode) {
  if (DRUM_NOTES[instrument] !== undefined) {
    return { note: DRUM_NOTES[instrument], channel: 9 };
  }
  const root   = KEY_MIDI_ROOT[key] ?? 60;
  const scale  = SCALES[mode] ?? SCALES.major;
  const offset = scale[Math.min(degree, scale.length - 1)] ?? 0;
  return { note: Math.min(127, root + offset), channel: 0 };
}

// ─── Low-level MIDI byte helpers ─────────────────────────────────────────

/** Encode a variable-length quantity (delta time) as MIDI VLQ bytes */
function vlq(value) {
  if (value < 0) value = 0;
  const bytes = [];
  bytes.unshift(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7F) | 0x80);
    value >>= 7;
  }
  return bytes;
}

/** Write a 4-byte big-endian unsigned integer */
function uint32be(n) {
  return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

/** Write a 2-byte big-endian unsigned integer */
function uint16be(n) {
  return [(n >>> 8) & 0xFF, n & 0xFF];
}

// ─── MIDI file builder ───────────────────────────────────────────────────

/**
 * Build a MIDI Type-0 file from an array of note events.
 *
 * @param {Array<{timeMs: number, note: number, channel: number, velocity: number, durationMs: number}>} notes
 * @param {number} bpm
 * @param {number} loopLengthMs
 * @returns {Uint8Array}
 */
function buildMidiFile(notes, bpm, loopLengthMs) {
  const TICKS_PER_BEAT = 480;
  const usPerBeat      = Math.round(60_000_000 / bpm);   // microseconds per beat
  const msPerTick      = (usPerBeat / 1000) / TICKS_PER_BEAT;

  function msToTicks(ms) {
    return Math.max(0, Math.round(ms / msPerTick));
  }

  // Build list of raw MIDI events: [tickAbsolute, bytes[]]
  const rawEvents = [];

  // Tempo event at tick 0
  rawEvents.push([0, [0xFF, 0x51, 0x03,
    (usPerBeat >>> 16) & 0xFF,
    (usPerBeat >>>  8) & 0xFF,
     usPerBeat        & 0xFF
  ]]);

  // Time signature: 4/4
  rawEvents.push([0, [0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]]);

  // Note on/off pairs
  for (const ev of notes) {
    const t0   = msToTicks(ev.timeMs);
    const t1   = msToTicks(ev.timeMs + ev.durationMs);
    const vel  = Math.min(127, Math.max(1, Math.round((ev.velocity ?? 0.8) * 100)));
    const ch   = ev.channel & 0x0F;

    rawEvents.push([t0, [0x90 | ch, ev.note & 0x7F, vel]]);         // note on
    rawEvents.push([t1, [0x80 | ch, ev.note & 0x7F, 0]]);           // note off
  }

  // End-of-track marker at loop length
  rawEvents.push([msToTicks(loopLengthMs), [0xFF, 0x2F, 0x00]]);

  // Sort by tick, then note-off before note-on at same tick
  rawEvents.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    const aOff = (a[1][0] & 0xF0) === 0x80 ? 0 : 1;
    const bOff = (b[1][0] & 0xF0) === 0x80 ? 0 : 1;
    return aOff - bOff;
  });

  // Convert to delta-time track bytes
  const trackBytes = [];
  let prevTick = 0;
  for (const [tick, bytes] of rawEvents) {
    const delta = tick - prevTick;
    prevTick = tick;
    trackBytes.push(...vlq(delta), ...bytes);
  }

  // MIDI header chunk: MThd
  const header = [
    0x4D, 0x54, 0x68, 0x64,   // "MThd"
    ...uint32be(6),             // chunk length = 6
    ...uint16be(0),             // format 0 (single track)
    ...uint16be(1),             // 1 track
    ...uint16be(TICKS_PER_BEAT) // ticks per quarter note
  ];

  // MIDI track chunk: MTrk
  const track = [
    0x4D, 0x54, 0x72, 0x6B,   // "MTrk"
    ...uint32be(trackBytes.length),
    ...trackBytes
  ];

  return new Uint8Array([...header, ...track]);
}

// ─── exportMidi() — main entry point ────────────────────────────────────

function exportMidi() {
  const data = getCurrentLoopData();

  const key        = data.settings?.key  || sessionSettings.key  || "C";
  const mode       = data.settings?.mode || sessionSettings.mode || "major";
  const bpm        = data.settings?.bpm  || sessionSettings.bpm  || 120;
  const loopMs     = data.loopLengthMs   || currentLoopLengthMs  || 2000;
  const steps      = data.stepGridSteps  || stepGridSteps        || 16;
  const resolution = parseInt(data.stepResolution || "16", 10);

  const notes = [];
  const noteDurationMs = Math.max(60, (loopMs / resolution) * 0.8); // 80% of step width

  // ── stepGridEvents (primary source) ──────────────────────────────────
  if (data.stepGridEvents && data.stepGridEvents.length > 0) {
    for (const ev of data.stepGridEvents) {
      const timeMs = (ev.step / steps) * loopMs;
      const { note, channel } = degreeToMidi(
        ev.degree ?? 0,
        ev.instrument || data.instrument || "sine",
        key, mode
      );
      notes.push({ timeMs, note, channel, velocity: 0.8, durationMs: noteDurationMs });
    }
  }

  // ── loopEvents (free-time fallback / supplement) ──────────────────────
  if (data.loopEvents && data.loopEvents.length > 0) {
    for (const ev of data.loopEvents) {
      const timeMs = ev.timeMs ?? 0;
      const { note, channel } = degreeToMidi(
        ev.degree ?? 0,
        ev.instrument || data.instrument || "sine",
        key, mode
      );
      notes.push({ timeMs, note, channel, velocity: 0.75, durationMs: noteDurationMs });
    }
  }

  if (notes.length === 0) {
    setLoopStatus("Nothing to export · record a loop first", "empty");
    return;
  }

  const midiBytes = buildMidiFile(notes, bpm, loopMs);

  // Trigger browser download
  const blob = new Blob([midiBytes], { type: "audio/midi" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `pulsetap-loop-${key}-${mode}-${bpm}bpm.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  setLoopStatus(`\u2193 MIDI exported \u00b7 ${notes.length} note${notes.length === 1 ? "" : "s"} \u00b7 ${bpm} BPM`, "ready");
}
