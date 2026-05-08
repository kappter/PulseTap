# PulseTap · Phase 1 Alpha

PulseTap is a browser-based collaborative musical sketching and synchronized performance environment.

The system is designed around a simple idea:

> Music exists before production.

Before recording, before arrangement, and before perfection, musicians move through a shared space of rhythm, repetition, tension, transition, and emotional direction.

PulseTap focuses on that stage.

The project currently exists as a browser-first ecosystem for:
- collaborative loop creation
- synchronized musical interaction
- section-based song structure
- live arrangement experimentation
- future visualization-guided performance

---

# Live Links

Landing page:

https://pulsetap.onrender.com/

Player page:

https://pulsetap.onrender.com/player/

Host page:

https://pulsetap.onrender.com/host/

GitHub repo:

https://github.com/kappter/PulseTap

---

# Ecosystem Vision

PulseTap is one part of a larger creative workflow.

## 1. Songmaker

Songmaker defines:
- structure
- sections
- transitions
- key and mode
- energy movement
- emotional direction

The goal is to capture the shape of a song before it becomes a finished production.

## 2. PulseTap

PulseTap turns structure into synchronized playable interaction.

Musicians:
- build loops
- experiment collaboratively
- perform transitions
- shape arrangements
- sketch rhythmic and harmonic ideas in real time

## 3. Visualization Layer

A future fullscreen visualization system will guide live performers through:
- section awareness
- energy movement
- timing cohesion
- transition countdowns
- ensemble synchronization

The long-term vision is a collaborative musical ecosystem connecting composition, interaction, and performance flow.

---

# Philosophy

PulseTap is intentionally lightweight:
- touch-first
- collaborative
- synchronization-aware
- structure-oriented
- performance-focused

The goal is not to replace a DAW.

The goal is to preserve the fragile moment before a song fully exists.

---

# Current Applications

PulseTap currently contains two primary interfaces:

## Landing Page `/`

The landing page explains:
- the PulseTap vision
- the instrument cube concept
- the roadmap
- collaborative performance philosophy
- Songmaker integration
- future visualization systems

## Live Session App

### Player
`/player/`

### Host
`/host/`

---

# Current Features

## Player Features

Players can:
- enter a name
- join a room
- choose a musical role
- trigger sounds live
- perform collaboratively
- build synchronized loops
- edit quantized step grids
- save and load loop slots
- duplicate loops
- queue transitions on bar boundaries
- organize sections into songs
- export MIDI sketches
- experiment with sample packs

The player interface is designed mobile-first.

---

# Loop + Song Mode

PulseTap currently supports:

- multi-bar loop recording
- quantized recording
- editable step sequencing
- variable step resolution
- loop slot banks
- slot duplication
- loop import/export
- queued bar-quantized slot switching
- local-first playback
- sample packs
- automatic section progression
- MIDI export

Song Mode allows musicians to organize loops into larger musical structures such as:
- Intro
- Verse
- Chorus
- Bridge
- Outro

The system automatically transitions between sections on exact bar boundaries while preserving playback continuity.

---

# Synchronization Philosophy

PulseTap prioritizes immediate local responsiveness first.

Players should hear and feel their own interaction instantly.

The system then uses:
- quantization
- synchronized transport
- queued transitions
- bar-aligned switching
- shared BPM structure

to maintain collective timing coherence across devices.

This local-first architecture preserves musical feel while still enabling collaborative synchronization.

---

# Host Features

The host interface currently allows:
- room management
- player visibility
- tap activity monitoring
- timing coordination
- early transport experimentation

The host page represents the beginning of a future arrangement and visualization control system.

---

# How To Test

## Basic Test

1. Open:

https://pulsetap.onrender.com/player/

2. Enter:
- your name
- room code
- role

3. Join the session.

4. Tap pads live.

5. Test:
- Loop Mode
- Slot saving
- Slot switching
- Song Mode
- MIDI export
- Sample packs

---

# Multi-Device Test

## Host

Open:

https://pulsetap.onrender.com/host/

## Player

Open:

https://pulsetap.onrender.com/player/

Use the same room code across devices.

Test:
- live interaction
- loop playback
- synchronized transitions
- queued slot switching
- song progression

---

# Current Phase

PulseTap is currently in Phase 1 Alpha.

The primary focus is:
- synchronization stability
- mobile usability
- collaborative timing
- live arrangement workflows
- section-based composition
- visualization architecture

Known limitations:
- long-session synchronization still requires refinement
- mobile UX continues evolving
- visualization mode is early-stage
- full session save/load is not finalized
- hardware integration is experimental

---

# Recommended Testing Setup

Recommended early testing:
- host page on laptop
- player page on phone
- stable Wi-Fi
- Chrome browser
- wired headphones when possible

---

# Development Path

PulseTap begins as a browser application, but the larger vision is a modular musical ecosystem.

## Phase 1
Browser-based collaborative music environment.

## Phase 2
External sensors and expanded interaction systems.

## Phase 3
Wireless PulseTap instrument cube hardware.

The long-term vision is:

> An instrument in every pocket.

---

# Future Directions

Planned areas of development include:
- fullscreen visualization mode
- ensemble guidance systems
- host arrangement board
- player mixer controls
- long-session sync correction
- shared song session files
- QR room joining
- hardware sensor integration
- Bluetooth MIDI experimentation
- PulseTap cube prototypes
- projector-safe performance mode

---

# Local Development

Install dependencies:

```bash
npm install
