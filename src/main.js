import * as THREE from "three";
import * as OBC from "@thatopen/components";

/*
 * IFC/CAD engine for Furniture CNC AI.
 * Functionality is based on the public IFC viewer architecture we studied:
 * browser IFC loading, real element geometry, selection/visibility, camera
 * presets, edge overlay, x-ray/wireframe modes and exploded inspection.
 * The implementation is native to our current ThatOpen/Fragments stack.
 */

const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const status = $("status");
const progress = $("progress");
const progressFill = $("progressFill");
const progressText = $("progressText");
const ifcInput = $("ifcInput");
const fileInfo = $("fileInfo");
const modelName = $("modelName");
const elementCount = $("elementCount");
const checks = $("checks");
const meshCount = $("meshCount");
const sizeX = $("sizeX");
const sizeY = $("sizeY");
const sizeZ = $("sizeZ");
const dimX = $("dimX");
const dimY = $("dimY");
const dimZ = $("dimZ");
const selectedPart = $("selectedPart");
const partNameField = $("partNameField");
const partsList = $("partsList");
const partsCountLabel = $("partsCountLabel");
const projectState = $("projectState");
const fitBtn = $("fitBtn");
const explodeBtn = $("explodeBtn");
const resetBtn = $("resetBtn");
const inspectBtn = $("inspectBtn");

if (!viewer) throw new Error("Viewer container not found");

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create();

world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color("#d8dde5");

const hemi = new THREE.HemisphereLight(0xffffff, 0x667085, 2.5);
world.scene.three.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffffff, 4);
keyLight.position.set(900, 1300, 1100);
world.scene.three.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 1.7);
fillLight.position.set(-900, 700, -700);
world.scene.three.add(fillLight);

world.renderer = new OBC.SimpleRenderer(components, viewer);
if (world.renderer.three) {
  world.renderer.three.outputColorSpace = THREE.SRGBColorSpace;
  world.renderer.three.toneMapping = THREE.ACESFilmicToneMapping;
  world.renderer.three.toneMappingExposure = 1.15;
  world.renderer.three.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
}

world.camera = new OBC.OrthoPerspectiveCamera(components);
components.init();

const grids = components.get(OBC.Grids);
grids.create(world);
await world.camera.controls.setLookAt(850, 650, 850, 0, 200, 0);

const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({
  autoSetWasm: false,
  wasm: { path: "https://unpkg.com/web-ifc@0.0.77/", absolute: true }
});

const fragments = components.get(OBC.FragmentsManager);
const workerUrl = await OBC.FragmentsManager.getWorker();
fragments.init(workerUrl);

world.camera.controls.addEventListener("update", () => fragments.core.update());

if (world.onCameraChanged?.add) {
  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) model.useCamera(camera.three);
    fragments.core.update(true);
  });
}

fragments.list.onItemSet.add(({ value: model }) => {
  model.useCamera(world.camera.three);
  if (!world.scene.three.children.includes(model.object)) world.scene.three.add(model.object);
  fragments.core.update(true);
});

let currentModel = null;
let currentLocalIds = [];
let partRecords = [];
let explodedParts = [];
let explodedVisual = null;
let exploded = false;
let explodedFactor = 1;
let selectedIds = new Set();
let hiddenIds = new Set();
let isolatedIds = new Set();
let edgeOverlays = new Map();
let originalModelVisible = true;
let currentBox = null;

const woodTexture = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 1024, 0);
  g.addColorStop(0, "#b98552");
  g.addColorStop(.18, "#d6ad7a");
  g.addColorStop(.42, "#c4945f");
  g.addColorStop(.68, "#e0bd8b");
  g.addColorStop(1, "#b27c49");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  for (let y = -40; y < 1060; y += 13) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 28) {
      ctx.lineTo(x, y + Math.sin(x * .018 + y * .021) * 5 + Math.sin(x * .051) * 2);
    }
    ctx.strokeStyle = "rgba(75,45,24,.24)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.2, 3.4);
  t.anisotropy = 4;
  return t;
})();

