import * as THREE from "three";
import * as OBC from "@thatopen/components";

const viewer = document.getElementById("viewer");
const status = document.getElementById("status");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const ifcInput = document.getElementById("ifcInput");
const fileInfo = document.getElementById("fileInfo");
const modelName = document.getElementById("modelName");
const elementCount = document.getElementById("elementCount");
const checks = document.getElementById("checks");
const meshCount = document.getElementById("meshCount");
const sizeX = document.getElementById("sizeX");
const sizeY = document.getElementById("sizeY");
const sizeZ = document.getElementById("sizeZ");
const dimX = document.getElementById("dimX");
const dimY = document.getElementById("dimY");
const dimZ = document.getElementById("dimZ");
const selectedPart = document.getElementById("selectedPart");
const partsList = document.getElementById("partsList");
const partsCountLabel = document.getElementById("partsCountLabel");
const projectState = document.getElementById("projectState");

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create();
world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color("#d8dde5");
world.scene.three.add(new THREE.HemisphereLight(0xffffff, 0x667085, 2.8));
const keyLight = new THREE.DirectionalLight(0xffffff, 4.0);
keyLight.position.set(900, 1300, 1100);
world.scene.three.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 1.8);
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
  wasm: {
    path: "https://unpkg.com/web-ifc@0.0.77/",
    absolute: true
  }
});

const workerUrl = await OBC.FragmentsManager.getWorker();
const fragments = components.get(OBC.FragmentsManager);
fragments.init(workerUrl);

world.camera.controls.addEventListener("update", () => fragments.core.update());

if (world.onCameraChanged?.add) {
  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) model.useCamera(camera.three);
    fragments.core.update(true);
  });
}

fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
  if (!("isLodMaterial" in material && material.isLodMaterial)) {
    material.polygonOffset = true;
    material.polygonOffsetUnits = 1;
    material.polygonOffsetFactor = Math.random();
  }
});

let currentModel = null;
let originalTransforms = new Map();
let exploded = false;
const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x17202b,
  transparent: true,
  opacity: 0.92,
  depthTest: true,
  depthWrite: false
});

function addEdgeOverlays(root) {
  if (!root) return;
  let edgeCount = 0;
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry || obj.userData?.__edgeOverlay) return;
    const position = obj.geometry.getAttribute?.("position");
    if (!position || position.count < 3 || position.count > 180000) return;
    try {
      const edges = new THREE.EdgesGeometry(obj.geometry, 14);
      if (!edges.getAttribute("position")?.count) {
        edges.dispose();
        return;
      }
      const lines = new THREE.LineSegments(edges, edgeMaterial);
      lines.name = "CNC_Edges";
      lines.renderOrder = 20;
      lines.frustumCulled = false;
      lines.userData.__edgeOverlay = true;
      obj.add(lines);
      edgeCount += 1;
    } catch (error) {
      console.warn("Edge overlay skipped", error);
    }
  });
  return edgeCount;
}

fragments.list.onItemSet.add(({ value: model }) => {
  model.useCamera(world.camera.three);
  if (!world.scene.three.children.includes(model.object)) {
    world.scene.three.add(model.object);
  }
  fragments.core.update(true);
});

function setStatus(text) {
  status.textContent = text;
}

function showProgress(show, value = 0, text = "Загрузка…") {
  progress.classList.toggle("hidden", !show);
  progressFill.style.width = Math.max(0, Math.min(100, value * 100)) + "%";
  progressText.textContent = text;
}

async function waitForRenderableModel(model, timeoutMs = 5000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    model.object?.updateMatrixWorld?.(true);
    let hasGeometry = false;
    model.object?.traverse?.(obj => {
      if (obj.isMesh && obj.geometry?.getAttribute?.("position")?.count) hasGeometry = true;
    });
    if (hasGeometry || model.object?.children?.length) return true;
    fragments.core.update(true);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return false;
}

function fitObject(object) {
  if (!object) return;
  object.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    world.camera.controls.setLookAt(900, 700, 900, 0, 0, 0, true);
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 1.6 || 100;
  world.camera.controls.setLookAt(
    center.x + radius,
    center.y + radius * 0.75,
    center.z + radius,
    center.x,
    center.y,
    center.z,
    true
  );
}

