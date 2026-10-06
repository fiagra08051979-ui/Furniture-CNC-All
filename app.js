import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe4e9);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
camera.position.set(3200, 2600, 3800);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1100, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x68727d, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3000, 4500, 3000);
scene.add(keyLight);

const grid = new THREE.GridHelper(7000, 70, 0x9aa3ad, 0xc6ccd3);
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

const parts = [];
let exploded = false;

function readParams() {
  return {
    width: Number($("width").value),
    height: Number($("height").value),
    depth: Number($("depth").value),
    thickness: Number($("thickness").value),
    sections: Math.max(1, Math.floor(Number($("sections").value))),
    shelves: Math.max(0, Math.floor(Number($("shelves").value))),
    doors: Math.max(0, Math.floor(Number($("doors").value)))
  };
}

function validateParams(p) {
  if (![p.width, p.height, p.depth, p.thickness].every(Number.isFinite)) {
    return "Проверьте размеры.";
  }
  if (p.width <= 2 * p.thickness || p.height <= 2 * p.thickness || p.depth <= p.thickness) {
    return "Размеры несовместимы с толщиной материала.";
  }
  if (p.width / p.sections <= p.thickness) {
    return "Слишком много секций для заданной ширины.";
  }
  if (p.doors > 0 && p.doors > 12) return "Количество фасадов: максимум 12.";
  return "";
}

function material() {
  const colors = {
    ldsp18: 0xc69b68,
    ldsp16: 0xc69b68,
    mdf18: 0xd7d9dc,
    ply18: 0xb88a58
  };
  return new THREE.MeshStandardMaterial({
    color: colors[$("material").value] || 0xc69b68,
    roughness: 0.68,
    metalness: 0
  });
}

function addPart(name, kind, width, height, depth, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material());
  mesh.position.copy(position);
  mesh.userData = {
    name, kind, width, height, depth,
    base: position.clone()
  };
  root.add(mesh);
  parts.push(mesh);
}

function clearModel() {
  while (root.children.length) {
    const object = root.children.pop();
    object.geometry.dispose();
    object.material.dispose();
  }
  parts.length = 0;
}

function build() {
  const p = readParams();
  const error = validateParams(p);
  if (error) {
    validate(error, "error");
    return;
  }

  clearModel();

  const innerW = p.width - 2 * p.thickness;
  const innerH = p.height - 2 * p.thickness;
  const sectionW = innerW / p.sections;

  addPart("Боковина левая", "Боковина", p.thickness, p.height, p.depth,
    new THREE.Vector3(-p.width / 2 + p.thickness / 2, p.height / 2, 0));

  addPart("Боковина правая", "Боковина", p.thickness, p.height, p.depth,
    new THREE.Vector3(p.width / 2 - p.thickness / 2, p.height / 2, 0));

  addPart("Дно", "Дно", innerW, p.thickness, p.depth,
    new THREE.Vector3(0, p.thickness / 2, 0));

  addPart("Крышка", "Крышка", innerW, p.thickness, p.depth,
    new THREE.Vector3(0, p.height - p.thickness / 2, 0));

  for (let i = 1; i < p.sections; i++) {
    addPart(
      "Вертикальная перегородка " + i,
      "Вертикальная перегородка",
      p.thickness,
      innerH,
      p.depth,
      new THREE.Vector3(-p.width / 2 + p.thickness + i * sectionW, p.height / 2, 0)
    );
  }

  // Распределяем указанное общее количество полок по всем секциям.
  for (let i = 0; i < p.shelves; i++) {
    const section = i % p.sections;
    const row = Math.floor(i / p.sections);
    const rows = Math.ceil(p.shelves / p.sections);
    const y = p.thickness + innerH * (row + 1) / (rows + 1);
    addPart(
      "Полка " + (i + 1),
      "Полка",
      Math.max(sectionW - p.thickness, 1),
      p.thickness,
      p.depth,
      new THREE.Vector3(
        -p.width / 2 + p.thickness + section * sectionW + sectionW / 2,
        y,
        0
      )
    );
  }

  if (p.doors > 0) {
    const doorW = p.width / p.doors;
    const gap = Math.min(3, Math.max(1, doorW * 0.002));
    for (let i = 0; i < p.doors; i++) {
      addPart(
        "Фасад " + (i + 1),
        "Фасад",
        Math.max(doorW - gap, 1),
        p.height - 2 * Math.max(gap, 1),
        p.thickness,
        new THREE.Vector3(
          -p.width / 2 + doorW * (i + 0.5),
          p.height / 2,
          p.depth / 2 + p.thickness / 2
        )
      );
    }
  }

  exploded = false;
  $("explode").textContent = "Взрыв";
  $("partsCount").textContent = parts.length;
  $("summary").textContent = parts.length + " деталей · " + p.width + " × " + p.height + " × " + p.depth + " мм";

  renderPartsTable();
  validate("Модель построена: корпус, перегородки, полки и фасады.", "ok");
  fitView();
}

