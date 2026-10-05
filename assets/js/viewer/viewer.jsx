/**
 * Three.js viewer wrapper.
 *
 * In a production app this would consume the geometry buffers emitted by
 * web-ifc's worker. Here we synthesize meshes from each element's `geometry`
 * descriptor and stamp them with `userData.expressId` so picking/selection
 * round-trips back to the IFC data layer cleanly.
 */

// ----- Hand-rolled orbit controls (no OrbitControls in CDN core) --------------
class OrbitController {
  constructor(camera, dom, target) {
    this.camera = camera;
    this.dom = dom;
    this.target = target.clone();
    this.spherical = new THREE.Spherical();
    this.updateFromCamera();
    this.enabled = true;
    this._down = false;
    this._mode = null; // 'orbit' | 'pan'
    this._last = { x: 0, y: 0 };
    this._bind();
  }
  updateFromCamera() {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.target);
    this.spherical.setFromVector3(offset);
  }
  _bind() {
    this.dom.addEventListener('pointerdown', this.onDown);
    this.dom.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('contextmenu', e => e.preventDefault());
  }
  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
  }
  onDown = (e) => {
    if (!this.enabled) return;
    if (e.button === 0 && !e.shiftKey && !e.altKey) {
      // left button without modifier is reserved for picking
      this._down = false;
      return;
    }
    this._down = true;
    this._mode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    this._last.x = e.clientX;
    this._last.y = e.clientY;
    this.dom.setPointerCapture && this.dom.setPointerCapture(e.pointerId);
  };
  onMove = (e) => {
    if (!this._down) return;
    const dx = e.clientX - this._last.x;
    const dy = e.clientY - this._last.y;
    this._last.x = e.clientX;
    this._last.y = e.clientY;
    if (this._mode === 'orbit') {
      this.spherical.theta -= dx * 0.005;
      this.spherical.phi -= dy * 0.005;
      this.spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.spherical.phi));
    } else {
      const panScale = this.spherical.radius * 0.0015;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      right.setFromMatrixColumn(this.camera.matrix, 0);
      up.setFromMatrixColumn(this.camera.matrix, 1);
      this.target.addScaledVector(right, -dx * panScale);
      this.target.addScaledVector(up, dy * panScale);
    }
    this.apply();
  };
  onUp = () => { this._down = false; };
  onWheel = (e) => {
    if (!this.enabled) return;
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.001);
    this.spherical.radius = Math.max(2, Math.min(200, this.spherical.radius * factor));
    this.apply();
  };
  apply() {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }
  setTarget(t, distance) {
    this.target.copy(t);
    if (distance != null) this.spherical.radius = distance;
    this.apply();
  }
  setView(name) {
    const r = this.spherical.radius;
    const t = this.target;
    let pos;
    switch (name) {
      case 'top': pos = new THREE.Vector3(t.x, t.y + r, t.z); break;
      case 'bottom': pos = new THREE.Vector3(t.x, t.y - r, t.z); break;
      case 'front': pos = new THREE.Vector3(t.x, t.y, t.z + r); break;
      case 'back': pos = new THREE.Vector3(t.x, t.y, t.z - r); break;
      case 'left': pos = new THREE.Vector3(t.x - r, t.y, t.z); break;
      case 'right': pos = new THREE.Vector3(t.x + r, t.y, t.z); break;
      case 'iso':
      default:
        pos = new THREE.Vector3(t.x + r * 0.6, t.y + r * 0.6, t.z + r * 0.6); break;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(t);
    this.updateFromCamera();
  }
}

const SECTION_FACES = [
  { id: 'xMin', axis: 'x', edge: 'min', normal: new THREE.Vector3(1, 0, 0) },
  { id: 'xMax', axis: 'x', edge: 'max', normal: new THREE.Vector3(-1, 0, 0) },
  { id: 'yMin', axis: 'y', edge: 'min', normal: new THREE.Vector3(0, 1, 0) },
  { id: 'yMax', axis: 'y', edge: 'max', normal: new THREE.Vector3(0, -1, 0) },
  { id: 'zMin', axis: 'z', edge: 'min', normal: new THREE.Vector3(0, 0, 1) },
  { id: 'zMax', axis: 'z', edge: 'max', normal: new THREE.Vector3(0, 0, -1) },
];