const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x000000,
  transparent: false,
  opacity: 1,
  depthTest: true,
  depthWrite: false
});

function setStatus(text) {
  if (status) status.textContent = text;
}

function showProgress(show, value = 0, text = "Загрузка…") {
  if (!progress) return;
  progress.classList.toggle("hidden", !show);
  if (progressFill) progressFill.style.width = Math.max(0, Math.min(100, value * 100)) + "%";
  if (progressText) progressText.textContent = text;
}

function updateChecks(loaded, verified = false) {
  if (!checks) return;
  checks.innerHTML = loaded
    ? '<div class="check ok">✓ IFC загружен</div><div class="check ok">✓ 3D-геометрия отображается</div><div class="check neutral">○ Технологический расчёт — следующий этап</div>'
    : '<div>○ IFC не загружен</div><div>○ Геометрия не проверена</div><div>○ Технология не рассчитана</div>';
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach(m => m?.dispose?.());
    else obj.material?.dispose?.();
  });
  root.removeFromParent();
}

function clearExplodedVisual() {
  if (explodedVisual) disposeObject(explodedVisual);
  explodedVisual = null;
}

function clearEdgeOverlays() {
  for (const lines of edgeOverlays.values()) {
    lines.geometry?.dispose();
    lines.removeFromParent();
  }
  edgeOverlays.clear();
}

function createEdgeOverlay(mesh) {
  if (!mesh?.isMesh || !mesh.geometry) return null;
  const pos = mesh.geometry.getAttribute?.("position");
  if (!pos || pos.count < 3 || pos.count > 180000) return null;
  try {
    const geo = new THREE.EdgesGeometry(mesh.geometry, 18);
    const lines = new THREE.LineSegments(geo, edgeMaterial);
    lines.renderOrder = 20;
    lines.userData.__edgeOverlay = true;
    mesh.add(lines);
    return lines;
  } catch {
    return null;
  }
}

function applyWoodAppearance(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh || obj.userData.__edgeOverlay) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (!m) return;
      if ("map" in m) m.map = woodTexture;
      if ("color" in m) m.color.set("#d0a06c");
      if ("roughness" in m) m.roughness = .72;
      if ("metalness" in m) m.metalness = 0;
      m.needsUpdate = true;
    });
  });
}

function applyViewMode(mode) {
  const root = explodedVisual || currentModel?.object;
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh || obj.userData.__edgeOverlay) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (!m) return;
      if (mode === "wireframe") {
        m.wireframe = true;
        m.transparent = false;
        m.opacity = 1;
      } else if (mode === "xray") {
        m.wireframe = false;
        m.transparent = true;
        m.opacity = .38;
        m.depthWrite = false;
      } else {
        m.wireframe = false;
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
      }
      m.needsUpdate = true;
    });
  });
}

function setEdgesVisible(visible) {
  for (const lines of edgeOverlays.values()) lines.visible = visible;
  if (explodedVisual) {
    explodedVisual.traverse(obj => {
      if (obj.userData.__edgeOverlay) obj.visible = visible;
    });
  }
}

async function getModelBox() {
  if (!currentModel || !currentLocalIds.length) return null;
  try {
    const box = await currentModel.getMergedBox(currentLocalIds);
    if (box && !box.isEmpty()) return box;
  } catch {}
  return currentModel.box || null;
}

async function fitObject() {
  const box = await getModelBox();
  if (!box || box.isEmpty()) return;
  currentBox = box.clone();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 1.8 || 100;
  await world.camera.controls.setLookAt(
    center.x + radius,
    center.y + radius * .75,
    center.z + radius,
    center.x, center.y, center.z, true
  );
  fragments.core.update(true);
}

function getPartDirection(box, center, index) {
  const d = box.getCenter(new THREE.Vector3()).sub(center);
  if (d.lengthSq() < 0.0001) {
    const fallback = new THREE.Vector3((index % 3) - 1, ((index + 1) % 3) - 1, Math.floor(index / 3) - 1);
    d.copy(fallback.lengthSq() ? fallback : new THREE.Vector3(1, 0, 0));
  }
  return d.normalize();
}

