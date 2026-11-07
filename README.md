# UltraBright Painter 🎨✨
### High Dynamic Range (HDR) & Ultra HDR Web Painting Application

A responsive, high-dynamic-range web painting application built to explore **High Dynamic Range (HDR)**, wide color gamut (Display-P3), and **Ultra HDR Gain Map image export** directly in the browser.

Designed specifically for HDR-capable displays and modern high-brightness mobile OLED/HDR screens (Samsung Galaxy AMOLED, iPhone Super Retina XDR, Google Pixel, and HDR monitors / TVs).

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
  - **Curated HDR Palette**: Includes super-luminous colors like *Solar Blast (600 nits)*, *Plasma Sun Gold*, *Cyber Neon Cyan*, *Supernova Magenta*, and *Bioluminescent Lime*.
  - **Free-Form Color Picker**: Interactive 2D Saturation/Value gradient with full 360° Hue slider.
  - **HDR Luminance Boost Slider**: Seamlessly scale luminance multiplier from `1.0x` (SDR ~100-120 nits) up to `5.0x` (Peak HDR ~600+ nits) with real-time estimated nits readouts.
  - **Chromaticity-Preserved Saturation**: Built-in maximum chroma retention prevents colors from bleaching out to white at high luminance. As you raise brightness into peak HDR, pure reds, cyans, and golds remain vivid, saturated, and laser-pure.
  - **Quick Tier Chips**: Jump instantly between `1.0x SDR`, `2.2x Glow`, `3.5x Solar`, and `5.0x Peak`.

- **Responsive Viewport Design**:
  - **Desktop View**: Sleek floating glassmorphism HUD panel dock with real-time brush cursor rings.
  - **Mobile Portrait View**: Full-bleed drawing canvas with a bottom-sheet control drawer optimized for thumb reach, pointer event touch tracking, and accidental scroll prevention (`touch-action: none`).

- **Canvas Spaces & Utilities**:
  - Deep Space Canvas Backgrounds (OLED Black, Charcoal Grey, Deep Navy, Dark Nebula) crafted to maximize contrast on IPS Black and OLED panels.
  - Full Undo / Redo history stack.
  - One-click **Ultra HDR JPEG (`.jpg`) artwork export**: embeds ISO 21496-1 / Adobe gain map metadata and Google GContainer directory so artwork renders in true high dynamic range on Android (Google Photos) and Windows 11 (Chrome/Edge/Photos), while remaining fully backwards compatible with standard SDR viewers.
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

Because **HDR Web Paint** is built with zero build dependencies and standard static scripts, you can run it in whichever way you prefer:

### Option 1: Direct File Launch (No server needed)
- Simply double-click **`index.html`** in Windows Explorer. It opens directly via `file:///` in your browser with zero CORS restrictions!

### Option 2: Windows Launcher (`start.bat` for local Wi-Fi & phone testing)
- Double-click **`start.bat`**. It starts a lightweight local server and displays the local Wi-Fi URL (e.g. `http://192.168.1.X:8080`) so other phones and devices on your Wi-Fi can test it.

### Option 3: GitHub Pages (Host for the world)
1. Push this repository to GitHub: `https://github.com/jpcturbo/UltraBright-Painter.git`.
2. In GitHub, go to **Settings** > **Pages**.
3. Under **Build and deployment**, select **Source: Deploy from a branch** and choose `main` / `/ (root)`.
4. Your HDR painting app is instantly live on the web at:
   👉 **https://jpcturbo.github.io/UltraBright-Painter/**

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
UltraBright-Painter/
├── index.html            # Main HTML document & responsive layout
├── .nojekyll             # Bypasses Jekyll processing on GitHub Pages
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
