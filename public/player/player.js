// ==============================
// LOOP MODE CONFIG
// ==============================

let loopEvents = [];
let isLoopRecording = false;
let isLoopPlaying = false;
let loopStartMs = 0;
let loopTimeouts = [];

let loopBars = 1;
let quantizeDivision = "off";
let currentLoopLengthMs = 2000;
let sessionSettings = { key: "C", mode: "major", bpm: 120, quantize: "none" };
// ==============================
// LOOP HELPERS
// ==============================

function getLoopLengthMs() {
  const bpm = Number(sessionSettings.bpm) || 120;
  const beatsPerBar = 4;
  const msPerBeat = 60000 / bpm;
  return loopBars * beatsPerBar * msPerBeat;
}

function quantizeLoopTime(timeMs, loopLengthMs) {
  if (quantizeDivision === "off") return timeMs;

  const stepsPerBar = parseInt(quantizeDivision);
  const totalSteps = stepsPerBar * loopBars;
  const stepSize = loopLengthMs / totalSteps;

  return Math.round(timeMs / stepSize) * stepSize;
}

// ==============================
// LOOP UI
// ==============================

function updateLoopUI() {
  const loopStatus = document.getElementById("loopStatus");
  const recordBtn = document.getElementById("recordLoopBtn");
  const playBtn = document.getElementById("playLoopBtn");
  const clearBtn = document.getElementById("clearLoopBtn");

  currentLoopLengthMs = getLoopLengthMs();

  if (recordBtn) recordBtn.textContent = isLoopRecording ? "Stop Recording" : "Record Loop";
  if (playBtn) playBtn.textContent = isLoopPlaying ? "Stop Loop" : "Play Loop";

  if (playBtn) playBtn.disabled = loopEvents.length === 0;
  if (clearBtn) clearBtn.disabled = loopEvents.length === 0;

  if (!loopStatus) return;

  if (isLoopRecording) {
    loopStatus.textContent = `Recording (${loopEvents.length})`;
  } else if (isLoopPlaying) {
    loopStatus.textContent = `Playing (${loopEvents.length})`;
  } else if (loopEvents.length) {
    loopStatus.textContent = `Ready (${loopEvents.length})`;
  } else {
    loopStatus.textContent = "Empty";
  }
}

// ==============================
// LOOP CONTROL
// ==============================

function startLoopRecording() {
  loopStartMs = performance.now();
requestAnimationFrame(animatePlayhead);
  loopEvents = [];
  loopStartMs = performance.now();
  isLoopRecording = true;
  isLoopPlaying = false;
  updateLoopUI();
}

function stopLoopRecording() {
  isLoopRecording = false;
  updateLoopUI();
}

function startLoopPlayback() {
  if (!loopEvents.length) return;

  isLoopPlaying = true;
  isLoopRecording = false;
  updateLoopUI();
  scheduleLoop();
}

function stopLoopPlayback() {
  isLoopPlaying = false;
  loopTimeouts.forEach(clearTimeout);
  loopTimeouts = [];
  updateLoopUI();
}

function clearLoop() {
  stopLoopPlayback();
  loopEvents = [];
  updateLoopUI();
}

// ==============================
// LOOP SCHEDULING
// ==============================

function scheduleLoop() {
  if (!isLoopPlaying) return;

  loopTimeouts.forEach(clearTimeout);
  loopTimeouts = [];

  const loopLength = getLoopLengthMs();

  loopEvents.forEach(evt => {
    const t = setTimeout(() => {
      triggerTap(evt.degree, evt.instrument, { fromLoop: true });
    }, evt.timeMs);

    loopTimeouts.push(t);
  });

  loopTimeouts.push(setTimeout(scheduleLoop, loopLength));
}

// ==============================
// WIRE CONTROLS
// ==============================

document.getElementById("recordLoopBtn")?.addEventListener("click", () => {
  isLoopRecording ? stopLoopRecording() : startLoopRecording();
});

document.getElementById("playLoopBtn")?.addEventListener("click", () => {
  isLoopPlaying ? stopLoopPlayback() : startLoopPlayback();
});

document.getElementById("clearLoopBtn")?.addEventListener("click", clearLoop);

document.getElementById("loopLengthSelect")?.addEventListener("change", (e) => {
  loopBars = parseInt(e.target.value);
});

document.getElementById("quantizeSelect")?.addEventListener("change", (e) => {
  quantizeDivision = e.target.value;
});
function animatePlayhead() {
  if (!isLoopPlaying) return;

  const loopLength = getLoopLengthMs();
  const now = performance.now();
  const progress = ((now - loopStartMs) % loopLength) / loopLength;

  const playhead = document.getElementById("loopPlayhead");
  if (playhead) {
    playhead.style.transform = `translateX(${progress * 100}%)`;
  }

  requestAnimationFrame(animatePlayhead);
}
// ==============================
// MODIFY YOUR EXISTING triggerTap
// ==============================

// FIND your triggerTap function and ADD THIS INSIDE:

/*
if (isLoopRecording) {
  const loopLength = getLoopLengthMs();
  let rel = (performance.now() - loopStartMs) % loopLength;
  rel = quantizeLoopTime(rel, loopLength);

  loopEvents.push({
    degree,
    instrument,
    timeMs: rel
  });

  updateLoopUI();
}
*/

updateLoopUI();
