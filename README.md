# PulseTap · Phase 1

PulseTap is a browser-based multi-user music session prototype.

It has two layers:

1. **Landing page** at `/`  
   This explains the PulseTap vision: an instrument in every pocket, the fidget-cube-to-instrument idea, the roadmap, the host board, and the group performance concept.

2. **Live session app**  
   - Player page: `/player/`
   - Host page: `/host/`

## Live Links

Landing page:

https://pulsetap.onrender.com/

Player page:

https://pulsetap.onrender.com/player/

Host page:

https://pulsetap.onrender.com/host/

GitHub repo:

https://github.com/kappter/PulseTap

## What This Prototype Does

### Player Mode

Players can:

- Enter a name
- Enter a room code
- Choose a role:
  - Melody
  - Bass
  - Percussion
  - Chords
  - FX
- Join a shared session
- Tap large pads to trigger sounds
- Send tap activity to the host board
- Record a one-bar loop with **Loop Mode v1**
- Play the loop back while still tapping live

The player page is designed for phones first.

### Loop Mode v1

Loop Mode is local-first.

The player can:

1. Tap **Record Loop**
2. Tap a short pattern
3. Tap **Stop Recording**
4. Tap **Play Loop**
5. Keep tapping live over the loop
6. Clear and rebuild the loop

Current loop behavior:

- One-bar loop length based on the session BPM
- Defaults to 4 beats at 120 BPM if no host metronome has been set
- Taps play immediately on the player device
- Loop playback also sends tap events to the session so the host can see activity
- Quantize support is basic and snaps to a 16-step grid when active

### Host Mode

The host can:

- Enter a room code
- View connected players
- See player roles
- Watch tap activity
- Use the page as an early master board / switchboard concept

The host page is designed for laptop, desktop, or tablet.

## How To Test

### Basic Test With One Device

1. Open:

   https://pulsetap.onrender.com/player/

2. Enter your name.
3. Enter a room code, such as:

   1413

4. Choose a role.
5. Join the session.
6. Tap the pads.
7. Try Loop Mode:
   - Record Loop
   - Tap a pattern
   - Stop Recording
   - Play Loop

### Test With Two Devices

1. On a computer, open:

   https://pulsetap.onrender.com/host/

2. Enter the room code:

   1413

3. On a phone, open:

   https://pulsetap.onrender.com/player/

4. Enter a name.
5. Use the same room code:

   1413

6. Join the session.
7. Tap on the phone and watch for activity on the host board.
8. Record a loop on the phone and watch the host respond to loop playback.

## Important Notes

This is Phase 1.

The most important goal is:

> The player should hear or feel their own tap immediately.

Network sync is secondary in this version.

Perfect simultaneity is not expected yet. The goal is to begin testing how close we can get to shared musical timing across devices.

## Current Limitations

- Timing between devices may not be perfect.
- Audio latency may vary by phone, browser, headphones, and internet connection.
- Bluetooth headphones may add delay.
- Loop Mode is one-bar only in this version.
- Loop saving/export is not implemented yet.
- The host board is an early prototype.
- Recording full sessions is not implemented yet.
- The cube hardware does not exist yet.

## Recommended Testing Setup

Best early test:

- Host page on laptop
- Player page on phone
- Same room code
- Wired headphones if possible
- Chrome browser
- Stable Wi-Fi

## Project Vision

PulseTap begins as a browser app, but the larger vision is a pocket instrument system.

Development path:

1. Build the browser app.
2. Add external sensors outside the phone.
3. Develop a wireless instrument cube.

The long-term dream is:

> An instrument in every pocket.

A small device could include buttons, switches, tap zones, motion sensors, or customizable panels. These inputs could become notes, percussion, chords, effects, or triggers inside a musical session.

## Future Features

Possible next steps:

- Better sounds
- Multiple loop slots
- Loop overdub
- Loop save / export
- Shared tempo
- Better quantization
- Host volume controls
- Mute / solo per player
- Session recording
- Invite links
- QR code room joining
- Hardware sensor testing
- Bluetooth MIDI experiments
- Cube prototype documentation

## Local Development

Install dependencies:

```bash
npm install
```

Start the server:

```bash
node server.js
```

Then open:

```text
http://localhost:3000/
http://localhost:3000/player/
http://localhost:3000/host/
```

## Deployment

This app is deployed on Render.

Render settings:

```text
Runtime: Node
Build Command: npm install
Start Command: node server.js
```

## Core Concept

PulseTap is not just an app.

It is a system for turning touch, timing, movement, looping, and collaboration into music.
