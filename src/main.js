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
let currentLocalIds = [];
let partRecords = [];
let exploded = false;
let explodedVisual = null;

function createWoodTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 1024, 0);
  g.addColorStop(0, "#b98552");
  g.addColorStop(0.18, "#d6ad7a");
  g.addColorStop(0.42, "#c4945f");
  g.addColorStop(0.68, "#e0bd8b");
  g.addColorStop(1, "#b27c49");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  for (let y = -40; y < 1060; y += 13) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 28) {
      const yy = y + Math.sin(x * 0.018 + y * 0.021) * 5 + Math.sin(x * 0.051) * 2;
      ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = "rgba(75,45,24,0.24)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.2, 3.4);
  texture.anisotropy = 4;
  return texture;
}

const woodTexture = createWoodTexture();

function applyWoodAppearance(root) {
  if (!root) return;
  root.traverse(obj => {
    if (!obj.isMesh || obj.userData?.__edgeOverlay) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach(material => {
      if (!material) return;
      if ("map" in material) material.map = woodTexture;
      if ("color" in material) material.color.set("#d0a06c");
      if ("roughness" in material) material.roughness = 0.72;
      if ("metalness" in material) material.metalness = 0;
      material.needsUpdate = true;
    });
  });
}
const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x000000,
  transparent: false,
  opacity: 1,
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

async function fitObject(object = currentModel?.object) {
  if (!currentModel) return;
  let box = null;
  try {
    if (currentLocalIds.length) box = await currentModel.getMergedBox(currentLocalIds);
    if (!box || box.isEmpty()) box = currentModel.box;
  } catch (e) {
    box = currentModel.box;
  }
  if (!box || box.isEmpty()) {
    world.camera.controls.setLookAt(850, 650, 850, 0, 0, 0, true);
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 1.8 || 100;
  world.camera.controls.setLookAt(center.x + radius, center.y + radius * 0.75, center.z + radius, center.x, center.y, center.z, true);
}
function clearExplodedVisual() {
  if (!explodedVisual) return;
  explodedVisual.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); });
  explodedVisual.removeFromParent();
  explodedVisual = null;
}

