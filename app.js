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
let projectVersion = "0.2";

function readParams() {
  return {
    width: Number($("width").value),
    height: Number($("height").value),
    depth: Number($("depth").value),
    thickness: Number($("thickness").value),
    sections: Math.max(1, Math.floor(Number($("sections").value))),
    shelves: Math.max(0, Math.floor(Number($("shelves").value))),
    doors: Math.max(0, Math.floor(Number($("doors").value))),
    fixedPartitions: Math.max(0, Math.floor(Number($("fixedPartitions").value))),
    frontGapTB: Math.max(0, Number($("frontGapTB").value)),
    frontGapBetween: Math.max(0, Number($("frontGapBetween").value)),
    frontType: $("frontType").value,
    hingeType: $("hingeType").value,
    hingeLimiter: $("hingeLimiter").value,
    openingAngle: Number($("openingAngle").value),
    fastenerType: $("fastenerType").value,
    confirmatDiameter: Number($("confirmatDiameter").value),
    connectorDiameter: Number($("connectorDiameter").value),
    secondaryFastener: $("secondaryFastener").value,
    dowelDiameter: Number($("dowelDiameter").value),
    eccentricDiameter: Number($("eccentricDiameter").value)
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
  if (p.doors > 0 && p.width - p.frontGapBetween * (p.doors - 1) <= 0) return "Зазоры фасадов превышают ширину корпуса.";
  if (![95, 110, 180].includes(p.openingAngle)) return "Недопустимый угол открывания фасада.";
  return "";
}


function recommendHinges(frontHeight, frontWidth) {
  // Базовое технологическое правило MVP; 600×2200 мм -> 5 петель.
  const byHeight = frontHeight <= 900 ? 2 :
    frontHeight <= 1500 ? 3 :
    frontHeight <= 1900 ? 4 :
    frontHeight <= 2300 ? 5 :
    frontHeight <= 2600 ? 6 : 7;
  const widthAdjustment = frontWidth > 700 ? 1 : 0;
  return Math.min(8, byHeight + widthAdjustment);
}

function buildHardwareForFront(front) {
  const u = front.userData;
  if (!u.frontTechnology) return null;
  const count = recommendHinges(u.height, u.width);
  const positions = Array.from({length: count}, (_, i) => {
    const topMargin = Math.max(96, Math.min(150, u.height * 0.07));
    if (count === 1) return Math.round(u.height / 2);
    const usable = Math.max(1, u.height - 2 * topMargin);
    return Math.round(topMargin + usable * i / (count - 1));
  });
  return {
    hingeType: u.frontTechnology.hinge,
    limiter: u.frontTechnology.limiter,
    openingAngle: u.frontTechnology.openingAngle,
    quantity: count,
    mountingPositionsFromBottom: positions
  };
}


function buildDrillingForFront(front) {
  const u = front.userData;
  const hw = u.hardware;
  const tech = u.frontTechnology;
  if (!hw || !tech) return [];
  const cupDiameter = 35;
  const cupDepth = 12.5;
  const cupOffsetFromEdge = 21.5;
  const plateOffsetFromEdge = 37;
  const hingeRows = hw.mountingPositionsFromBottom || [];
  const frontLeft = -u.width / 2;
  const cupX = Math.round(frontLeft + cupOffsetFromEdge);
  return hingeRows.map((y, index) => ({
    id: "H" + (index + 1),
    operation: "Чашка петли",
    diameter: cupDiameter,
    depth: cupDepth,
    x: cupX,
    y: Math.round(y),
    z: Math.round(u.depth / 2),
    edgeDistance: cupOffsetFromEdge,
    plateOffsetFromEdge,
    linkedHardware: "Петля фасада"
  }));
}


function buildBodyFasteners() {
  const p = readParams();
  const result = [];
  const useConfirmat = p.fastenerType === "конфирматы" || p.fastenerType === "комбинированный";
  const useConnector = p.fastenerType === "стяжки" || p.fastenerType === "комбинированный";
  const verticals = parts.filter(part => part.userData.kind === "Вертикальная перегородка");
  const horizontals = parts.filter(part => part.userData.kind === "Горизонтальная перегородка");
  const sides = parts.filter(part => part.userData.kind === "Боковина");
  const addJoint = (part, jointType, index, x, y, z) => result.push({
    id: jointType === "Конфирмат" ? "C" + index : "K" + index,
    type: jointType,
    diameter: jointType === "Конфирмат" ? p.confirmatDiameter : p.connectorDiameter,
    depth: jointType === "Конфирмат" ? Math.max(35, p.thickness * 2) : p.thickness,
    x: Math.round(x), y: Math.round(y), z: Math.round(z),
    linkedPart: part.userData.name
  });
  let n = 1;
  verticals.forEach(part => {
    const y1 = p.height * 0.28, y2 = p.height * 0.72;
    if (useConfirmat) { addJoint(part, "Конфирмат", n++, part.position.x, y1, 0); addJoint(part, "Конфирмат", n++, part.position.x, y2, 0); }
    if (useConnector) { addJoint(part, "Стяжка", n++, part.position.x, y1, 0); addJoint(part, "Стяжка", n++, part.position.x, y2, 0); }
  });
  horizontals.forEach(part => {
    const x1 = -p.width * 0.28, x2 = p.width * 0.28;
    if (useConfirmat) { addJoint(part, "Конфирмат", n++, x1, part.position.y, 0); addJoint(part, "Конфирмат", n++, x2, part.position.y, 0); }
    if (useConnector) { addJoint(part, "Стяжка", n++, x1, part.position.y, 0); addJoint(part, "Стяжка", n++, x2, part.position.y, 0); }
  });
  if (sides.length && !verticals.length && !horizontals.length) {
    // Базовые крепления корпуса даже для простого шкафа.
    sides.forEach(side => {
      if (useConfirmat) { addJoint(side, "Конфирмат", n++, side.position.x, p.height * 0.25, 0); addJoint(side, "Конфирмат", n++, side.position.x, p.height * 0.75, 0); }
      if (useConnector) { addJoint(side, "Стяжка", n++, side.position.x, p.height * 0.25, 0); addJoint(side, "Стяжка", n++, side.position.x, p.height * 0.75, 0); }
    });
  }
  return result;
}


function buildShelfSupportDrilling() {
  const p = readParams();
  const shelfSupports = [];
  const shelves = parts.filter(part => part.userData.kind === "Полка");
  const sides = parts.filter(part => part.userData.kind === "Боковина");
  const diameter = p.shelfSupportType === "штифт Ø6" ? 6 : 5;
  let index = 1;
  shelves.forEach(shelf => {
    const y = shelf.position.y;
    const shelfLeft = shelf.position.x - shelf.userData.width / 2;
    const shelfRight = shelf.position.x + shelf.userData.width / 2;
    const frontZ = shelf.position.z + shelf.userData.depth / 2;
    [shelfLeft + 32, shelfRight - 32].forEach((x, i) => {
      shelfSupports.push({
        id: "S" + index++,
        operation: "Отверстие под полкодержатель",
        type: p.shelfSupportType,
        diameter,
        depth: 12,
        x: Math.round(x),
        y: Math.round(y),
        z: Math.round(frontZ - p.shelfFrontOffset),
        edgeDistance: 32,
        linkedPart: shelf.userData.name
      });
    });
  });
  return shelfSupports;
}


function buildSecondaryFasteners() {
  const p = readParams();
  const result = [];
  const useDowel = p.secondaryFastener === "дюбель" || p.secondaryFastener === "дюбель+эксцентрик";
  const useEccentric = p.secondaryFastener === "эксцентрик" || p.secondaryFastener === "дюбель+эксцентрик";
  let n = 1;
  const targets = parts.filter(part => ["Вертикальная перегородка","Горизонтальная перегородка"].includes(part.userData.kind));
  targets.forEach(part => {
    const x = Math.round(part.position.x);
    const y = Math.round(part.position.y);
    if (useDowel) result.push({id:"D"+n++, type:"Дюбель", diameter:p.dowelDiameter, depth:30, x, y, z:0, linkedPart:part.userData.name});
    if (useEccentric) result.push({id:"E"+n++, type:"Эксцентрик", diameter:p.eccentricDiameter, depth:13, x, y, z:Math.round(part.userData.depth/2-40), linkedPart:part.userData.name});
  });
  return result;
}

function constructionChecks(bodyFasteners, shelfSupportDrilling, secondaryFasteners) {
  const p = readParams();
  const issues = [];
  if (p.shelves > 0 && p.sections > 0) {
    const sectionW = (p.width - 2 * p.thickness) / p.sections;
    if (sectionW < 250) issues.push("Секция уже 250 мм: проверьте конструкцию и размещение крепежа.");
  }
  if (p.fixedPartitions > 0 && p.height / (p.fixedPartitions + 1) < 120) issues.push("Слишком малый шаг между горизонтальными перегородками.");
  const all = [];
  parts.forEach(part => {
    (part.userData.drilling || []).forEach(h => all.push({...h, part:part.userData.name}));
    (part.userData.shelfSupportDrilling || []).forEach(h => all.push({...h, part:part.userData.name}));
  });
  secondaryFasteners.forEach(h => all.push({...h, part:h.linkedPart}));
  for (let i=0;i<all.length;i++) for (let k=i+1;k<all.length;k++) {
    if (all[i].part !== all[k].part) continue;
    const dx=all[i].x-all[k].x, dy=all[i].y-all[k].y, dz=all[i].z-all[k].z;
    const minR=(all[i].diameter+all[k].diameter)/2;
    if (Math.sqrt(dx*dx+dy*dy+dz*dz) < minR) issues.push("Конфликт отверстий: " + all[i].id + " / " + all[k].id + " на " + all[i].part);
  }
  if (p.thickness < 16 && (p.confirmatDiameter >= 7 || p.dowelDiameter >= 8)) issues.push("Проверьте диаметр крепежа относительно толщины материала.");
  return [...new Set(issues)];
}


function buildDetailedProcessing(part) {
  const u = part.userData;
  const operations = [];
  (u.drilling || []).forEach(h => operations.push({
    type:"Сверление", operation:h.operation, diameter:h.diameter, depth:h.depth,
    x:h.x, y:h.y, z:h.z, linkedHardware:h.linkedHardware || h.type || ""
  }));
  (u.bodyFasteners || []).forEach(h => operations.push({
    type:"Сверление", operation:h.type, diameter:h.diameter, depth:h.depth,
    x:h.x, y:h.y, z:h.z, linkedHardware:h.type
  }));
  (u.shelfSupportDrilling || []).forEach(h => operations.push({
    type:"Сверление", operation:h.operation, diameter:h.diameter, depth:h.depth,
    x:h.x, y:h.y, z:h.z, linkedHardware:h.type
  }));
  (u.secondaryFasteners || []).forEach(h => operations.push({
    type:"Сверление", operation:h.type, diameter:h.diameter, depth:h.depth,
    x:h.x, y:h.y, z:h.z, linkedHardware:h.type
  }));
  return operations;
}

function constructionChecksDetailed() {
  const p = readParams();
  const issues = [];
  parts.forEach(part => {
    const u = part.userData;
    const minDrillEdge = 4;
    (u.drilling || []).forEach(h => {
      if (h.depth > Math.max(u.depth, u.width, u.height)) issues.push("Глубина отверстия превышает толщину/габарит детали: " + u.name);
      if (Math.min(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) < minDrillEdge) {
        issues.push("Отверстие слишком близко к базовой грани: " + u.name + " / " + h.id);
      }
    });
    if (u.kind === "Полка" && u.width < 100) issues.push("Полка слишком узкая: " + u.name);
    if (u.kind === "Фасад" && (u.width < 100 || u.height < 200)) issues.push("Недопустимые габариты фасада: " + u.name);
  });
  if (p.doors > 1 && p.frontGapBetween < 2) issues.push("Зазор между соседними фасадами меньше 2 мм.");
  if (p.frontGapTB < 1) issues.push("Верхний/нижний технологический зазор фасада меньше 1 мм.");
  if (p.depth < 300 && p.shelves > 0) issues.push("Малая глубина корпуса: проверьте рабочую глубину полок и крепежа.");
  return [...new Set(issues)];
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

function edgeLabels() { return [1, 2, 3, 4].map(i => $("edge" + i).value); }

function addPart(name, kind, width, height, depth, position, quantity = 1, edges = null) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material());
  mesh.position.copy(position);
  mesh.userData = {
    name, kind, width, height, depth, quantity,
    material: $("material").value,
    edges: edges || edgeLabels(),
    base: position.clone(),
    partNumber: ""
  };
  root.add(mesh);
  parts.push(mesh);
}


