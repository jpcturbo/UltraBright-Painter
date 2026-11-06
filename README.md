# HDR Web Paint 🎨✨
### High Dynamic Range & Display-P3 Web Painting Application

A fun, responsive web painting application built to explore **High Dynamic Range (HDR)** and **Display-P3 Wide Color Gamut** directly inside modern browsers.

Designed specifically for HDR-capable displays and modern high-brightness mobile OLED/HDR screens (iPhone Super Retina XDR, Samsung Galaxy AMOLED, Google Pixel, and wide-gamut Display-P3 monitors).

---

## 🌟 Key Features

- **True HDR Rendering Pipeline**:
  - Leverages WebGL 2 with `gl.drawingBufferStorage(gl.RGBA16F)` half-float backing store and `gl.drawingBufferColorSpace = 'display-p3'`.
  - Opts into the browser compositor's extended dynamic range headroom via `canvas.configureHighDynamicRange({ mode: 'extended' })`.
  - Brush strokes and stamps emit unclamped luminance values exceeding standard SDR white (`1.0`), tapping directly into peak monitor and phone screen brightness (up to 600+ nits).

- **Tools**:
  1. **Circular Paint Brush**: Smooth continuous stroke interpolation, radius sizing (4px - 220px), adjustable edge feathering/softness (0% to 100%), and opacity.
  2. **Blinding HDR Sun**: Procedural multi-stage solar corona with an over-bright white core (> 3.5x - 5.0x SDR), fiery solar flares, and radiant corona rays.
  3. **Luminous HDR Moon**: Radiant lunar disc with soft ambient atmospheric glow and interactive crescent phase adjustment.
  4. **Eraser**: Smoothly carves away paint back to the deep canvas background.

- **Color Palette & Free-form Selector**:
  - **Curated HDR & P3 Palette**: Includes super-luminous colors like *Solar Blast (600 nits)*, *Plasma Sun Gold*, *Cyber Neon Cyan*, *Supernova Magenta*, and *Bioluminescent Lime*.
  - **Free-Form P3 Color Picker**: Interactive 2D Saturation/Value gradient with full 360° Hue slider.
  - **HDR Luminance Boost Slider**: Seamlessly scale luminance multiplier from `1.0x` (SDR ~100-120 nits) up to `5.0x` (Peak HDR ~600+ nits) with real-time estimated nits readouts.
  - **Quick Tier Chips**: Jump instantly between `1.0x SDR`, `2.2x Glow`, `3.5x Solar`, and `5.0x Peak`.

- **Responsive Viewport Design**:
  - **Desktop View**: Sleek floating glassmorphism HUD panel dock with real-time brush cursor rings.
  - **Mobile Portrait View**: Full-bleed drawing canvas with a bottom-sheet control drawer optimized for thumb reach, pointer event touch tracking, and accidental scroll prevention (`touch-action: none`).

- **Canvas Spaces & Utilities**:
  - Deep Space Canvas Backgrounds (OLED Black, Charcoal Grey, Deep Navy, Dark Nebula) crafted to maximize contrast on IPS Black and OLED panels.
  - Full Undo / Redo history stack.
  - One-click high-resolution PNG artwork export.
  - Live HDR display diagnostics badge and monitor status modal.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `B` | Select Circular Brush |
| `S` | Select HDR Sun Tool |
| `M` | Select HDR Moon Tool |
| `E` | Select Eraser |
| `[` / `]` | Decrease / Increase Brush Size |
| `Ctrl + Z` / `Cmd + Z` | Undo |
| `Ctrl + Y` / `Ctrl + Shift + Z` | Redo |

---

## 🚀 Getting Started

Because **HDR Web Paint** is built with modern ES modules and zero build dependencies, you can run it with any static web server:

### Option 1: Python HTTP Server (Built-in)
```bash
# In the project directory:
python -m http.server 8080
```
Then navigate to: `http://localhost:8080`

### Option 2: Node.js `npx serve`
```bash
npx serve .
```

### Option 3: GitHub Pages
1. Push this repository to GitHub.
2. In GitHub, go to **Settings** > **Pages**.
3. Under **Build and deployment**, select **Source: Deploy from a branch** and pick `main` / `/ (root)`.
4. Your HDR painting app is instantly live on the web!

---

## 🖥️ Recommended HDR Setup (Windows & Mobile)

To get the most dazzling HDR experience:

1. **Windows 11 Setup**:
   - Press <kbd>Win</kbd> + <kbd>Alt</kbd> + <kbd>B</kbd> or go to **Windows Settings > System > Display > HDR** and turn **Use HDR** ON.
2. **HDR Monitors / TVs**:
   - On your monitor OSD menu, ensure **HDR** (DisplayHDR, HDR10, or Smart HDR) is enabled.
3. **Mobile Devices (iPhones, iPads, Android)**:
   - Modern OLED iPhones (iPhone X and later) and modern Android flagship phones (Samsung Galaxy, Google Pixel) support HDR and Display-P3 wide gamut natively in Safari, Chrome, and Edge.
4. **Browser Compatibility**:
   - Google Chrome, Microsoft Edge, or Safari.
   - Ensure hardware graphics acceleration is enabled under browser settings.
   - Click the green **HDR Active** badge in the top bar to verify the canvas backing format is set to `RGBA16F (Half-Float)` in `display-p3`.

---

## 📁 Repository Structure

```text
HDR-Web-Paint/
├── index.html            # Main HTML document & responsive layout
├── css/
│   └── style.css         # Dark theme, responsive rules & HDR styles
├── js/
│   ├── app.js            # App lifecycle, pointer events & UI controls
│   ├── hdr-engine.js     # WebGL 2 Float16 HDR pipeline & procedural shaders
│   └── color-palette.js  # Display-P3 palettes, HSV math & nits estimations
├── .gitignore            # Git ignore file
├── LICENSE               # MIT License
└── README.md             # Project documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