function collectTransforms(root) {
  originalTransforms.clear();
  root.traverse(obj => {
    originalTransforms.set(obj, {
      position: obj.position.clone(),
      rotation: obj.rotation.clone(),
      scale: obj.scale.clone()
    });
  });
}

function explodeObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const children = root.children.filter(c => c.visible);
  const size = box.getSize(new THREE.Vector3());
  const amount = Math.max(Math.max(size.x, size.y, size.z) * 0.42, 140);

  children.forEach((child, index) => {
    const childBox = new THREE.Box3().setFromObject(child);
    const c = childBox.getCenter(new THREE.Vector3());
    const dir = c.sub(center);
    if (dir.lengthSq() < 0.0001) {
      dir.set((index % 3) - 1, Math.floor(index / 3) - 1, 0);
    }
    dir.normalize();
    // Make the exploded view directional and readable: vertical parts separate
    // left/right, horizontal parts move up/down, rear parts move backward.
    if (Math.abs(dir.x) > Math.abs(dir.z) && Math.abs(dir.x) > Math.abs(dir.y)) {
      dir.y *= 0.35;
    } else if (Math.abs(dir.y) > Math.abs(dir.z)) {
      dir.x *= 0.45;
      dir.z *= 0.45;
    }
    child.position.add(dir.multiplyScalar(amount));
  });
}

function resetTransforms() {
  originalTransforms.forEach((t, obj) => {
    obj.position.copy(t.position);
    obj.rotation.copy(t.rotation);
    obj.scale.copy(t.scale);
  });
}

function selectPart(obj, name = "Деталь") {
  const box = new THREE.Box3().setFromObject(obj);
  const s = box.getSize(new THREE.Vector3());
  selectedPart.textContent = name;
  dimX.textContent = s.x.toFixed(1) + " мм";
  dimY.textContent = s.y.toFixed(1) + " мм";
  dimZ.textContent = s.z.toFixed(1) + " мм";
}

function buildPartsList(root) {
  partsList.innerHTML = "";
  const items = root.children.filter(c => c.visible && !c.userData?.__edgeOverlay);
  partsCountLabel.textContent = "(" + items.length + ")";
  items.forEach((obj, i) => {
    const row = document.createElement("div");
    row.className = "part-row";
    const box = new THREE.Box3().setFromObject(obj);
    const s = box.getSize(new THREE.Vector3());
    row.innerHTML = `<span class="part-no">${i + 1}</span><span class="part-name">${obj.name || "Деталь " + (i + 1)}</span><span class="part-size">${s.x.toFixed(0)}×${s.y.toFixed(0)}×${s.z.toFixed(0)}</span>`;
    row.addEventListener("click", () => {
      document.querySelectorAll(".part-row").forEach(x => x.classList.remove("selected"));
      row.classList.add("selected");
      selectPart(obj, obj.name || "Деталь " + (i + 1));
    });
    partsList.appendChild(row);
  });
}