function geometryDataBox(data) {
  if (!data?.positions || !data.positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  if (data.indices) geometry.setIndex(Array.from(data.indices));
  if (data.transform) geometry.applyMatrix4(data.transform);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ? geometry.boundingBox.clone() : null;
  geometry.dispose();
  return box;
}

function nameSubPart(index, total, parentName) {
  if (total === 11) {
    const names = [
      "Задняя стенка HDF/HDFR",
      "Боковина правая",
      "Боковина левая",
      "Дно",
      "Крышка",
      "Ножка P01",
      "Ножка P02",
      "Ножка P03",
      "Ножка P04",
      "Фасад нижнего ящика",
      "Фасад верхнего ящика"
    ];
    return names[index] || ("Деталь " + (index + 1));
  }
  return (parentName ? parentName + " — " : "") + "Деталь " + (index + 1);
}

function createMeshFromGeometryData(data) {
  if (!data?.positions || !data?.indices) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  if (data.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  else geometry.computeVertexNormals();
  geometry.setIndex(Array.from(data.indices));
  geometry.computeBoundingBox();

  const material = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0xd0a06c,
    roughness: .72,
    metalness: 0
  });
  const mesh = new THREE.Mesh(geometry, material);

  if (data.transform?.isMatrix4) mesh.applyMatrix4(data.transform);
  else if (Array.isArray(data.transform) || ArrayBuffer.isView(data.transform)) {
    const m = new THREE.Matrix4().fromArray(Array.from(data.transform));
    mesh.applyMatrix4(m);
  }

  const lines = createEdgeOverlay(mesh);
  if (lines) lines.visible = true;
  return mesh;
}

async function buildExplodedVisual(factor = 1) {
  if (!currentModel || !currentLocalIds.length) return;

  clearExplodedVisual();
  explodedParts = [];
  explodedVisual = new THREE.Group();
  explodedVisual.name = "FurnitureExplodedAssembly";

  const geometryGroups = await currentModel.getItemsGeometry(currentLocalIds);
  const overall = await currentModel.getMergedBox(currentLocalIds);
  const center = overall.getCenter(new THREE.Vector3());
  const size = overall.getSize(new THREE.Vector3());
  const distance = Math.max(Math.max(size.x, size.y, size.z) * .28, 80) * factor;

  let partIndex = 0;
  for (let localIndex = 0; localIndex < currentLocalIds.length; localIndex++) {
    const localId = currentLocalIds[localIndex];
    const group = geometryGroups[localIndex] || [];
    const parent = partRecords.find(p => p.localId === localId);
    for (let geometryIndex = 0; geometryIndex < group.length; geometryIndex++) {
      const data = group[geometryIndex];
      const mesh = createMeshFromGeometryData(data);
      if (!mesh) continue;

      const box = new THREE.Box3().setFromObject(mesh);
      const partCenter = box.getCenter(new THREE.Vector3());
      const direction = getPartDirection(box, center, partIndex++);
      const part = new THREE.Group();
      part.name = nameSubPart(geometryIndex + (localIndex ? 0 : 0), group.length === 11 ? 11 : group.length, parent?.name);
      part.userData.localId = localId;
      part.userData.geometryIndex = geometryIndex;
      part.userData.baseCenter = partCenter.clone();
      part.userData.direction = direction.clone();

      part.add(mesh);
      part.position.copy(direction.multiplyScalar(distance));
      explodedVisual.add(part);

      explodedParts.push({ part, mesh, localId, geometryIndex, box, data });
    }
  }

  world.scene.three.add(explodedVisual);
  explodedVisual.visible = true;
  if (currentModel.object) {
    originalModelVisible = currentModel.object.visible;
    currentModel.object.visible = false;
  }
  exploded = factor > 0;
  explodedFactor = factor;
  fragments.core.update(true);
}

async function resetExploded() {
  clearExplodedVisual();
  if (currentModel?.object) currentModel.object.visible = originalModelVisible;
  exploded = false;
  explodedFactor = 0;
  selectedIds.clear();
  fragments.core.update(true);
}