function assignPartNumbers() {
  parts.forEach((part, index) => {
    part.userData.partNumber = String(index + 1).padStart(3, "0");
  });
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

  for (let i = 0; i < p.fixedPartitions; i++) {
    const y = p.thickness + innerH * (i + 1) / (p.fixedPartitions + 1);
    addPart("Горизонтальная перегородка " + (i + 1), "Горизонтальная перегородка", innerW, p.thickness, p.depth,
      new THREE.Vector3(0, y, 0));
  }

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
    const sideGap = p.frontGapTB;
    const betweenGap = p.frontGapBetween;
    const totalBetween = betweenGap * Math.max(0, p.doors - 1);
    const doorW = (p.width - totalBetween) / p.doors;
    const doorH = p.height - 2 * sideGap;
    for (let i = 0; i < p.doors; i++) {
      addPart(
        "Фасад " + (i + 1),
        "Фасад",
        Math.max(doorW, 1),
        Math.max(doorH, 1),
        p.thickness,
        new THREE.Vector3(
          -p.width / 2 + doorW * (i + 0.5) + betweenGap * i,
          p.height / 2,
          p.depth / 2 + p.thickness / 2
        )
      );
      parts[parts.length - 1].userData.frontTechnology = {
        type: p.frontType,
        hinge: p.hingeType,
        limiter: p.hingeLimiter,
        openingAngle: p.openingAngle,
        topBottomGap: sideGap,
        betweenGap
      };
      parts[parts.length - 1].userData.hardware = buildHardwareForFront(parts[parts.length - 1]);
      parts[parts.length - 1].userData.drilling = buildDrillingForFront(parts[parts.length - 1]);
    }
  }

  const bodyFasteners = buildBodyFasteners();
  const shelfSupportDrilling = buildShelfSupportDrilling();
  const secondaryFasteners = buildSecondaryFasteners();
  parts.forEach(part => {
    part.userData.bodyFasteners = bodyFasteners.filter(h => h.linkedPart === part.userData.name);
    part.userData.shelfSupportDrilling = shelfSupportDrilling.filter(h => h.linkedPart === part.userData.name);
    part.userData.secondaryFasteners = secondaryFasteners.filter(h => h.linkedPart === part.userData.name);
    part.userData.processing = buildDetailedProcessing(part);
  });

  assignPartNumbers();
  exploded = false;
  $("explode").textContent = "Взрыв";
  $("partsCount").textContent = parts.length;
  $("summary").textContent = parts.length + " деталей · " + p.width + " × " + p.height + " × " + p.depth + " мм · фасадные зазоры " + p.frontGapTB + "/" + p.frontGapBetween + " мм";

  renderPartsTable();
  const drillingCount = parts.reduce((sum, part) => sum + (part.userData.drilling?.length || 0), 0);
  const bodyFastenerCount = bodyFasteners.length;
  const shelfSupportCount = shelfSupportDrilling.length;
  const constructionIssues = [...constructionChecks(bodyFasteners, shelfSupportDrilling, secondaryFasteners), ...constructionChecksDetailed()];
  if ($("drillingSummary")) $("drillingSummary").textContent = drillingCount
    ? "Фасады: " + drillingCount + " отв. · корпус: " + bodyFastenerCount + " креплений · полкодержатели: " + shelfSupportCount
    : "Фасадное сверление не требуется. Корпус: " + bodyFastenerCount + " креплений.";
  validate(constructionIssues.length ? "Проверка: " + constructionIssues.join(" ") : "Проверка конструкции: ошибок не обнаружено.", constructionIssues.length ? "error" : "ok");
  fitView();
}

