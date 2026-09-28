# Magic Mirror

An interactive mirror: see your live camera reflection, open your mouth to fog the glass, pinch (thumb + index) to draw through the condensation, and turn your drawing into music.

## Run locally

Camera access requires `localhost` or HTTPS, so serve the folder (don't open `index.html` directly):

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080 in Chrome or Safari and allow camera access.

## How to use

- **Fog the mirror:** open your mouth. The mist appears at your mouth and gets denser the longer it stays open.
- **Draw:** pinch thumb and index finger together and move your hand to wipe a line through the mist.
- **Play:** press "Play my drawing" to hear your strokes as music.
- **Fade:** the mist slowly clears (~30s) once your mouth is closed.
- **Buttons:** undo, clear (resets drawing and mist), mist again, play.

## Tech

- Vanilla HTML/CSS/JS, no build step
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) (hand + face landmarks), loaded from CDN
- [Tone.js](https://tonejs.github.io/) for music, loaded from CDN

Requires an internet connection for the CDN scripts and fonts.
