/**
 * HDR Paint Engine
 * Powered by WebGL 2 with Float16 Backing Storage and Display-P3 Extended Range.
 * Falls back gracefully to standard Canvas2D if WebGL2 is unavailable.
 * Compatible with both classic script loading (file:///) and static web hosting.
 */

(function(global) {
class HDREngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.isHDRSupported = false;
    this.hdrInfo = {
      displayP3: false,
      highDynamicRange: false,
      float16Buffer: false,
      mode: 'sdr'
    };

    // Painting state
    this.brushSize = 25;
    this.brushSoftness = 0.5; // 0 = hard, 1 = super soft
    this.brushOpacity = 1.0;
    this.brushColor = [1.0, 0.4, 0.1]; // Display P3 RGB
    this.hdrIntensity = 2.5; // 1.0 = SDR 100 nits, up to 5.0x = Peak HDR highlights
    this.chromaRetention = 1.0; // Maximum vivid chromaticity preservation (always active)
    this.displayHeadroom = 2.8; // Calibrated HDR display headroom (prevents monitor hardware clipping)
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

    this.init();
  }

  init() {
    this.detectHDRCapabilities();
    this.initWebGL();
    if (!this.gl) {
      console.warn('WebGL2 not available. Falling back to 2D canvas.');
      this.init2DFallback();
    }
  }

  detectHDRCapabilities() {
    // 1. Check URL parameters and localStorage for forced/saved HDR preference
    const urlParams = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;
    const forceHdrParam = urlParams ? (urlParams.get('hdr') === '1' || urlParams.get('hdr') === 'true' || urlParams.get('forcehdr') === '1') : false;
    let savedHdrPref = null;
    try {
      const stored = localStorage.getItem('force_hdr_mode');
      if (stored !== null) savedHdrPref = (stored === 'true');
    } catch (e) {}

    // 2. Check screen dynamic-range and color gamut queries
    const hdrQuery = window.matchMedia('(dynamic-range: high)');
    const p3Query = window.matchMedia('(color-gamut: p3)');

    // On mobile Android flagships (e.g. Samsung Galaxy S23 Ultra AMOLED), Chrome for Android
    // often reports (dynamic-range: high) as false in web contexts even though the screen
    // is a 1750-nit Display-P3 HDR display. We recognize mobile P3 screens as HDR capable!
    const isMobileP3 = p3Query.matches && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');

    const isHDR = forceHdrParam || (savedHdrPref !== null ? savedHdrPref : (hdrQuery.matches || isMobileP3));

    this.hdrInfo.highDynamicRange = isHDR;
    this.hdrInfo.displayP3 = p3Query.matches || isHDR;
    this.displayHeadroom = isHDR ? 2.8 : 1.0;

    // Listen for live display changes (e.g. Win+Alt+B HDR toggling or dragging between monitors)
    const onDisplayChange = () => {
      if (!this.manualHdrOverride && !forceHdrParam && savedHdrPref === null) {
        this.hdrInfo.highDynamicRange = hdrQuery.matches || isMobileP3;
        this.hdrInfo.displayP3 = p3Query.matches;
        this.displayHeadroom = this.hdrInfo.highDynamicRange ? 2.8 : 1.0;
        this.setupDrawingBufferStorage();
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

    // 3. Configure canvas HDR if supported by browser (Chrome 122+)
    if (typeof this.canvas.configureHighDynamicRange === 'function') {
      try {
        this.canvas.configureHighDynamicRange({ mode: 'extended' });
        this.hdrInfo.float16Buffer = true;
      } catch (err) {
        console.warn('configureHighDynamicRange error:', err);
      }
    }
  }

  setManualHDR(enabled) {
    this.manualHdrOverride = true;
    try {
      localStorage.setItem('force_hdr_mode', enabled ? 'true' : 'false');
    } catch (e) {}
    this.hdrInfo.highDynamicRange = !!enabled;
    this.hdrInfo.displayP3 = !!enabled;
    this.displayHeadroom = enabled ? 2.8 : 1.0;
    this.setupDrawingBufferStorage();
    this.renderToScreen();
    if (typeof window.onHDRCapabilityChange === 'function') {
      window.onHDRCapabilityChange(this.hdrInfo);
    }
  }

  initWebGL() {
    const glOptions = {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    };

    let gl = this.canvas.getContext('webgl2', glOptions);
    if (!gl) return;
    this.gl = gl;

    // Enable floating-point color buffer extensions for WebGL2
    this.extColorFloat = gl.getExtension('EXT_color_buffer_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear') || gl.getExtension('OES_texture_half_float_linear');

    // Try setting drawing buffer storage to RGBA16F for extended dynamic range
    this.setupDrawingBufferStorage();

    // Compile Shaders
    this.initShaders();

    // Setup full-screen quad geometry
    this.initGeometry();

    // Initial canvas sizing
    this.resizeCanvas();
  }

  setupDrawingBufferStorage() {
    const gl = this.gl;
    if (!gl) return;

    if (typeof gl.drawingBufferStorage === 'function') {
      try {
        gl.drawingBufferStorage(gl.RGBA16F, this.canvas.width || 800, this.canvas.height || 600);
        this.hdrInfo.float16Buffer = true;
        if ('drawingBufferColorSpace' in gl) {
          gl.drawingBufferColorSpace = 'display-p3';
        }
      } catch (e) {
        console.warn('drawingBufferStorage configuration skipped:', e);
      }
    }

    // Modern Chromium WebGL extended dynamic range tone mapping
    if ('drawingBufferToneMapping' in gl) {
      try {
        gl.drawingBufferToneMapping = { mode: 'extended' };
      } catch (e) {
        console.warn('drawingBufferToneMapping configuration skipped:', e);
      }
    }

    this.hdrInfo.mode = (this.hdrInfo.float16Buffer && this.hdrInfo.highDynamicRange)
      ? 'HDR Display P3 (Float16)'
      : (this.hdrInfo.displayP3 ? 'Display P3 Wide Gamut' : 'Standard Dynamic Range');
  }

  initShaders() {
    const gl = this.gl;

    // Common Vertex Shader
    const vsSource = `#version 300 es
      layout(location = 0) in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // 1. Lossless 1:1 Blit Fragment Shader (for FBO-to-FBO texture copies in undo/redo/resize)
    const fsBlitSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      out vec4 fragColor;
      void main() {
        fragColor = texture(u_texture, v_uv);
      }
    `;

    // 1b. Screen Display Presentation Fragment Shader with Adaptive Photographic HDR Roll-off
    const fsDisplaySource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      uniform float u_displayPeak;
      uniform int u_isHDR;
      uniform int u_isMobile;
      out vec4 fragColor;

      void main() {
        vec4 texCol = texture(u_texture, v_uv);
        vec3 c = texCol.rgb;
        float peak = max(c.r, max(c.g, c.b));

        if (u_isHDR == 1) {
          if (u_isMobile == 0) {
            // Desktop HDR with extended swapchain (Windows 11 HDR):
            if (peak <= 1.0) {
              fragColor = texCol;
              return;
            }
            float start = 1.0;
            float headroom = max(0.2, u_displayPeak - start);
            float D = 2.2;
            float s = start + headroom * (1.0 - exp(-(peak - start) / D));
            float k = s / peak;
            fragColor = vec4(c * k, texCol.a);
          } else {
            // Mobile OLED HDR Mode (e.g. Samsung S23 Ultra):
            // Expanded dynamic range mapping highlights vividly into [0.60, 0.995]
            // Guarantees maximum contrast, glowing saturation, and distinct 1.0x, 2.2x, 3.5x, 5.0x tiers!
            if (peak <= 0.60) {
              fragColor = texCol;
              return;
            }
            float start = 0.60;
            float headroom = 0.395;
            float D = 1.9;
            float s = start + headroom * (1.0 - exp(-(peak - start) / D));
            float k = s / peak;
            fragColor = vec4(c * k, texCol.a);
          }
        } else {
          // Standard Dynamic Range (SDR Mode):
          // Compressed, subdued highlights capped at SDR ceiling (~0.74) for classic 8-bit paint feel
          if (peak <= 0.50) {
            fragColor = texCol;
            return;
          }
          float start = 0.50;
          float headroom = 0.245;
          float D = 1.4;
          float s = start + headroom * (1.0 - exp(-(peak - start) / D));
          float k = s / peak;
          fragColor = vec4(c * k, texCol.a);
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

        // Soft radial falloff
        float inner = u_radius * (1.0 - u_softness);
        float normSoft = (dist <= inner) ? 0.0 : clamp((dist - inner) / max(0.001, u_radius - inner), 0.0, 1.0);
        float edgeAlpha = (dist <= inner) ? 1.0 : (1.0 - smoothstep(0.0, 1.0, normSoft));
        float alpha = edgeAlpha * u_opacity;

        if (u_isEraser == 1) {
          // Erase back to exact canvas background color
          fragColor = vec4(u_bgColor, alpha);
        } else {
          // Dynamic intensity tapering across the soft edge:
          // Core maintains full u_intensity; as the stroke feathers outwards, intensity tapers smoothly
          // from peak HDR radiance down to baseline SDR (1.0x), preserving rich saturated halos,
          // distinct overlapping stamp disc textures, and photographic soft falloffs.
          float localIntensity = (dist <= inner) ? u_intensity : (1.0 + (u_intensity - 1.0) * pow(edgeAlpha, 1.25));

          // Chromaticity-preserving HDR scaling:
          // Prevents subordinate RGB channels from climbing into the dominant subpixel clipping ceiling
          // Keeps Cyan, Magenta, Gold, Lime, and Crimson ultra-vivid even at 5.0x boost without washing out to white
          vec3 baseCol = u_color;
          float maxC = max(baseCol.r, max(baseCol.g, baseCol.b));
          float minC = min(baseCol.r, min(baseCol.g, baseCol.b));
          float chroma = maxC - minC;

          vec3 hdrRGB;
          if (chroma > 0.001 && localIntensity > 1.0 && u_chromaRetention > 0.01) {
            vec3 norm = (baseCol - minC) / chroma;
            // Power curve suppresses subordinate channels from whitening out the color at peak luminance
            float p = 1.0 + u_chromaRetention * (localIntensity - 1.0) * 0.55;
            vec3 boostedNorm = pow(max(vec3(0.0), norm), vec3(p));
            // Floor scaling maintains dark contrast without graying
            float floorScale = minC * pow(localIntensity, max(0.0, 1.0 - u_chromaRetention * 0.8));
            hdrRGB = boostedNorm * (chroma * localIntensity) + floorScale;
          } else {
            hdrRGB = baseCol * localIntensity;
          }

          fragColor = vec4(hdrRGB, alpha);
        }
      }
    `;

    // 3. HDR Sun Bloom Fragment Shader (Warm Volumetric Glow extending to full 5x radius)
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

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        vec2 diff = pixelCoord - u_center;
        float dist = length(diff);
        // Outer limit extends to 5.0x radius = 10.0x radius in diameter = 5x tool diameter!
        if (dist > u_radius * 5.0) {
          discard;
        }

        float normDist = dist / u_radius;

        // 1. Searing Incandescent Core (pure over-bright white > 5.0x peak HDR)
        float coreRadius = 0.55;
        float core = 1.0 - smoothstep(0.0, coreRadius, normDist);
        float coreEdge = 1.0 - smoothstep(coreRadius * 0.7, 1.05, normDist);

        // 2. Intense Golden-Yellow Inner Solar Bloom (stretches to ~2.2x)
        float innerBloom = 1.0 - smoothstep(0.35, 2.2, normDist);

        // 3. Warm Golden-Amber Mid Bloom (stretches to ~3.8x)
        float midBloom = 1.0 - smoothstep(1.2, 3.8, normDist);

        // 4. Smooth, continuous warm atmospheric falloff to the full 5.0x radius
        float atmosphericDropoff = pow(max(0.0, 1.0 - normDist / 5.0), 1.35);

        // Warm, luminous HDR colors (never dark or muddy):
        // Pure blinding white peak core
        vec3 coreWhite = vec3(1.0, 0.99, 0.95) * (u_intensity * 2.5);
        // Saturated electric solar yellow
        vec3 solarYellow = mix(u_color, vec3(1.0, 0.95, 0.15), 0.7) * (u_intensity * 1.8);
        // Rich warm golden amber
        vec3 warmAmber = mix(u_color, vec3(1.0, 0.62, 0.08), 0.75) * (u_intensity * 1.4);
        // Luminous warm sunset gold outer glow
        vec3 warmOuterGlow = mix(warmAmber, vec3(1.0, 0.52, 0.12), 0.5) * (u_intensity * 1.15);

        // Color gradient from outer warmth to blinding core
        vec3 color = warmOuterGlow;
        color = mix(color, warmAmber, midBloom);
        color = mix(color, solarYellow, innerBloom);
        color = mix(color, coreWhite, coreEdge);
        color = mix(color, coreWhite * 1.15, core);

        // Alpha drop-off: preserves warm illumination across the full 5x radius
        float alpha = (core * 0.45 + coreEdge * 0.35 + innerBloom * 0.2 + atmosphericDropoff * 0.75) * u_opacity;
        alpha = clamp(alpha, 0.0, 1.0);

        fragColor = vec4(color, alpha);
      }
    `;

    // 4. HDR Moon Fragment Shader: Clean Ethereal Lunar Disc with Full Moon Fix
    const fsMoonSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_radius;
      uniform vec3 u_color;
      uniform float u_intensity;
      uniform float u_opacity;
      uniform float u_moonPhase; // 0.0 (thin crescent) -> 0.5 (half moon) -> 1.0 (full moon)
      out vec4 fragColor;

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        vec2 diff = pixelCoord - u_center;
        float dist = length(diff);
        if (dist > u_radius * 2.0) {
          discard;
        }

        float normDist = dist / u_radius;

        // Moon disc base
        float disc = 1.0 - smoothstep(0.96, 1.0, normDist);

        // Crescent moon shadow cut-out:
        // At phase 1.0 (full moon), shadowOffset moves completely off the disc!
        // At phase 0.0 (thin crescent), shadowOffset is close, carving away most of the disc.
        float offsetDistance = u_radius * (0.35 + clamp(u_moonPhase, 0.0, 1.0) * 1.85);
        vec2 shadowOffset = vec2(offsetDistance, u_radius * 0.05);
        float shadowDist = length(pixelCoord - (u_center + shadowOffset)) / u_radius;
        float shadow = 1.0 - smoothstep(0.95, 1.02, shadowDist);
        float crescent = clamp(disc - shadow, 0.0, 1.0);

        // Soft ethereal ambient lunar glow
        float halo = 1.0 - smoothstep(0.9, 1.8, normDist);

        // Radiant Lunar Colors
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

    // Use RGBA16F for true HDR storage
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      width,
      height,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      null
    );

    const filter = this.extFloatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0
    );

    return { tex, fbo };
  }

  resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const newWidth = Math.max(Math.floor(rect.width * dpr), 300);
    const newHeight = Math.max(Math.floor(rect.height * dpr), 300);

    if (newWidth === this.canvasWidth && newHeight === this.canvasHeight) {
      return;
    }

    const oldWidth = this.canvasWidth;
    const oldHeight = this.canvasHeight;
    const oldFboTex = this.fboTexture;

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;
    this.canvas.width = newWidth;
    this.canvas.height = newHeight;

    if (!this.gl) return;
    const gl = this.gl;

    // Update hardware drawing buffer
    this.setupDrawingBufferStorage();

    // Create new HDR offscreen buffer
    const { tex, fbo } = this.createFramebufferTexture(newWidth, newHeight);

    // If we had old artwork, preserve and copy it across
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, newWidth, newHeight);

    if (oldFboTex && oldWidth > 0 && oldHeight > 0) {
      // Clear with background color then blit old content
      gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.progBlit);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, oldFboTex);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } else {
      // Clean start: dark canvas background
      gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    this.fboTexture = tex;
    this.fbo = fbo;

    // Render to display
    this.renderToScreen();
    this.pushUndoState();
  }

  clearCanvas() {
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
    if (!this.gl || !this.fboTexture) return;
    const gl = this.gl;

    // Copy current fboTexture to an undo texture
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
    // Clear redo stack on new operation
    this.clearRedoStack();
  }

  clearRedoStack() {
    const gl = this.gl;
    while (this.redoStack.length > 0) {
      const item = this.redoStack.pop();
      gl.deleteTexture(item.tex);
      gl.deleteFramebuffer(item.fbo);
    }
  }

  undo() {
    if (this.undoStack.length <= 1) return;
    const gl = this.gl;

    // Move current state to redo
    const current = this.undoStack.pop();
    this.redoStack.push(current);

    // Restore previous state
    const target = this.undoStack[this.undoStack.length - 1];
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
    const gl = this.gl;

    const item = this.redoStack.pop();
    this.undoStack.push(item);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, item.tex);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.renderToScreen();
  }

  beginStroke(x, y) {
    this.isDrawing = true;
    this.pushUndoState();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pt = { x: x * dpr, y: this.canvasHeight - (y * dpr) };
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
    if (!this.isDrawing) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pt = { x: x * dpr, y: this.canvasHeight - (y * dpr) };

    if (this.activeTool === 'sun' || this.activeTool === 'moon') {
      // Stamp tools place once on tap/drag
      return;
    }

    if (this.lastPoint) {
      // Interpolate between lastPoint and current point for seamless, smooth strokes
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
    const gl = this.gl;
    if (!gl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const radius = this.brushSize * dpr;

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
      this.backgroundColor[0],
      this.backgroundColor[1],
      this.backgroundColor[2]
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
    const gl = this.gl;
    if (!gl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const radius = this.brushSize * dpr;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progSun);
    gl.uniform2f(gl.getUniformLocation(this.progSun, 'u_center'), x, y);
    gl.uniform2f(gl.getUniformLocation(this.progSun, 'u_resolution'), this.canvasWidth, this.canvasHeight);
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_radius'), radius);
    gl.uniform3fv(gl.getUniformLocation(this.progSun, 'u_color'), this.brushColor);
    // Super-luminescent sun multiplier
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_intensity'), Math.max(this.hdrIntensity, 2.5));
    gl.uniform1f(gl.getUniformLocation(this.progSun, 'u_opacity'), this.brushOpacity);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  drawMoon(x, y) {
    const gl = this.gl;
    if (!gl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const radius = this.brushSize * 1.8 * dpr;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progMoon);
    gl.uniform2f(gl.getUniformLocation(this.progMoon, 'u_center'), x, y);
    gl.uniform2f(gl.getUniformLocation(this.progMoon, 'u_resolution'), this.canvasWidth, this.canvasHeight);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_radius'), radius);
    gl.uniform3fv(gl.getUniformLocation(this.progMoon, 'u_color'), this.brushColor);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_intensity'), Math.max(this.hdrIntensity, 1.8));
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_opacity'), this.brushOpacity);
    gl.uniform1f(gl.getUniformLocation(this.progMoon, 'u_moonPhase'), this.moonPhase);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  renderToScreen() {
    const gl = this.gl;
    if (!gl || !this.fboTexture) return;

    // Render directly to default swapchain buffer with adaptive photographic HDR display roll-off
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');

    gl.useProgram(this.progDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_texture'), 0);
    gl.uniform1f(gl.getUniformLocation(this.progDisplay, 'u_displayPeak'), this.displayHeadroom || 2.8);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_isHDR'), this.hdrInfo.highDynamicRange ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.progDisplay, 'u_isMobile'), isMobile ? 1 : 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Fallback 2D canvas initialization if WebGL2 is not supported
  init2DFallback() {
    const ctx = this.canvas.getContext('2d', {
      colorSpace: 'display-p3'
    });
    this.ctx2D = ctx;
    this.hdrInfo.mode = '2D Canvas (Display-P3 Fallback)';
  }

  // Injects an APP1 XMP metadata segment into a JPEG byte buffer
  injectApp1Segment(jpegBytes, payloadString, targetPos = null) {
    const enc = new TextEncoder();
    const payloadBytes = enc.encode(payloadString);
    const dataLen = payloadBytes.length;
    const segLen = 2 + dataLen;

    if (segLen > 65535) {
      console.warn('XMP metadata payload exceeds 64KB APP1 marker limit');
      return jpegBytes;
    }

    const app1 = new Uint8Array(2 + segLen);
    app1[0] = 0xFF;
    app1[1] = 0xE1;
    app1[2] = (segLen >> 8) & 0xFF;
    app1[3] = segLen & 0xFF;
    app1.set(payloadBytes, 4);

    let insertPos = (targetPos !== null) ? targetPos : 2;
    if (targetPos === null && jpegBytes[0] === 0xFF && jpegBytes[1] === 0xD8) {
      if (jpegBytes[2] === 0xFF && jpegBytes[3] === 0xE0) {
        const app0Len = (jpegBytes[4] << 8) | jpegBytes[5];
        insertPos = 4 + app0Len;
      }
    }

    const result = new Uint8Array(jpegBytes.length + app1.length);
    result.set(jpegBytes.subarray(0, insertPos), 0);
    result.set(app1, insertPos);
    result.set(jpegBytes.subarray(insertPos), insertPos + app1.length);
    return result;
  }

  // Generates an APP2 Multi-Picture Format (MPF) segment required by libultrahdr,
  // Google Photos, Samsung Gallery, and Chromium to link the base image and secondary gain map.
  generateMpfApp2(primarySize, app2Pos, secondarySize) {
    const secondaryOffset = primarySize - app2Pos - 8;
    const mpf = new Uint8Array(86);
    const view = new DataView(mpf.buffer);

    // 1. Signature 'MPF\0' (4 bytes)
    mpf[0] = 0x4D; mpf[1] = 0x50; mpf[2] = 0x46; mpf[3] = 0x00;

    // 2. TIFF Header: Big Endian 'MM\0*' (4 bytes)
    mpf[4] = 0x4D; mpf[5] = 0x4D; mpf[6] = 0x00; mpf[7] = 0x2A;

    // 3. Index IFD offset from start of TIFF header = 8 (4 bytes)
    view.setUint32(8, 8, false);

    // 4. Number of IFD tags = 3 (2 bytes)
    view.setUint16(12, 3, false);

    // 5. Tag 1: Version 0xB000, type 7 (UNDEFINED), count 4, value '0100' (12 bytes)
    view.setUint16(14, 0xB000, false);
    view.setUint16(16, 7, false);
    view.setUint32(18, 4, false);
    mpf[22] = 0x30; mpf[23] = 0x31; mpf[24] = 0x30; mpf[25] = 0x30; // '0100'

    // 6. Tag 2: Number of images 0xB001, type 4 (LONG), count 1, value 2 (12 bytes)
    view.setUint16(26, 0xB001, false);
    view.setUint16(28, 4, false);
    view.setUint32(30, 1, false);
    view.setUint32(34, 2, false); // 2 images

    // 7. Tag 3: MP Entry 0xB002, type 7 (UNDEFINED), count 32, offset 50 (12 bytes)
    view.setUint16(38, 0xB002, false);
    view.setUint16(40, 7, false);
    view.setUint32(42, 32, false); // 2 entries * 16 bytes
    view.setUint32(46, 50, false); // offset from TIFF header to MP entries

    // 8. Next IFD offset = 0 (4 bytes)
    view.setUint32(50, 0, false);

    // 9. MP Entry 1 (Primary Image):
    // Attributes: 0x030000 (primary image)
    view.setUint32(54, 0x030000, false);
    view.setUint32(58, primarySize, false);
    view.setUint32(62, 0, false); // offset = 0
    view.setUint16(66, 0, false);
    view.setUint16(68, 0, false);

    // 10. MP Entry 2 (Secondary Gain Map Image):
    // Attributes: 0x000000 (standard JPEG)
    view.setUint32(70, 0x000000, false);
    view.setUint32(74, secondarySize, false);
    view.setUint32(78, secondaryOffset, false);
    view.setUint16(82, 0, false);
    view.setUint16(84, 0, false);

    // Wrap in JPEG APP2 marker (0xFF, 0xE2, length_high, length_low)
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
   * Generates a fully compliant Ultra HDR JPEG Blob in memory.
   * Encodes 1:1 linear Float16 radiance into Base SDR + Gain Map with Adobe hdrgm & MPF metadata.
   */
  async generateUltraHDRBlob() {
    if (!this.gl || !this.fbo) {
      return null;
    }

    const gl = this.gl;
    const width = this.canvasWidth;
    const height = this.canvasHeight;

    // Read full floating point HDR pixel buffer from offscreen FBO
    const hdrPixels = new Float32Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    try {
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, hdrPixels);
    } catch (e) {
      console.warn('Float readPixels not supported on this platform:', e);
      return null;
    }

    // Allocate SDR base and Gain Map pixel buffers (flipped vertically from WebGL to 2D canvas coordinates)
    const sdrData = new Uint8ClampedArray(width * height * 4);
    const gainData = new Uint8ClampedArray(width * height * 4);

    // Detect scene peak dynamic range
    let maxHdr = 1.0;
    for (let i = 0; i < hdrPixels.length; i += 4) {
      if (hdrPixels[i] > maxHdr) maxHdr = hdrPixels[i];
      if (hdrPixels[i + 1] > maxHdr) maxHdr = hdrPixels[i + 1];
      if (hdrPixels[i + 2] > maxHdr) maxHdr = hdrPixels[i + 2];
    }

    // Max-RGB Proportional Tone Mapping with Smooth Photographic Highlight Shoulder:
    // 1. Shadows and midtones up to 0.65 are 100% uncompressed linear (SDR = HDR), guaranteeing
    //    pristine preservation of soft brush edge falloffs, stamp disc textures, and dark contrast.
    // 2. Highlights (peak > 0.65) smoothly compress towards 0.985 with a strictly monotonic C1 curve,
    //    guaranteeing distinct, non-clipped luminance steps between 1.0x SDR, 2.2x Glow, 3.5x Solar, and 5.0x Peak.
    // 3. Proportional channel scaling (k = s / peak) preserves 100% of exact color chromaticity and hue ratios
    //    (R:G:B) across all tools, glows, and soft edges without any bleaching or hue shifts.
    const start = 0.65;
    const headroom = 1.0 - start;
    const D = Math.max(1.8, (maxHdr - start) * 0.45);

    function tonePeak(peak) {
      if (peak <= start) return peak;
      return start + headroom * 0.985 * (1.0 - Math.exp(-(peak - start) / D));
    }

    let maxLogGain = 0.0;
    const logGains = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
      const srcRow = y * width * 4;
      const dstRow = (height - 1 - y) * width * 4;
      const pixelRowOffset = (height - 1 - y) * width;

      for (let x = 0; x < width; x++) {
        const srcIdx = srcRow + x * 4;
        const dstIdx = dstRow + x * 4;
        const pIdx = pixelRowOffset + x;

        const rHdr = Math.max(0, hdrPixels[srcIdx]);
        const gHdr = Math.max(0, hdrPixels[srcIdx + 1]);
        const bHdr = Math.max(0, hdrPixels[srcIdx + 2]);

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

        sdrData[dstIdx] = Math.round(rSdr * 255);
        sdrData[dstIdx + 1] = Math.round(gSdr * 255);
        sdrData[dstIdx + 2] = Math.round(bSdr * 255);
        sdrData[dstIdx + 3] = 255;

        // Exact gain required to restore original floating point HDR radiance from tone-mapped base
        const ratio = (peak + 0.015625) / (s + 0.015625);
        const logG = Math.max(0.0, Math.log2(ratio));
        logGains[pIdx] = logG;

        if (logG > maxLogGain) {
          maxLogGain = logG;
        }
      }
    }

    // Determine GainMapMax headroom (minimum 1.5, capped between 1.5 and 4.0 = up to 16x headroom)
    const gainMapMax = Math.max(1.5, Math.min(4.0, Math.ceil(maxLogGain * 10) / 10 || 3.0));

    // Populate Gain Map grayscale buffer normalized to [0, 255]
    for (let i = 0; i < width * height; i++) {
      const normGain = Math.max(0.0, Math.min(1.0, logGains[i] / gainMapMax));
      const val = Math.round(normGain * 255);
      const dstIdx = i * 4;
      gainData[dstIdx] = val;
      gainData[dstIdx + 1] = val;
      gainData[dstIdx + 2] = val;
      gainData[dstIdx + 3] = 255;
    }

    // Render SDR base to offscreen canvas
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

    // Render Gain Map to offscreen canvas
    const gainCanvas = document.createElement('canvas');
    gainCanvas.width = width;
    gainCanvas.height = height;
    const gainCtx = gainCanvas.getContext('2d');
    const gainImgData = new ImageData(gainData, width, height);
    gainCtx.putImageData(gainImgData, 0, 0);

    // Encode both renditions into JPEG ArrayBuffers (high quality to prevent edge blur & quantization)
    const [sdrBlob, gainBlob] = await Promise.all([
      new Promise(res => sdrCanvas.toBlob(res, 'image/jpeg', 0.98)),
      new Promise(res => gainCanvas.toBlob(res, 'image/jpeg', 0.92))
    ]);

    if (!sdrBlob || !gainBlob) {
      console.warn('Canvas JPEG encoding failed');
      return null;
    }

    let sdrBytes = new Uint8Array(await sdrBlob.arrayBuffer());
    let gainBytes = new Uint8Array(await gainBlob.arrayBuffer());

    // Calibrate HDRCapacityMax: mobile displays (like Samsung S23 Ultra) typically have ~1.2 headroom (2.3x)
    // If HDRCapacityMax is set too high (e.g. 2.4 - 3.0), the mobile viewer scales down the gain weight
    // to weight = DisplayCapacity / HDRCapacityMax (~40%), which makes the HDR highlights look weak or flat.
    // By calibrating hdrCapacityMax to Math.min(1.2, gainMapMax), mobile devices apply 100% gain map boost!
    const hdrCapacityMax = Math.min(1.2, gainMapMax);

    // 1. Build and inject Secondary XMP Metadata for Gain Map image
    const secondaryXmp = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0.000000" hdrgm:GainMapMax="${gainMapMax.toFixed(6)}" hdrgm:Gamma="1.000000" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0.000000" hdrgm:HDRCapacityMax="${hdrCapacityMax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>`;
    gainBytes = this.injectApp1Segment(gainBytes, secondaryXmp);
    const finalGainLength = gainBytes.length;

    // 2. Build and inject Primary XMP Metadata with GContainer directory and complete gain map parameters
    const primaryXmp = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0.000000" hdrgm:GainMapMax="${gainMapMax.toFixed(6)}" hdrgm:Gamma="1.000000" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0.000000" hdrgm:HDRCapacityMax="${hdrCapacityMax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${finalGainLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;

    let sdrApp1Pos = 2;
    if (sdrBytes[0] === 0xFF && sdrBytes[1] === 0xD8) {
      if (sdrBytes[2] === 0xFF && sdrBytes[3] === 0xE0) {
        const app0Len = (sdrBytes[4] << 8) | sdrBytes[5];
        sdrApp1Pos = 4 + app0Len;
      }
    }
    sdrBytes = this.injectApp1Segment(sdrBytes, primaryXmp, sdrApp1Pos);

    // 3. Build and inject MPF APP2 segment immediately following APP1
    const app1PayloadBytes = new TextEncoder().encode(primaryXmp);
    const app1SegLen = 2 + 2 + app1PayloadBytes.length;
    const app2Pos = sdrApp1Pos + app1SegLen;

    const finalPrimarySize = sdrBytes.length + 90;
    const app2 = this.generateMpfApp2(finalPrimarySize, app2Pos, finalGainLength);

    const finalSdrBytes = new Uint8Array(finalPrimarySize);
    finalSdrBytes.set(sdrBytes.subarray(0, app2Pos), 0);
    finalSdrBytes.set(app2, app2Pos);
    finalSdrBytes.set(sdrBytes.subarray(app2Pos), app2Pos + app2.length);

    // 4. Concatenate Primary SDR JPEG and Secondary Gain Map JPEG
    const ultraHdrBytes = new Uint8Array(finalPrimarySize + finalGainLength);
    ultraHdrBytes.set(finalSdrBytes, 0);
    ultraHdrBytes.set(gainBytes, finalPrimarySize);

    return new Blob([ultraHdrBytes], { type: 'image/jpeg' });
  }

  /**
   * Export the artwork as an Ultra HDR JPEG (.jpg).
   */
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
    // Generate high resolution PNG download
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }
}

global.HDREngine = HDREngine;
})(typeof window !== 'undefined' ? window : globalThis);
