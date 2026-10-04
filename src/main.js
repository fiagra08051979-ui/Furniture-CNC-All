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

function fitObject(object) {
  if (!object) return;
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
    fragments.core.update(true);
    addEdgeOverlays(model.object);
    collectTransforms(model.object);
    fitObject(model.object);
    modelName.textContent = file.name;
    elementCount.textContent = "3D-модель загружена";
    const stats = updateGeometryStats(model.object);
    updateChecks(true, false);
    setStatus("IFC загружен · 3D-модель подключена");
    console.info("IFC loaded", { fragments: fragments.list.size, objects: stats.objects, parts: stats.meshes, size: stats.size });
    setStatus("IFC загружен · 3D-взрывная схема готова");
    showProgress(false);
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