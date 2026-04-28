# PulseTap · Phase 1

PulseTap is a browser-based multi-user music session prototype.

Players join a shared room from their phones and tap large musical pads. A host opens a separate master board page to see connected players, monitor activity, and eventually control the session like a simplified DAW or live mixer.

## Live Links

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
- Join a session
- Tap large pads to trigger sounds
- Send tap activity to the session

The player page is designed for phones first.

### Host Mode

The host can:

- Enter the same room code
- View connected players
- See player roles
- Watch tap activity
- Begin testing the idea of a master board / switchboard

The host page is designed for a laptop, desktop, or tablet.

## How To Test

### Basic Test With One Device

1. Open the player page:
   https://pulsetap.onrender.com/player/

2. Enter your name.

3. Enter a room code, such as:

   1413

4. Choose a role.

5. Join the session.

6. Tap the pads.

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
- The host board is an early prototype.
- Recording is not fully implemented yet.
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
- Shared tempo
- Quantization
- Host volume controls
- Mute / solo per player
- Session recording
- Invite links
- QR code room joining
- Better mobile responsiveness
- Hardware sensor testing
- Bluetooth MIDI experiments
- Cube prototype documentation

## Local Development

Install dependencies:

```bash
npm install