function renderDocumentation(root) {
  const box = new THREE.Box3().setFromObject(root);
  const s = box.getSize(new THREE.Vector3());
  const rows = Array.from(root.children.filter(c => c.visible && !c.userData?.__edgeOverlay)).slice(0, 40).map((obj,i) => {
    const b=new THREE.Box3().setFromObject(obj), z=b.getSize(new THREE.Vector3());
    return `<tr><td>${i+1}</td><td>${obj.name || "Деталь "+(i+1)}</td><td>${z.x.toFixed(1)}</td><td>${z.y.toFixed(1)}</td><td>${z.z.toFixed(1)}</td><td>ЛДСП EGGER 20</td></tr>`;
  }).join("");
  document.getElementById("drawingsView").innerHTML=`<div class="sheet"><h2>Чертежи</h2><div class="drawing-grid"><div class="drawing-card"><h3>Главный вид</h3><svg viewBox="0 0 500 280"><rect x="120" y="35" width="260" height="210" fill="#e8edf2" stroke="#18222d" stroke-width="3"/><line x1="120" y1="258" x2="380" y2="258" stroke="#18222d"/><text x="250" y="275" text-anchor="middle" font-size="13">${s.x.toFixed(0)} мм</text><line x1="95" y1="35" x2="95" y2="245" stroke="#18222d"/><text x="70" y="145" text-anchor="middle" font-size="13" transform="rotate(-90 70 145)">${s.z.toFixed(0)} мм</text></svg></div><div class="drawing-card"><h3>Боковой вид</h3><svg viewBox="0 0 500 280"><rect x="165" y="35" width="170" height="210" fill="#e8edf2" stroke="#18222d" stroke-width="3"/><text x="250" y="275" text-anchor="middle" font-size="13">${s.y.toFixed(0)} мм</text></svg></div></div></div>`;
  document.getElementById("cuttingView").innerHTML=`<div class="sheet"><h2>Карта раскроя</h2><table class="cut-list"><thead><tr><th>№</th><th>Деталь</th><th>X</th><th>Y</th><th>Z</th><th>Материал</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  document.getElementById("hardwareView").innerHTML=`<div class="sheet"><h2>Фурнитура</h2><div class="hardware-grid"><div class="hardware-card"><b>BOYARD SB38GRPH.1/350</b><span>Направляющие ящиков · 2 комплекта · TIP-ON + soft-close</span></div><div class="hardware-card"><b>Стяжки корпуса</b><span>BOYARD · количество рассчитывается по соединениям IFC</span></div><div class="hardware-card"><b>Крепление задней стенки</b><span>Гвозди · HDF/HDFR 3,2 мм</span></div></div></div>`;
  document.getElementById("specView").innerHTML=`<div class="sheet"><h2>Спецификация</h2><table class="spec-table"><thead><tr><th>Позиция</th><th>Наименование</th><th>Количество</th><th>Материал / артикул</th></tr></thead><tbody><tr><td>1</td><td>Корпусные детали</td><td>${Math.max(0,root.children.length)}</td><td>ЛДСП EGGER 20 мм</td></tr><tr><td>2</td><td>Фасады ящиков</td><td>2</td><td>ЛДСП EGGER 20 мм</td></tr><tr><td>3</td><td>Задняя стенка</td><td>1</td><td>HDF/HDFR 3,2 мм</td></tr><tr><td>4</td><td>Кромка</td><td>по деталям</td><td>ABS 1 мм, по кругу</td></tr></tbody></table></div>`;
}

function switchTab(tab) {
  document.querySelectorAll(".work-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view-panel").forEach(v => v.classList.remove("active"));
  const map={model:"modelView",drawings:"drawingsView",cutting:"cuttingView",hardware:"hardwareView",spec:"specView"};
  document.getElementById(map[tab]).classList.add("active");
  if (tab !== "model" && currentModel) renderDocumentation(currentModel.object);
}

document.querySelectorAll(".work-tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => {
  if (!currentModel) return;
  const v=b.dataset.view;
  if(v==="explode" && !exploded){explodeObject(currentModel.object); exploded=true;}
  else if(v==="assembled" && exploded){resetTransforms(); exploded=false;}
  const box=new THREE.Box3().setFromObject(currentModel.object), c=box.getCenter(new THREE.Vector3()), s=box.getSize(new THREE.Vector3()), r=Math.max(...[s.x,s.y,s.z])*1.8;
  const targets={front:[c.x,c.y+r,c.z,c.x,c.y,c.z],side:[c.x+r,c.y,c.z,c.x,c.y,c.z],top:[c.x,c.y,c.z+r,c.x,c.y,c.z],bottom:[c.x,c.y,c.z-r,c.x,c.y,c.z]};
  if(targets[v]) world.camera.controls.setLookAt(...targets[v],true);
  fragments.core.update(true);
}));

function updateGeometryStats(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  let meshes = 0;
  let objects = 0;
  root.traverse(obj => {
    objects += 1;
    if (obj.isMesh) meshes += 1;
  });
  const parts = Math.max(meshes, root.children?.length || 0);
  meshCount.textContent = String(parts);
  sizeX.textContent = size.x.toFixed(1) + " mm";
  sizeY.textContent = size.y.toFixed(1) + " mm";
  sizeZ.textContent = size.z.toFixed(1) + " mm";
  elementCount.textContent = "Элементы: " + parts;
  return { box, size, meshes: parts, objects };
}

function updateChecks(loaded, verified = false) {
  checks.innerHTML = loaded
    ? "<div class=\"check ok\">✓ IFC загружен</div><div class=\"check ok\">✓ 3D-геометрия отображается</div><div class=\"check neutral\">○ Технологический расчёт — следующий этап</div>"
    : "<div>○ IFC не загружен</div><div>○ Геометрия не проверена</div><div>○ Технология не рассчитана</div>";
}

async function loadIfc(file) {
  if (!file) return;
  setStatus("Читаю IFC…");
  showProgress(true, 0, "Чтение IFC");
  if (currentModel) {
    world.scene.three.remove(currentModel.object);
    currentModel = null;
    originalTransforms.clear();
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  fileInfo.textContent = file.name + " · " + Math.round(file.size / 1024) + " KB";

  try {
    const model = await ifcLoader.load(buffer, true, "FurnitureModel", {
      processData: {
        progressCallback: (p) => {
          const value = typeof p === "number" ? p : 0;
          showProgress(true, value, "Конвертация IFC " + Math.round(value * 100) + "%");
        }
      }
    });

    currentModel = model;
    model.useCamera(world.camera.three);
    if (!world.scene.three.children.includes(model.object)) {
      world.scene.three.add(model.object);
    }

    const renderable = await waitForRenderableModel(model);
    model.object.updateMatrixWorld?.(true);
    fragments.core.update(true);
    if (!renderable) {
      throw new Error("IFC загружен, но 3D-геометрия не появилась в Fragments-модели.");
    }

    addEdgeOverlays(model.object);
    collectTransforms(model.object);
    fitObject(model.object);
    modelName.textContent = file.name;
    elementCount.textContent = "3D-модель загружена";
    const stats = updateGeometryStats(model.object);
    buildPartsList(model.object);
    renderDocumentation(model.object);
    projectState.textContent = "IFC загружен · " + partsList.children.length + " деталей";
    updateChecks(true, false);
    setStatus("IFC загружен · 3D-модель подключена");
    console.info("IFC loaded", { fragments: fragments.list.size, objects: stats.objects, parts: stats.meshes, size: stats.size });
    setStatus("IFC загружен · рабочее пространство готово");
    showProgress(false);
    requestAnimationFrame(() => {
      model.object.updateMatrixWorld?.(true);
      fragments.core.update(true);
      fitObject(model.object);
    });
  } catch (error) {
    console.error(error);
    setStatus("Ошибка загрузки IFC");
    showProgress(false);
    fileInfo.textContent = "Ошибка: " + (error?.message || error);
    updateChecks(false);
  }
}

ifcInput.addEventListener("change", e => loadIfc(e.target.files?.[0]));

document.getElementById("fitBtn").addEventListener("click", () => {
  if (currentModel) fitObject(currentModel.object);
});

document.getElementById("explodeBtn").addEventListener("click", () => {
  if (!currentModel) return;
  if (!exploded) {
    explodeObject(currentModel.object);
    exploded = true;
  } else {
    resetTransforms();
    exploded = false;
  }
  fragments.core.update(true);
});

document.getElementById("inspectBtn").addEventListener("click", () => {
  if (!currentModel) {
    setStatus("Сначала загрузите IFC");
    return;
  }
  const s = updateGeometryStats(currentModel.object);
  const valid = s.meshes > 0 && [s.size.x, s.size.y, s.size.z].every(v => Number.isFinite(v) && v > 0);
  updateChecks(true, valid);
  setStatus(valid ? "Проверка геометрии пройдена" : "Проверка геометрии не пройдена");
});

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!currentModel) return;
  resetTransforms();
  exploded = false;
  fitObject(currentModel.object);
  fragments.core.update(true);
});

window.addEventListener("resize", () => {
  // SimpleRenderer observes its container; this keeps the camera target stable.
  if (currentModel) fitObject(currentModel.object);
});

setStatus("Готов. Загрузите IFC-файл.");
updateChecks(false);