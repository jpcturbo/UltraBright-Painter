/**
 * HDR Paint Engine
 * Powered by WebGL 2 with Float16 Backing Storage and Display-P3 Extended Range.
 * Falls back gracefully to standard Canvas2D if WebGL2 is unavailable.
 */

export class HDREngine {
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
    // 1. Check screen dynamic-range media queries
    const hdrQuery = window.matchMedia('(dynamic-range: high)');
    const p3Query = window.matchMedia('(color-gamut: p3)');
    this.hdrInfo.highDynamicRange = hdrQuery.matches;
    this.hdrInfo.displayP3 = p3Query.matches;

    // 2. Configure canvas HDR if supported by browser (Chrome 122+)
    if (typeof this.canvas.configureHighDynamicRange === 'function') {
      try {
        this.canvas.configureHighDynamicRange({ mode: 'extended' });
        this.hdrInfo.float16Buffer = true;
      } catch (err) {
        console.warn('configureHighDynamicRange error:', err);
      }
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

    // 1. Display/Composite Fragment Shader (renders offscreen HDR texture to default framebuffer)
    const fsBlitSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      out vec4 fragColor;
      void main() {
        fragColor = texture(u_texture, v_uv);
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
        float edgeAlpha = 1.0 - smoothstep(inner, u_radius, dist);
        float alpha = edgeAlpha * u_opacity;

        if (u_isEraser == 1) {
          // Erase back to exact canvas background color
          fragColor = vec4(u_bgColor, alpha);
        } else {
          // Output high-dynamic-range photon emission
          vec3 hdrRGB = u_color * u_intensity;
          fragColor = vec4(hdrRGB, alpha);
        }
      }
    `;

    // 3. HDR Sun Fragment Shader: Glowing Orb with Asymmetric Corona Flares
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
        if (dist > u_radius * 2.8) {
          discard;
        }

        float normDist = dist / u_radius;
        float angle = atan(diff.y, diff.x);

        // Continuous Volumetric Bloom / Inverse Falloff for radiant orb
        float orbGlow = pow(max(0.0, 1.0 - normDist * 0.38), 2.8);

        // Blinding Incandescent Core (pure over-bright white > 4.0x)
        float coreRadius = 0.40;
        float core = 1.0 - smoothstep(0.0, coreRadius, normDist);
        float coreDisc = 1.0 - smoothstep(coreRadius * 0.8, 1.0, normDist);

        // Organic Asymmetric Solar Flares & Corona Rays
        // Combine prime/irregular frequencies with distinct directional spikes
        float r1 = sin(angle * 3.0 + 0.6) * 0.5 + 0.5;
        float r2 = sin(angle * 7.0 - 1.2) * 0.5 + 0.5;
        float r3 = sin(angle * 11.0 + 2.1) * 0.5 + 0.5;
        float r4 = cos(angle * 5.0 - 0.4) * 0.5 + 0.5;
        float wisp = (r1 * 0.35 + r2 * 0.28 + r3 * 0.22 + r4 * 0.15);

        // Prominent Asymmetric Flare Spikes (different intensities and angles)
        float spike1 = pow(max(0.0, cos(angle - 0.65)), 12.0) * 1.4; // NE spike
        float spike2 = pow(max(0.0, cos(angle + 2.10)), 14.0) * 1.1; // SW spike
        float spike3 = pow(max(0.0, cos(angle - 2.50)), 18.0) * 0.9; // NW spike
        float spike4 = pow(max(0.0, cos(angle + 0.85)), 16.0) * 0.8; // SE spike

        float totalSpikes = (spike1 + spike2 + spike3 + spike4);
        float rayFalloff = smoothstep(2.6, 0.45, normDist);
        float rays = (wisp * 0.65 + totalSpikes * 0.75) * rayFalloff;

        // Radiant Colors
        vec3 incandescentWhite = vec3(1.0, 0.99, 0.94) * (u_intensity * 2.2);
        vec3 solarGold = u_color * (u_intensity * 1.4);
        vec3 fieryAmber = mix(solarGold, vec3(1.0, 0.28, 0.04) * u_intensity, 0.65);
        vec3 outerHalo = mix(fieryAmber, vec3(1.0, 0.45, 0.1) * u_intensity, 0.5);

        // Color blending across layers
        vec3 color = mix(outerHalo, fieryAmber, normDist < 1.6 ? 0.6 : 0.2);
        color = mix(color, solarGold, coreDisc);
        color = mix(color, incandescentWhite, core * 0.92);

        // Corona addition
        color += fieryAmber * (rays * 0.8);

        float alpha = clamp(coreDisc * 0.95 + orbGlow * 0.65 + rays * 0.45, 0.0, 1.0) * u_opacity;
        fragColor = vec4(color, alpha);
      }
    `;

    // 4. HDR Moon Fragment Shader: Accurate Astronomical Phase & Glowing Lunar Orb
    const fsMoonSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_radius;
      uniform vec3 u_color;
      uniform float u_intensity;
      uniform float u_opacity;
      uniform float u_moonPhase; // 0.0 (razor crescent) -> 0.5 (half moon) -> 1.0 (full moon)
      out vec4 fragColor;

      void main() {
        vec2 pixelCoord = v_uv * u_resolution;
        vec2 p = (pixelCoord - u_center) / u_radius;
        float dist = length(p);
        if (dist > 2.0) {
          discard;
        }

        // Base disc mask
        float disc = 1.0 - smoothstep(0.97, 1.0, dist);

        // Astronomical lunar terminator formula
        // At any height p.y, the disc width is W = sqrt(max(0.0, 1.0 - p.y * p.y))
        float W = sqrt(max(0.0, 1.0 - p.y * p.y));
        // k ranges from -1.0 (phase 0) to 0.0 (phase 0.5) to +1.0 (phase 1.0)
        float k = 2.0 * clamp(u_moonPhase, 0.0, 1.0) - 1.0;
        // Terminator position xT = -k * W
        float xT = -k * W;
        // Illumination from the right side (p.x > xT)
        float lit = smoothstep(-0.03, 0.03, p.x - xT);
        float moonBody = disc * lit;

        // Atmospheric/celestial outer glow
        float glow = pow(max(0.0, 1.0 - dist / 1.9), 3.0) * (0.35 + 0.45 * u_moonPhase);

        // Procedural lunar surface texture / subtle crater mottling
        float crater1 = sin(p.x * 9.0 + sin(p.y * 7.0)) * 0.06;
        float crater2 = cos(p.x * 16.0 - p.y * 14.0) * 0.04;
        float textureNoise = 1.0 - (crater1 + crater2);

        // Radiant Lunar Colors
        vec3 moonCore = vec3(0.95, 0.98, 1.0) * (u_intensity * 1.6);
        vec3 moonColor = mix(u_color, vec3(0.75, 0.88, 1.0), 0.5) * u_intensity;
        vec3 col = mix(moonColor, moonCore, 0.5) * textureNoise;

        // Outer halo
        vec3 haloColor = mix(moonColor, vec3(0.5, 0.75, 1.0) * u_intensity, 0.6);

        vec3 finalRGB = col * moonBody + haloColor * glow;
        float finalAlpha = clamp(moonBody * 0.98 + glow * 0.6, 0.0, 1.0) * u_opacity;

        fragColor = vec4(finalRGB, finalAlpha);
      }
    `;

    this.progBlit = this.createProgram(vsSource, fsBlitSource);
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
    const radius = this.brushSize * 2.0 * dpr;

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

    // Render directly to default swapchain buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
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

  exportImage(filename = 'hdr-paint.png') {
    // Generate high resolution PNG download
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }
}
