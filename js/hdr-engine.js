/**
 * HDR Paint Engine
 * Primary backend: WebGPU with rgba16float + display-p3 + toneMapping: { mode: 'extended' }
 *   (unlocks true live hardware HDR > 1.0 on Chrome Android 129+, iOS Safari 26+, and Desktop).
 * Fallback backend: WebGL 2 with RGBA16F + EXT_color_buffer_float/half_float + extended range.
 * Export / Preview: Dual-standard Ultra HDR JPEG with both ISO/TS 21496-1 binary APP2 metadata
 *   (iOS 18+ / Safari / Android 15+) and Adobe hdrgm XMP + MPF (Android 14+ / Chrome / Windows 11).
 * Compatible with both classic script loading (file:///) and static web hosting.
 */

(function(global) {
// Extended sRGB / Display-P3 EOTF (display-encoded -> linear light, supports values > 1.0)
function extendedSrgbToLinear(v) {
  if (v <= 0) return 0;
  if (v <= 0.04045) return v / 12.92;
  return Math.pow((v + 0.055) / 1.055, 2.4);
}

// IEEE 754 binary16 (half-float) -> float32 decoder for WebGPU rgba16float readback
function float16ToFloat32(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7C00) >> 10;
  const f = h & 0x03FF;
  if (e === 0) {
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  } else if (e === 0x1F) {
    return f ? NaN : (s ? -Infinity : Infinity);
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

class HDREngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.backend = 'initializing'; // 'webgpu' | 'webgl2' | '2d'
    this.ready = false;

    // WebGL2 state
    this.gl = null;

    // WebGPU state
    this.gpuDevice = null;
    this.gpuContext = null;
    this.gpuFormat = 'rgba16float';
    this.gpuSampler = null;
    this.gpuFboTexture = null;
    this.gpuFboView = null;
    this.gpuUniformBuf = null;

    this.hdrInfo = {
      displayP3: false,
      highDynamicRange: false,
      osHdrDetected: false,
      float16Buffer: false,
      extendedToneMapping: false,
      backend: 'Initializing...',
      mode: 'sdr'
    };

    // Painting state
    this.brushSize = 25;
    this.brushSoftness = 0.5; // 0 = hard, 1 = super soft
    this.brushOpacity = 1.0;
    this.brushColor = [1.0, 0.4, 0.1]; // Display P3 RGB
    this.hdrIntensity = 2.5; // 1.0 = SDR 100 nits, up to 5.0x = Peak HDR highlights
    this.chromaRetention = 1.0; // Maximum vivid chromaticity preservation (always active)
    this.displayHeadroom = 3.0; // Extended display-encoded peak (3.0 encoded ≈ ~10x linear luminance)
    this.activeTool = 'brush'; // 'brush', 'sun', 'moon', 'eraser'
    this.moonPhase = 0.5; // 0.0 = razor crescent, 0.5 = half moon, 1.0 = full moon
    this.backgroundColor = [0.03, 0.03, 0.04, 1.0]; // Deep OLED/IPS Black

    // Internal textures & framebuffers
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.fboTexture = null;
    this.fbo = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndo = 15;

    // Stroke interpolation state
    this.isDrawing = false;
    this.lastPoint = null;

    this.detectHDRCapabilities();
    this.initPromise = this.initAsync();
  }

  detectHDRCapabilities() {
    const urlParams = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;
    const forceHdrParam = urlParams ? (urlParams.get('hdr') === '1' || urlParams.get('hdr') === 'true' || urlParams.get('forcehdr') === '1') : false;
    let savedHdrPref = null;
    try {
      const stored = localStorage.getItem('force_hdr_mode');
      if (stored !== null) savedHdrPref = (stored === 'true');
    } catch (e) {}

    const hdrQuery = window.matchMedia('(dynamic-range: high)');
    const p3Query = window.matchMedia('(color-gamut: p3)');
    const isMobileP3 = p3Query.matches && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');

    this.hdrInfo.osHdrDetected = hdrQuery.matches;
    const isHDR = forceHdrParam || (savedHdrPref !== null ? savedHdrPref : (hdrQuery.matches || isMobileP3));

    this.hdrInfo.highDynamicRange = isHDR;
    this.hdrInfo.displayP3 = p3Query.matches || isHDR;
    this.displayHeadroom = isHDR ? 3.0 : 1.0;

    const onDisplayChange = () => {
      if (!this.manualHdrOverride && !forceHdrParam && savedHdrPref === null) {
        this.hdrInfo.osHdrDetected = hdrQuery.matches;
        this.hdrInfo.highDynamicRange = hdrQuery.matches || isMobileP3;
        this.hdrInfo.displayP3 = p3Query.matches;
        this.displayHeadroom = this.hdrInfo.highDynamicRange ? 3.0 : 1.0;
        if (this.backend === 'webgpu') {
          this.configureWebGPUContext();
        } else if (this.backend === 'webgl2') {
          this.setupDrawingBufferStorage();
        }
        this.updateHdrModeLabel();
        this.renderToScreen();
        if (typeof window.onHDRCapabilityChange === 'function') {
          window.onHDRCapabilityChange(this.hdrInfo);
        }
      }
    };
    if (typeof hdrQuery.addEventListener === 'function') {
      hdrQuery.addEventListener('change', onDisplayChange);
      p3Query.addEventListener('change', onDisplayChange);
    }
  }

  updateHdrModeLabel() {
    if (this.backend === 'webgpu') {
      this.hdrInfo.backend = this.hdrInfo.extendedToneMapping
        ? 'WebGPU (Extended HDR)'
        : 'WebGPU (Standard)';
    } else if (this.backend === 'webgl2') {
      this.hdrInfo.backend = this.hdrInfo.extendedToneMapping
        ? 'WebGL2 (Extended HDR)'
        : (this.hdrInfo.float16Buffer ? 'WebGL2 (Float16 / SDR Compositor)' : 'WebGL2 (8-bit SDR)');
    } else {
      this.hdrInfo.backend = 'Canvas 2D Fallback';
    }

    if (this.hdrInfo.extendedToneMapping && this.hdrInfo.highDynamicRange) {
      this.hdrInfo.mode = 'Live Hardware HDR (Extended Display-P3)';
    } else if (this.hdrInfo.displayP3) {
      this.hdrInfo.mode = 'Display-P3 Wide Gamut (Use Preview for Ultra HDR)';
    } else {
      this.hdrInfo.mode = 'Standard Dynamic Range';
    }
  }

  async initAsync() {
    // 1. Prefer WebGPU for true native hardware HDR canvas on Chrome Android 129+, iOS Safari 26+, Desktop
    const webgpuOk = await this.tryInitWebGPU();
    if (webgpuOk) {
      this.backend = 'webgpu';
      this.ready = true;
      this.updateHdrModeLabel();
      this.resizeCanvas();
      if (typeof window.onHDRCapabilityChange === 'function') {
        window.onHDRCapabilityChange(this.hdrInfo);
      }
      return;
    }

    // 2. Fallback to WebGL 2
    this.initWebGL();
    if (this.gl) {
      this.backend = 'webgl2';
      this.ready = true;
      this.updateHdrModeLabel();
      if (typeof window.onHDRCapabilityChange === 'function') {
        window.onHDRCapabilityChange(this.hdrInfo);
      }
      return;
    }

    // 3. Fallback to 2D Canvas
    console.warn('WebGPU and WebGL2 not available. Falling back to 2D canvas.');
    this.init2DFallback();
    this.backend = '2d';
    this.ready = true;
    this.updateHdrModeLabel();
    if (typeof window.onHDRCapabilityChange === 'function') {
      window.onHDRCapabilityChange(this.hdrInfo);
    }
  }

  setManualHDR(enabled) {
    this.manualHdrOverride = true;
    try {
      localStorage.setItem('force_hdr_mode', enabled ? 'true' : 'false');
    } catch (e) {}
    this.hdrInfo.highDynamicRange = !!enabled;
    this.hdrInfo.displayP3 = !!enabled;
    this.displayHeadroom = enabled ? 3.0 : 1.0;

    if (this.backend === 'webgpu') {
      this.configureWebGPUContext();
    } else if (this.backend === 'webgl2') {
      this.setupDrawingBufferStorage();
    }
    this.updateHdrModeLabel();
    this.renderToScreen();
    if (typeof window.onHDRCapabilityChange === 'function') {
      window.onHDRCapabilityChange(this.hdrInfo);
    }
  }

  // ===========================================================================
  // WEBGPU HDR BACKEND
  // ===========================================================================
  async tryInitWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return false;

      const device = await adapter.requestDevice();
      if (!device) return false;

      // Probe rgba16float + extended tone mapping on a throwaway canvas first so we
      // never lock the main <canvas> to WebGPU if it can't support Float16 HDR output.
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 1;
      probeCanvas.height = 1;
      const probeCtx = probeCanvas.getContext('webgpu');
      if (!probeCtx) return false;

      let supportsFloat16 = false;
      try {
        probeCtx.configure({
          device,
          format: 'rgba16float',
          colorSpace: 'display-p3',
          toneMapping: { mode: 'extended' },
          alphaMode: 'premultiplied'
        });
        supportsFloat16 = true;
      } catch (e) {
        try {
          probeCtx.configure({
            device,
            format: 'rgba16float',
            colorSpace: 'srgb',
            toneMapping: { mode: 'extended' },
            alphaMode: 'premultiplied'
          });
          supportsFloat16 = true;
        } catch (e2) {
          supportsFloat16 = false;
        }
      }
      if (!supportsFloat16) return false;

      const context = this.canvas.getContext('webgpu');
      if (!context) return false;

      this.gpuDevice = device;
      this.gpuContext = context;
      this.gpuFormat = 'rgba16float';

      if (!this.configureWebGPUContext()) {
        this.gpuDevice = null;
        this.gpuContext = null;
        return false;
      }

      this.initWebGPUPipelines();
      return true;
    } catch (err) {
      console.warn('WebGPU HDR init failed, falling back to WebGL2:', err);
      this.gpuDevice = null;
      this.gpuContext = null;
      return false;
    }
  }

  configureWebGPUContext() {
    if (!this.gpuContext || !this.gpuDevice) return false;

    const toneMode = this.hdrInfo.highDynamicRange ? 'extended' : 'standard';
    const configs = [
      { device: this.gpuDevice, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: toneMode }, alphaMode: 'premultiplied' },
      { device: this.gpuDevice, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: toneMode }, alphaMode: 'premultiplied' },
      { device: this.gpuDevice, format: 'rgba16float', colorSpace: 'display-p3', alphaMode: 'premultiplied' }
    ];

    for (let i = 0; i < configs.length; i++) {
      try {
        this.gpuContext.configure(configs[i]);
        this.gpuFormat = 'rgba16float';
        this.hdrInfo.float16Buffer = true;
        this.hdrInfo.extendedToneMapping = (i < 2 && toneMode === 'extended');
        if (configs[i].colorSpace === 'display-p3') {
          this.hdrInfo.displayP3 = true;
        }
        return true;
      } catch (e) {
        // Try next configuration
      }
    }
    return false;
  }

  initWebGPUPipelines() {
    const device = this.gpuDevice;

    this.gpuSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    // Shared uniform buffer (128 bytes = 32 floats) for brush/sun/moon/display params
    this.gpuUniformBuf = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const commonVS = /* wgsl */`
      struct VSOut {
        @builtin(position) pos: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn vs_main(@builtin(vertex_index) idx: u32) -> VSOut {
        var positions = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 1.0, -1.0),
          vec2<f32>(-1.0,  1.0),
          vec2<f32>(-1.0,  1.0),
          vec2<f32>( 1.0, -1.0),
          vec2<f32>( 1.0,  1.0)
        );
        let p = positions[idx];
        var out: VSOut;
        out.pos = vec4<f32>(p, 0.0, 1.0);
        // Flip Y for texture sampling so uv=(0,0) is top-left in WebGPU
        out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
        return out;
      }
    `;

    // 1. Lossless 1:1 Blit Shader
    const blitModule = device.createShaderModule({
      code: commonVS + /* wgsl */`
        @group(0) @binding(0) var u_sampler: sampler;
        @group(0) @binding(1) var u_tex: texture_2d<f32>;

        @fragment
        fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
          return textureSample(u_tex, u_sampler, in.uv);
        }
      `
    });

    // 2. Display Presentation Shader (true extended HDR > 1.0 on both Desktop and Mobile!)
    const displayModule = device.createShaderModule({
      code: commonVS + /* wgsl */`
        struct DisplayParams {
          displayPeak: f32,
          isHDR: f32,
          hasExtended: f32,
          _pad: f32,
        };
        @group(0) @binding(0) var u_sampler: sampler;
        @group(0) @binding(1) var u_tex: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> params: DisplayParams;

        @fragment
        fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
          let texCol = textureSample(u_tex, u_sampler, in.uv);
          let c = max(vec3<f32>(0.0), texCol.rgb);
          let peak = max(c.r, max(c.g, c.b));

          if (params.isHDR > 0.5 && params.hasExtended > 0.5) {
            // True Extended Hardware HDR (Desktop & Mobile WebGPU rgba16float):
            // Values <= 1.0 pass through 1:1 as SDR. Values > 1.0 smoothly extend up to displayPeak (~3.0 encoded = ~10x linear nits).
            if (peak <= 1.0) {
              return vec4<f32>(c, 1.0);
            }
            let start = 1.0;
            let headroom = max(0.5, params.displayPeak - start);
            let D = 2.4;
            let s = start + headroom * (1.0 - exp(-(peak - start) / D));
            let k = s / peak;
            return vec4<f32>(c * k, 1.0);
          } else {
            // SDR Mode fallback roll-off
            if (peak <= 0.65) {
              return vec4<f32>(c, 1.0);
            }
            let start = 0.65;
            let headroom = 0.345;
            let D = 1.8;
            let s = start + headroom * (1.0 - exp(-(peak - start) / D));
            let k = s / peak;
            return vec4<f32>(c * k, 1.0);
          }
        }
      `
    });

    // 3. Brush Shader
    const brushModule = device.createShaderModule({
      code: commonVS + /* wgsl */`
        struct BrushParams {
          center: vec2<f32>,
          resolution: vec2<f32>,
          color: vec3<f32>,
          radius: f32,
          bgColor: vec3<f32>,
          softness: f32,
          intensity: f32,
          chromaRetention: f32,
          opacity: f32,
          isEraser: f32,
        };
        @group(0) @binding(0) var<uniform> u: BrushParams;

        @fragment
        fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
          let pixelCoord = in.uv * u.resolution;
          let dist = distance(pixelCoord, u.center);
          if (dist > u.radius) {
            discard;
          }

          let inner = u.radius * (1.0 - u.softness);
          let normSoft = select(clamp((dist - inner) / max(0.001, u.radius - inner), 0.0, 1.0), 0.0, dist <= inner);
          let edgeAlpha = select(1.0 - smoothstep(0.0, 1.0, normSoft), 1.0, dist <= inner);
          let alpha = edgeAlpha * u.opacity;

          if (u.isEraser > 0.5) {
            return vec4<f32>(u.bgColor, alpha);
          }

          let localIntensity = select(1.0 + (u.intensity - 1.0) * pow(edgeAlpha, 1.25), u.intensity, dist <= inner);
          let baseCol = u.color;
          let maxC = max(baseCol.r, max(baseCol.g, baseCol.b));
          let minC = min(baseCol.r, min(baseCol.g, baseCol.b));
          let chroma = maxC - minC;

          var hdrRGB: vec3<f32>;
          if (chroma > 0.001 && localIntensity > 1.0 && u.chromaRetention > 0.01) {
            let norm = (baseCol - vec3<f32>(minC)) / chroma;
            let p = 1.0 + u.chromaRetention * (localIntensity - 1.0) * 0.55;
            let boostedNorm = pow(max(vec3<f32>(0.0), norm), vec3<f32>(p));
            let floorScale = minC * pow(localIntensity, max(0.0, 1.0 - u.chromaRetention * 0.8));
            hdrRGB = boostedNorm * (chroma * localIntensity) + vec3<f32>(floorScale);
          } else {
            hdrRGB = baseCol * localIntensity;
          }

          return vec4<f32>(hdrRGB, alpha);
        }
      `
    });

    // 4. HDR Sunset Sun Shader (Panoramic fiery orange-yellow cloud haze above, crisp blazing disc, darker below)
    const sunModule = device.createShaderModule({
      code: commonVS + /* wgsl */`
        struct SunParams {
          center: vec2<f32>,
          resolution: vec2<f32>,
          color: vec3<f32>,
          radius: f32,
          intensity: f32,
          opacity: f32,
          _pad0: f32,
          _pad1: f32,
        };
        @group(0) @binding(0) var<uniform> u: SunParams;

        fn sunHash(p: vec2<f32>) -> f32 {
          let h = dot(p, vec2<f32>(127.1, 311.7));
          return fract(sin(h) * 43758.5453123);
        }

        fn sunNoise(p: vec2<f32>) -> f32 {
          let i = floor(p);
          let f = fract(p);
          let u2 = f * f * (3.0 - 2.0 * f);
          let a = sunHash(i);
          let b = sunHash(i + vec2<f32>(1.0, 0.0));
          let c = sunHash(i + vec2<f32>(0.0, 1.0));
          let d = sunHash(i + vec2<f32>(1.0, 1.0));
          return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
        }

        fn sunFbm(p_in: vec2<f32>) -> f32 {
          var p = p_in;
          var val = 0.0;
          var amp = 0.52;
          for (var i = 0; i < 4; i++) {
            val += amp * sunNoise(p);
            p = p * vec2<f32>(2.05, 1.95) + vec2<f32>(11.3, 5.7);
            amp *= 0.5;
          }
          return val;
        }

        @fragment
        fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
          let pixelCoord = in.uv * u.resolution;
          // WebGPU Y increases downward, so positive rel.y = ABOVE the sun, negative = BELOW
          let rel = vec2<f32>(
            (pixelCoord.x - u.center.x) / u.radius,
            (u.center.y - pixelCoord.y) / u.radius
          );

          // Wide panoramic sunset envelope: 8.5x wide, 5.8x tall above, 2.4x below
          let ellipX = rel.x / 8.5;
          let ellipY = select(rel.y / 2.4, rel.y / 5.8, rel.y >= 0.0);
          let envDist = length(vec2<f32>(ellipX, ellipY));
          if (envDist > 1.0) {
            discard;
          }

          let dist = length(rel);

          // 1. Crisp, searing white-hot solar disc + tight intense corona
          let sunDisc = 1.0 - smoothstep(0.54, 0.66, dist);
          let sunHalo = exp(-dist * 1.15);

          // 2. Vertical horizon split: expansive fiery sky above, darker grounded atmosphere below
          let aboveFactor = smoothstep(-0.55, 0.45, rel.y);

          // 3. Horizontally-stretched backlit sunset cloud streaks
          let cloudUV = vec2<f32>(rel.x * 0.28 + u.center.x * 0.003, rel.y * 1.35 + u.center.y * 0.002);
          let n1 = sunFbm(cloudUV);
          let n2 = sunFbm(cloudUV * vec2<f32>(2.1, 2.3) + vec2<f32>(3.7, -1.2));
          let cloudStreaks = clamp(n1 * 0.65 + n2 * 0.35, 0.0, 1.0);
          let skyBreak = smoothstep(0.32, 0.72, cloudStreaks);
          let darkCloudRibbon = smoothstep(0.56, 0.18, cloudStreaks);

          // 4. Panoramic atmospheric haze & horizon band
          let horizonBand = exp(-abs(rel.y - 0.55) * 0.50) * exp(-abs(rel.x) * 0.20);
          let upperSkyHaze = exp(-length(vec2<f32>(rel.x * 0.16, max(0.0, rel.y - 0.3) * 0.25)) * 1.4) * aboveFactor;
          let outerFade = pow(clamp(1.0 - envDist, 0.0, 1.0), 1.35);

          // 5. Darker below-horizon glare & shadow
          let belowGlare = exp(-length(vec2<f32>(rel.x * 0.72, min(0.0, rel.y) * 1.1)) * 1.3) * (1.0 - aboveFactor);

          // 6. HDR Sunset Color Palette
          let blazingWhite = vec3<f32>(1.00, 0.99, 0.93) * (u.intensity * 2.6);
          let moltenYellow = mix(vec3<f32>(1.00, 0.90, 0.16), u.color, 0.15) * (u.intensity * 1.45);
          let fireOrange   = mix(vec3<f32>(1.00, 0.40, 0.03), u.color, 0.20) * (u.intensity * 1.05);
          let deepCrimson  = vec3<f32>(0.82, 0.12, 0.02) * (u.intensity * 0.72);
          let darkCloudRed = vec3<f32>(0.26, 0.04, 0.01) * max(0.7, u.intensity * 0.32);
          let belowShadow  = vec3<f32>(0.12, 0.022, 0.008);

          let heat = clamp(sunHalo * 1.2 + horizonBand * 0.78 + upperSkyHaze * 0.68, 0.0, 1.0);
          let litHeat = clamp(heat * (0.58 + 0.72 * skyBreak) - darkCloudRibbon * 0.24 * smoothstep(0.6, 2.2, dist), 0.0, 1.0);

          var skyCol = mix(darkCloudRed, deepCrimson, smoothstep(0.05, 0.35, litHeat));
          skyCol = mix(skyCol, fireOrange, smoothstep(0.28, 0.62, litHeat));
          skyCol = mix(skyCol, moltenYellow, smoothstep(0.55, 0.88, litHeat));

          var lowerCol = mix(belowShadow, deepCrimson * 0.82, clamp(belowGlare * 1.1, 0.0, 1.0));
          lowerCol = mix(lowerCol, fireOrange * 0.72, clamp(sunHalo * 0.82, 0.0, 1.0));

          var col = mix(lowerCol, skyCol, aboveFactor);
          col = mix(col, moltenYellow * 1.35, clamp(sunHalo * 0.85, 0.0, 1.0));
          col = mix(col, blazingWhite, sunDisc);

          let skyAlpha = (upperSkyHaze * 0.95 + horizonBand * 0.82) * (0.72 + 0.28 * cloudStreaks);
          let lowerAlpha = (belowGlare * 0.72 + exp(-length(vec2<f32>(rel.x * 0.25, rel.y * 0.8)) * 1.45) * 0.55) * (1.0 - aboveFactor);
          let alpha = clamp((sunDisc + sunHalo * 0.72 + (skyAlpha + lowerAlpha) * outerFade) * u.opacity, 0.0, 1.0);
          return vec4<f32>(col, alpha);
        }
      `
    });

    // 5. HDR Moon Shader
    const moonModule = device.createShaderModule({
      code: commonVS + /* wgsl */`
        struct MoonParams {
          center: vec2<f32>,
          resolution: vec2<f32>,
          color: vec3<f32>,
          radius: f32,
          intensity: f32,
          opacity: f32,
          moonPhase: f32,
          _pad0: f32,
        };
        @group(0) @binding(0) var<uniform> u: MoonParams;

        @fragment
        fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
          let pixelCoord = in.uv * u.resolution;
          let dist = length(pixelCoord - u.center);
          if (dist > u.radius * 2.0) {
            discard;
          }

          let normDist = dist / u.radius;
          let disc = 1.0 - smoothstep(0.96, 1.0, normDist);

          let offsetDistance = u.radius * (0.35 + clamp(u.moonPhase, 0.0, 1.0) * 1.85);
          let shadowOffset = vec2<f32>(offsetDistance, -u.radius * 0.05);
          let shadowDist = length(pixelCoord - (u.center + shadowOffset)) / u.radius;
          let shadow = 1.0 - smoothstep(0.95, 1.02, shadowDist);
          let crescent = clamp(disc - shadow, 0.0, 1.0);

          let halo = 1.0 - smoothstep(0.9, 1.8, normDist);
          let moonCore = vec3<f32>(0.92, 0.97, 1.0) * (u.intensity * 1.5);
          let moonGlow = mix(u.color, vec3<f32>(0.6, 0.8, 1.0), 0.5) * u.intensity;

          let col = mix(moonGlow, moonCore, crescent);
          let alpha = clamp((crescent * 0.95 + halo * 0.35) * u.opacity, 0.0, 1.0);
          return vec4<f32>(col, alpha);
        }
      `
    });

    const alphaBlend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
    };

    const makePipeline = (module, blend = undefined) => device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float', blend }]
      },
      primitive: { topology: 'triangle-list' }
    });

    this.gpuPipeBlit = makePipeline(blitModule);
    this.gpuPipeDisplay = makePipeline(displayModule);
    this.gpuPipeBrush = makePipeline(brushModule, alphaBlend);
    this.gpuPipeSun = makePipeline(sunModule, alphaBlend);
    this.gpuPipeMoon = makePipeline(moonModule, alphaBlend);
  }

  createWebGPUTexture(width, height) {
    const tex = this.gpuDevice.createTexture({
      size: [width, height, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT |
             GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_SRC |
             GPUTextureUsage.COPY_DST
    });
    return { tex, view: tex.createView() };
  }

  webgpuBlit(srcView, dstView, clearBg = false) {
    const device = this.gpuDevice;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        clearValue: { r: this.backgroundColor[0], g: this.backgroundColor[1], b: this.backgroundColor[2], a: 1.0 },
        loadOp: clearBg ? 'clear' : 'load',
        storeOp: 'store'
      }]
    });
    const bg = device.createBindGroup({
      layout: this.gpuPipeBlit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.gpuSampler },
        { binding: 1, resource: srcView }
      ]
    });
    pass.setPipeline(this.gpuPipeBlit);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // ===========================================================================
  // WEBGL 2 FALLBACK BACKEND
  // ===========================================================================
  initWebGL() {
    // Configure canvas HDR if supported by browser (Chrome experimental / newer WebGL HDR)
    if (typeof this.canvas.configureHighDynamicRange === 'function') {
      try {
        this.canvas.configureHighDynamicRange({ mode: 'extended' });
        this.hdrInfo.extendedToneMapping = true;
      } catch (err) {
        console.warn('configureHighDynamicRange error:', err);
      }
    }

    const glOptions = {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    };

    const gl = this.canvas.getContext('webgl2', glOptions);
    if (!gl) return;
    this.gl = gl;

    // Request BOTH full-float and half-float color buffer extensions for broad mobile GPU compatibility
    this.extColorFloat = gl.getExtension('EXT_color_buffer_float');
    this.extColorHalfFloat = gl.getExtension('EXT_color_buffer_half_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear') || gl.getExtension('OES_texture_half_float_linear');

    this.setupDrawingBufferStorage();
    this.initShaders();
    this.initGeometry();
    this.resizeCanvas();
  }

  setupDrawingBufferStorage() {
    const gl = this.gl;
    if (!gl) return;

    // Clear any stale GL error before testing drawingBufferStorage
    while (gl.getError() !== gl.NO_ERROR) {}

    if (typeof gl.drawingBufferStorage === 'function') {
      try {
        gl.drawingBufferStorage(gl.RGBA16F, this.canvas.width || 800, this.canvas.height || 600);
        const err = gl.getError();
        if (err === gl.NO_ERROR) {
          this.hdrInfo.float16Buffer = true;
        } else {
          console.warn('drawingBufferStorage(RGBA16F) GL error:', err);
          this.hdrInfo.float16Buffer = false;
        }
      } catch (e) {
        console.warn('drawingBufferStorage configuration skipped:', e);
        this.hdrInfo.float16Buffer = false;
      }
    }

    if ('drawingBufferColorSpace' in gl) {
      try {
        gl.drawingBufferColorSpace = 'display-p3';
      } catch (e) {
        console.warn('drawingBufferColorSpace configuration skipped:', e);
      }
    }

    // Modern Chromium WebGL extended dynamic range tone mapping
    if ('drawingBufferToneMapping' in gl) {
      try {
        gl.drawingBufferToneMapping = { mode: this.hdrInfo.highDynamicRange ? 'extended' : 'standard' };
        this.hdrInfo.extendedToneMapping = !!this.hdrInfo.highDynamicRange;
      } catch (e) {
        console.warn('drawingBufferToneMapping configuration skipped:', e);
      }
    }

    // Also allow configureHighDynamicRange if present
    if (typeof this.canvas.configureHighDynamicRange === 'function') {
      try {
        this.canvas.configureHighDynamicRange({ mode: this.hdrInfo.highDynamicRange ? 'extended' : 'standard' });
        this.hdrInfo.extendedToneMapping = !!this.hdrInfo.highDynamicRange;
      } catch (e) {}
    }

    this.updateHdrModeLabel();
  }

  initShaders() {
    const gl = this.gl;

    const vsSource = `#version 300 es
      layout(location = 0) in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // 1. Lossless 1:1 Blit Fragment Shader
    const fsBlitSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      out vec4 fragColor;
      void main() {
        fragColor = texture(u_texture, v_uv);
      }
    `;

    // 1b. Screen Display Presentation Fragment Shader
    // Never artificially clamps mobile devices to <= 0.995 when HDR is enabled!
    const fsDisplaySource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      uniform float u_displayPeak;
      uniform int u_isHDR;
      uniform int u_hasExtended;
      out vec4 fragColor;

      void main() {
        vec4 texCol = texture(u_texture, v_uv);
        vec3 c = max(vec3(0.0), texCol.rgb);
        float peak = max(c.r, max(c.g, c.b));

        if (u_isHDR == 1 && u_hasExtended == 1) {
          // Extended HDR swapchain (Desktop or Mobile): preserve full > 1.0 luminance up to u_displayPeak
          if (peak <= 1.0) {
            fragColor = vec4(c, 1.0);
            return;
          }
          float start = 1.0;
          float headroom = max(0.5, u_displayPeak - start);
          float D = 2.4;
          float s = start + headroom * (1.0 - exp(-(peak - start) / D));
          float k = s / peak;
          fragColor = vec4(c * k, 1.0);
        } else if (u_isHDR == 1) {
          // Wide-gamut SDR-composited fallback: allow full 1.0 peak (no artificial 0.675 dimming!)
          if (peak <= 0.80) {
            fragColor = vec4(c, 1.0);
            return;
          }
          float start = 0.80;
          float headroom = 0.20;
          float D = 2.0;
          float s = start + headroom * (1.0 - exp(-(peak - start) / D));
          float k = s / peak;
          fragColor = vec4(c * k, 1.0);
        } else {
          // Explicit SDR Mode
          if (peak <= 0.65) {
            fragColor = vec4(c, 1.0);
            return;
          }
          float start = 0.65;
          float headroom = 0.345;
          float D = 1.8;
          float s = start + headroom * (1.0 - exp(-(peak - start) / D));
          float k = s / peak;
          fragColor = vec4(c * k, 1.0);
        }
      }
    `;

    // 2. Brush Stroke Fragment Shader
    const fsBrushSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_radius;
      uniform float u_softness;
      uniform vec3 u_color;
      uniform vec3 u_bgColor;
      uniform float u_intensity;
      uniform float u_chromaRetention;
      uniform float u_opacity;
      uniform int u_isEraser;
      out vec4 fragColor;

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        float dist = distance(pixelCoord, u_center);
        if (dist > u_radius) {
          discard;
        }

        float inner = u_radius * (1.0 - u_softness);
        float normSoft = (dist <= inner) ? 0.0 : clamp((dist - inner) / max(0.001, u_radius - inner), 0.0, 1.0);
        float edgeAlpha = (dist <= inner) ? 1.0 : (1.0 - smoothstep(0.0, 1.0, normSoft));
        float alpha = edgeAlpha * u_opacity;

        if (u_isEraser == 1) {
          fragColor = vec4(u_bgColor, alpha);
        } else {
          float localIntensity = (dist <= inner) ? u_intensity : (1.0 + (u_intensity - 1.0) * pow(edgeAlpha, 1.25));
          vec3 baseCol = u_color;
          float maxC = max(baseCol.r, max(baseCol.g, baseCol.b));
          float minC = min(baseCol.r, min(baseCol.g, baseCol.b));
          float chroma = maxC - minC;

          vec3 hdrRGB;
          if (chroma > 0.001 && localIntensity > 1.0 && u_chromaRetention > 0.01) {
            vec3 norm = (baseCol - minC) / chroma;
            float p = 1.0 + u_chromaRetention * (localIntensity - 1.0) * 0.55;
            vec3 boostedNorm = pow(max(vec3(0.0), norm), vec3(p));
            float floorScale = minC * pow(localIntensity, max(0.0, 1.0 - u_chromaRetention * 0.8));
            hdrRGB = boostedNorm * (chroma * localIntensity) + floorScale;
          } else {
            hdrRGB = baseCol * localIntensity;
          }

          fragColor = vec4(hdrRGB, alpha);
        }
      }
    `;

    // 3. HDR Sunset Sun Fragment Shader (Panoramic fiery orange-yellow cloud haze above, crisp blazing disc, darker below)
    const fsSunSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_radius;
      uniform vec3 u_color;
      uniform float u_intensity;
      uniform float u_opacity;
      out vec4 fragColor;

      float sunHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float sunNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u2 = f * f * (3.0 - 2.0 * f);
        float a = sunHash(i);
        float b = sunHash(i + vec2(1.0, 0.0));
        float c = sunHash(i + vec2(0.0, 1.0));
        float d = sunHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
      }

      float sunFbm(vec2 p) {
        float val = 0.0;
        float amp = 0.52;
        for (int i = 0; i < 4; i++) {
          val += amp * sunNoise(p);
          p = p * vec2(2.05, 1.95) + vec2(11.3, 5.7);
          amp *= 0.5;
        }
        return val;
      }

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        // WebGL Y increases upward, so positive rel.y = ABOVE the sun, negative = BELOW
        vec2 rel = vec2(
          (pixelCoord.x - u_center.x) / u_radius,
          (pixelCoord.y - u_center.y) / u_radius
        );

        float ellipX = rel.x / 8.5;
        float ellipY = (rel.y >= 0.0) ? (rel.y / 5.8) : (rel.y / 2.4);
        float envDist = length(vec2(ellipX, ellipY));
        if (envDist > 1.0) {
          discard;
        }

        float dist = length(rel);

        // 1. Crisp, searing white-hot solar disc + tight intense corona
        float sunDisc = 1.0 - smoothstep(0.54, 0.66, dist);
        float sunHalo = exp(-dist * 1.15);

        // 2. Vertical horizon split: expansive fiery sky above, darker grounded atmosphere below
        float aboveFactor = smoothstep(-0.55, 0.45, rel.y);

        // 3. Horizontally-stretched backlit sunset cloud streaks
        vec2 cloudUV = vec2(rel.x * 0.28 + u_center.x * 0.003, rel.y * 1.35 + u_center.y * 0.002);
        float n1 = sunFbm(cloudUV);
        float n2 = sunFbm(cloudUV * vec2(2.1, 2.3) + vec2(3.7, -1.2));
        float cloudStreaks = clamp(n1 * 0.65 + n2 * 0.35, 0.0, 1.0);
        float skyBreak = smoothstep(0.32, 0.72, cloudStreaks);
        float darkCloudRibbon = smoothstep(0.56, 0.18, cloudStreaks);

        // 4. Panoramic atmospheric haze & horizon band
        float horizonBand = exp(-abs(rel.y - 0.55) * 0.50) * exp(-abs(rel.x) * 0.20);
        float upperSkyHaze = exp(-length(vec2(rel.x * 0.16, max(0.0, rel.y - 0.3) * 0.25)) * 1.4) * aboveFactor;
        float outerFade = pow(clamp(1.0 - envDist, 0.0, 1.0), 1.35);

        // 5. Darker below-horizon glare & shadow
        float belowGlare = exp(-length(vec2(rel.x * 0.72, min(0.0, rel.y) * 1.1)) * 1.3) * (1.0 - aboveFactor);

        // 6. HDR Sunset Color Palette
        vec3 blazingWhite = vec3(1.00, 0.99, 0.93) * (u_intensity * 2.6);
        vec3 moltenYellow = mix(vec3(1.00, 0.90, 0.16), u_color, 0.15) * (u_intensity * 1.45);
        vec3 fireOrange   = mix(vec3(1.00, 0.40, 0.03), u_color, 0.20) * (u_intensity * 1.05);
        vec3 deepCrimson  = vec3(0.82, 0.12, 0.02) * (u_intensity * 0.72);
        vec3 darkCloudRed = vec3(0.26, 0.04, 0.01) * max(0.7, u_intensity * 0.32);
        vec3 belowShadow  = vec3(0.12, 0.022, 0.008);

        float heat = clamp(sunHalo * 1.2 + horizonBand * 0.78 + upperSkyHaze * 0.68, 0.0, 1.0);
        float litHeat = clamp(heat * (0.58 + 0.72 * skyBreak) - darkCloudRibbon * 0.24 * smoothstep(0.6, 2.2, dist), 0.0, 1.0);

        vec3 skyCol = mix(darkCloudRed, deepCrimson, smoothstep(0.05, 0.35, litHeat));
        skyCol = mix(skyCol, fireOrange, smoothstep(0.28, 0.62, litHeat));
        skyCol = mix(skyCol, moltenYellow, smoothstep(0.55, 0.88, litHeat));

        vec3 lowerCol = mix(belowShadow, deepCrimson * 0.82, clamp(belowGlare * 1.1, 0.0, 1.0));
        lowerCol = mix(lowerCol, fireOrange * 0.72, clamp(sunHalo * 0.82, 0.0, 1.0));

        vec3 col = mix(lowerCol, skyCol, aboveFactor);
        col = mix(col, moltenYellow * 1.35, clamp(sunHalo * 0.85, 0.0, 1.0));
        col = mix(col, blazingWhite, sunDisc);

        float skyAlpha = (upperSkyHaze * 0.95 + horizonBand * 0.82) * (0.72 + 0.28 * cloudStreaks);
        float lowerAlpha = (belowGlare * 0.72 + exp(-length(vec2(rel.x * 0.25, rel.y * 0.8)) * 1.45) * 0.55) * (1.0 - aboveFactor);
        float alpha = clamp((sunDisc + sunHalo * 0.72 + (skyAlpha + lowerAlpha) * outerFade) * u_opacity, 0.0, 1.0);

        fragColor = vec4(col, alpha);
      }
    `;

    // 4. HDR Moon Fragment Shader
    const fsMoonSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_radius;
      uniform vec3 u_color;
      uniform float u_intensity;
      uniform float u_opacity;
      uniform float u_moonPhase;
      out vec4 fragColor;

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        vec2 diff = pixelCoord - u_center;
        float dist = length(diff);
        if (dist > u_radius * 2.0) {
          discard;
        }

        float normDist = dist / u_radius;
        float disc = 1.0 - smoothstep(0.96, 1.0, normDist);

        float offsetDistance = u_radius * (0.35 + clamp(u_moonPhase, 0.0, 1.0) * 1.85);
        vec2 shadowOffset = vec2(offsetDistance, u_radius * 0.05);
        float shadowDist = length(pixelCoord - (u_center + shadowOffset)) / u_radius;
        float shadow = 1.0 - smoothstep(0.95, 1.02, shadowDist);
        float crescent = clamp(disc - shadow, 0.0, 1.0);

        float halo = 1.0 - smoothstep(0.9, 1.8, normDist);
        vec3 moonCore = vec3(0.92, 0.97, 1.0) * (u_intensity * 1.5);
        vec3 moonGlow = mix(u_color, vec3(0.6, 0.8, 1.0), 0.5) * u_intensity;

        vec3 col = mix(moonGlow, moonCore, crescent);
        float alpha = (crescent * 0.95 + halo * 0.35) * u_opacity;
        alpha = clamp(alpha, 0.0, 1.0);

        fragColor = vec4(col, alpha);
      }
    `;

    this.progBlit = this.createProgram(vsSource, fsBlitSource);
    this.progDisplay = this.createProgram(vsSource, fsDisplaySource);
    this.progBrush = this.createProgram(vsSource, fsBrushSource);
    this.progSun = this.createProgram(vsSource, fsSunSource);
    this.progMoon = this.createProgram(vsSource, fsMoonSource);
  }

  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  initGeometry() {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    const quadVertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  createFramebufferTexture(width, height) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    const canFloatFbo = !!(this.extColorFloat || this.extColorHalfFloat);
    if (canFloatFbo) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    const filter = this.extFloatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    return { tex, fbo };
  }

  // ===========================================================================
  // SHARED CANVAS LIFECYCLE & UNDO / REDO
  // ===========================================================================
  resizeCanvas() {
    if (!this.ready && this.backend === 'initializing') return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const newWidth = Math.max(Math.floor(rect.width * dpr), 300);
    const newHeight = Math.max(Math.floor(rect.height * dpr), 300);

    if (newWidth === this.canvasWidth && newHeight === this.canvasHeight) {
      return;
    }

    const oldWidth = this.canvasWidth;
    const oldHeight = this.canvasHeight;

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;
    this.canvas.width = newWidth;
    this.canvas.height = newHeight;

    if (this.backend === 'webgpu') {
      const oldTex = this.gpuFboTexture;
      const oldView = this.gpuFboView;

      this.configureWebGPUContext();
      const { tex, view } = this.createWebGPUTexture(newWidth, newHeight);

      if (oldView && oldWidth > 0 && oldHeight > 0) {
        this.webgpuBlit(oldView, view, true);
        oldTex.destroy();
      } else {
        const encoder = this.gpuDevice.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view,
            clearValue: { r: this.backgroundColor[0], g: this.backgroundColor[1], b: this.backgroundColor[2], a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store'
          }]
        });
        pass.end();
        this.gpuDevice.queue.submit([encoder.finish()]);
      }

      this.gpuFboTexture = tex;
      this.gpuFboView = view;
      this.renderToScreen();
      this.pushUndoState();
      return;
    }

    if (!this.gl) return;
    const gl = this.gl;
    const oldFboTex = this.fboTexture;

    this.setupDrawingBufferStorage();
    const { tex, fbo } = this.createFramebufferTexture(newWidth, newHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, newWidth, newHeight);

    if (oldFboTex && oldWidth > 0 && oldHeight > 0) {
      gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.progBlit);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, oldFboTex);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } else {
      gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    this.fboTexture = tex;
    this.fbo = fbo;
    this.renderToScreen();
    this.pushUndoState();
  }

  clearCanvas() {
    if (this.backend === 'webgpu' && this.gpuFboView) {
      this.pushUndoState();
      const encoder = this.gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.gpuFboView,
          clearValue: { r: this.backgroundColor[0], g: this.backgroundColor[1], b: this.backgroundColor[2], a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
      pass.end();
      this.gpuDevice.queue.submit([encoder.finish()]);
      this.renderToScreen();
      return;
    }

    if (!this.gl) return;
    this.pushUndoState();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderToScreen();
  }

  setBackgroundColor(r, g, b) {
    this.backgroundColor = [r, g, b, 1.0];
    this.clearCanvas();
  }

  pushUndoState() {
    if (this.backend === 'webgpu' && this.gpuFboView) {
      const copy = this.createWebGPUTexture(this.canvasWidth, this.canvasHeight);
      this.webgpuBlit(this.gpuFboView, copy.view, false);
      this.undoStack.push(copy);
      if (this.undoStack.length > this.maxUndo) {
        const removed = this.undoStack.shift();
        removed.tex.destroy();
      }
      this.clearRedoStack();
      return;
    }

    if (!this.gl || !this.fboTexture) return;
    const gl = this.gl;
    const copy = this.createFramebufferTexture(this.canvasWidth, this.canvasHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, copy.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.undoStack.push(copy);
    if (this.undoStack.length > this.maxUndo) {
      const removed = this.undoStack.shift();
      gl.deleteTexture(removed.tex);
      gl.deleteFramebuffer(removed.fbo);
    }
    this.clearRedoStack();
  }

  clearRedoStack() {
    if (this.backend === 'webgpu') {
      while (this.redoStack.length > 0) {
        const item = this.redoStack.pop();
        item.tex.destroy();
      }
      return;
    }

    const gl = this.gl;
    while (this.redoStack.length > 0) {
      const item = this.redoStack.pop();
      gl.deleteTexture(item.tex);
      gl.deleteFramebuffer(item.fbo);
    }
  }

  undo() {
    if (this.undoStack.length <= 1) return;

    const current = this.undoStack.pop();
    this.redoStack.push(current);
    const target = this.undoStack[this.undoStack.length - 1];

    if (this.backend === 'webgpu') {
      this.webgpuBlit(target.view, this.gpuFboView, false);
      this.renderToScreen();
      return;
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.renderToScreen();
  }

  redo() {
    if (this.redoStack.length === 0) return;

    const item = this.redoStack.pop();
    this.undoStack.push(item);

    if (this.backend === 'webgpu') {
      this.webgpuBlit(item.view, this.gpuFboView, false);
      this.renderToScreen();
      return;
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, item.tex);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.renderToScreen();
  }

  // ===========================================================================
  // DRAWING & STROKES
  // ===========================================================================
  toCanvasPoint(x, y) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.backend === 'webgpu') {
      // WebGPU UV=(0,0) is top-left
      return { x: x * dpr, y: y * dpr };
    }
    // WebGL UV=(0,0) is bottom-left
    return { x: x * dpr, y: this.canvasHeight - (y * dpr) };
  }

  beginStroke(x, y) {
    if (!this.ready) return;
    this.isDrawing = true;
    this.pushUndoState();
    const pt = this.toCanvasPoint(x, y);
    this.lastPoint = pt;

    if (this.activeTool === 'sun') {
      this.drawSun(pt.x, pt.y);
    } else if (this.activeTool === 'moon') {
      this.drawMoon(pt.x, pt.y);
    } else {
      this.drawBrushPoint(pt.x, pt.y);
    }
    this.renderToScreen();
  }

  continueStroke(x, y) {
    if (!this.isDrawing || !this.ready) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pt = this.toCanvasPoint(x, y);

    if (this.activeTool === 'sun' || this.activeTool === 'moon') {
      return;
    }

    if (this.lastPoint) {
      const dx = pt.x - this.lastPoint.x;
      const dy = pt.y - this.lastPoint.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, (this.brushSize * dpr) * 0.25);
      const steps = Math.ceil(dist / step);

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const curX = this.lastPoint.x + dx * t;
        const curY = this.lastPoint.y + dy * t;
        this.drawBrushPoint(curX, curY);
      }
    }

    this.lastPoint = pt;
    this.renderToScreen();
  }

  endStroke() {
    this.isDrawing = false;
    this.lastPoint = null;
  }

  drawBrushPoint(x, y) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const radius = this.brushSize * dpr;

    if (this.backend === 'webgpu' && this.gpuFboView) {
      const data = new Float32Array([
        x, y,
        this.canvasWidth, this.canvasHeight,
        this.brushColor[0], this.brushColor[1], this.brushColor[2], radius,
        this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.brushSoftness,
        this.hdrIntensity, this.chromaRetention, this.brushOpacity, this.activeTool === 'eraser' ? 1.0 : 0.0
      ]);
      this.gpuDevice.queue.writeBuffer(this.gpuUniformBuf, 0, data);

      const bg = this.gpuDevice.createBindGroup({
        layout: this.gpuPipeBrush.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.gpuUniformBuf } }]
      });
      const encoder = this.gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.gpuFboView, loadOp: 'load', storeOp: 'store' }]
      });
      pass.setPipeline(this.gpuPipeBrush);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
      this.gpuDevice.queue.submit([encoder.finish()]);
      return;
    }

    const gl = this.gl;
    if (!gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progBrush);
    gl.uniform2f(gl.getUniformLocation(this.progBrush, 'u_center'), x, y);
    gl.uniform2f(gl.getUniformLocation(this.progBrush, 'u_resolution'), this.canvasWidth, this.canvasHeight);
    gl.uniform1f(gl.getUniformLocation(this.progBrush, 'u_radius'), radius);
    gl.uniform1f(gl.getUniformLocation(this.progBrush, 'u_softness'), this.brushSoftness);
    gl.uniform3fv(gl.getUniformLocation(this.progBrush, 'u_color'), this.brushColor);
    gl.uniform3fv(gl.getUniformLocation(this.progBrush, 'u_bgColor'), [
      this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2]
    ]);
    gl.uniform1f(gl.getUniformLocation(this.progBrush, 'u_intensity'), this.hdrIntensity);
    gl.uniform1f(gl.getUniformLocation(this.progBrush, 'u_chromaRetention'), this.chromaRetention);
    gl.uniform1f(gl.getUniformLocation(this.progBrush, 'u_opacity'), this.brushOpacity);
    gl.uniform1i(gl.getUniformLocation(this.progBrush, 'u_isEraser'), this.activeTool === 'eraser' ? 1 : 0);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  drawSun(x, y) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Larger panoramic HDR sunset scale (base solar disc + wide fiery cloud sky)
    const radius = this.brushSize * 1.7 * dpr;
    const sunIntensity = Math.max(this.hdrIntensity, 2.8);

    if (this.backend === 'webgpu' && this.gpuFboView) {
      const data = new Float32Array([
        x, y,
        this.canvasWidth, this.canvasHeight,
        this.brushColor[0], this.brushColor[1], this.brushColor[2], radius,
        sunIntensity, this.brushOpacity, 0, 0
      ]);
      this.gpuDevice.queue.writeBuffer(this.gpuUniformBuf, 0, data);

      const bg = this.gpuDevice.createBindGroup({
        layout: this.gpuPipeSun.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.gpuUniformBuf } }]
      });
      const encoder = this.gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.gpuFboView, loadOp: 'load', storeOp: 'store' }]
      });
      pass.setPipeline(this.gpuPipeSun);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
      this.gpuDevice.queue.submit([encoder.finish()]);
      return;
    }

    const gl = this.gl;
    if (!gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progSun);
    gl.uniform2f(gl.getUniformLocation(this.progSun, 'u_center'), x, y);
    gl.uniform2f(gl.getUniformLocation(this.progSun, 'u_resolution'), this.canvasWidth, this.canvasHeight);
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_radius'), radius);
    gl.uniform3fv(gl.getUniformLocation(this.progSun, 'u_color'), this.brushColor);
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_intensity'), sunIntensity);
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_opacity'), this.brushOpacity);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  drawMoon(x, y) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const radius = this.brushSize * 1.8 * dpr;
    const moonIntensity = Math.max(this.hdrIntensity, 1.8);

    if (this.backend === 'webgpu' && this.gpuFboView) {
      const data = new Float32Array([
        x, y,
        this.canvasWidth, this.canvasHeight,
        this.brushColor[0], this.brushColor[1], this.brushColor[2], radius,
        moonIntensity, this.brushOpacity, this.moonPhase, 0
      ]);
      this.gpuDevice.queue.writeBuffer(this.gpuUniformBuf, 0, data);

      const bg = this.gpuDevice.createBindGroup({
        layout: this.gpuPipeMoon.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.gpuUniformBuf } }]
      });
      const encoder = this.gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.gpuFboView, loadOp: 'load', storeOp: 'store' }]
      });
      pass.setPipeline(this.gpuPipeMoon);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
      this.gpuDevice.queue.submit([encoder.finish()]);
      return;
    }

    const gl = this.gl;
    if (!gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progMoon);
    gl.uniform2f(gl.getUniformLocation(this.progMoon, 'u_center'), x, y);
    gl.uniform2f(gl.getUniformLocation(this.progMoon, 'u_resolution'), this.canvasWidth, this.canvasHeight);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_radius'), radius);
    gl.uniform3fv(gl.getUniformLocation(this.progMoon, 'u_color'), this.brushColor);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_intensity'), moonIntensity);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_opacity'), this.brushOpacity);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_moonPhase'), this.moonPhase);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  renderToScreen() {
    if (this.backend === 'webgpu' && this.gpuFboView && this.gpuContext) {
      const data = new Float32Array([
        this.displayHeadroom || 3.0,
        this.hdrInfo.highDynamicRange ? 1.0 : 0.0,
        this.hdrInfo.extendedToneMapping ? 1.0 : 0.0,
        0.0
      ]);
      this.gpuDevice.queue.writeBuffer(this.gpuUniformBuf, 0, data);

      const currentTex = this.gpuContext.getCurrentTexture();
      const bg = this.gpuDevice.createBindGroup({
        layout: this.gpuPipeDisplay.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.gpuSampler },
          { binding: 1, resource: this.gpuFboView },
          { binding: 2, resource: { buffer: this.gpuUniformBuf } }
        ]
      });

      const encoder = this.gpuDevice.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: currentTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
      pass.setPipeline(this.gpuPipeDisplay);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
      this.gpuDevice.queue.submit([encoder.finish()]);
      return;
    }

    const gl = this.gl;
    if (!gl || !this.fboTexture) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_texture'), 0);
    gl.uniform1f(gl.getUniformLocation(this.progDisplay, 'u_displayPeak'), this.displayHeadroom || 3.0);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_isHDR'), this.hdrInfo.highDynamicRange ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_hasExtended'), this.hdrInfo.extendedToneMapping ? 1 : 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  init2DFallback() {
    const ctx = this.canvas.getContext('2d', { colorSpace: 'display-p3' });
    this.ctx2D = ctx;
  }

  // ===========================================================================
  // HDR PIXEL READBACK (WebGPU & WebGL2, always returned top-down as Float32Array)
  // ===========================================================================
  async readHdrPixelsTopDown() {
    const width = this.canvasWidth;
    const height = this.canvasHeight;

    if (this.backend === 'webgpu' && this.gpuFboTexture) {
      const bytesPerPixel = 8; // rgba16float = 4 * 2 bytes
      const unalignedBytesPerRow = width * bytesPerPixel;
      const bytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256;
      const bufferSize = bytesPerRow * height;

      const readBuf = this.gpuDevice.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });

      const encoder = this.gpuDevice.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.gpuFboTexture },
        { buffer: readBuf, bytesPerRow, rowsPerImage: height },
        [width, height, 1]
      );
      this.gpuDevice.queue.submit([encoder.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ);
      const mapped = new Uint16Array(readBuf.getMappedRange());
      const out = new Float32Array(width * height * 4);
      const u16Stride = bytesPerRow / 2;

      for (let y = 0; y < height; y++) {
        const srcRow = y * u16Stride;
        const dstRow = y * width * 4;
        for (let x = 0; x < width * 4; x++) {
          out[dstRow + x] = float16ToFloat32(mapped[srcRow + x]);
        }
      }

      readBuf.unmap();
      readBuf.destroy();
      return out;
    }

    if (this.gl && this.fbo) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      while (gl.getError() !== gl.NO_ERROR) {}

      let bottomUp = new Float32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, bottomUp);

      if (gl.getError() !== gl.NO_ERROR) {
        // Fallback: try HALF_FLOAT readback (for GPUs without FLOAT readPixels)
        const halfBuf = new Uint16Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, halfBuf);
        if (gl.getError() !== gl.NO_ERROR) {
          console.warn('Float/HalfFloat readPixels not supported on this GPU');
          return null;
        }
        for (let i = 0; i < halfBuf.length; i++) {
          bottomUp[i] = float16ToFloat32(halfBuf[i]);
        }
      }

      // Flip vertically from WebGL bottom-up to standard top-down coordinates
      const topDown = new Float32Array(width * height * 4);
      const rowSize = width * 4;
      for (let y = 0; y < height; y++) {
        const srcOff = y * rowSize;
        const dstOff = (height - 1 - y) * rowSize;
        topDown.set(bottomUp.subarray(srcOff, srcOff + rowSize), dstOff);
      }
      return topDown;
    }

    return null;
  }

  // ===========================================================================
  // ULTRA HDR + ISO/TS 21496-1 JPEG ENCODER
  // ===========================================================================
  findJpegInsertPos(jpegBytes) {
    let pos = 2;
    if (jpegBytes[0] === 0xFF && jpegBytes[1] === 0xD8) {
      if (jpegBytes[2] === 0xFF && jpegBytes[3] === 0xE0) {
        const app0Len = (jpegBytes[4] << 8) | jpegBytes[5];
        pos = 4 + app0Len;
      }
    }
    return pos;
  }

  insertSegmentAt(jpegBytes, segmentBytes, insertPos) {
    const result = new Uint8Array(jpegBytes.length + segmentBytes.length);
    result.set(jpegBytes.subarray(0, insertPos), 0);
    result.set(segmentBytes, insertPos);
    result.set(jpegBytes.subarray(insertPos), insertPos + segmentBytes.length);
    return result;
  }

  buildApp1XmpSegment(payloadString) {
    const payloadBytes = new TextEncoder().encode(payloadString);
    const segLen = 2 + payloadBytes.length;
    if (segLen > 65535) return new Uint8Array(0);

    const app1 = new Uint8Array(2 + segLen);
    app1[0] = 0xFF;
    app1[1] = 0xE1;
    app1[2] = (segLen >> 8) & 0xFF;
    app1[3] = segLen & 0xFF;
    app1.set(payloadBytes, 4);
    return app1;
  }

  // Builds ISO/TS 21496-1 Primary Image signaling APP2 segment (required by iOS 18+ / Safari / Android 15+)
  buildIso21496PrimaryApp2() {
    const urn = new TextEncoder().encode('urn:iso:std:iso:ts:21496:-1\0'); // 28 bytes
    const payload = new Uint8Array(4); // minimum_version=0 (u16), writer_version=0 (u16)
    const segLen = 2 + urn.length + payload.length;
    const app2 = new Uint8Array(2 + segLen);
    app2[0] = 0xFF;
    app2[1] = 0xE2;
    app2[2] = (segLen >> 8) & 0xFF;
    app2[3] = segLen & 0xFF;
    app2.set(urn, 4);
    app2.set(payload, 4 + urn.length);
    return app2;
  }

  // Builds ISO/TS 21496-1 Gain Map metadata APP2 segment (single-channel, base colour space)
  buildIso21496GainMapApp2(gainMapMax, hdrCapacityMax) {
    const urn = new TextEncoder().encode('urn:iso:std:iso:ts:21496:-1\0'); // 28 bytes
    const payload = new Uint8Array(61);
    const view = new DataView(payload.buffer);
    const SCALE = 1000000;

    view.setUint16(0, 0, false); // minimum_version = 0
    view.setUint16(2, 0, false); // writer_version = 0
    payload[4] = 0x40;           // flags: is_multichannel=0 (bit7), use_base_colour_space=1 (bit6)

    // base_hdr_headroom = 0 / 1 (SDR base)
    view.setUint32(5, 0, false);
    view.setUint32(9, 1, false);

    // alternate_hdr_headroom = hdrCapacityMax
    view.setUint32(13, Math.round(hdrCapacityMax * SCALE), false);
    view.setUint32(17, SCALE, false);

    // Channel 0 parameters (monochrome gain map):
    // gain_map_min = 0 / 1
    view.setInt32(21, 0, false);
    view.setUint32(25, 1, false);

    // gain_map_max = gainMapMax
    view.setInt32(29, Math.round(gainMapMax * SCALE), false);
    view.setUint32(33, SCALE, false);

    // gamma = 1 / 1
    view.setUint32(37, 1, false);
    view.setUint32(41, 1, false);

    // base_offset = 1 / 64 (0.015625)
    view.setInt32(45, 1, false);
    view.setUint32(49, 64, false);

    // alternate_offset = 1 / 64 (0.015625)
    view.setInt32(53, 1, false);
    view.setUint32(57, 64, false);

    const segLen = 2 + urn.length + payload.length;
    const app2 = new Uint8Array(2 + segLen);
    app2[0] = 0xFF;
    app2[1] = 0xE2;
    app2[2] = (segLen >> 8) & 0xFF;
    app2[3] = segLen & 0xFF;
    app2.set(urn, 4);
    app2.set(payload, 4 + urn.length);
    return app2;
  }

  // Generates APP2 Multi-Picture Format (MPF) segment linking primary image and secondary gain map
  generateMpfApp2(primarySize, app2Pos, secondarySize) {
    const secondaryOffset = primarySize - app2Pos - 8;
    const mpf = new Uint8Array(86);
    const view = new DataView(mpf.buffer);

    mpf[0] = 0x4D; mpf[1] = 0x50; mpf[2] = 0x46; mpf[3] = 0x00; // 'MPF\0'
    mpf[4] = 0x4D; mpf[5] = 0x4D; mpf[6] = 0x00; mpf[7] = 0x2A; // Big-Endian TIFF 'MM\0*'
    view.setUint32(8, 8, false);   // Index IFD offset
    view.setUint16(12, 3, false);  // 3 IFD tags

    // Tag 1: Version 0xB000 = '0100'
    view.setUint16(14, 0xB000, false);
    view.setUint16(16, 7, false);
    view.setUint32(18, 4, false);
    mpf[22] = 0x30; mpf[23] = 0x31; mpf[24] = 0x30; mpf[25] = 0x30;

    // Tag 2: Number of images 0xB001 = 2
    view.setUint16(26, 0xB001, false);
    view.setUint16(28, 4, false);
    view.setUint32(30, 1, false);
    view.setUint32(34, 2, false);

    // Tag 3: MP Entry 0xB002 (32 bytes at offset 50 from TIFF header)
    view.setUint16(38, 0xB002, false);
    view.setUint16(40, 7, false);
    view.setUint32(42, 32, false);
    view.setUint32(46, 50, false);

    view.setUint32(50, 0, false); // Next IFD offset = 0

    // MP Entry 1 (Primary Image)
    view.setUint32(54, 0x030000, false);
    view.setUint32(58, primarySize, false);
    view.setUint32(62, 0, false);
    view.setUint16(66, 0, false);
    view.setUint16(68, 0, false);

    // MP Entry 2 (Secondary Gain Map Image)
    view.setUint32(70, 0x000000, false);
    view.setUint32(74, secondarySize, false);
    view.setUint32(78, secondaryOffset, false);
    view.setUint16(82, 0, false);
    view.setUint16(84, 0, false);

    const segLen = 2 + mpf.length; // 88
    const app2 = new Uint8Array(2 + segLen); // 90
    app2[0] = 0xFF;
    app2[1] = 0xE2;
    app2[2] = (segLen >> 8) & 0xFF;
    app2[3] = segLen & 0xFF;
    app2.set(mpf, 4);
    return app2;
  }

  /**
   * Generates a dual-standard Ultra HDR + ISO/TS 21496-1 JPEG Blob in memory.
   * Computes gain map in true linear light (matching ISO 21496-1 / Adobe / Apple decoders).
   */
  async generateUltraHDRBlob() {
    const hdrPixels = await this.readHdrPixelsTopDown();
    if (!hdrPixels) return null;

    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const sdrData = new Uint8ClampedArray(width * height * 4);
    const gainData = new Uint8ClampedArray(width * height * 4);

    let maxHdr = 1.0;
    for (let i = 0; i < hdrPixels.length; i += 4) {
      if (hdrPixels[i] > maxHdr) maxHdr = hdrPixels[i];
      if (hdrPixels[i + 1] > maxHdr) maxHdr = hdrPixels[i + 1];
      if (hdrPixels[i + 2] > maxHdr) maxHdr = hdrPixels[i + 2];
    }

    const start = 0.70;
    const headroom = 1.0 - start;
    const D = Math.max(1.8, (maxHdr - start) * 0.45);

    function tonePeak(peak) {
      if (peak <= start) return peak;
      return start + headroom * 0.99 * (1.0 - Math.exp(-(peak - start) / D));
    }

    let maxLogGain = 0.0;
    const logGains = new Float32Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const rHdr = Math.max(0, hdrPixels[idx]);
      const gHdr = Math.max(0, hdrPixels[idx + 1]);
      const bHdr = Math.max(0, hdrPixels[idx + 2]);

      const peak = Math.max(rHdr, Math.max(gHdr, bHdr));
      let k = 1.0;
      let s = peak;

      if (peak > start) {
        s = tonePeak(peak);
        k = s / peak;
      }

      const rSdr = Math.min(1.0, rHdr * k);
      const gSdr = Math.min(1.0, gHdr * k);
      const bSdr = Math.min(1.0, bHdr * k);

      sdrData[idx] = Math.round(rSdr * 255);
      sdrData[idx + 1] = Math.round(gSdr * 255);
      sdrData[idx + 2] = Math.round(bSdr * 255);
      sdrData[idx + 3] = 255;

      // Convert both HDR and SDR peak values to LINEAR light before computing log2 gain,
      // matching ISO 21496-1 / Ultra HDR decoders which linearize the SDR JPEG before multiplying by 2^(gain * w).
      const linHdr = extendedSrgbToLinear(peak);
      const linSdr = extendedSrgbToLinear(s);
      const ratio = (linHdr + 0.015625) / (linSdr + 0.015625);
      const logG = Math.max(0.0, Math.log2(ratio));
      logGains[i] = logG;

      if (logG > maxLogGain) {
        maxLogGain = logG;
      }
    }

    // Clamp GainMapMax to [1.5, 4.0] stops (up to 16x linear luminance boost)
    const gainMapMax = Math.max(1.5, Math.min(4.0, Math.ceil(maxLogGain * 10) / 10 || 3.0));
    // Calibrate HDRCapacityMax so mobile OLED displays (typically 1.3–2.0 stops headroom) apply ~100% boost
    const hdrCapacityMax = Math.min(1.5, gainMapMax);

    for (let i = 0; i < width * height; i++) {
      const normGain = Math.max(0.0, Math.min(1.0, logGains[i] / gainMapMax));
      const val = Math.round(normGain * 255);
      const idx = i * 4;
      gainData[idx] = val;
      gainData[idx + 1] = val;
      gainData[idx + 2] = val;
      gainData[idx + 3] = 255;
    }

    const sdrCanvas = document.createElement('canvas');
    sdrCanvas.width = width;
    sdrCanvas.height = height;
    const sdrCtx = sdrCanvas.getContext('2d', { colorSpace: 'display-p3' }) || sdrCanvas.getContext('2d');
    let sdrImgData;
    try {
      sdrImgData = new ImageData(sdrData, width, height, { colorSpace: 'display-p3' });
    } catch {
      sdrImgData = new ImageData(sdrData, width, height);
    }
    sdrCtx.putImageData(sdrImgData, 0, 0);

    const gainCanvas = document.createElement('canvas');
    gainCanvas.width = width;
    gainCanvas.height = height;
    const gainCtx = gainCanvas.getContext('2d');
    gainCtx.putImageData(new ImageData(gainData, width, height), 0, 0);

    const [sdrBlob, gainBlob] = await Promise.all([
      new Promise(res => sdrCanvas.toBlob(res, 'image/jpeg', 0.98)),
      new Promise(res => gainCanvas.toBlob(res, 'image/jpeg', 0.92))
    ]);

    if (!sdrBlob || !gainBlob) return null;

    let sdrBytes = new Uint8Array(await sdrBlob.arrayBuffer());
    let gainBytes = new Uint8Array(await gainBlob.arrayBuffer());

    // 1. Secondary Gain Map Image: embed BOTH Adobe hdrgm XMP AND ISO/TS 21496-1 binary APP2
    const secondaryXmp = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0.000000" hdrgm:GainMapMax="${gainMapMax.toFixed(6)}" hdrgm:Gamma="1.000000" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0.000000" hdrgm:HDRCapacityMax="${hdrCapacityMax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>`;
    const gainApp1 = this.buildApp1XmpSegment(secondaryXmp);
    const gainIsoApp2 = this.buildIso21496GainMapApp2(gainMapMax, hdrCapacityMax);
    const gainInsertPos = this.findJpegInsertPos(gainBytes);
    const gainMetaBlock = new Uint8Array(gainApp1.length + gainIsoApp2.length);
    gainMetaBlock.set(gainApp1, 0);
    gainMetaBlock.set(gainIsoApp2, gainApp1.length);
    gainBytes = this.insertSegmentAt(gainBytes, gainMetaBlock, gainInsertPos);
    const finalGainLength = gainBytes.length;

    // 2. Primary SDR Image: embed APP1 XMP (GContainer + hdrgm), APP2 ISO 21496-1 primary marker, and APP2 MPF
    const primaryXmp = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0.000000" hdrgm:GainMapMax="${gainMapMax.toFixed(6)}" hdrgm:Gamma="1.000000" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0.000000" hdrgm:HDRCapacityMax="${hdrCapacityMax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${finalGainLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const primaryApp1 = this.buildApp1XmpSegment(primaryXmp);
    const primaryIsoApp2 = this.buildIso21496PrimaryApp2();

    const sdrInsertPos = this.findJpegInsertPos(sdrBytes);
    const mpfPos = sdrInsertPos + primaryApp1.length + primaryIsoApp2.length;
    const finalPrimarySize = sdrBytes.length + primaryApp1.length + primaryIsoApp2.length + 90;
    const mpfApp2 = this.generateMpfApp2(finalPrimarySize, mpfPos, finalGainLength);

    const primaryMetaBlock = new Uint8Array(primaryApp1.length + primaryIsoApp2.length + mpfApp2.length);
    primaryMetaBlock.set(primaryApp1, 0);
    primaryMetaBlock.set(primaryIsoApp2, primaryApp1.length);
    primaryMetaBlock.set(mpfApp2, primaryApp1.length + primaryIsoApp2.length);

    const finalSdrBytes = this.insertSegmentAt(sdrBytes, primaryMetaBlock, sdrInsertPos);

    // 3. Concatenate Primary SDR JPEG + Secondary Gain Map JPEG
    const ultraHdrBytes = new Uint8Array(finalSdrBytes.length + finalGainLength);
    ultraHdrBytes.set(finalSdrBytes, 0);
    ultraHdrBytes.set(gainBytes, finalSdrBytes.length);

    return new Blob([ultraHdrBytes], { type: 'image/jpeg' });
  }

  async exportUltraHDR(filename = `HDR-Artwork-${Date.now()}.jpg`) {
    const blob = await this.generateUltraHDRBlob();
    if (!blob) {
      this.exportImage(filename.replace(/\.jpg$/i, '.png'));
      return;
    }
    const link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  exportImage(filename = 'hdr-paint.png') {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }
}

global.HDREngine = HDREngine;
})(typeof window !== 'undefined' ? window : globalThis);