// ----- Viewer class ----------------------------------------------------------
class ThreeViewer {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eef2f7');
    this.scene.fog = new THREE.Fog('#eef2f7', 60, 220);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'viewer-canvas';

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(28, 22, 28);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 4, 0);

    // Lights
    const hemi = new THREE.HemisphereLight(0xe8eef5, 0x8a96a8, 1.05);
    this.scene.add(hemi);
    this.hemiLight = hemi;
    const dir = new THREE.DirectionalLight(0xffffff, 1.35);
    dir.position.set(22, 38, 14);
    this.scene.add(dir);
    this.dirLight = dir;
    const dir2 = new THREE.DirectionalLight(0xb8dcff, 0.55);
    dir2.position.set(-18, 20, -12);
    this.scene.add(dir2);
    this.dirLight2 = dir2;
    const fill = new THREE.DirectionalLight(0xfff4e8, 0.28);
    fill.position.set(-12, 8, 24);
    this.scene.add(fill);
    this.fillLight = fill;

    // Grid + ground
    this.grid = new THREE.GridHelper(80, 80, 0x90969f, 0xc5cad2);
    this.grid.position.y = -0.01;
    this.scene.add(this.grid);

    // Axis gizmo at world origin (X=red, Y=green/up, Z=blue)
    this.axisLength = 6;
    this.axes = new THREE.AxesHelper(this.axisLength);
    this.axes.position.set(0, 0.02, 0);
    this.scene.add(this.axes);
    this.axesLabels = this._buildAxisLabels();
    this.scene.add(this.axesLabels);

    // Root group
    this.modelRoot = new THREE.Group();
    this.modelRoot.name = 'IFCModelRoot';
    this.scene.add(this.modelRoot);

    // Real IFC geometry is normalized to Three.js Y-up by the loader.
    this.modelRoot.rotation.set(0, 0, 0);
    this.upAxis = 'y';

    this.theme = 'light';
    this._applyTheme();

    // Edges group
    this.edgesGroup = new THREE.Group();
    this.modelRoot.add(this.edgesGroup);

    // Selection highlight outline
    this.selectionGroup = new THREE.Group();
    this.modelRoot.add(this.selectionGroup);

    // Hover material
    this.materials = {};
    this._buildMaterials();

    // Controls
    this.controls = new OrbitController(this.camera, this.renderer.domElement, new THREE.Vector3(0, 4, 0));

    // State
    this.meshes = new Map(); // expressId -> Mesh
    this.elementGeometryCenters = new Map();
    this.elementOriginalPositions = new Map();
    this.selectedIds = new Set();
    this.hiddenIds = new Set();
    this.isolatedIds = new Set();
    this.hoverIds = new Set();
    this.colorOverrides = new Map(); // expressId -> hex
    this.opacityOverrides = new Map();
    this.viewMode = 'shaded'; // 'shaded' | 'xray' | 'wireframe' | 'edges'
    this.showEdges = false;
    this.explodeFactor = 0;
    this.clippingPlane = null;
    this.clipEnabled = false;
    this.sectionEnabled = false;
    this.sectionBox = null;
    this.sectionBounds = null;
    this.sectionHandleGroup = null;
    this.sectionHandleMeshes = new Map();
    this._sectionDrag = null;
    this._sectionDragPointer = null;
    this.annotations = []; // {id, position, status, ...}
    this.measurePoints = [];
    this.measureLine = null;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.lastPickPoint = null;

    // Resize (coalesced to animation frames to avoid blink during panel drag)
    this._sizeW = 0;
    this._sizeH = 0;
    this._resizeRaf = 0;
    this._xrayFogFar = null;
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(host);
    this.handleResize();

    // Loop
    this._running = true;
    this.renderLoop = this.renderLoop.bind(this);
    requestAnimationFrame(this.renderLoop);

    // Events
    this._listeners = {
      pick: [], hover: [], stats: [], measure: [], anno: [], sectionBox: [],
    };
    this.renderer.domElement.addEventListener('click', this.onClick);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

    this._frameTimes = [];
    this._lastFrame = performance.now();
  }

  _buildMaterials() {
    this.matCache = new Map();
    this.highlightMat = new THREE.MeshStandardMaterial({
      color: 0x6fb7d6,
      emissive: 0x6fb7d6,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.hoverEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    this.selectEdgeMat = new THREE.LineBasicMaterial({ color: 0x6fe7ff, linewidth: 2 });
  }

  _resolveElementColor(el, ifcColor) {
    const c = new THREE.Color();
    if (ifcColor) {
      c.setRGB(ifcColor.r, ifcColor.g, ifcColor.b);
    } else {
      c.set(el.colorOverride ?? CLASS_COLOR(el.ifcClass));
    }
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    if (hsl.s > 0.03) hsl.s = Math.min(1, hsl.s * 1.85 + 0.08);
    hsl.l = Math.min(0.74, Math.max(0.24, hsl.l * 1.04 + 0.01));
    c.setHSL(hsl.h, hsl.s, hsl.l);
    return c;
  }

  matForElement(el) {
    const key = `${el.ifcClass}-${el.colorOverride ?? CLASS_COLOR(el.ifcClass)}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const baseColor = this._resolveElementColor(el, null);
    const isSpace = el.ifcClass === 'IfcSpace';
    const isGlass = el.ifcClass === 'IfcWindow' || el.ifcClass === 'IfcWindowStandardCase';
    const m = new THREE.MeshStandardMaterial({
      color: baseColor,
      emissive: baseColor.clone().multiplyScalar(0.1),
      emissiveIntensity: isSpace ? 0 : 0.42,
      metalness: isGlass ? 0.12 : 0.14,
      roughness: isGlass ? 0.1 : 0.36,
      transparent: isSpace || isGlass,
      opacity: isSpace ? 0.14 : (isGlass ? 0.42 : 1.0),
      side: isSpace || isGlass ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: !(isSpace || isGlass),
    });
    this.matCache.set(key, m);
    return m;
  }

  async loadModel(model) {
    // Clear existing
    this.clearModel();

    this.modelRoot.position.set(0, 0, 0);
    this.modelRoot.rotation.set(0, 0, 0);

    let totalGeomItems = 0;
    let totalTris = 0;
    const geomElements = model.elements.filter(el => el.geometry);
    const CHUNK = 140;
    let framed = false;

    for (let i = 0; i < geomElements.length; i++) {
      const el = geomElements[i];
      const mesh = this._geometryToMesh(el);
      if (!mesh) continue;
      mesh.userData.expressId = el.expressId;
      mesh.userData.ifcClass = el.ifcClass;
      mesh.frustumCulled = true;
      this.modelRoot.add(mesh);
      this.meshes.set(el.expressId, mesh);
      totalGeomItems++;
      if (mesh.geometry && mesh.geometry.index) totalTris += mesh.geometry.index.count / 3;

      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      mesh.geometry.boundingBox.getCenter(center);
      const worldCenter = center.clone().applyMatrix4(mesh.matrixWorld);
      this.elementGeometryCenters.set(el.expressId, worldCenter);
      this.elementOriginalPositions.set(el.expressId, mesh.position.clone());

      if (!framed && totalGeomItems >= 24) {
        this._autoCenter();
        this.modelRoot.updateMatrixWorld(true);
        this.frameAll({ resetView: true });
        framed = true;
      }

      if (i > 0 && i % CHUNK === 0) {
        await new Promise(r => requestAnimationFrame(r));
      }
    }

    this._emit('stats', { totalGeomItems, totalTris });
    this._autoCenter();
    this.modelRoot.updateMatrixWorld(true);
    if (this.sectionEnabled) {
      this.sectionBounds = this.getModelBounds();
      if (this.sectionBounds && !this.sectionBox) {
        this.sectionBox = { ...this.sectionBounds };
      }
      if (this.sectionBox) {
        this._applyModelSectionClipping(this.sectionBox);
        this._syncSectionVisuals(this.sectionBox);
      }
    }
    requestAnimationFrame(() => this.frameAll({ resetView: true }));
  }

  // Lazily build edge LineSegments for one mesh (called on demand)
  _ensureEdgeLines(mesh, id) {
    if (mesh.userData.edge) return mesh.userData.edge;
    const tri = mesh.geometry.index ? mesh.geometry.index.count / 3 : 0;
    if (tri > 8000) return null; // skip huge meshes
    const edgeGeo = new THREE.EdgesGeometry(mesh.geometry, 25);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 });
    const edge = new THREE.LineSegments(edgeGeo, edgeMat);
    edge.position.copy(mesh.position);
    edge.rotation.copy(mesh.rotation);
    edge.userData.expressId = id;
    edge.visible = false;
    this.edgesGroup.add(edge);
    mesh.userData.edge = edge;
    return edge;
  }

  _geometryToMesh(el) {
    const g = el.geometry;
    if (!g) return null;
    let geom, mat = this.matForElement(el);
    if (g.kind === 'mesh') {
      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geom.setIndex(new THREE.Uint32BufferAttribute(g.indices, 1));
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      if (g.color) {
        mat = mat.clone();
        const enhanced = this._resolveElementColor(el, g.color);
        mat.color.copy(enhanced);
        mat.emissive.copy(enhanced).multiplyScalar(0.1);
        mat.emissiveIntensity = 0.42;
        if (g.color.a < 0.99) {
          mat.transparent = true;
          mat.opacity = Math.max(0.35, g.color.a);
          mat.depthWrite = g.color.a > 0.95;
        }
      }
      const mesh = new THREE.Mesh(geom, mat);
      // Vertices are already in world coords — no per-mesh translation needed
      mesh.userData.original_y = 0;
      return mesh;
    }
    if (g.kind === 'box' || g.kind === 'space') {
      geom = new THREE.BoxGeometry(g.w, g.h, g.d);
    } else if (g.kind === 'stair') {
      geom = this._stairGeom(g.w, g.d, g.h);
    } else {
      geom = new THREE.BoxGeometry(g.w || 0.5, g.h || 0.5, g.d || 0.5);
    }
    const mesh = new THREE.Mesh(geom, mat);
    const yPos = (g.z || 0) + (g.h || 1) / 2 + (g.offsetZ || 0);
    mesh.position.set(g.x, yPos, g.y);
    mesh.userData.original_y = mesh.position.y;
    return mesh;
  }
  _stairGeom(w, depth, height) {
    const steps = 10;
    const geom = new THREE.BufferGeometry();
    const verts = [];
    const pushQuad = (arr, pts) => {
      // pts: [x1,y1,z1, x2,y2,z2, x3,y3,z3, x4,y4,z4] => two triangles
      arr.push(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7], pts[8]);
      arr.push(pts[0], pts[1], pts[2], pts[6], pts[7], pts[8], pts[9], pts[10], pts[11]);
    };
    const tread = depth / steps;
    const rise = height / steps;
    for (let i = 0; i < steps; i++) {
      const x1 = -w/2, x2 = w/2;
      const z1 = -depth/2 + i * tread;
      const z2 = z1 + tread;
      const y0 = i * rise - height/2;
      const y1 = (i + 1) * rise - height/2;
      // Top (tread)
      pushQuad(verts, [x1, y1, z1, x2, y1, z1, x2, y1, z2, x1, y1, z2]);
      // Front (riser)
      pushQuad(verts, [x1, y0, z1, x2, y0, z1, x2, y1, z1, x1, y1, z1]);
      // Sides
      pushQuad(verts, [x1, y0, z1, x1, y1, z1, x1, y1, z2, x1, y0, z2]);
      pushQuad(verts, [x2, y0, z2, x2, y1, z2, x2, y1, z1, x2, y0, z1]);
      // Bottom (only the very last tread bottom for sealing - skip for simplicity)
    }
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.computeVertexNormals();
    return geom;
  }

  clearModel() {
    this.meshes.forEach(m => {
      m.geometry.dispose();
      this.modelRoot.remove(m);
      if (m.userData.edge) {
        m.userData.edge.geometry.dispose();
        this.edgesGroup.remove(m.userData.edge);
      }
    });
    this.meshes.clear();
    this.elementGeometryCenters.clear();
    this.elementOriginalPositions.clear();
    this.selectedIds.clear();
    this.hiddenIds.clear();
    this.isolatedIds.clear();
    this.colorOverrides.clear();
    this.opacityOverrides.clear();
    this.clearMeasure();
    this.annotations = [];
    this._updateOutlines();
  }

  // ----- Selection / hover ---------------------------------------------------
  onClick = (e) => {
    if (this._sectionDragPointer === e.pointerId) return;
    if (this._measureMode) {
      this._handleMeasureClick(e);
      return;
    }
    if (this._annoMode) {
      this._handleAnnoClick(e);
      return;
    }
    if (this.sectionEnabled) return;
    const id = this._pickAt(e);
    this._emit('pick', { expressId: id, multi: e.ctrlKey || e.metaKey || e.shiftKey, button: e.button, x: e.clientX, y: e.clientY });
  };

  onPointerDown = (e) => {
    if (!this.sectionEnabled || !this.sectionBox || this._measureMode || this._annoMode) return;
    const face = this._pickSectionHandle(e);
    if (!face) return;
    e.preventDefault();
    e.stopPropagation();
    this._sectionDrag = { face };
    this._sectionDragPointer = e.pointerId;
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
    this.renderer.domElement.style.cursor = 'grabbing';
  };

  onPointerUp = (e) => {
    if (this._sectionDrag && (this._sectionDragPointer == null || e.pointerId === this._sectionDragPointer)) {
      this._sectionDrag = null;
      this._sectionDragPointer = null;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = '';
      try { this.renderer.domElement.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }
  };

  onPointerMove = (e) => {
    if (this._sectionDrag) {
      this._dragSectionFace(e);
      return;
    }
    if (this._measureMode || this._annoMode) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.lastPickPoint = this._worldPointAt(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (this.sectionEnabled && this.sectionHandleGroup) {
      const overHandle = this._pickSectionHandle(e);
      this.renderer.domElement.style.cursor = overHandle ? 'grab' : '';
      if (overHandle) return;
    }
    const id = this._pickAt(e);
    this._emit('hover', { expressId: id });
  };

  _pickAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.mouse.set(x, y);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const candidates = [];
    this.meshes.forEach(m => { if (m.visible) candidates.push(m); });
    const hits = this.raycaster.intersectObjects(candidates, false);
    if (hits.length === 0) return null;
    this.lastPickPoint = hits[0].point.clone();
    return hits[0].object.userData.expressId;
  }

  _worldPointAt(px, py) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = (px / r.width) * 2 - 1;
    const y = -(py / r.height) * 2 + 1;
    this.mouse.set(x, y);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const candidates = [];
    this.meshes.forEach(m => { if (m.visible) candidates.push(m); });
    const hits = this.raycaster.intersectObjects(candidates, false);
    return hits.length ? hits[0].point.clone() : null;
  }

  setSelection(ids) {
    this.selectedIds = new Set(ids);
    this._updateOutlines();
    if (this.viewMode === 'xray') this._applyViewMode();
  }
  setHover(ids) {
    this.hoverIds = new Set(ids);
    this._updateOutlines();
    if (this.viewMode === 'xray') this._applyViewMode();
  }
  setHidden(ids) {
    this.hiddenIds = new Set(ids);
    this._applyVisibility();
  }
  setIsolated(ids) {
    this.isolatedIds = new Set(ids);
    this._applyVisibility();
  }
  setColorOverrides(map) {
    this.colorOverrides = new Map(map);
    this._applyColors();
  }
  setOpacityOverrides(map) {
    this.opacityOverrides = new Map(map);
    this._applyColors();
  }

  _applyVisibility() {
    const hasIsolation = this.isolatedIds.size > 0;
    this.meshes.forEach((m, id) => {
      let visible = true;
      if (hasIsolation && !this.isolatedIds.has(id)) visible = false;
      if (this.hiddenIds.has(id)) visible = false;
      m.visible = visible;
      if (m.userData.edge) m.userData.edge.visible = visible && this.showEdges;
    });
  }
  _applyColors() {
    // Rebuild materials with new overrides
    this.matCache.clear();
    this.meshes.forEach((m, id) => {
      const el = window.__currentModel && window.__currentModel.byId.get(id);
      if (!el) return;
      const override = this.colorOverrides.get(id);
      const opOverride = this.opacityOverrides.get(id);
      const fakeEl = { ...el, colorOverride: override ?? el.colorOverride };
      const mat = this.matForElement(fakeEl);
      // Preserve IFC-provided color if no explicit override exists
      if (override == null && el.geometry && el.geometry.kind === 'mesh' && el.geometry.color) {
        const enhanced = this._resolveElementColor(el, el.geometry.color);
        mat.color.copy(enhanced);
        mat.emissive.copy(enhanced).multiplyScalar(0.1);
        mat.emissiveIntensity = 0.42;
      }
      if (opOverride != null) {
        mat.transparent = true;
        mat.opacity = opOverride;
        mat.depthWrite = opOverride > 0.95;
      }
      m.material = mat;
    });
    this._applyViewMode();
    if (this.sectionEnabled && this.sectionBox) this._applyModelSectionClipping(this.sectionBox);
  }

  _updateOutlines() {
    // Clear and rebuild selection outline group
    while (this.selectionGroup.children.length) {
      const c = this.selectionGroup.children.pop();
      c.geometry && c.geometry.dispose();
    }
    this.selectedIds.forEach(id => {
      const m = this.meshes.get(id);
      if (!m || !m.visible) return;
      const triCount = m.geometry.index ? m.geometry.index.count / 3 : 0;
      // Only draw edge outline on reasonably small meshes
      if (triCount > 0 && triCount < 4000) {
        const edgeGeo = new THREE.EdgesGeometry(m.geometry, 18);
        const line = new THREE.LineSegments(edgeGeo, this.selectEdgeMat);
        line.position.copy(m.position);
        line.rotation.copy(m.rotation);
        line.renderOrder = 2;
        this.selectionGroup.add(line);
      }
      // Glow box (transparent overlay) — share geometry, don't clone
      const glow = new THREE.Mesh(m.geometry, this.highlightMat);
      glow.position.copy(m.position);
      glow.rotation.copy(m.rotation);
      glow.renderOrder = 1;
      glow.scale.set(1.005, 1.005, 1.005);
      this.selectionGroup.add(glow);
    });
    this.hoverIds.forEach(id => {
      if (this.selectedIds.has(id)) return;
      const m = this.meshes.get(id);
      if (!m || !m.visible) return;
      const triCount = m.geometry.index ? m.geometry.index.count / 3 : 0;
      if (triCount > 0 && triCount < 4000) {
        const edgeGeo = new THREE.EdgesGeometry(m.geometry, 18);
        const line = new THREE.LineSegments(edgeGeo, this.hoverEdgeMat);
        line.position.copy(m.position);
        line.rotation.copy(m.rotation);
        line.renderOrder = 2;
        this.selectionGroup.add(line);
      }
    });
  }

  // ----- View modes ---------------------------------------------------------
  setViewMode(mode) {
    this.viewMode = mode;
    this._applyViewMode();
  }
  _applyViewMode() {
    const xray = this.viewMode === 'xray';
    if (this.scene.fog) {
      if (xray) {
        if (this._xrayFogFar == null) this._xrayFogFar = this.scene.fog.far;
        this.scene.fog.far = 5000;
      } else if (this._xrayFogFar != null) {
        this.scene.fog.far = this._xrayFogFar;
        this._xrayFogFar = null;
      }
    }

    this.meshes.forEach((m, id) => {
      const el = window.__currentModel && window.__currentModel.byId.get(id);
      if (!el) return;
      const isSpace = el.ifcClass === 'IfcSpace';
      const isGlass = el.ifcClass === 'IfcWindow';
      const isSelected = this.selectedIds.has(id);
      const isHovered = this.hoverIds.has(id);
      const mat = m.material;
      const opOverride = this.opacityOverrides.get(id);

      mat.wireframe = false;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      mat.depthTest = true;
      mat.side = isSpace || isGlass ? THREE.DoubleSide : THREE.FrontSide;
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
      mat.roughness = isGlass ? 0.1 : 0.36;
      mat.metalness = isGlass ? 0.12 : 0.14;

      if (opOverride != null) {
        mat.transparent = true;
        mat.opacity = opOverride;
        mat.depthWrite = opOverride > 0.95;
        return;
      }

      switch (this.viewMode) {
        case 'wireframe':
          mat.wireframe = true;
          break;
        case 'xray':
          mat.wireframe = false;
          mat.transparent = true;
          mat.depthWrite = false;
          mat.depthTest = true;
          mat.side = THREE.DoubleSide;
          mat.roughness = 0.35;
          mat.metalness = 0.04;
          mat.emissive.copy(mat.color);
          if (isSelected) {
            mat.opacity = 0.78;
            mat.emissiveIntensity = 0.42;
          } else if (isHovered) {
            mat.opacity = 0.52;
            mat.emissiveIntensity = 0.22;
          } else if (isSpace) {
            mat.opacity = 0.05;
            mat.emissiveIntensity = 0;
          } else if (isGlass) {
            mat.opacity = 0.2;
            mat.emissiveIntensity = 0.06;
          } else {
            mat.opacity = 0.34;
            mat.emissiveIntensity = 0.1;
          }
          break;
        case 'shaded':
        default: {
          const base = this._resolveElementColor(el, el.geometry?.color || null);
          mat.color.copy(base);
          mat.emissive.copy(base).multiplyScalar(0.1);
          mat.emissiveIntensity = isSpace ? 0 : 0.42;
          mat.transparent = isSpace || isGlass;
          mat.opacity = isSpace ? 0.14 : (isGlass ? 0.42 : 1.0);
          mat.depthWrite = !(isSpace || isGlass);
          break;
        }
      }
    });
  }
  setShowEdges(v) {
    this.showEdges = v;
    if (v) {
      // Lazy: build edge lines only when first turned on
      this.meshes.forEach((mesh, id) => {
        this._ensureEdgeLines(mesh, id);
      });
    }
    this.edgesGroup.children.forEach(c => { c.visible = v && (this.meshes.get(c.userData.expressId)?.visible !== false); });
  }

  // ----- Camera helpers -----------------------------------------------------
  frameAll({ resetView = false } = {}) {
    this.modelRoot.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.meshes.forEach(m => { if (m.visible) box.expandByObject(m); });
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = Math.max(sphere.radius * 2.2, 4);
    this.controls.target.copy(sphere.center);
    this.controls.spherical.radius = dist;
    if (resetView) {
      // Standard zoom-extents orbit (fit all), not a named face preset.
      this.controls.spherical.theta = Math.PI / 4;
      this.controls.spherical.phi = 1.05;
    }
    this.controls.apply();
  }
  frameElements(ids) {
    const box = new THREE.Box3();
    ids.forEach(id => {
      const m = this.meshes.get(id);
      if (m) box.expandByObject(m);
    });
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.controls.setTarget(sphere.center, Math.max(sphere.radius * 2.5, 4));
  }
  setCameraPreset(name) {
    this.controls.setView(name);
  }

  // ----- Explode ------------------------------------------------------------
  setExplode(factor) {
    this.explodeFactor = factor;
    // Move each storey's elements upwards proportional to storey index.
    const model = window.__currentModel;
    if (!model) return;
    const storeyOrder = new Map(model.storeys.map((s, i) => [s.expressId, i]));
    this.meshes.forEach((m, id) => {
      const el = model.byId.get(id);
      if (!el || !el.storey) return;
      const sIdx = storeyOrder.get(el.storey.expressId) ?? 0;
      const orig = this.elementOriginalPositions.get(id);
      if (!orig) return;
      m.position.set(orig.x, orig.y + sIdx * factor * 3, orig.z);
      if (m.userData.edge) m.userData.edge.position.copy(m.position);
    });
    this._updateOutlines();
  }

  _buildSky() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const ctx = c.getContext('2d');
    // Sky gradient (top blue → soft horizon → ground)
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#5d96c4');
    g.addColorStop(0.35, '#a4c6df');
    g.addColorStop(0.55, '#dbe5ec');
    g.addColorStop(0.62, '#e6ecf1');
    g.addColorStop(0.85, '#c9d0d8');
    g.addColorStop(1.00, '#b3bcc6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Auto-center the model on the grid after loadModel.
  _autoCenter() {
    // Force world-matrix refresh so the bbox reflects current rotation
    this.modelRoot.position.set(0, 0, 0);
    this.modelRoot.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.meshes.forEach(m => box.expandByObject(m));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.modelRoot.position.set(-center.x, -box.min.y, -center.z);
  }

  setUpAxis(axis) {
    this.upAxis = axis;
    if (axis === 'z') this.modelRoot.rotation.set(-Math.PI / 2, 0, 0);
    else if (axis === 'y') this.modelRoot.rotation.set(0, 0, 0);
    else if (axis === 'x') this.modelRoot.rotation.set(0, 0, Math.PI / 2);
    this._autoCenter();
    this.frameAll();
  }
  _buildAxisLabels() {
    const group = new THREE.Group();
    group.name = 'AxisLabels';
    const makeSprite = (text, color, position) => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = color;
      ctx.font = 'bold 72px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, size / 2, size / 2);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(position);
      sprite.scale.set(1.4, 1.4, 1);
      sprite.renderOrder = 20;
      return sprite;
    };
    const o = 0.02;
    const len = this.axisLength;
    const pad = 0.85;
    group.add(makeSprite('X', '#ef4444', new THREE.Vector3(len + pad, o, 0)));
    group.add(makeSprite('Y', '#22c55e', new THREE.Vector3(0, len + pad, 0)));
    group.add(makeSprite('Z', '#3b82f6', new THREE.Vector3(0, o, len + pad)));
    return group;
  }

  setShowAxes(v) {
    if (this.axes) this.axes.visible = v;
    if (this.axesLabels) this.axesLabels.visible = v;
  }
  setShowGrid(v) {
    if (this.grid) this.grid.visible = v;
  }

  setTheme(theme) {
    this.theme = theme;
    this._applyTheme();
  }
  _applyTheme() {
    if (this.theme === 'dark') {
      this.scene.background = new THREE.Color('#0a0d11');
      this.scene.fog = new THREE.Fog('#0a0d11', 50, 220);
      this._rebuildGrid(0x2a3441, 0x1c232c);
      this.hemiLight.color.set(0xd0dae6);
      this.hemiLight.groundColor.set(0x3a4554);
      this.hemiLight.intensity = 0.95;
      this.dirLight.intensity = 1.25;
      this.dirLight2.intensity = 0.45;
      if (this.fillLight) this.fillLight.intensity = 0.22;
      this.renderer.toneMappingExposure = 1.05;
    } else {
      this.scene.background = this._buildSky();
      this.scene.fog = new THREE.Fog('#cad3dc', 80, 280);
      this._rebuildGrid(0x6b7480, 0xc5cad2);
      this.hemiLight.color.set(0xe8eef5);
      this.hemiLight.groundColor.set(0x8a96a8);
      this.hemiLight.intensity = 1.05;
      this.dirLight.intensity = 1.35;
      this.dirLight2.intensity = 0.55;
      if (this.fillLight) this.fillLight.intensity = 0.28;
      this.renderer.toneMappingExposure = 1.12;
    }
  }
  _rebuildGrid(colorCenter, colorGrid) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry?.dispose();
      if (Array.isArray(this.grid.material)) this.grid.material.forEach(m => m.dispose());
      else this.grid.material?.dispose();
    }
    this.grid = new THREE.GridHelper(80, 80, colorCenter, colorGrid);
    this.grid.position.y = -0.01;
    this.scene.add(this.grid);
  }

  // ----- Section box (local clipping on model only — grid/axes stay visible) -----
  _sectionClippingPlanes(box) {
    if (!this._sectionClipPlanes) {
      this._sectionClipPlanes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
      ];
    }
    const p = this._sectionClipPlanes;
    p[0].constant = -box.xMin;
    p[1].constant = box.xMax;
    p[2].constant = -box.yMin;
    p[3].constant = box.yMax;
    p[4].constant = -box.zMin;
    p[5].constant = box.zMax;
    return p;
  }

  _applyModelSectionClipping(box) {
    const planes = this._sectionClippingPlanes(box);
    const apply = (mat) => {
      mat.clippingPlanes = planes;
    };
    this.meshes.forEach(m => apply(m.material));
    this.edgesGroup.children.forEach(c => { if (c.material) apply(c.material); });
    apply(this.highlightMat);
    apply(this.hoverEdgeMat);
    apply(this.selectEdgeMat);
    this.selectionGroup.children.forEach(c => {
      if (c.material) apply(c.material);
    });
  }

  _clearModelSectionClipping() {
    const clear = (mat) => {
      mat.clippingPlanes = null;
    };
    this.meshes.forEach(m => clear(m.material));
    this.edgesGroup.children.forEach(c => { if (c.material) clear(c.material); });
    clear(this.highlightMat);
    clear(this.hoverEdgeMat);
    clear(this.selectEdgeMat);
    this.selectionGroup.children.forEach(c => {
      if (c.material) clear(c.material);
    });
  }

  _ensureSectionVisuals() {
    if (!this.sectionHandleGroup) {
      this.sectionHandleGroup = new THREE.Group();
      this.sectionHandleGroup.name = 'SectionHandles';
      this.scene.add(this.sectionHandleGroup);
      SECTION_FACES.forEach(face => {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.userData.sectionFace = face.id;
        mesh.renderOrder = 12;
        this.sectionHandleGroup.add(mesh);
        this.sectionHandleMeshes.set(face.id, mesh);
      });
    }
  }

  _syncSectionVisuals(box) {
    if (!box) return;
    this._ensureSectionVisuals();
    const cx = (box.xMin + box.xMax) / 2;
    const cy = (box.yMin + box.yMax) / 2;
    const cz = (box.zMin + box.zMax) / 2;
    const sx = Math.max(box.xMax - box.xMin, 0.02);
    const sy = Math.max(box.yMax - box.yMin, 0.02);
    const sz = Math.max(box.zMax - box.zMin, 0.02);
    const pad = 0;
    const placeFace = (id, center, normal, tangentU, tangentV, sizeU, sizeV) => {
      const mesh = this.sectionHandleMeshes.get(id);
      if (!mesh) return;
      const u = tangentU.clone().normalize();
      const v = tangentV.clone().normalize();
      const n = normal.clone().normalize();
      const basis = new THREE.Matrix4().makeBasis(u, v, n);
      mesh.position.copy(center);
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.scale.set(Math.max(sizeU, 0.5), Math.max(sizeV, 0.5), 1);
      mesh.visible = true;
    };

    // Each face lies flat on its box side (PlaneGeometry XY → world normal via basis).
    placeFace('xMin', new THREE.Vector3(box.xMin - pad, cy, cz), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), sy, sz);
    placeFace('xMax', new THREE.Vector3(box.xMax + pad, cy, cz), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), sy, sz);
    placeFace('yMin', new THREE.Vector3(cx, box.yMin - pad, cz), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), sx, sz);
    placeFace('yMax', new THREE.Vector3(cx, box.yMax + pad, cz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), sx, sz);
    placeFace('zMin', new THREE.Vector3(cx, cy, box.zMin - pad), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), sx, sy);
    placeFace('zMax', new THREE.Vector3(cx, cy, box.zMax + pad), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), sx, sy);

    if (!this.sectionBoxEdges) {
      const edgeMat = new THREE.LineBasicMaterial({
        color: this.theme === 'dark' ? 0xf4f6f8 : 0x1f2933,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      });
      const pts = new Array(24).fill(0);
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      this.sectionBoxEdges = new THREE.LineSegments(edgeGeo, edgeMat);
      this.sectionBoxEdges.renderOrder = 11;
      this.scene.add(this.sectionBoxEdges);
    }
    this.sectionBoxEdges.material.color.setHex(this.theme === 'dark' ? 0xf4f6f8 : 0x1f2933);
    const { xMin, xMax, yMin, yMax, zMin, zMax } = box;
    const corners = [
      [xMin, yMin, zMin], [xMax, yMin, zMin], [xMax, yMax, zMin], [xMin, yMax, zMin],
      [xMin, yMin, zMax], [xMax, yMin, zMax], [xMax, yMax, zMax], [xMin, yMax, zMax],
    ];
    const edgeIdx = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const pos = this.sectionBoxEdges.geometry.attributes.position.array;
    let i = 0;
    edgeIdx.forEach(([a, b]) => {
      pos[i++] = corners[a][0]; pos[i++] = corners[a][1]; pos[i++] = corners[a][2];
      pos[i++] = corners[b][0]; pos[i++] = corners[b][1]; pos[i++] = corners[b][2];
    });
    this.sectionBoxEdges.geometry.attributes.position.needsUpdate = true;
    this.sectionBoxEdges.visible = true;

    this.sectionHandleGroup.visible = true;
  }

  _pickSectionHandle(e) {
    if (!this.sectionHandleGroup || !this.sectionHandleGroup.visible) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.mouse.set(x, y);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.sectionHandleGroup.children, false);
    return hits.length ? hits[0].object.userData.sectionFace : null;
  }

  _dragSectionFace(e) {
    if (!this._sectionDrag || !this.sectionBox || !this.sectionBounds) return;
    const face = SECTION_FACES.find(f => f.id === this._sectionDrag.face);
    if (!face) return;

    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.mouse.set(x, y);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const minKey = `${face.axis}Min`;
    const maxKey = `${face.axis}Max`;
    const coord = face.edge === 'min' ? this.sectionBox[minKey] : this.sectionBox[maxKey];
    const point = new THREE.Vector3();
    if (face.axis === 'x') point.set(coord, 0, 0);
    else if (face.axis === 'y') point.set(0, coord, 0);
    else point.set(0, 0, coord);

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(face.normal, point);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return;

    const next = { ...this.sectionBox };
    const b = this.sectionBounds;
    const gap = Math.max(0.05, (b[`${face.axis}Max`] - b[`${face.axis}Min`]) * 0.01);

    if (face.axis === 'x') {
      if (face.edge === 'min') next.xMin = Math.min(Math.max(hit.x, b.xMin), next.xMax - gap);
      else next.xMax = Math.max(Math.min(hit.x, b.xMax), next.xMin + gap);
    } else if (face.axis === 'y') {
      if (face.edge === 'min') next.yMin = Math.min(Math.max(hit.y, b.yMin), next.yMax - gap);
      else next.yMax = Math.max(Math.min(hit.y, b.yMax), next.yMin + gap);
    } else {
      if (face.edge === 'min') next.zMin = Math.min(Math.max(hit.z, b.zMin), next.zMax - gap);
      else next.zMax = Math.max(Math.min(hit.z, b.zMax), next.zMin + gap);
    }

    this.sectionBox = next;
    this._applyModelSectionClipping(next);
    this._syncSectionVisuals(next);
    this._emit('sectionBox', { box: next });
  }

  setSectionBox(enabled, box, bounds) {
    this.sectionEnabled = enabled;
    if (bounds) this.sectionBounds = bounds;
    if (!this.sectionBounds && enabled) this.sectionBounds = this.getModelBounds();

    if (enabled && box) {
      this.sectionBox = { ...box };
      if (!this.clipEnabled) this.renderer.clippingPlanes = [];
      this._applyModelSectionClipping(box);
      this._syncSectionVisuals(box);
    } else {
      this.sectionBox = null;
      this._sectionDrag = null;
      this._clearModelSectionClipping();
      if (!this.clipEnabled) this.renderer.clippingPlanes = [];
      if (this.sectionBoxEdges) this.sectionBoxEdges.visible = false;
      if (this.sectionHandleGroup) this.sectionHandleGroup.visible = false;
      this.renderer.domElement.style.cursor = '';
    }
  }
  getModelBounds() {
    const box = new THREE.Box3();
    this.meshes.forEach(m => { if (m.visible) box.expandByObject(m); });
    if (box.isEmpty()) return null;
    return {
      xMin: box.min.x, xMax: box.max.x,
      yMin: box.min.y, yMax: box.max.y,
      zMin: box.min.z, zMax: box.max.z,
    };
  }

  // ----- Zoom helpers --------------------------------------------------------
  zoomIn(factor = 0.8) {
    this.controls.spherical.radius = Math.max(2, this.controls.spherical.radius * factor);
    this.controls.apply();
  }
  zoomOut(factor = 1.25) {
    this.controls.spherical.radius = Math.min(400, this.controls.spherical.radius * factor);
    this.controls.apply();
  }
  panBy(dx, dy) {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    right.setFromMatrixColumn(this.camera.matrix, 0);
    up.setFromMatrixColumn(this.camera.matrix, 1);
    const scale = this.controls.spherical.radius * 0.05;
    this.controls.target.addScaledVector(right, dx * scale);
    this.controls.target.addScaledVector(up, dy * scale);
    this.controls.apply();
  }
  orbitBy(dTheta, dPhi) {
    this.controls.spherical.theta += dTheta;
    this.controls.spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.controls.spherical.phi + dPhi));
    this.controls.apply();
  }
  getCameraOrientation() {
    return {
      theta: this.controls.spherical.theta,
      phi: this.controls.spherical.phi,
    };
  }

  // ----- Section / clipping (legacy single-plane API kept for compat) -------
  setClipping(enabled, height) {
    this.clipEnabled = enabled;
    if (enabled) {
      if (!this.clippingPlane) {
        this.clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), height);
      } else {
        this.clippingPlane.constant = height;
      }
      this.renderer.clippingPlanes = [this.clippingPlane];
      // Show clipping plane helper
      if (!this.clipHelper) {
        const planeGeom = new THREE.PlaneGeometry(40, 28);
        planeGeom.rotateX(-Math.PI / 2);
        const planeMat = new THREE.MeshBasicMaterial({
          color: 0x6fe7ff, transparent: true, opacity: 0.06,
          side: THREE.DoubleSide, depthWrite: false,
        });
        this.clipHelper = new THREE.Mesh(planeGeom, planeMat);
        this.scene.add(this.clipHelper);
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(planeGeom),
          new THREE.LineBasicMaterial({ color: 0x6fe7ff, transparent: true, opacity: 0.4 }),
        );
        this.clipHelper.add(outline);
      }
      this.clipHelper.visible = true;
      this.clipHelper.position.y = height;
    } else {
      this.renderer.clippingPlanes = [];
      if (this.clipHelper) this.clipHelper.visible = false;
    }
  }
  setClipHeight(h) {
    if (this.clipEnabled && this.clippingPlane) {
      this.clippingPlane.constant = h;
      if (this.clipHelper) this.clipHelper.position.y = h;
    }
  }

  // ----- Measurement -------------------------------------------------------
  setMeasureMode(on) {
    this._measureMode = on;
    this.clearMeasure();
    this.renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  }
  _handleMeasureClick(e) {
    const pt = this._worldPointAt(
      e.clientX - this.renderer.domElement.getBoundingClientRect().left,
      e.clientY - this.renderer.domElement.getBoundingClientRect().top
    );
    if (!pt) return;
    this.measurePoints.push(pt);
    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints;
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const mat = new THREE.LineBasicMaterial({ color: 0x6fe7ff, linewidth: 2 });
      this.measureLine = new THREE.Line(geo, mat);
      this.scene.add(this.measureLine);
      const distance = a.distanceTo(b);
      this._emit('measure', { distance, a, b });
    }
  }
  clearMeasure() {
    if (this.measureLine) { this.scene.remove(this.measureLine); this.measureLine.geometry.dispose(); this.measureLine = null; }
    this.measurePoints = [];
  }

  // ----- Annotations -------------------------------------------------------
  setAnnotationMode(on) {
    this._annoMode = on;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  }
  _handleAnnoClick(e) {
    const id = this._pickAt(e);
    if (this.lastPickPoint) {
      this._emit('anno', { position: this.lastPickPoint.clone(), elementId: id });
    }
  }
  worldToScreen(world) {
    const v = world.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * r.width,
      y: (-v.y * 0.5 + 0.5) * r.height,
      behind: v.z > 1 || v.z < -1,
    };
  }

  // ----- Screenshot --------------------------------------------------------
  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ----- Event helper ------------------------------------------------------
  on(name, fn) { this._listeners[name].push(fn); return () => {
    const arr = this._listeners[name];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }; }
  _emit(name, payload) { (this._listeners[name] || []).forEach(fn => fn(payload)); }

  // ----- Resize / loop -----------------------------------------------------
  scheduleResize() {
    if (this._resizeRaf) return;
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this.handleResize();
    });
  }
  handleResize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (!w || !h) return;
    if (w === this._sizeW && h === this._sizeH) return;
    this._sizeW = w;
    this._sizeH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._running) this.renderer.render(this.scene, this.camera);
  }
  renderLoop() {
    if (!this._running) return;
    const now = performance.now();
    const dt = now - this._lastFrame;
    this._lastFrame = now;
    this._frameTimes.push(dt);
    if (this._frameTimes.length > 60) this._frameTimes.shift();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.renderLoop);
  }
  getFps() {
    const avg = this._frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this._frameTimes.length);
    return Math.round(1000 / avg);
  }

  dispose() {
    this._running = false;
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('click', this.onClick);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

Object.assign(window, { ThreeViewer, OrbitController });
