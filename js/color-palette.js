/**
 * Color Palette & Free-form HDR Color Selector
 * Supports Display P3 Color Gamut and Extended Dynamic Range Multipliers.
 */

export const PRESET_PALETTES = [
  // Tier 1: Blinding Supercharged HDR (Peak Highlights: 2.5x - 5.0x)
  {
    name: 'Solar Blast (600 nits)',
    p3: [1.0, 0.95, 0.85],
    intensity: 4.5,
    tag: 'HDR Peak',
    css: 'color(display-p3 1.0 0.95 0.85)'
  },
  {
    name: 'Plasma Sun Gold',
    p3: [1.0, 0.72, 0.1],
    intensity: 3.8,
    tag: 'HDR High',
    css: 'color(display-p3 1.0 0.72 0.1)'
  },
  {
    name: 'Cyber Neon Cyan',
    p3: [0.0, 0.95, 1.0],
    intensity: 3.5,
    tag: 'HDR High',
    css: 'color(display-p3 0.0 0.95 1.0)'
  },
  {
    name: 'Supernova Magenta',
    p3: [1.0, 0.1, 0.85],
    intensity: 3.2,
    tag: 'HDR High',
    css: 'color(display-p3 1.0 0.1 0.85)'
  },
  {
    name: 'Bioluminescent Lime',
    p3: [0.35, 1.0, 0.15],
    intensity: 3.5,
    tag: 'HDR High',
    css: 'color(display-p3 0.35 1.0 0.15)'
  },
  {
    name: 'Ultra Electric Blue',
    p3: [0.15, 0.45, 1.0],
    intensity: 3.2,
    tag: 'HDR High',
    css: 'color(display-p3 0.15 0.45 1.0)'
  },

  // Tier 2: Glowing HDR (1.8x - 2.5x)
  {
    name: 'Molten Core Orange',
    p3: [1.0, 0.4, 0.0],
    intensity: 2.4,
    tag: 'HDR Glow',
    css: 'color(display-p3 1.0 0.4 0.0)'
  },
  {
    name: 'Lunar Silver Cyan',
    p3: [0.85, 0.95, 1.0],
    intensity: 2.2,
    tag: 'HDR Glow',
    css: 'color(display-p3 0.85 0.95 1.0)'
  },
  {
    name: 'Aurora Emerald',
    p3: [0.0, 0.98, 0.45],
    intensity: 2.0,
    tag: 'HDR Glow',
    css: 'color(display-p3 0.0 0.98 0.45)'
  },
  {
    name: 'Radiant Amethyst',
    p3: [0.75, 0.25, 1.0],
    intensity: 2.2,
    tag: 'HDR Glow',
    css: 'color(display-p3 0.75 0.25 1.0)'
  },

  // Tier 3: Display P3 Wide Gamut Standard (1.0x - 1.4x)
  {
    name: 'Deep P3 Crimson',
    p3: [0.95, 0.05, 0.15],
    intensity: 1.2,
    tag: 'P3 Gamut',
    css: 'color(display-p3 0.95 0.05 0.15)'
  },
  {
    name: 'Deep Space Navy',
    p3: [0.02, 0.08, 0.25],
    intensity: 1.0,
    tag: 'Deep Tone',
    css: 'color(display-p3 0.02 0.08 0.25)'
  },
  {
    name: 'Pure Midnight Black',
    p3: [0.0, 0.0, 0.0],
    intensity: 1.0,
    tag: 'Deep Tone',
    css: 'color(display-p3 0.0 0.0 0.0)'
  },
  {
    name: 'Pure White (100 nits SDR)',
    p3: [1.0, 1.0, 1.0],
    intensity: 1.0,
    tag: 'SDR 1x',
    css: 'color(display-p3 1.0 1.0 1.0)'
  }
];

/**
 * HSV to RGB converter for wide-gamut calculations
 */
export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;

  if (h < 60) {
    r = c; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = c; b = 0;
  } else if (h < 180) {
    r = 0; g = c; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = c;
  } else if (h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }

  return [r + m, g + m, b + m];
}

/**
 * RGB to HSV helper
 */
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }

  return { h, s, v };
}

/**
 * Estimate approximate peak nits based on 100 nits reference SDR white
 */
export function getEstimatedNits(intensity) {
  // 1.0x SDR is calibrated around ~100-120 nits in Windows HDR SDR slider.
  // 5.0x multiplier reaches HDR display peak highlight headroom (~600+ nits).
  return Math.round(intensity * 120);
}
