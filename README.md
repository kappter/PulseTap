# PulseTap · Phase 1

A browser-based multi-user music session prototype. Players tap pads on their phones; a host page acts as a DAW-style master board showing each connected player as a channel strip.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node server.js

# 3. Open in browser
# Player:  http://localhost:3000/player
# Host:    http://localhost:3000/host
```

To test with real phones on the same Wi-Fi network, find your machine's local IP address and open `http://<your-ip>:3000/player` on each phone.

---

## File structure

```
pulsetap-phase1/
├── server.js                   # Node/Express + Socket.IO backend
├── package.json
├── README.md
└── public/
    ├── shared/
    │   └── style.css           # Shared design tokens, resets, components
    ├── player/
    │   ├── index.html          # Player page markup
    │   ├── player.css          # Player-specific styles
    │   └── player.js           # Web Audio synthesis + Socket.IO client
    └── host/
        ├── index.html          # Host / mixer page markup
        ├── host.css            # Mixer-specific styles
        └── host.js             # Room management + channel strip logic
```

---

## How it works

### Architecture

```
Phone A (player.js)          server.js               Phone B (player.js)
      │                           │                         │
      │── player:join ──────────► │                         │
      │                           │── player:joined ───────►│ (host only)
      │                           │                         │
      │── player:tap ───────────► │                         │
      │  (plays sound locally)    │── tap:event ───────────►│
      │                           │  (plays sound locally)  │
      │                           │                         │
      │◄── metronome:start ───────│◄── host:metronome ──────│ (host page)
      │  (schedules local ticks)  │                         │
```

**Key design principle:** Every player plays their own tap sound **immediately** on their own device using the Web Audio API. The Socket.IO relay is fire-and-forget. Network latency never blocks local audio.

### Socket.IO events

| Direction | Event | Payload |
|---|---|---|
| Player → Server | `player:join` | `{ roomId, playerId, playerName, role }` |
| Player → Server | `player:tap` | `{ roomId, playerId, padNumber, instrument, frequency, … }` |
| Host → Server | `host:create` | `{ roomId }` |
| Host → Server | `host:settings` | `{ roomId, bpm, key, mode, quantize }` |
| Host → Server | `host:metronome` | `{ roomId, action, bpm, beatsPerBar, beatUnit, startTime }` |
| Host → Server | `host:mute` | `{ roomId, targetPlayerId, muted }` |
| Host → Server | `host:volume` | `{ roomId, targetPlayerId, volume }` |
| Server → All | `tap:event` | Full tap payload (excluding sender) |
| Server → All | `metronome:start` | `{ bpm, beatsPerBar, beatUnit, startTime }` |
| Server → All | `metronome:stop` | `{}` |
| Server → Host | `room:state` | Full room snapshot |
| Server → Host | `player:joined` | Player info object |
| Server → Host | `player:left` | `{ playerId }` |
| Server → Host | `player:tap:meter` | Lightweight meter pulse |

---

## Player page (`/player`)

1. Enter your name and a room code.
2. Choose a role: Melody, Bass, Percussion, Chords, or FX.
3. Tap **Join Session**.
4. Select an instrument from the dropdown (sine, triangle, square, sawtooth, kick, snare, hi-hat, tom).
5. Tap the 8 large pads. Your sound plays instantly. Other players in the same room hear it too.

The key, mode, and BPM shown at the top are set by the host and update in real time.

---

## Host page (`/host`)

1. Enter or generate a room code and click **Open Room**.
2. Share the room code with your players (use the copy button).
3. Set BPM, time signature, key, mode, and quantize in the transport bar.
4. Click **▶ Start** to launch the shared metronome. All players hear it simultaneously.
5. As players join, their channel strips appear. Each strip shows:
   - Player name and role (colour-coded)
   - VU meter that pulses on every tap
   - Volume slider (sent to the player's device)
   - Mute button (silences that player's pads)
   - Solo button (Phase 2 placeholder)

---

## Deploying for two-phone testing

### Option A — Local Wi-Fi (fastest)

```bash
node server.js
# Note the IP address shown in your terminal or run:
ipconfig getifaddr en0   # macOS
hostname -I              # Linux
```

Open `http://<your-ip>:3000/host` on your laptop and `http://<your-ip>:3000/player` on each phone. All devices must be on the same Wi-Fi network.

### Option B — Public tunnel (test across networks)

```bash
# Install ngrok (https://ngrok.com) then:
ngrok http 3000
```

Share the `https://…ngrok.io` URL with players. Replace `localhost:3000` with the ngrok URL.

### Option C — Deploy to Render (free tier, permanent)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service.
3. Connect your repo. Set:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node
4. Deploy. Render gives you a permanent `https://…onrender.com` URL.

---

## Latency notes and Phase 1 limitations

### What works well

- **Local tap latency** is effectively zero — the Web Audio API plays the sound in the same event loop tick as the `pointerdown` event, before any network round-trip.
- **Metronome alignment** is tight within a single device. The host sends a `startTime` epoch timestamp; each client schedules its first tick relative to that timestamp using `Date.now()`, giving sub-50 ms alignment on a good LAN.

### Known limitations in Phase 1

| Limitation | Impact | Phase 2 fix |
|---|---|---|
| Remote tap delay | Other players hear your tap 50–300 ms late depending on network | WebRTC data channels or server-side scheduling with lookahead |
| Metronome drift | `setInterval` drifts ±10–20 ms per minute | Web Audio clock scheduler (`audioCtx.currentTime`-based lookahead) |
| No quantization | Quantize setting is broadcast but not enforced | Client-side snap-to-grid using the shared BPM clock |
| No persistence | Room state is lost if the server restarts | Add Redis or a simple JSON store |
| Volume/mute relay | Volume and mute events are sent to all clients but player.js does not yet apply them to the local gain node | Wire `host:volume:ack` and `host:mute:ack` to the player's `masterGain.gain` |
| No audio on host | The host page does not synthesise sound | Add an optional monitor mix on the host using the same Web Audio engine |

---

## Phase 2 roadmap

The following features are planned for Phase 2:

- **Quantized playback** — snap taps to the nearest beat grid division on the client before playing and before sending the event.
- **Web Audio lookahead scheduler** — replace `setInterval` metronome with a precise `audioCtx.currentTime`-based scheduler (the "Chris Wilson" pattern) for sub-millisecond drift.
- **Host audio monitor** — the host page synthesises a mix of all players' sounds with per-channel volume and mute applied.
- **Record + playback** — capture tap events with timestamps and replay them as a loop.
- **MIDI output** — send tap events as MIDI note-on/off messages via the Web MIDI API.
- **Wearable / accelerometer input** — use `DeviceMotionEvent` to trigger pads from walking rhythm.
- **Persistent rooms** — store room state in Redis so the host can reload without losing players.
- **Solo mode** — mute all channels except the soloed one, with host-side routing.
- **Per-player instrument lock** — host can lock a player's instrument so it cannot be changed mid-session.

---

## Browser compatibility

| Feature | Chrome | Safari iOS | Firefox |
|---|---|---|---|
| Web Audio API | ✓ | ✓ (requires user gesture) | ✓ |
| `pointerdown` | ✓ | ✓ | ✓ |
| `navigator.vibrate` | ✓ | ✗ | ✓ |
| Socket.IO (WebSocket) | ✓ | ✓ | ✓ |

Safari on iOS requires a user gesture (tap) before the `AudioContext` can be created. The code handles this automatically via the `pointerdown` listener on `document.body`.

---

## License

MIT — build freely, credit appreciated.
