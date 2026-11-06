/**
 * Main Application Controller for HDR Web Paint
 */

import { HDREngine } from './hdr-engine.js';
import { PRESET_PALETTES, hsvToRgb, rgbToHsv, getEstimatedNits } from './color-palette.js';

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('paintCanvas');
  const brushCursor = document.getElementById('brushCursor');
  const hdrEngine = new HDREngine(canvas);

  // App UI State
  const state = {
    currentHue: 38,
    currentSat: 0.9,
    currentVal: 1.0,
    currentColorName: 'Plasma Sun Gold',
    isPickingSV: false
  };

  // DOM Elements
  const toolButtons = document.querySelectorAll('.tool-btn');
  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValText = document.getElementById('sizeValText');
  const softnessSlider = document.getElementById('softnessSlider');
  const softnessValText = document.getElementById('softnessValText');
  const softnessRow = document.getElementById('softnessRow');
  const moonPhaseSlider = document.getElementById('moonPhaseSlider');
  const moonPhaseValText = document.getElementById('moonPhaseValText');
  const moonPhaseRow = document.getElementById('moonPhaseRow');

  const hdrBoostSlider = document.getElementById('hdrBoostSlider');
  const hdrBoostValText = document.getElementById('hdrBoostValText');
  const tierChips = document.querySelectorAll('.tier-chip');

  const swatchesGrid = document.getElementById('swatchesGrid');
  const activeColorSwatch = document.getElementById('activeColorSwatch');
  const activeColorLabel = document.getElementById('activeColorLabel');

  const toggleCustomColorBtn = document.getElementById('toggleCustomColorBtn');
  const customPickerBox = document.getElementById('customPickerBox');
  const svPickerArea = document.getElementById('svPickerArea');
  const svHandle = document.getElementById('svHandle');
  const hueSlider = document.getElementById('hueSlider');
  const cssColorCode = document.getElementById('cssColorCode');

  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  const btnClear = document.getElementById('btnClear');
  const btnExport = document.getElementById('btnExport');

  const hdrBadgeBtn = document.getElementById('hdrBadgeBtn');
  const hdrStatusText = document.getElementById('hdrStatusText');
  const hdrModal = document.getElementById('hdrModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const diagHdrStatus = document.getElementById('diagHdrStatus');
  const diagP3Status = document.getElementById('diagP3Status');
  const diagFormatStatus = document.getElementById('diagFormatStatus');
  const diagPeakStatus = document.getElementById('diagPeakStatus');

  const bgButtons = document.querySelectorAll('.bg-opt-btn');

  // =========================================================================
  // 1. Initialize UI with HDR Engine
  // =========================================================================
  function initApp() {
    updateHDRStatusBadge();
    buildPresetSwatches();
    bindToolEvents();
    bindSliderEvents();
    bindColorPickerEvents();
    bindCanvasEvents();
    bindActions();
    bindModal();
    selectPresetColor(PRESET_PALETTES[1]); // Default to Plasma Sun Gold
    updateBrushCursorSize();

    // Responsive Canvas Resize via ResizeObserver and window events
    const canvasViewport = document.getElementById('canvasViewport');
    if (window.ResizeObserver && canvasViewport) {
      const resizeObserver = new ResizeObserver(() => {
        hdrEngine.resizeCanvas();
      });
      resizeObserver.observe(canvasViewport);
    } else {
      window.addEventListener('resize', () => hdrEngine.resizeCanvas());
    }
    window.addEventListener('orientationchange', () => {
      setTimeout(() => hdrEngine.resizeCanvas(), 100);
    });
  }

  // =========================================================================
  // 2. HDR Detection Badge & Diagnostics
  // =========================================================================
  function updateHDRStatusBadge() {
    const info = hdrEngine.hdrInfo;
    if (info.highDynamicRange) {
      hdrBadgeBtn.classList.remove('sdr-mode');
      hdrStatusText.textContent = 'HDR Active (Display-P3)';
      diagHdrStatus.textContent = 'Detected & Active (Windows 11 HDR ON)';
      diagHdrStatus.className = 'diag-val highlight';
    } else {
      hdrBadgeBtn.classList.add('sdr-mode');
      hdrStatusText.textContent = info.displayP3 ? 'P3 Gamut Active' : 'SDR Mode';
      diagHdrStatus.textContent = 'Standard Dynamic Range';
      diagHdrStatus.className = 'diag-val';
    }

    diagP3Status.textContent = info.displayP3 ? 'Supported (Wide Gamut P3)' : 'sRGB Standard Fallback';
    diagFormatStatus.textContent = info.float16Buffer ? 'RGBA16F Half-Float (Extended Range)' : 'Standard 8-bit Clamped';
    diagPeakStatus.textContent = info.highDynamicRange ? '~600+ nits (HDR Display Peak)' : '~120-150 nits (SDR Target)';
  }

  // =========================================================================
  // 3. Preset Swatches
  // =========================================================================
  function buildPresetSwatches() {
    swatchesGrid.innerHTML = '';
    PRESET_PALETTES.forEach((preset, index) => {
      const btn = document.createElement('button');
      btn.className = `swatch-btn ${preset.intensity > 2.0 ? 'is-hdr' : ''}`;
      btn.title = `${preset.name} - ${preset.intensity}x Boost (${preset.tag})`;

      // Use CSS Display-P3 color function
      const [r, g, b] = preset.p3;
      btn.style.backgroundColor = `color(display-p3 ${r} ${g} ${b})`;
      btn.style.color = `color(display-p3 ${r} ${g} ${b})`;

      btn.addEventListener('click', () => {
        selectPresetColor(preset);
        document.querySelectorAll('.swatch-btn').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
      });

      swatchesGrid.appendChild(btn);
    });
  }

  function selectPresetColor(preset) {
    state.currentColorName = preset.name;
    hdrEngine.brushColor = [...preset.p3];
    hdrEngine.hdrIntensity = preset.intensity;

    // Update boost slider
    hdrBoostSlider.value = Math.round(preset.intensity * 10);
    updateHdrBoostUI(preset.intensity);

    // Update custom picker SV/Hue state
    const hsv = rgbToHsv(preset.p3[0], preset.p3[1], preset.p3[2]);
    state.currentHue = hsv.h;
    state.currentSat = hsv.s;
    state.currentVal = hsv.v;
    hueSlider.value = Math.round(hsv.h);
    updateSVHandle();

    // Update active swatch
    updateActiveSwatchUI();
  }

  function updateActiveSwatchUI() {
    const [r, g, b] = hdrEngine.brushColor;
    const intensity = hdrEngine.hdrIntensity;
    const p3Color = `color(display-p3 ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)})`;

    activeColorSwatch.style.backgroundColor = p3Color;
    activeColorSwatch.style.color = p3Color;
    activeColorSwatch.style.boxShadow = `0 0 ${Math.min(24, intensity * 5)}px currentColor`;

    activeColorLabel.textContent = `${state.currentColorName} (${intensity.toFixed(1)}x)`;
    cssColorCode.textContent = `color(display-p3 ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)}) × ${intensity.toFixed(1)}x`;

    // Also update cursor ring color
    brushCursor.style.borderColor = p3Color;
    brushCursor.style.boxShadow = `0 0 ${Math.min(18, intensity * 4)}px ${p3Color}, inset 0 0 6px ${p3Color}`;
  }

  // =========================================================================
  // 4. Tools Binding
  // =========================================================================
  function bindToolEvents() {
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        toolButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tool = btn.dataset.tool;
        hdrEngine.activeTool = tool;

        // Dynamic visibility of tool parameters
        if (tool === 'brush') {
          softnessRow.classList.remove('hidden');
          moonPhaseRow.classList.add('hidden');
        } else if (tool === 'moon') {
          softnessRow.classList.add('hidden');
          moonPhaseRow.classList.remove('hidden');
        } else {
          softnessRow.classList.add('hidden');
          moonPhaseRow.classList.add('hidden');
        }

        updateBrushCursorSize();
      });
    });
  }

  // =========================================================================
  // 5. Sliders Binding
  // =========================================================================
  function bindSliderEvents() {
    // Size Slider
    sizeSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      hdrEngine.brushSize = val;
      sizeValText.textContent = `${val} px`;
      updateBrushCursorSize();
    });

    // Softness Slider
    softnessSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      hdrEngine.brushSoftness = val / 100;
      softnessValText.textContent = `${val}%`;
    });

    // Moon Phase Slider
    moonPhaseSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      hdrEngine.moonPhase = val / 100;
      let label = 'Half Moon';
      if (val <= 12) label = 'Razor Crescent';
      else if (val <= 32) label = 'Crescent';
      else if (val <= 68) label = 'Half Moon';
      else if (val <= 88) label = 'Gibbous';
      else label = 'Full Moon';
      moonPhaseValText.textContent = `${label} (${val}%)`;
    });

    // HDR Boost Slider
    hdrBoostSlider.addEventListener('input', (e) => {
      const intensity = parseInt(e.target.value, 10) / 10;
      hdrEngine.hdrIntensity = intensity;
      updateHdrBoostUI(intensity);
      updateActiveSwatchUI();
    });

    // HDR Quick Tier Chips
    tierChips.forEach(chip => {
      chip.addEventListener('click', () => {
        tierChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        const boost = parseFloat(chip.dataset.boost);
        hdrEngine.hdrIntensity = boost;
        hdrBoostSlider.value = Math.round(boost * 10);
        updateHdrBoostUI(boost);
        updateActiveSwatchUI();
      });
    });
  }

  function updateHdrBoostUI(intensity) {
    const nits = getEstimatedNits(intensity);
    hdrBoostValText.textContent = `${intensity.toFixed(1)}x (~${nits} nits)`;

    // Update active state on tier chips if matches
    tierChips.forEach(c => {
      const b = parseFloat(c.dataset.boost);
      if (Math.abs(b - intensity) < 0.2) {
        c.classList.add('active');
      } else {
        c.classList.remove('active');
      }
    });
  }

  function updateBrushCursorSize() {
    let size = hdrEngine.brushSize * 2;
    if (hdrEngine.activeTool === 'sun') {
      size = hdrEngine.brushSize * 4.4;
    } else if (hdrEngine.activeTool === 'moon') {
      size = hdrEngine.brushSize * 3.6;
    }
    brushCursor.style.width = `${size}px`;
    brushCursor.style.height = `${size}px`;
  }

  // =========================================================================
  // 6. Free-form Color Picker
  // =========================================================================
  function bindColorPickerEvents() {
    toggleCustomColorBtn.addEventListener('click', () => {
      const isHidden = customPickerBox.classList.toggle('hidden');
      toggleCustomColorBtn.classList.toggle('expanded', !isHidden);
      if (!isHidden) {
        updateSVBackground();
        updateSVHandle();
      }
    });

    // Hue Slider
    hueSlider.addEventListener('input', (e) => {
      state.currentHue = parseInt(e.target.value, 10);
      updateSVBackground();
      applyFreeformColor();
    });

    // Saturation / Value 2D Box
    const updateSVFromPointer = (e) => {
      const rect = svPickerArea.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

      state.currentSat = x / rect.width;
      state.currentVal = 1.0 - (y / rect.height);

      updateSVHandle();
      applyFreeformColor();
    };

    svPickerArea.addEventListener('pointerdown', (e) => {
      state.isPickingSV = true;
      svPickerArea.setPointerCapture(e.pointerId);
      updateSVFromPointer(e);
    });

    svPickerArea.addEventListener('pointermove', (e) => {
      if (state.isPickingSV) {
        updateSVFromPointer(e);
      }
    });

    svPickerArea.addEventListener('pointerup', (e) => {
      state.isPickingSV = false;
    });
    svPickerArea.addEventListener('pointercancel', (e) => {
      state.isPickingSV = false;
    });
  }

  function updateSVBackground() {
    const pureRGB = hsvToRgb(state.currentHue, 1.0, 1.0);
    const cssHue = `color(display-p3 ${pureRGB[0]} ${pureRGB[1]} ${pureRGB[2]})`;
    svPickerArea.style.backgroundColor = cssHue;
  }

  function updateSVHandle() {
    const leftPercent = state.currentSat * 100;
    const topPercent = (1.0 - state.currentVal) * 100;
    svHandle.style.left = `${leftPercent}%`;
    svHandle.style.top = `${topPercent}%`;
  }

  function applyFreeformColor() {
    const rgb = hsvToRgb(state.currentHue, state.currentSat, state.currentVal);
    hdrEngine.brushColor = [rgb[0], rgb[1], rgb[2]];
    state.currentColorName = 'Custom P3 HDR';
    updateActiveSwatchUI();

    // Deselect preset swatches
    document.querySelectorAll('.swatch-btn').forEach(s => s.classList.remove('active'));
  }

  // =========================================================================
  // 7. Canvas Painting & Pointer Events
  // =========================================================================
  function bindCanvasEvents() {
    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    };

    // Pointer events for desktop mouse, tablet pen, and mobile touch
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const pos = getPos(e);
      canvas.setPointerCapture(e.pointerId);
      hdrEngine.beginStroke(pos.x, pos.y);
    });

    canvas.addEventListener('pointermove', (e) => {
      const pos = getPos(e);

      // Move visual cursor ring relative to canvas viewport container
      const viewportRect = canvas.parentElement.getBoundingClientRect();
      brushCursor.style.left = `${e.clientX - viewportRect.left}px`;
      brushCursor.style.top = `${e.clientY - viewportRect.top}px`;
      brushCursor.style.display = 'block';

      if (hdrEngine.isDrawing) {
        hdrEngine.continueStroke(pos.x, pos.y);
      }
    });

    const stopDrawing = (e) => {
      if (hdrEngine.isDrawing) {
        hdrEngine.endStroke();
      }
    };

    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
    canvas.addEventListener('pointerleave', () => {
      brushCursor.style.display = 'none';
      stopDrawing();
    });
  }

  // =========================================================================
  // 8. Canvas Background & Actions
  // =========================================================================
  function bindActions() {
    btnUndo.addEventListener('click', () => hdrEngine.undo());
    btnRedo.addEventListener('click', () => hdrEngine.redo());
    btnClear.addEventListener('click', () => {
      if (confirm('Clear the entire canvas?')) {
        hdrEngine.clearCanvas();
      }
    });
    btnExport.addEventListener('click', () => {
      hdrEngine.exportImage(`HDR-Paint-${Date.now()}.png`);
    });

    // Canvas Background Color Options
    bgButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        bgButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const mode = btn.dataset.bg;
        if (mode === 'space') {
          hdrEngine.setBackgroundColor(0.03, 0.03, 0.04);
        } else if (mode === 'charcoal') {
          hdrEngine.setBackgroundColor(0.10, 0.11, 0.14);
        } else if (mode === 'navy') {
          hdrEngine.setBackgroundColor(0.03, 0.07, 0.15);
        } else if (mode === 'nebula') {
          hdrEngine.setBackgroundColor(0.09, 0.04, 0.14);
        } else if (mode === 'white') {
          hdrEngine.setBackgroundColor(1.0, 1.0, 1.0);
        }
      });
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Avoid firing when user is typing in any potential inputs
      if (e.target.tagName === 'INPUT') return;

      if (e.key === 'b' || e.key === 'B') {
        document.getElementById('toolBrush').click();
      } else if (e.key === 's' || e.key === 'S') {
        document.getElementById('toolSun').click();
      } else if (e.key === 'm' || e.key === 'M') {
        document.getElementById('toolMoon').click();
      } else if (e.key === 'e' || e.key === 'E') {
        document.getElementById('toolEraser').click();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          hdrEngine.redo();
        } else {
          hdrEngine.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        hdrEngine.redo();
      } else if (e.key === '[') {
        sizeSlider.value = Math.max(4, parseInt(sizeSlider.value, 10) - 6);
        sizeSlider.dispatchEvent(new Event('input'));
      } else if (e.key === ']') {
        sizeSlider.value = Math.min(220, parseInt(sizeSlider.value, 10) + 6);
        sizeSlider.dispatchEvent(new Event('input'));
      }
    });
  }

  // =========================================================================
  // 9. Diagnostics Modal
  // =========================================================================
  function bindModal() {
    hdrBadgeBtn.addEventListener('click', () => {
      updateHDRStatusBadge();
      hdrModal.classList.remove('hidden');
    });

    closeModalBtn.addEventListener('click', () => {
      hdrModal.classList.add('hidden');
    });

    hdrModal.addEventListener('click', (e) => {
      if (e.target === hdrModal) {
        hdrModal.classList.add('hidden');
      }
    });
  }

  // Start the application
  initApp();
});