async function setExplodedFactor(factor) {
  factor = Math.max(0, Math.min(1, factor));
  if (!currentModel) return;
  if (factor === 0) {
    await resetExploded();
    return;
  }
  await buildExplodedVisual(factor);
}

function extractValue(raw, key) {
  const v = raw?.[key];
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

async function buildPartsList() {
  if (!partsList) return;
  partsList.innerHTML = "";
  partRecords = [];

  if (!currentModel || !currentLocalIds.length) {
    if (partsCountLabel) partsCountLabel.textContent = "(0)";
    partsList.innerHTML = '<div class="empty-state">Загрузите IFC — детали появятся здесь.</div>';
    return;
  }

  const itemData = await currentModel.getItemsData(currentLocalIds).catch(() => []);
  const geometryGroups = await currentModel.getItemsGeometry(currentLocalIds);

  for (let localIndex = 0; localIndex < currentLocalIds.length; localIndex++) {
    const localId = currentLocalIds[localIndex];
    const raw = itemData[localIndex] || {};
    const parentName = extractValue(raw, "Name") || extractValue(raw, "ObjectType") || extractValue(raw, "Tag") || "IFC элемент";
    const group = geometryGroups[localIndex] || [];

    for (let geometryIndex = 0; geometryIndex < group.length; geometryIndex++) {
      const data = group[geometryIndex];
      const box = geometryDataBox(data);
      if (!box || box.isEmpty()) continue;

      const size = box.getSize(new THREE.Vector3());
      const record = {
        localId,
        geometryIndex,
        name: nameSubPart(geometryIndex, group.length, String(parentName)),
        size,
        box,
        raw,
        data
      };
      partRecords.push(record);

      const row = document.createElement("div");
      row.className = "part-row";
      row.dataset.partIndex = String(partRecords.length - 1);
      row.innerHTML =
        '<span class="part-no">' + partRecords.length + '</span>' +
        '<span class="part-name">' + record.name.replace(/[<>]/g, "") + '</span>' +
        '<span class="part-size">' +
        size.x.toFixed(0) + "×" + size.y.toFixed(0) + "×" + size.z.toFixed(0) +
        '</span>';

      row.addEventListener("click", async () => {
        document.querySelectorAll(".part-row").forEach(x => x.classList.remove("selected"));
        row.classList.add("selected");
        selectedIds = new Set([record.localId]);
        selectPart(record);
        await focusRecord(record);
      });

      partsList.appendChild(row);
    }
  }

  if (partsCountLabel) partsCountLabel.textContent = "(" + partRecords.length + ")";
}

function selectPart(record) {
  if (!record) return;
  if (selectedPart) selectedPart.textContent = record.name;
  if (partNameField) partNameField.value = record.name;
  if (dimX) dimX.textContent = record.size.x.toFixed(1) + " mm";
  if (dimY) dimY.textContent = record.size.y.toFixed(1) + " mm";
  if (dimZ) dimZ.textContent = record.size.z.toFixed(1) + " mm";
}

async function focusRecord(record) {
  if (!record) return;
  const c = record.box.getCenter(new THREE.Vector3());
  const s = record.box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) * 3 || 100;
  await world.camera.controls.setLookAt(c.x + r, c.y + r * .7, c.z + r, c.x, c.y, c.z, true);
  fragments.core.update(true);
}

async function updateGeometryStats() {
  if (!currentModel || !currentLocalIds.length) {
    if (meshCount) meshCount.textContent = "0";
    if (sizeX) sizeX.textContent = "0";
    if (sizeY) sizeY.textContent = "0";
    if (sizeZ) sizeZ.textContent = "0";
    if (elementCount) elementCount.textContent = "Элементы: 0";
    return null;
  }

  const box = await currentModel.getMergedBox(currentLocalIds);
  const size = box.getSize(new THREE.Vector3());

  if (meshCount) meshCount.textContent = String(currentLocalIds.length);
  if (sizeX) sizeX.textContent = size.x.toFixed(1) + " mm";
  if (sizeY) sizeY.textContent = size.y.toFixed(1) + " mm";
  if (sizeZ) sizeZ.textContent = size.z.toFixed(1) + " mm";
  if (elementCount) elementCount.textContent = "Элементы: " + currentLocalIds.length;

  currentBox = box.clone();
  return { box, size, meshes: currentLocalIds.length };
}

