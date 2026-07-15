/* 3D visualisation of a job - the sales tool.
   Built from the survey measurements when they exist, standard sizes when they
   don't, and everything is adjustable live from the "Adjust the design" panel.
   To scale. Works on desktop, phone, and Meta Quest (VR/AR via the Quest
   browser over the https address - see the README). */

(function () {
  const params = new URLSearchParams(location.search);
  const jobId = params.get('job');
  const errEl = document.getElementById('err');

  function fail(msg) { errEl.style.display = 'flex'; errEl.textContent = msg; }
  if (!jobId) return fail('No job given. Open this page from a job\'s "3D view" button.');
  if (!window.THREE) return fail('The 3D library failed to load.');

  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  fetch('/api/jobs/' + jobId)
    .then(r => { if (!r.ok) throw new Error('Job not found'); return r.json(); })
    .then(init)
    .catch(e => fail(e.message));

  // ---------- procedural textures (no image files needed) ----------
  function canvasTex(size, draw, repeatX, repeatY) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX || 1, repeatY || 1);
    return t;
  }
  function noise(ctx, size, base, spread, count) {
    ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < count; i++) {
      const v = (Math.random() - 0.5) * spread;
      ctx.fillStyle = 'rgba(' + [v > 0 ? 255 : 0, v > 0 ? 255 : 0, v > 0 ? 255 : 0].join(',') + ',' + Math.abs(v) + ')';
      ctx.fillRect(Math.random() * size, Math.random() * size, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }
  }
  const lawnTex = canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#5f9346'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2200; i++) {
      ctx.fillStyle = ['#557f3d', '#69a04e', '#4f7a38', '#74aa57'][Math.floor(Math.random() * 4)];
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 3 + Math.random() * 3);
    }
  }, 14, 14);
  const timberTex = canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#7d6248'; ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 32) {
      ctx.fillStyle = ['#75593f', '#84684d', '#6d5238'][Math.floor(x / 32) % 3];
      ctx.fillRect(x, 0, 30, s);
      ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(x + 30, 0, 2, s);
    }
    for (let i = 0; i < 250; i++) {
      ctx.fillStyle = 'rgba(60,40,20,.12)';
      ctx.fillRect(Math.random() * s, Math.random() * s, 1, 6 + Math.random() * 16);
    }
  }, 4, 1);
  const deckTex = canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#96683c'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 24) {
      ctx.fillStyle = ['#8d6138', '#a06f40', '#855a32'][Math.floor(y / 24) % 3];
      ctx.fillRect(0, y, s, 22);
      ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, y + 22, s, 2);
    }
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = 'rgba(70,45,20,.10)';
      ctx.fillRect(Math.random() * s, Math.random() * s, 8 + Math.random() * 18, 1);
    }
  }, 2, 2);
  const concreteTex = canvasTex(256, (ctx, s) => noise(ctx, s, '#c7c4bb', 0.16, 1600), 3, 3);
  const paverTex = canvasTex(256, (ctx, s) => {
    noise(ctx, s, '#b8b2a6', 0.14, 1200);
    ctx.strokeStyle = 'rgba(80,75,65,.5)'; ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, s - 4, s - 4);
  }, 1, 1);

  function init(job) {
    const s = job.survey || {};
    const m = s.measurements || {};
    document.getElementById('title').textContent = (job.title || '3D view') + ' - to scale';

    // ---------- state: survey values first, sensible defaults otherwise ----------
    const spa = m.spa || {}, slab = m.slab || {}, deckM = m.decking || {};
    const dists = m.distances || [];
    const distTo = kw => { const d = dists.find(x => kw.some(k => (x.label || '').toLowerCase().includes(k))); return d ? num(d.metres) : 0; };
    const state = {
      spaL: num(spa.lengthM) || 2.3, spaW: num(spa.widthM) || 2.3, spaH: num(spa.depthM) || 0.95,
      sitting: /semi/i.test(job.installType || '') ? 'semi'
        : (!job.installType || /in-?ground|inground|plunge/i.test(job.installType)) ? 'in' : 'above',
      // blank unless actually measured - the drawing suggests a slab size but
      // Save never writes numbers you didn't enter
      slabL: num(slab.lengthM) || '', slabW: num(slab.widthM) || '',
      deckL: num(deckM.lengthM), deckW: num(deckM.widthM),
      deckPlace: deckM.placement || 'front',
      walls: (m.retainingWalls || []).filter(w => num(w.lengthM) && num(w.heightM)),
      dRear: distTo(['rear']) || 2.5, dLeft: distTo(['left', 'side boundary']) || 3,
      dRight: distTo(['right']) || 6, dHouse: distTo(['house']) || 5,
      landscape: true, furniture: true, stones: true, photoTop: true,
      hasSurvey: !!job.survey
    };

    // ---------- three.js scaffolding ----------
    const scene = new THREE.Scene();
    const SKY = 0xcfe6f0;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 45, 95);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.xr.enabled = true;
    document.getElementById('canvas-wrap').appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x4a6b3a, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.0);
    sun.position.set(9, 15, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -16; sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16; sun.shadow.camera.bottom = -16;
    scene.add(sun);

    // Bird's-eye product photo from the catalogue: once loaded, it becomes the
    // top of the 3D spa instead of the plain water sheet. The spa is found
    // inside the photo (product shots have plain backgrounds) so only the
    // shell itself is shown - no background, no stretching.
    let spaTopTex = null;
    let spaTopBox = { u0: 0, u1: 1, v0: 0, v1: 1, iw: 1, ih: 1 };
    if (s.spaModel && s.spaModel.image) {
      new THREE.TextureLoader().load('/catalogue-images/' + s.spaModel.image, t => {
        const iw = t.image.width, ih = t.image.height;
        spaTopBox = { u0: 0, u1: 1, v0: 0, v1: 1, iw, ih };
        try {
          // magic-wand from the photo edges: grow the background inward,
          // pixel by pixel, so gradients and two-tone backdrops all peel away
          const cw = 220, ch = Math.max(4, Math.round(220 * ih / iw));
          const c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          const ctx = c.getContext('2d');
          ctx.drawImage(t.image, 0, 0, cw, ch);
          const px = ctx.getImageData(0, 0, cw, ch).data;
          const bg = new Uint8Array(cw * ch);
          const queue = [];
          for (let x = 0; x < cw; x++) { queue.push(x, (ch - 1) * cw + x); }
          for (let y = 0; y < ch; y++) { queue.push(y * cw, y * cw + cw - 1); }
          queue.forEach(i => { bg[i] = 1; });
          const near = (a, b) =>
            Math.abs(px[a * 4] - px[b * 4]) + Math.abs(px[a * 4 + 1] - px[b * 4 + 1]) + Math.abs(px[a * 4 + 2] - px[b * 4 + 2]) < 48;
          while (queue.length) {
            const i = queue.pop();
            const x = i % cw, y = (i / cw) | 0;
            for (const nb of [i - 1, i + 1, i - cw, i + cw]) {
              if (nb < 0 || nb >= cw * ch || bg[nb]) continue;
              if ((nb === i - 1 && x === 0) || (nb === i + 1 && x === cw - 1)) continue;
              if (near(i, nb)) { bg[nb] = 1; queue.push(nb); }
            }
          }
          // bounding box of what's left: the spa itself
          let x0 = cw, x1 = 0, y0 = ch, y1 = 0, kept = 0;
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
              if (!bg[y * cw + x]) {
                kept++;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
            }
          }
          if (kept > cw * ch * 0.08 && x1 > x0 + 10 && y1 > y0 + 10) {
            // cut the background out of the full-size photo using the mask
            const outW = Math.min(iw, 1024), outH = Math.round(outW * ih / iw);
            const out = document.createElement('canvas');
            out.width = outW; out.height = outH;
            const octx = out.getContext('2d');
            octx.drawImage(t.image, 0, 0, outW, outH);
            const maskC = document.createElement('canvas');
            maskC.width = cw; maskC.height = ch;
            const mctx = maskC.getContext('2d');
            const mdata = mctx.createImageData(cw, ch);
            for (let i = 0; i < cw * ch; i++) { mdata.data[i * 4 + 3] = bg[i] ? 0 : 255; }
            mctx.putImageData(mdata, 0, 0);
            octx.globalCompositeOperation = 'destination-in';
            octx.imageSmoothingEnabled = true;
            octx.drawImage(maskC, 0, 0, outW, outH);
            const cut = new THREE.CanvasTexture(out);
            cut.encoding = THREE.sRGBEncoding;
            cut.wrapS = cut.wrapT = THREE.ClampToEdgeWrapping;
            spaTopTex = cut;
            spaTopBox = { u0: x0 / cw, u1: (x1 + 1) / cw, v0: 1 - (y1 + 1) / ch, v1: 1 - y0 / ch, iw, ih };
            rebuild();
            return;
          }
        } catch (e) { /* fall through to the plain photo */ }
        t.encoding = THREE.sRGBEncoding;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        spaTopTex = t;
        rebuild();
      });
    }
    // Photo on the spa top at TRUE scale: long side along the spa's long side,
    // aspect ratio preserved (crops rather than stretches).
    function spaTopPlane(fx, fz, y) {
      const b = spaTopBox;
      const bw = b.u1 - b.u0, bh = b.v1 - b.v0;
      const photoAspect = (bw * b.iw) / (bh * b.ih);
      const swap = (photoAspect >= 1) !== (fx >= fz);
      const pw = swap ? fz : fx, ph = swap ? fx : fz;
      const planeAspect = pw / ph;
      const t = spaTopTex;
      t.center.set(0.5, 0.5);
      t.rotation = 0;
      let ru = bw, rv = bh;
      if (photoAspect > planeAspect) ru = bw * planeAspect / photoAspect;
      else rv = bh * photoAspect / planeAspect;
      t.repeat.set(ru, rv);
      t.offset.set(b.u0 + (bw - ru) / 2, b.v0 + (bh - rv) / 2);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pw, ph),
        new THREE.MeshBasicMaterial({ map: t, transparent: true }));
      mesh.rotateX(-Math.PI / 2);
      if (swap) mesh.rotateZ(Math.PI / 2);
      mesh.position.set(0, y, 0);
      return mesh;
    }

    // Real decking boards (Innowood / Millboard photos) as the deck surface.
    let deckLib = [], deckBoard = null;
    const boardTexCache = {};
    // Planks drawn in the board's true colour (sampled from the product photo).
    // Tiling the marketing photo directly looks like wallpaper; this looks like decking.
    function boardTex(image) {
      if (boardTexCache[image]) return boardTexCache[image];
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const tex = new THREE.CanvasTexture(canvas);
      tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      boardTexCache[image] = tex;
      const img = new Image();
      img.onload = () => {
        const s = document.createElement('canvas');
        s.width = s.height = 24;
        const sc = s.getContext('2d');
        sc.drawImage(img, 0, 0, 24, 24);
        const px = sc.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 128 && (px[i] + px[i + 1] + px[i + 2]) > 60) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
        }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        const shade = f => 'rgb(' + Math.min(255, Math.round(r * f)) + ',' + Math.min(255, Math.round(g * f)) + ',' + Math.min(255, Math.round(b * f)) + ')';
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = shade(1);
        ctx.fillRect(0, 0, 256, 256);
        for (let y = 0; y < 256; y += 24) {
          ctx.fillStyle = [shade(0.9), shade(1.08), shade(0.82)][Math.floor(y / 24) % 3];
          ctx.fillRect(0, y, 256, 22);
          ctx.fillStyle = 'rgba(0,0,0,.3)';
          ctx.fillRect(0, y + 22, 256, 2);
        }
        for (let i = 0; i < 300; i++) {
          ctx.fillStyle = 'rgba(0,0,0,.07)';
          ctx.fillRect(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 18, 1);
        }
        tex.needsUpdate = true;
        rebuild();
      };
      img.src = '/decking-images/' + image;
      return tex;
    }
    fetch('/api/decking').then(r => r.json()).then(lib => {
      deckLib = lib.filter(b => b.image);
      const sel = document.getElementById('p-deckBoard');
      const groups = {};
      for (const b of deckLib) {
        const g = b.brand + (b.range ? ' - ' + b.range : '');
        (groups[g] = groups[g] || []).push(b);
      }
      for (const g of Object.keys(groups)) {
        const og = document.createElement('optgroup');
        og.label = g;
        for (const b of groups[g]) {
          const o = document.createElement('option');
          o.value = b.id;
          o.textContent = b.name.replace(/^\d+x\d+mm\s*/i, '').replace(/\s*(Millboard|Innowood).*$/i, '');
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      // preselect whatever board the survey already names
      const surveyBrand = ((m.decking || {}).brand || '').toLowerCase();
      if (surveyBrand) {
        const match = deckLib.find(b => surveyBrand.includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(surveyBrand));
        if (match) { deckBoard = match; sel.value = match.id; rebuild(); }
      }
      sel.onchange = () => {
        deckBoard = deckLib.find(b => b.id === sel.value) || null;
        rebuild();
      };
    }).catch(() => {});

    const build = new THREE.Group();  // what the customer is buying (shown in AR)
    const yard = new THREE.Group();   // context: lawn, fences, house, landscaping
    const scanGroup = new THREE.Group(); // the customer's real yard, 3D-scanned
    scanGroup.visible = false;
    scene.add(build); scene.add(yard); scene.add(scanGroup);

    const stdMat = opts => new THREE.MeshStandardMaterial(opts);
    function box(l, h, w, material, x, y, z, noShadow) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), material);
      b.position.set(x, y, z);
      if (!noShadow) { b.castShadow = true; b.receiveShadow = true; }
      return b;
    }
    function roundedRect(w, d, r) {
      const sh = new THREE.Shape();
      const x = -w / 2, y = -d / 2;
      sh.moveTo(x + r, y);
      sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r);
      sh.lineTo(x + w, y + d - r); sh.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
      sh.lineTo(x + r, y + d); sh.quadraticCurveTo(x, y + d, x, y + d - r);
      sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y);
      return sh;
    }
    // Extrudes a flat shape upwards: the result occupies y .. y + height.
    function extrude(shape, height, material, x, y, z) {
      const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(g, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      return mesh;
    }
    function shrub(x, z, scale, color) {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.25 * scale * (0.8 + Math.random() * 0.4), 8, 8),
          stdMat({ color: color || 0x3e6b2f, roughness: 1 }));
        b.position.set((Math.random() - 0.5) * 0.3 * scale, 0.2 * scale + Math.random() * 0.15 * scale, (Math.random() - 0.5) * 0.3 * scale);
        b.castShadow = true;
        g.add(b);
      }
      g.position.set(x, 0, z);
      return g;
    }
    function tree(x, z, height) {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, height * 0.45, 8),
        stdMat({ color: 0x6b4f33, roughness: 1 }));
      trunk.position.y = height * 0.225; trunk.castShadow = true;
      g.add(trunk);
      for (let i = 0; i < 3; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(height * (0.22 - i * 0.03), 9, 9),
          stdMat({ color: [0x477a35, 0x528a3e, 0x3d6b2c][i], roughness: 1 }));
        f.position.set((Math.random() - 0.5) * 0.3, height * (0.5 + i * 0.16), (Math.random() - 0.5) * 0.3);
        f.castShadow = true;
        g.add(f);
      }
      g.position.set(x, 0, z);
      return g;
    }

    // ---------- scene builder (re-run whenever the panel changes something) ----------
    function rebuild() {
      while (build.children.length) build.remove(build.children[0]);
      while (yard.children.length) yard.remove(yard.children[0]);

      const st = state;
      // slab drawn at measured size, or a suggested spa+600mm if not measured
      const slabL = st.slabL || st.spaL + 0.6;
      const slabW = st.slabW || st.spaW + 0.6;
      const zRear = -(st.dRear + st.spaW / 2);
      const xLeft = -(st.dLeft + st.spaL / 2);
      const xRight = (st.dRight + st.spaL / 2);
      const zHouse = st.dHouse + st.spaW / 2;
      const yardHalfZ = Math.max(st.dRear + st.spaW / 2 + 2, zHouse + 3, 8);

      // lawn
      const lawn = new THREE.Mesh(new THREE.PlaneGeometry((xRight - xLeft) + 12, yardHalfZ * 2 + 8),
        stdMat({ map: lawnTex, roughness: 1 }));
      lawn.rotation.x = -Math.PI / 2;
      lawn.receiveShadow = true;
      yard.add(lawn);

      // fences
      const fenceMat = stdMat({ map: timberTex, roughness: 0.95 });
      const fenceH = 1.8;
      yard.add(box(xRight - xLeft, fenceH, 0.06, fenceMat, (xLeft + xRight) / 2, fenceH / 2, zRear));
      yard.add(box(0.06, fenceH, yardHalfZ * 2, fenceMat, xLeft, fenceH / 2, zRear + yardHalfZ));
      yard.add(box(0.06, fenceH, yardHalfZ * 2, fenceMat, xRight, fenceH / 2, zRear + yardHalfZ));
      // fence capping
      const capMat = stdMat({ color: 0x6b5238, roughness: 0.9 });
      yard.add(box(xRight - xLeft, 0.05, 0.1, capMat, (xLeft + xRight) / 2, fenceH + 0.025, zRear));
      yard.add(box(0.1, 0.05, yardHalfZ * 2, capMat, xLeft, fenceH + 0.025, zRear + yardHalfZ));
      yard.add(box(0.1, 0.05, yardHalfZ * 2, capMat, xRight, fenceH + 0.025, zRear + yardHalfZ));

      // house wall with window + sliding door
      const wallW = Math.min(xRight - xLeft, 14);
      yard.add(box(wallW, 2.7, 0.25, stdMat({ color: 0xe9e2d2, roughness: 0.9 }), 0, 1.35, zHouse));
      yard.add(box(wallW, 0.12, 0.35, stdMat({ color: 0xb9b2a4, roughness: 0.9 }), 0, 2.76, zHouse));
      yard.add(box(2.2, 1.2, 0.06, stdMat({ color: 0x9ec7d8, roughness: 0.15, metalness: 0.3 }), -wallW / 4, 1.5, zHouse - 0.13));
      yard.add(box(2.0, 2.15, 0.06, stdMat({ color: 0xa9cede, roughness: 0.15, metalness: 0.3 }), wallW / 5, 1.07, zHouse - 0.13));
      yard.add(box(2.1, 0.06, 0.1, capMat, wallW / 5, 2.18, zHouse - 0.16));

      // person for scale
      const person = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 1.45, 12), stdMat({ color: 0x33607a, roughness: 0.9 }));
      body.position.y = 0.75; body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), stdMat({ color: 0xd8b094, roughness: 0.8 }));
      head.position.y = 1.62; head.castShadow = true;
      person.add(body); person.add(head);
      person.position.set(xLeft + 1.4, 0, zHouse - 2);
      yard.add(person);

      // ---- the build ----
      const copingMat = stdMat({ map: paverTex, roughness: 0.85 });
      const shellMat = stdMat({ color: 0xdfe3e6, roughness: 0.35 });
      const cabinetMat = stdMat({ map: deckTex, color: 0x9a9a94, roughness: 0.85 });
      const waterMat = stdMat({ color: 0x2fa8d5, roughness: 0.08, metalness: 0.05, transparent: true, opacity: 0.88 });
      // slab drawn only when a slab was actually measured - the spa stands alone otherwise
      const slabDrawn = !!(st.slabL && st.slabW);
      if (slabDrawn) {
        const slabMesh = new THREE.Mesh(new THREE.BoxGeometry(slabL, 0.1, slabW), stdMat({ map: concreteTex, roughness: 0.95 }));
        slabMesh.position.set(0, 0.05, 0);
        slabMesh.castShadow = true; slabMesh.receiveShadow = true;
        build.add(slabMesh);
      }
      const base = slabDrawn ? 0.1 : 0;

      if (st.sitting === 'in') {
        // just the spa: thin acrylic lip flush with the ground, water/photo inside
        const lip = roundedRect(st.spaL + 0.06, st.spaW + 0.06, 0.18);
        lip.holes.push(roundedRect(st.spaL - 0.08, st.spaW - 0.08, 0.15));
        build.add(extrude(lip, 0.035, shellMat, 0, base, 0));
        build.add(extrude(roundedRect(st.spaL - 0.06, st.spaW - 0.06, 0.15), 0.02, waterMat, 0, base + 0.015, 0));
        if (spaTopTex && st.photoTop) build.add(spaTopPlane(st.spaL - 0.06, st.spaW - 0.06, base + 0.041));
        // pale shell visible through the water edges
        const innerShell = new THREE.Mesh(new THREE.BoxGeometry(st.spaL - 0.1, 0.5, st.spaW - 0.1), shellMat);
        innerShell.position.set(0, base - 0.26, 0);
        build.add(innerShell);
      } else {
        // above ground shows the full cabinet; semi in-ground shows the top
        // 500-600mm with the rest sunk into the yard
        const exposedH = st.sitting === 'semi' ? Math.min(0.6, st.spaH * 0.55) : st.spaH;
        build.add(extrude(roundedRect(st.spaL, st.spaW, 0.18), exposedH, cabinetMat, 0, base, 0));
        build.add(extrude(roundedRect(st.spaL + 0.1, st.spaW + 0.1, 0.2), 0.09, shellMat, 0, base + exposedH, 0));
        build.add(extrude(roundedRect(st.spaL - 0.28, st.spaW - 0.28, 0.14), 0.02, waterMat, 0, base + exposedH + 0.055, 0));
        if (spaTopTex && st.photoTop) build.add(spaTopPlane(st.spaL - 0.08, st.spaW - 0.08, base + exposedH + 0.092));
        // steps: two for a full-height cabinet, one for semi in-ground
        build.add(box(0.8, 0.18, 0.35, stdMat({ map: deckTex, roughness: 0.9 }), 0, base + 0.09, st.spaW / 2 + 0.25));
        if (st.sitting !== 'semi') {
          build.add(box(0.8, 0.18, 0.35, stdMat({ map: deckTex, roughness: 0.9 }), 0, base + 0.27, st.spaW / 2 + 0.08));
        }
      }

      // decking - in front, beside, behind, or wrapped all around the spa
      if (st.deckL && st.deckW) {
        let deckSurface = deckTex;
        if (deckBoard && deckBoard.image) {
          deckSurface = boardTex(deckBoard.image);
          // tile the board photo so plank scale looks right on big decks
          deckSurface.repeat.set(Math.max(1, Math.round(st.deckL / 1.4)), Math.max(1, Math.round(st.deckW / 1.4)));
        }
        const deckMat2 = stdMat({ map: deckSurface, roughness: 0.85 });
        if (st.deckPlace === 'around') {
          // a deck sheet with a hole the spa sits in, slightly proud of the slab
          const sheet = roundedRect(Math.max(st.deckL, st.spaL + 0.5), Math.max(st.deckW, st.spaW + 0.5), 0.15);
          sheet.holes.push(roundedRect(st.spaL + 0.1, st.spaW + 0.1, 0.18));
          build.add(extrude(sheet, 0.12, deckMat2, 0, 0, 0));
        } else {
          const offsets = {
            front: [0, slabW / 2 + st.deckW / 2 + 0.03],
            behind: [0, -(slabW / 2 + st.deckW / 2 + 0.03)],
            left: [-(slabL / 2 + st.deckL / 2 + 0.03), 0],
            right: [slabL / 2 + st.deckL / 2 + 0.03, 0]
          };
          const [dx, dz] = offsets[st.deckPlace] || offsets.front;
          build.add(box(st.deckL, 0.1, st.deckW, deckMat2, dx, 0.05, dz));
          build.add(box(st.deckL, 0.1, 0.03, stdMat({ color: 0x7a512c, roughness: 0.9 }), dx, 0.05, dz + st.deckW / 2 + 0.015));
        }
      }

      // retaining walls behind the build
      st.walls.forEach((w, i) => {
        const t = num(w.thicknessM) || 0.1;
        const isTimber = /timber|sleeper/i.test(w.type || '') && !/concrete/i.test(w.type || '');
        const wallMat = isTimber ? stdMat({ map: timberTex, roughness: 0.95 }) : stdMat({ color: 0xa3a099, roughness: 0.9, map: concreteTex });
        build.add(box(num(w.lengthM), num(w.heightM), t, wallMat, 0, num(w.heightM) / 2, -(slabW / 2 + 0.45 + i * (t + 0.35))));
      });

      // ---- dress-ups ----
      if (st.landscape) {
        // hedge along the rear fence
        for (let x = xLeft + 0.6; x < xRight - 0.6; x += 0.75) {
          if (Math.abs(x) < slabL / 2 + 0.5 && st.dRear < 2.2) continue; // keep the spa corner clear on tight blocks
          yard.add(shrub(x, zRear + 0.45, 1.15, 0x3a6a2d));
        }
        // corner garden + trees
        yard.add(tree(xLeft + 1.1, zRear + 1.3, 3.2));
        yard.add(tree(xRight - 1.3, zRear + 1.6, 2.6));
        yard.add(shrub(xRight - 0.8, zHouse - 3, 1.3, 0x4a7a36));
        yard.add(shrub(xLeft + 0.8, zRear + 2.6, 0.9));
        // garden bed strip against the rear fence (dark mulch)
        const bed = new THREE.Mesh(new THREE.BoxGeometry(xRight - xLeft - 0.4, 0.06, 0.9),
          stdMat({ color: 0x4a3826, roughness: 1 }));
        bed.position.set(0, 0.03, zRear + 0.5);
        bed.receiveShadow = true;
        yard.add(bed);
      }
      if (st.stones) {
        // stepping stones from the house door to the spa
        const from = new THREE.Vector3(0, 0, zHouse - 0.8);
        const deckFrontExtent = st.deckL && st.deckW
          ? (st.deckPlace === 'around' ? Math.max(st.deckW, st.spaW + 0.5) / 2 - slabW / 2 : (st.deckPlace === 'front' ? st.deckW : 0))
          : 0;
        const to = new THREE.Vector3(0, 0, slabW / 2 + Math.max(0, deckFrontExtent) + 0.6);
        const steps = Math.max(2, Math.floor(from.distanceTo(to) / 0.65));
        for (let i = 0; i <= steps; i++) {
          const p = from.clone().lerp(to, i / steps);
          const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.04, 10),
            stdMat({ map: paverTex, roughness: 0.95 }));
          stone.position.set(p.x + (i % 2 ? 0.12 : -0.12), 0.02, p.z);
          stone.castShadow = true; stone.receiveShadow = true;
          yard.add(stone);
        }
      }
      if (st.furniture) {
        // two sun loungers + umbrella beside the spa
        const loungeX = slabL / 2 + 1.2;
        for (let i = 0; i < 2; i++) {
          const lounger = new THREE.Group();
          const base = box(0.65, 0.09, 1.7, stdMat({ color: 0xd8d3c8, roughness: 0.8 }), 0, 0.28, 0);
          const back = box(0.65, 0.09, 0.62, stdMat({ color: 0xd8d3c8, roughness: 0.8 }), 0, 0.46, -0.78);
          back.rotation.x = -0.6;
          const legs = box(0.55, 0.24, 1.3, stdMat({ color: 0x8f8a80, roughness: 0.8 }), 0, 0.12, 0);
          lounger.add(base); lounger.add(back); lounger.add(legs);
          lounger.position.set(loungeX + i * 0.9, 0, 0.4);
          yard.add(lounger);
        }
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 8), stdMat({ color: 0xe8e4da, roughness: 0.6 }));
        pole.position.set(loungeX + 0.45, 1.1, -0.9); pole.castShadow = true;
        yard.add(pole);
        const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.25, 0.45, 10), stdMat({ color: 0xc4573a, roughness: 0.8 }));
        canopy.position.set(loungeX + 0.45, 2.25, -0.9); canopy.castShadow = true;
        yard.add(canopy);
      }

      // legend
      const bits = ['<b>' + (job.installType || 'spa') + ' - everything to scale</b>',
        '<span class="sw" style="background:#2fa8d5"></span>Spa ' + st.spaL + 'm x ' + st.spaW + 'm x ' + st.spaH + 'm, ' + ({ in: 'in the ground', semi: 'semi in-ground', above: 'above ground' }[st.sitting])];
      if (slabDrawn) bits.push('<span class="sw" style="background:#c7c4bb"></span>Slab ' + slabL.toFixed(1) + 'm x ' + slabW.toFixed(1) + 'm');
      if (st.deckL && st.deckW) {
        const placeWords = { front: 'in front', around: 'all around the spa', left: 'left side', right: 'right side', behind: 'behind' };
        bits.push('<span class="sw" style="background:#96683c"></span>Deck ' + st.deckL + 'm x ' + st.deckW + 'm, ' + (placeWords[st.deckPlace] || 'in front') +
          (deckBoard ? '<br><span style="opacity:.85">' + deckBoard.brand + ' ' + deckBoard.name + '</span>' +
            (deckBoard.image ? '<br><img src="/decking-images/' + deckBoard.image + '" style="width:100%;max-height:56px;object-fit:cover;border-radius:6px;margin-top:3px">' : '') : ''));
      }
      st.walls.forEach(w => bits.push('<span class="sw" style="background:#a3a099"></span>Retaining wall ' + w.lengthM + 'm x ' + w.heightM + 'm (' + (w.type || '') + ')'));
      bits.push('<span class="sw" style="background:#7d6248"></span>Fences at ' + (state.hasSurvey ? 'measured' : 'typical') + ' boundary distances');
      bits.push('Drag to look around, scroll or pinch to zoom.');
      // the actual spa they picked, photo and all
      const sm = s.spaModel;
      if (sm && sm.image) {
        bits.unshift('<img src="/catalogue-images/' + sm.image + '" style="width:100%;border-radius:8px;margin-bottom:6px">' +
          '<b>' + sm.name + '</b> <span style="opacity:.8">(' + (sm.brand || '') + ')</span>');
      }
      document.getElementById('legend').innerHTML = bits.join('<br>');
    }
    rebuild();

    // ---------- adjust panel ----------
    const P = id => document.getElementById(id);
    const fields = [['p-spaL', 'spaL'], ['p-spaW', 'spaW'], ['p-spaH', 'spaH'], ['p-slabL', 'slabL'], ['p-slabW', 'slabW'], ['p-deckL', 'deckL'], ['p-deckW', 'deckW']];
    for (const [id, key] of fields) {
      P(id).value = state[key] || '';
      P(id).oninput = () => { state[key] = num(P(id).value); rebuild(); };
    }
    P('p-inground').value = state.sitting;
    P('p-inground').onchange = () => { state.sitting = P('p-inground').value; rebuild(); };
    P('p-deckPlace').value = state.deckPlace;
    P('p-deckPlace').onchange = () => { state.deckPlace = P('p-deckPlace').value; rebuild(); };
    P('btn-back').href = '/#/job/' + jobId;
    for (const [id, key] of [['p-landscape', 'landscape'], ['p-furniture', 'furniture'], ['p-stones', 'stones'], ['p-phototop', 'photoTop']]) {
      P(id).checked = state[key];
      P(id).onchange = () => { state[key] = P(id).checked; rebuild(); };
    }
    P('btn-panel').onclick = () => P('panel').classList.toggle('open');
    P('p-save').onclick = async () => {
      try {
        const fresh = await fetch('/api/jobs/' + jobId).then(r => r.json());
        let survey = fresh.survey;
        if (!survey) survey = await fetch('/api/empty-survey').then(r => r.json());
        const mm = survey.measurements;
        mm.spa.lengthM = String(state.spaL); mm.spa.widthM = String(state.spaW); mm.spa.depthM = String(state.spaH);
        // slab only when you actually typed a size - never the suggested one
        mm.slab = mm.slab || {};
        if (state.slabL) mm.slab.lengthM = String(state.slabL);
        if (state.slabW) mm.slab.widthM = String(state.slabW);
        mm.decking = mm.decking || { brand: '' };
        mm.decking.lengthM = state.deckL ? String(state.deckL) : '';
        mm.decking.widthM = state.deckW ? String(state.deckW) : '';
        mm.decking.placement = state.deckPlace;
        if (deckBoard) mm.decking.brand = deckBoard.brand + ' ' + deckBoard.name;
        const res = await fetch('/api/jobs/' + jobId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ survey })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
        state.hasSurvey = true;
        P('p-save').textContent = 'Saved - use "Back to the job" up top';
        setTimeout(() => { P('p-save').textContent = 'Save these sizes to the job'; }, 4000);
      } catch (e) { alert('Could not save: ' + e.message); }
    };

    // ---------- camera + controls ----------
    const target = new THREE.Vector3(0, 0.4, 0);
    let theta = 0.35, phi = 1.12,
      radius = Math.max(4, Math.min(Math.max(state.spaL, state.spaW) * 3 + 4, state.dHouse + state.spaW / 2 - 1));
    function applyCamera() {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta)
      );
      camera.lookAt(target);
    }
    applyCamera();

    // Rotate buttons: tap for a nudge, hold to keep turning. Spin = slow auto-orbit.
    let autoSpin = false;
    function holdRotate(btnId, dir) {
      const btn = P(btnId);
      let timer = null;
      const step = () => { theta += dir * 0.035; applyCamera(); };
      btn.addEventListener('pointerdown', e => { e.preventDefault(); step(); timer = setInterval(step, 30); });
      const stop = () => { clearInterval(timer); timer = null; };
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointerleave', stop);
      btn.addEventListener('pointercancel', stop);
    }
    holdRotate('btn-rot-l', 1);
    holdRotate('btn-rot-r', -1);
    P('btn-spin').onclick = () => {
      autoSpin = !autoSpin;
      P('btn-spin').textContent = autoSpin ? 'Stop spin' : 'Spin';
    };

    // ---------- the customer's real yard, from a phone 3D scan ----------
    let showScan = false, moveMode = false;
    if (s.scan && s.scan.file && THREE.GLTFLoader) {
      new THREE.GLTFLoader().load('/uploads/' + s.scan.file, gltf => {
        const model = gltf.scene;
        // sit the scan on the ground, centred where the spa starts
        const bbox = new THREE.Box3().setFromObject(model);
        const centre = bbox.getCenter(new THREE.Vector3());
        model.position.x -= centre.x;
        model.position.z -= centre.z;
        model.position.y -= bbox.min.y;
        scanGroup.add(model);
        P('btn-scan').style.display = 'inline-block';
      }, undefined, () => {
        P('btn-scan').style.display = 'inline-block';
        P('btn-scan').textContent = 'Scan file would not load';
        P('btn-scan').disabled = true;
      });
      P('btn-scan').onclick = () => {
        showScan = !showScan;
        scanGroup.visible = showScan;
        yard.visible = !showScan;
        P('btn-scan').textContent = showScan ? 'Show the model yard' : 'Show the real yard';
        P('btn-move').style.display = showScan ? 'inline-block' : 'none';
        if (!showScan) { moveMode = false; P('btn-move').textContent = 'Move spa'; build.position.set(0, 0, 0); }
        else conformBuildToScan();
      };
      P('btn-move').onclick = () => {
        moveMode = !moveMode;
        P('btn-move').textContent = moveMode ? 'Done moving' : 'Move spa';
      };
    }
    // spin the spa (and its slab/deck) on the spot - works in every mode
    P('btn-turn').onclick = () => { build.rotation.y += Math.PI / 12; };
    // drag-to-place: project the finger onto the ground and put the spa there
    const groundRay = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundHit = new THREE.Vector3();
    function moveBuildTo(e) {
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      groundRay.setFromCamera(ndc, camera);
      if (groundRay.ray.intersectPlane(groundPlane, groundHit)) {
        build.position.x = groundHit.x;
        build.position.z = groundHit.z;
        conformBuildToScan();
      }
    }
    // Scanned ground is never perfectly flat - stand the spa on the surface at
    // its position so the scan can't poke up through it.
    const downRay = new THREE.Raycaster();
    function conformBuildToScan() {
      if (!showScan || !scanGroup.children.length) { build.position.y = 0; return; }
      downRay.set(new THREE.Vector3(build.position.x, 50, build.position.z), new THREE.Vector3(0, -1, 0));
      const hits = downRay.intersectObject(scanGroup, true);
      build.position.y = hits.length ? hits[0].point.y + 0.03 : 0;
    }

    const pointers = new Map();
    let lastPinch = 0;
    renderer.domElement.addEventListener('pointerdown', e => {
      if (autoSpin) { autoSpin = false; P('btn-spin').textContent = 'Spin'; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      renderer.domElement.setPointerCapture(e.pointerId);
    });
    renderer.domElement.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const p = pointers.get(e.pointerId);
      if (pointers.size === 1) {
        if (moveMode) {
          moveBuildTo(e);
        } else {
          theta -= (e.clientX - p.x) * 0.006;
          phi = Math.min(1.52, Math.max(0.25, phi - (e.clientY - p.y) * 0.006));
          applyCamera();
        }
      }
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastPinch) { radius = Math.min(60, Math.max(2, radius * lastPinch / pinch)); applyCamera(); }
        lastPinch = pinch;
      }
    });
    const endPointer = e => { pointers.delete(e.pointerId); lastPinch = 0; };
    renderer.domElement.addEventListener('pointerup', endPointer);
    renderer.domElement.addEventListener('pointercancel', endPointer);
    renderer.domElement.addEventListener('wheel', e => {
      e.preventDefault();
      radius = Math.min(60, Math.max(2, radius * (1 + e.deltaY * 0.001)));
      applyCamera();
    }, { passive: false });

    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ---------- WebXR: Quest VR walk-around + AR passthrough ----------
    let inAR = false;
    function setupXR() {
      if (!navigator.xr) return;
      navigator.xr.isSessionSupported('immersive-vr').then(ok => {
        if (!ok) return;
        P('btn-vr').style.display = 'inline-block';
        P('btn-vr').onclick = () => startSession('immersive-vr');
      }).catch(() => {});
      navigator.xr.isSessionSupported('immersive-ar').then(ok => {
        if (!ok) return;
        P('btn-ar').style.display = 'inline-block';
        P('btn-ar').onclick = () => startSession('immersive-ar');
      }).catch(() => {});
    }
    function startSession(mode) {
      navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] }).then(session => {
        inAR = mode === 'immersive-ar';
        if (inAR) { yard.visible = false; scanGroup.visible = false; scene.background = null; scene.fog = null; }
        renderer.xr.setReferenceSpaceType('local-floor');
        renderer.xr.setSession(session);
        session.addEventListener('end', () => {
          inAR = false;
          yard.visible = !showScan;
          scanGroup.visible = showScan;
          scene.background = new THREE.Color(SKY);
          scene.fog = new THREE.Fog(SKY, 45, 95);
          build.position.set(0, 0, 0);
        });
      }).catch(e => alert('Could not start the headset session: ' + e.message));
    }
    // Trigger = move the spa to where you're pointing.
    const rayDir = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      controller.addEventListener('select', () => {
        controller.getWorldDirection(rayDir);
        rayDir.multiplyScalar(-1);
        const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
        if (rayDir.y < -0.05) {
          const t = -origin.y / rayDir.y;
          build.position.set(origin.x + rayDir.x * t, 0, origin.z + rayDir.z * t);
        } else {
          build.position.set(origin.x + rayDir.x * 2, 0, origin.z + rayDir.z * 2);
        }
      });
      scene.add(controller);
    }
    setupXR();

    renderer.setAnimationLoop(() => {
      if (autoSpin && !renderer.xr.isPresenting) { theta += 0.004; applyCamera(); }
      renderer.render(scene, camera);
    });
  }
})();