function renderPartsTable() {
  const body = $("partsList");
  body.innerHTML = "";
  parts.forEach((part, index) => {
    const row = document.createElement("tr");
    row.innerHTML =
      "<td>" + (index + 1) + "</td>" +
      "<td>" + part.userData.name + "</td>" +
      "<td>" + part.userData.width.toFixed(0) + "</td>" +
      "<td>" + part.userData.height.toFixed(0) + "</td>" +
      "<td>" + part.userData.depth.toFixed(0) + "</td>";
    row.addEventListener("click", () => focusPart(part));
    body.appendChild(row);
  });
}

function focusPart(part) {
  controls.target.copy(part.position);
  const r = Math.max(part.userData.width, part.userData.height, part.userData.depth) * 2.5;
  camera.position.copy(part.position).add(new THREE.Vector3(r, r * 0.7, r));
  controls.update();
}

function fitView() {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 1.8;
  controls.target.copy(center);
  camera.position.set(center.x + radius * 0.95, center.y + radius * 0.7, center.z + radius);
  controls.update();
}

function setExplode(on) {
  exploded = on;
  const p = readParams();
  const distance = Math.max(p.width, p.height, p.depth) * 0.42;

  parts.forEach((part, index) => {
    const direction = new THREE.Vector3(
      (index % 3) - 1,
      ((index % 4) - 1.5) * 0.7,
      index % 2 ? 1 : -1
    ).normalize();

    part.position.copy(part.userData.base);
    if (on) part.position.add(direction.multiplyScalar(distance));
  });

  $("explode").textContent = on ? "Свернуть" : "Взрыв";
}

function frontView() {
  const p = readParams();
  controls.target.set(0, p.height / 2, 0);
  camera.position.set(0, p.height / 2, Math.max(p.width, p.height) * 2.2);
  controls.update();
}

function validate(message, type) {
  const box = $("validation");
  box.textContent = message;
  box.className = "validation " + type;
}

$("build").addEventListener("click", build);
$("explode").addEventListener("click", () => setExplode(!exploded));
$("resetExplode").addEventListener("click", () => setExplode(false));
$("frontView").addEventListener("click", frontView);
$("isoView").addEventListener("click", fitView);
$("material").addEventListener("change", build);

$("newProject").addEventListener("click", () => {
  [2400, 2200, 600, 18, 3, 6, 3].forEach((value, i) => {
    $("width height depth thickness sections shelves doors".split(" ")[i]).value = value;
  });
  build();
});

$("saveProject").addEventListener("click", () => {
  const ids = ["width", "height", "depth", "thickness", "sections", "shelves", "doors"];
  const parameters = Object.fromEntries(ids.map(id => [id, $(id).value]));
  parameters.material = $("material").value;
  parameters.edge = $("edge").value;

  const data = {
    version: "0.1",
    name: "Furniture AI Designer",
    parameters
  };

  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = "furniture-ai-project.json";
  link.click();
  URL.revokeObjectURL(url);
});

$("loadProject").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      Object.entries(data.parameters || {}).forEach(([key, value]) => {
        if ($(key)) $(key).value = value;
      });
      build();
    } catch {
      validate("Не удалось прочитать проект JSON.", "error");
    }
  };
  reader.readAsText(file);
});

function resize() {
  const width = viewer.clientWidth;
  const height = viewer.clientHeight;
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
build();