function drawingSvg(part) {
  const dims = [part.size.x, part.size.y, part.size.z].sort((a,b) => b-a);
  const w = Math.max(70, Math.min(270, dims[0] * 0.42));
  const h = Math.max(45, Math.min(190, dims[1] * 0.42));
  return '<svg viewBox="0 0 340 230" aria-label="Чертёж ' + part.name.replace(/[<>]/g, "") + '">' +
    '<rect x="' + (170-w/2).toFixed(1) + '" y="' + (100-h/2).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="none" stroke="#111827" stroke-width="2"/>' +
    '<line x1="' + (170-w/2).toFixed(1) + '" y1="' + (110+h/2).toFixed(1) + '" x2="' + (170+w/2).toFixed(1) + '" y2="' + (110+h/2).toFixed(1) + '" stroke="#4b5563"/>' +
    '<text x="170" y="' + (128+h/2).toFixed(1) + '" text-anchor="middle" font-size="11" fill="#374151">' + dims[0].toFixed(1) + ' mm</text>' +
    '<line x1="' + (185+w/2).toFixed(1) + '" y1="' + (100-h/2).toFixed(1) + '" x2="' + (185+w/2).toFixed(1) + '" y2="' + (100+h/2).toFixed(1) + '" stroke="#4b5563"/>' +
    '<text x="' + (198+w/2).toFixed(1) + '" y="104" font-size="11" fill="#374151" transform="rotate(90 ' + (198+w/2).toFixed(1) + ' 104)">' + dims[1].toFixed(1) + ' mm</text>' +
    '<text x="12" y="20" font-size="12" font-weight="700" fill="#111827">' + part.name.replace(/[<>]/g, "") + '</text>' +
    '<text x="12" y="215" font-size="10" fill="#6b7280">Толщина: ' + dims[2].toFixed(1) + ' mm</text>' +
    '</svg>';
}

function renderDocumentation() {
  const drawings = $("drawingsView");
  const cutting = $("cuttingView");
  const hardware = $("hardwareView");
  const spec = $("specView");

  if (drawings) {
    drawings.innerHTML =
      '<div class="sheet"><h2>Чертежи деталей · ' + partRecords.length + ' шт.</h2>' +
      '<div class="drawing-grid">' +
      partRecords.map(p => '<div class="drawing-card"><h3>' + p.name.replace(/[<>]/g, "") + '</h3>' + drawingSvg(p) +
      '<div style="font-size:10px;color:#687586">X ' + p.size.x.toFixed(1) + ' · Y ' + p.size.y.toFixed(1) + ' · Z ' + p.size.z.toFixed(1) + ' mm</div></div>').join("") +
      '</div></div>';
  }

  if (cutting) {
    cutting.innerHTML =
      '<div class="sheet"><h2>Карта раскроя · исходная геометрия IFC</h2>' +
      '<table class="cut-list"><thead><tr><th>№</th><th>Деталь</th><th>X</th><th>Y</th><th>Z</th><th>Материал</th><th>Кромка</th></tr></thead><tbody>' +
      partRecords.map((p,i) => '<tr><td>' + (i+1) + '</td><td>' + p.name.replace(/[<>]/g, "") + '</td><td>' + p.size.x.toFixed(1) + '</td><td>' + p.size.y.toFixed(1) + '</td><td>' + p.size.z.toFixed(1) + '</td><td>По IFC</td><td>ABS 1 мм</td></tr>').join("") +
      '</tbody></table></div>';
  }

  if (hardware) {
    hardware.innerHTML =
      '<div class="sheet"><h2>Фурнитура</h2><div class="hardware-grid">' +
      '<div class="hardware-card"><b>BOYARD SB38GRPH.1/350</b><span>2 пары для 2 ящиков. Технологические параметры берутся из библиотеки.</span></div>' +
      '<div class="hardware-card"><b>Стяжки корпуса</b><span>BOYARD — тип и количество определяются после технологического расчёта.</span></div>' +
      '<div class="hardware-card"><b>Задняя стенка</b><span>HDF/HDFR 3,2 мм · крепление гвоздями.</span></div>' +
      '</div></div>';
  }

  if (spec) {
    spec.innerHTML =
      '<div class="sheet"><h2>Спецификация · ' + partRecords.length + ' геометрических деталей</h2>' +
      '<table class="spec-table"><thead><tr><th>№</th><th>Позиция</th><th>Количество</th><th>Размер</th><th>Статус</th></tr></thead><tbody>' +
      partRecords.map((p,i) => '<tr><td>' + (i+1) + '</td><td>' + p.name.replace(/[<>]/g, "") + '</td><td>1</td><td>' +
      p.size.x.toFixed(1) + ' × ' + p.size.y.toFixed(1) + ' × ' + p.size.z.toFixed(1) + ' mm</td><td>IFC</td></tr>').join("") +
      '</tbody></table></div>';
  }
}