function createMeshFromData(data) {
  if (!data?.positions || !data?.indices || !data?.normals) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setIndex(Array.from(data.indices));
  geometry.computeBoundingBox();
  const material = new THREE.MeshStandardMaterial({ map: woodTexture, color: 0xd0a06c, roughness: 0.72, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.applyMatrix4(data.transform);
  const edges = new THREE.EdgesGeometry(geometry, 14);
  const lines = new THREE.LineSegments(edges, edgeMaterial);
  lines.renderOrder = 20;
  lines.userData.__edgeOverlay = true;
  mesh.add(lines);
  return mesh;
}

async function buildExplodedVisual() {
  clearExplodedVisual();
  if (!currentModel || !currentLocalIds.length) return;
  explodedVisual = new THREE.Group();
  explodedVisual.name = "ExplodedAssembly";
  const boxes = await currentModel.getBoxes(currentLocalIds);
  const geometries = await currentModel.getItemsGeometry(currentLocalIds);
  const overall = await currentModel.getMergedBox(currentLocalIds);
  const center = overall.getCenter(new THREE.Vector3());
  const size = overall.getSize(new THREE.Vector3());
  const amount = Math.max(Math.max(size.x, size.y, size.z) * 0.28, 80);

  for (let i = 0; i < currentLocalIds.length; i++) {
    const partGroup = new THREE.Group();
    const b = boxes[i];
    const bc = b?.getCenter(new THREE.Vector3()) || center.clone();
    let dir = bc.sub(center).normalize();
    if (dir.lengthSq() < 0.0001) dir = new THREE.Vector3((i % 3) - 1, Math.floor(i / 3) - 1, 0).normalize();
    dir.multiplyScalar(amount);
    for (const data of (geometries[i] || [])) {
      const mesh = createMeshFromData(data);
      if (mesh) partGroup.add(mesh);
    }
    partGroup.position.add(dir);
    partGroup.userData.localId = currentLocalIds[i];
    explodedVisual.add(partGroup);
  }
  world.scene.three.add(explodedVisual);
  await currentModel.setVisible(currentLocalIds, false);
  fragments.core.update(true);
}

async function resetTransforms() {
  clearExplodedVisual();
  exploded = false;
  if (currentModel && currentLocalIds.length) await currentModel.setVisible(currentLocalIds, true);
  fragments.core.update(true);
}

function selectPartByRecord(record) {
  if (!record) return;
  selectedPart.textContent = record.name;
  dimX.textContent = record.size.x.toFixed(1) + " mm";
  dimY.textContent = record.size.y.toFixed(1) + " mm";
  dimZ.textContent = record.size.z.toFixed(1) + " mm";
}

async function buildPartsList() {
  partsList.innerHTML = "";
  partRecords = [];
  if (!currentModel || !currentLocalIds.length) {
    partsCountLabel.textContent = "(0)";
    partsList.innerHTML = '<div class="empty-state">IFC загружен, но геометрических деталей не найдено.</div>';
    return;
  }
  const boxes = await currentModel.getBoxes(currentLocalIds);
  const data = await currentModel.getItemsData(currentLocalIds, { attributesDefault: false, attributes: ["Name", "ObjectType", "Tag"] });
  for (let i = 0; i < currentLocalIds.length; i++) {
    const b = boxes[i];
    if (!b || b.isEmpty()) continue;
    const size = b.getSize(new THREE.Vector3());
    const raw = data[i] || {};
    const val = key => raw[key] && typeof raw[key] === "object" && "value" in raw[key] ? raw[key].value : raw[key];
    const name = val("Name") || val("ObjectType") || val("Tag") || ("Деталь " + (i + 1));
    const record = { localId: currentLocalIds[i], name: String(name), size, box: b };
    partRecords.push(record);
    const row = document.createElement("div");
    row.className = "part-row";
    row.innerHTML = `<span class="part-no">${partRecords.length}</span><span class="part-name">${record.name}</span><span class="part-size">${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)}</span>`;
    row.addEventListener("click", () => {
      document.querySelectorAll(".part-row").forEach(x => x.classList.remove("selected"));
      row.classList.add("selected");
      selectPartByRecord(record);
    });
    partsList.appendChild(row);
  }
  partsCountLabel.textContent = "(" + partRecords.length + ")";
}

async function updateGeometryStats() {
  if (!currentModel || !currentLocalIds.length) {
    meshCount.textContent = "0"; sizeX.textContent = "0"; sizeY.textContent = "0"; sizeZ.textContent = "0"; elementCount.textContent = "Элементы: 0";
    return null;
  }
  const box = await currentModel.getMergedBox(currentLocalIds);
  const size = box.getSize(new THREE.Vector3());
  meshCount.textContent = String(currentLocalIds.length);
  sizeX.textContent = size.x.toFixed(1) + " mm";
  sizeY.textContent = size.y.toFixed(1) + " mm";
  sizeZ.textContent = size.z.toFixed(1) + " mm";
  elementCount.textContent = "Элементы: " + currentLocalIds.length;
  return {box,size,meshes:currentLocalIds.length};
}
document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", async () => {
  if (!currentModel) return;
  const v=b.dataset.view;
  if (v === "explode") {
    if (!exploded) { await buildExplodedVisual(); exploded = true; }
  } else if (v === "assembled") {
    await resetTransforms();
  }
  let box = currentModel.box;
  try { if (currentLocalIds.length) box = await currentModel.getMergedBox(currentLocalIds); } catch {}
  const c=box.getCenter(new THREE.Vector3()), s=box.getSize(new THREE.Vector3()), r=Math.max(s.x,s.y,s.z)*1.8;
  const targets={front:[c.x,c.y+r,c.z,c.x,c.y,c.z],side:[c.x+r,c.y,c.z,c.x,c.y,c.z],top:[c.x,c.y,c.z+r,c.x,c.y,c.z],bottom:[c.x,c.y,c.z-r,c.x,c.y,c.z]};
  if(targets[v]) world.camera.controls.setLookAt(...targets[v],true);
  fragments.core.update(true);
}));
async function loadIfc(file) {
  if (!file) return;
  setStatus("Читаю IFC…"); showProgress(true, 0, "Чтение IFC");
  clearExplodedVisual(); exploded=false; currentLocalIds=[]; partRecords=[];
  if (currentModel) { try { await currentModel.dispose(); } catch {} currentModel=null; }
  const buffer = new Uint8Array(await file.arrayBuffer());
  fileInfo.textContent = file.name + " · " + Math.round(file.size / 1024) + " KB";
  try {
    const model = await ifcLoader.load(buffer, false, "FurnitureModel_" + Date.now(), {
      processData: { progressCallback: p => { const value=typeof p==="number"?p:0; showProgress(true,value,"Конвертация IFC "+Math.round(value*100)+"%"); } }
    });
    currentModel = model;
    model.useCamera(world.camera.three);
    if (!world.scene.three.children.includes(model.object)) world.scene.three.add(model.object);
    fragments.core.update(true);

    currentLocalIds = await model.getItemsIdsWithGeometry();
    console.info("Fragments geometry ids", currentLocalIds.length, currentLocalIds.slice(0,20));
    if (!currentLocalIds.length) throw new Error("IFC загружен, но Fragments не получил ни одного геометрического элемента.");

    await buildPartsList();
    const stats = await updateGeometryStats();
    renderDocumentation();
    modelName.textContent = file.name;
    projectState.textContent = "IFC загружен · " + currentLocalIds.length + " геометрических элементов";
    updateChecks(true, true);
    setStatus("IFC загружен · 3D-модель подключена · " + currentLocalIds.length + " элементов");
    showProgress(false);
    await fitObject(model.object);
    fragments.core.update(true);
    console.info("IFC ready", {modelId:model.modelId, elements:currentLocalIds.length, size:stats?.size});
  } catch (error) {
    console.error(error); setStatus("Ошибка загрузки IFC"); showProgress(false); fileInfo.textContent="Ошибка: "+(error?.message||error); updateChecks(false);
  }
}
;