function renderPartsTable() {
  const body = $("partsList");
  body.innerHTML = "";
  parts.forEach((part, index) => {
    const row = document.createElement("tr");
    row.innerHTML =
      "<td>" + part.userData.partNumber + "</td>" +
      "<td>" + part.userData.name + "</td>" +
      "<td>" + part.userData.width.toFixed(0) + "</td>" +
      "<td>" + part.userData.height.toFixed(0) + "</td>" +
      "<td>" + part.userData.depth.toFixed(0) + "</td>" +
      "<td>" + part.userData.material.toUpperCase() + "</td>" +
      "<td>" + part.userData.edges.map(e => e || "—").join(" / ") + "</td>" +
      "<td>" + part.userData.quantity + "</td>" +
      "<td>" + (part.userData.hardware?.quantity || "—") + "</td>";
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

function exportExcel() {
  if (!window.XLSX) { validate("Модуль Excel недоступен.", "error"); return; }
  const rows = parts.map((part, i) => ({
    "№": part.userData.partNumber, "Деталь": part.userData.name,
    "Тип": part.userData.kind, "Количество": part.userData.quantity,
    "Длина": Math.round(part.userData.width), "Ширина": Math.round(part.userData.height),
    "Глубина": Math.round(part.userData.depth), "Материал": part.userData.material,
    "Кромка 1": part.userData.edges[0], "Кромка 2": part.userData.edges[1],
    "Кромка 3": part.userData.edges[2], "Кромка 4": part.userData.edges[3],
    "Тип фасада": part.userData.frontTechnology?.type || "",
    "Петли": part.userData.frontTechnology?.hinge || "",
    "Ограничитель": part.userData.frontTechnology?.limiter || "",
    "Угол открывания": part.userData.frontTechnology?.openingAngle || "",
    "Петель": part.userData.hardware?.quantity || "",
    "Позиции петель, мм": part.userData.hardware?.mountingPositionsFromBottom?.join("; ") || "",
    "Сверление": part.userData.drilling?.map(h => h.operation + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ")").join(" | ") || "",
    "Крепёж корпуса": part.userData.bodyFasteners?.map(h => h.type + " Ø" + h.diameter + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Полкодержатели": part.userData.shelfSupportDrilling?.map(h => h.type + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Дюбели/эксцентрики": part.userData.secondaryFasteners?.map(h => h.type + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Обработка": part.userData.processing?.map(h => h.operation + " " + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Примечания": constructionChecksDetailed().filter(x => x.includes(part.userData.name)).join(" | ")
  }));
  const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Деталировка");
  XLSX.writeFile(wb, "furniture-ai-parts.xlsx");
}

function exportPdf() {
  if (!window.jspdf) { validate("Модуль PDF недоступен.", "error"); return; }
  const { jsPDF } = window.jspdf; const doc = new jsPDF({orientation:"landscape", unit:"mm", format:"a4"});
  doc.setFontSize(16); doc.text("Furniture AI Designer — Спецификация", 14, 16);
  doc.setFontSize(9); doc.text("Модель: " + readParams().width + " × " + readParams().height + " × " + readParams().depth + " мм", 14, 23);
  let y=31; doc.setFontSize(7);
  doc.text("№   Деталь                         Ш        В        Г        Материал        Кромка 1-4",14,y); y+=5;
  parts.forEach((part,i)=>{ const u=part.userData; const line=(u.partNumber+"   "+u.name).slice(0,42)+"   "+Math.round(u.width)+"   "+Math.round(u.height)+"   "+Math.round(u.depth)+"   "+u.material+"   "+u.edges.join(" / "); doc.text(line.slice(0,150),14,y); y+=4; if(y>195){doc.addPage();y=15;} });
  doc.save("furniture-ai-specification.pdf");
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
[1, 2, 3, 4].forEach(i => $("edge" + i).addEventListener("change", build));
$("exportExcel").addEventListener("click", exportExcel);
$("exportPdf").addEventListener("click", exportPdf);

$("newProject").addEventListener("click", () => {
  [2400, 2200, 600, 18, 3, 6, 0, 3, 2, 3].forEach((value, i) => {
    $("width height depth thickness sections shelves fixedPartitions doors frontGapTB frontGapBetween".split(" ")[i]).value = value;
  });
  build();
});

$("saveProject").addEventListener("click", () => {
  const ids = ["width", "height", "depth", "thickness", "sections", "shelves", "fixedPartitions", "doors", "frontGapTB", "frontGapBetween"];
  const parameters = Object.fromEntries(ids.map(id => [id, $(id).value]));
  parameters.material = $("material").value;
  parameters.edges = edgeLabels();
  parameters.frontType = $("frontType").value;
  parameters.hingeType = $("hingeType").value;
  parameters.hingeLimiter = $("hingeLimiter").value;
  parameters.openingAngle = $("openingAngle").value;
  parameters.fastenerType = $("fastenerType").value;
  parameters.confirmatDiameter = $("confirmatDiameter").value;
  parameters.connectorDiameter = $("connectorDiameter").value;
  parameters.shelfSupportType = $("shelfSupportType").value;
  parameters.shelfFrontOffset = $("shelfFrontOffset").value;
  parameters.secondaryFastener = $("secondaryFastener").value;
  parameters.dowelDiameter = $("dowelDiameter").value;
  parameters.eccentricDiameter = $("eccentricDiameter").value;

  const data = {
    version: projectVersion,
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
      const savedEdges = data.parameters?.edges || [];
      savedEdges.forEach((value, index) => {
        if ($("edge" + (index + 1))) $("edge" + (index + 1)).value = value;
      });
      if (!savedEdges.length && data.parameters?.edge) {
        [1, 2, 3, 4].forEach(i => $("edge" + i).value = data.parameters.edge);
      }
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