function applyModelEdges() {
  clearEdgeOverlays();
  const root = currentModel?.object;
  if (!root) return;
  root.traverse(obj => {
    if (!obj.isMesh || obj.userData.__edgeOverlay) return;
    const lines = createEdgeOverlay(obj);
    if (lines) edgeOverlays.set(obj.uuid, lines);
  });
}

async function loadIfc(file) {
  if (!file) return;

  setStatus("Читаю IFC…");
  showProgress(true, 0, "Чтение IFC");
  clearExplodedVisual();
  clearEdgeOverlays();
  selectedIds.clear();
  hiddenIds.clear();
  isolatedIds.clear();
  currentLocalIds = [];
  partRecords = [];

  if (currentModel) {
    try { await currentModel.dispose(); } catch {}
    currentModel = null;
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  if (fileInfo) fileInfo.textContent = file.name + " · " + Math.round(file.size / 1024) + " KB";

  try {
    const model = await ifcLoader.load(
      buffer,
      false,
      "FurnitureModel_" + Date.now(),
      {
        processData: {
          progressCallback: (p) => {
            const value = typeof p === "number" ? p : 0;
            showProgress(true, value, "Конвертация IFC " + Math.round(value * 100) + "%");
          }
        }
      }
    );

    currentModel = model;
    model.useCamera(world.camera.three);

    if (!world.scene.three.children.includes(model.object)) {
      world.scene.three.add(model.object);
    }

    fragments.core.update(true);

    currentLocalIds = await model.getItemsIdsWithGeometry();
    if (!currentLocalIds.length) {
      throw new Error("IFC загружен, но геометрические элементы не получены.");
    }

    applyWoodAppearance(model.object);
    applyModelEdges();
    setEdgesVisible(true);

    await buildPartsList();
    const stats = await updateGeometryStats();
    renderDocumentation();

    if (modelName) modelName.textContent = file.name;
    if (projectState) projectState.textContent = "IFC загружен · " + currentLocalIds.length + " геометрических элементов";

    updateChecks(true, true);
    setStatus("IFC загружен · реальная 3D-геометрия · " + currentLocalIds.length + " элементов");
    showProgress(false);

    await fitObject();
    fragments.core.update(true);

    console.info("IFC ready", {
      modelId: model.modelId,
      elements: currentLocalIds.length,
      size: stats?.size
    });
  } catch (error) {
    console.error(error);
    setStatus("Ошибка загрузки IFC");
    showProgress(false);
    if (fileInfo) fileInfo.textContent = "Ошибка: " + (error?.message || error);
    updateChecks(false);
  }
}

async function setVisibility(ids, visible) {
  if (!currentModel || !ids.length) return;
  try {
    await currentModel.setVisible(ids, visible);
    fragments.core.update(true);
  } catch (error) {
    console.warn("setVisible failed", error);
  }
}

async function showAll() {
  hiddenIds.clear();
  isolatedIds.clear();
  await setVisibility(currentLocalIds, true);
}

async function hideSelected() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  ids.forEach(id => hiddenIds.add(id));
  await setVisibility(ids, false);
}

async function isolateSelected() {
  if (!selectedIds.size) return;
  const keep = new Set(selectedIds);
  isolatedIds = keep;
  const hide = currentLocalIds.filter(id => !keep.has(id));
  await setVisibility(hide, false);
  await setVisibility([...keep], true);
}

async function focusSelected() {
  const records = partRecords.filter(p => selectedIds.has(p.localId));
  if (records.length) {
    const box = records.reduce((b, p) => b.union(p.box.clone()), new THREE.Box3());
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 3 || 100;
    await world.camera.controls.setLookAt(c.x + r, c.y + r * .7, c.z + r, c.x, c.y, c.z, true);
    fragments.core.update(true);
  } else {
    await fitObject();
  }
}

function cameraPreset(name) {
  if (!currentBox || currentBox.isEmpty()) return;
  const c = currentBox.getCenter(new THREE.Vector3());
  const s = currentBox.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) * 1.8 || 100;
  const targets = {
    iso: [c.x + r, c.y + r * .75, c.z + r],
    top: [c.x, c.y + r, c.z],
    front: [c.x, c.y, c.z + r],
    back: [c.x, c.y, c.z - r],
    left: [c.x - r, c.y, c.z],
    right: [c.x + r, c.y, c.z]
  };
  const p = targets[name] || targets.iso;
  world.camera.controls.setLookAt(...p, c.x, c.y, c.z, true);
  fragments.core.update(true);
}

ifcInput?.addEventListener("change", (e) => loadIfc(e.target.files?.[0]));

viewer.addEventListener("dragover", e => e.preventDefault());
viewer.addEventListener("drop", e => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find(f => /\.ifc$/i.test(f.name));
  if (file) loadIfc(file);
});

fitBtn?.addEventListener("click", () => fitObject());
explodeBtn?.addEventListener("click", async () => {
  if (!currentModel) return;
  try {
    await setExplodedFactor(exploded ? .45 : 1);
    setStatus("Взрывная схема: " + explodedParts.length + " отдельных геометрических деталей");
  } catch (error) {
    console.error("Exploded view failed", error);
    setStatus("Ошибка взрывной схемы: " + (error?.message || error));
  }
});
resetBtn?.addEventListener("click", () => resetExploded());
inspectBtn?.addEventListener("click", () => focusSelected());

document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", async () => {
    const v = button.dataset.view;
    if (!currentModel) return;
    if (v === "explode") await setExplodedFactor(1);
    else if (v === "assembled") await resetExploded();
    else cameraPreset(v === "side" ? "right" : v);
  });
});

document.querySelectorAll(".work-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".work-tab").forEach(x => x.classList.toggle("active", x === tab));
    document.querySelectorAll(".view-panel").forEach(x => x.classList.remove("active"));
    const target = $(name === "model" ? "modelView" : name + "View");
    target?.classList.add("active");
  });
});

document.addEventListener("keydown", async (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "f") return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

  const k = e.key.toLowerCase();
  if (k === "o") ifcInput?.click();
  else if (k === "f") await focusSelected();
  else if (k === "a") await showAll();
  else if (k === "h") await hideSelected();
  else if (k === "i") await isolateSelected();
  else if (k === "e") setEdgesVisible([...edgeOverlays.values()].some(x => !x.visible));
  else if (k === "x") applyViewMode("xray");
  else if (k === "w") applyViewMode("wireframe");
  else if (k === "s") applyViewMode("shaded");
  else if (k === "1") cameraPreset("iso");
  else if (k === "2") cameraPreset("top");
  else if (k === "3") cameraPreset("front");
  else if (k === "4") cameraPreset("back");
  else if (k === "5") cameraPreset("left");
  else if (k === "6") cameraPreset("right");
  else if (e.key === "Escape") {
    selectedIds.clear();
    await showAll();
    applyViewMode("shaded");
  }
});

window.addEventListener("resize", () => fragments.core.update(true));

setStatus("Готов. Загрузите IFC-файл.");
updateChecks(false);
