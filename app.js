import { validateSheetLayout, evaluateReleaseGateState } from "./release-gate-core.js";
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
import * as WebIFC from "web-ifc";

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
let ifcMode = false;
let modelRevision = 0;

/* =========================
   IFC → Furniture Core bridge
   Геометрия IFC является источником истины.
   Импорт не изменяет исходную форму детали.
   ========================= */
let ifcApi = null;
let ifcModelId = null;
let ifcImportedParts = [];

function ifcScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "value" in value) return value.value;
  return value;
}

function vectorToArray(vector) {
  if (!vector) return [];
  const out = [];
  if (typeof vector.size === "function" && typeof vector.get === "function") {
    for (let i = 0; i < vector.size(); i++) out.push(vector.get(i));
  } else if (Array.isArray(vector)) {
    return vector;
  }
  return out;
}

async function ensureIfcApi() {
  if (ifcApi) return ifcApi;
  ifcApi = new WebIFC.IfcAPI();
  ifcApi.SetWasmPath?.("https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/");
  await ifcApi.Init();
  return ifcApi;
}

function closeIfcModel() {
  if (ifcApi && ifcModelId !== null) {
    try { ifcApi.CloseModel(ifcModelId); } catch {}
  }
  ifcModelId = null;
  ifcImportedParts = [];
}

function makeIfcMesh(api, modelId, placedGeometry) {
  const geometry = api.GetGeometry(modelId, placedGeometry.geometryExpressID);
  const vertices = api.GetVertexArray(
    geometry.GetVertexData(),
    geometry.GetVertexDataSize()
  );
  const indices = api.GetIndexArray(
    geometry.GetIndexData(),
    geometry.GetIndexDataSize()
  );

  // web-ifc vertices are interleaved: XYZ + normal XYZ.
  const positions = new Float32Array(vertices.length / 2);
  const normals = new Float32Array(vertices.length / 2);

  for (let i = 0, j = 0; i < vertices.length; i += 6, j += 3) {
    positions[j] = vertices[i];
    positions[j + 1] = vertices[i + 1];
    positions[j + 2] = vertices[i + 2];
    normals[j] = vertices[i + 3];
    normals[j + 1] = vertices[i + 4];
    normals[j + 2] = vertices[i + 5];
  }

  const buffer = new THREE.BufferGeometry();
  buffer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  buffer.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  buffer.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  buffer.computeBoundingBox();
  buffer.computeBoundingSphere();

  const color = placedGeometry.color
    ? new THREE.Color(placedGeometry.color.x, placedGeometry.color.y, placedGeometry.color.z)
    : new THREE.Color(0xc69b68);

  const mesh = new THREE.Mesh(
    buffer,
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.68,
      metalness: 0,
      side: THREE.DoubleSide
    })
  );

  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(placedGeometry.flatTransformation);
  mesh.matrixWorldNeedsUpdate = true;
  return mesh;
}

function classifyIfcType(typeName) {
  const type = String(typeName || "").toUpperCase();
  if (type.includes("FURNITURE")) return "Мебель";
  if (type.includes("FURNISHING")) return "Мебель";
  if (type.includes("BUILDINGELEMENTPROXY")) return "Мебель / прокси";
  return "IFC элемент";
}

function normalizeIfcText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, words) {
  return words.some(word => text.includes(word));
}

/*
 * Распознавание детали выполняется поверх реальной IFC-геометрии.
 * Приоритет:
 * 1. явное имя/тип IFC;
 * 2. ориентация и положение bounding box;
 * 3. резервная классификация.
 *
 * Никакого изменения вершин/трансформаций исходной IFC-модели здесь нет.
 */
function recognizeIfcPart({ name, typeName, size, center, overallBox }) {
  const text = normalizeIfcText(name + " " + typeName);
  const overallSize = overallBox.getSize(new THREE.Vector3());
  const overallMin = overallBox.min;
  const overallMax = overallBox.max;

  const maxX = Math.max(overallSize.x, 1);
  const maxY = Math.max(overallSize.y, 1);
  const maxZ = Math.max(overallSize.z, 1);

  const sx = Math.max(size.x, 0.01);
  const sy = Math.max(size.y, 0.01);
  const sz = Math.max(size.z, 0.01);

  const minDim = Math.min(sx, sy, sz);
  const plateTol = Math.max(Math.min(maxX, maxY, maxZ) * 0.08, minDim * 1.35);

  // 1. Наиболее надёжный источник — семантика IFC/имя объекта.
  if (containsAny(text, ["фасад", "дверь", "дверца", "front", "door", "facade"])) {
    return { kind:"Фасад", label:"Фасад", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["задняя стенка", "задник", "задняя", "back panel", "back wall", "rear"])) {
    return { kind:"Задняя стенка", label:"Задняя стенка", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["боковина", "side panel", "side"])) {
    return { kind:"Боковина", label:"Боковина", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["крышка", "верх", "top", "lid"])) {
    return { kind:"Крышка", label:"Крышка", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["дно", "низ", "bottom", "base"])) {
    return { kind:"Дно", label:"Дно", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["полка", "shelf"])) {
    return { kind:"Полка", label:"Полка", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["горизонтальная перегород", "horizontal partition", "hpartition"])) {
    return { kind:"Горизонтальная перегородка", label:"Горизонтальная перегородка", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["вертикальная перегород", "vertical partition", "vpartition"])) {
    return { kind:"Вертикальная перегородка", label:"Вертикальная перегородка", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["ящик", "drawer", "выдвижн"])) {
    return { kind:"Ящик", label:"Ящик", confidence:"high", reason:"имя/тип IFC" };
  }
  if (containsAny(text, ["ножка", "опора", "leg", "foot"])) {
    return { kind:"Опора", label:"Опора", confidence:"high", reason:"имя/тип IFC" };
  }

  // 2. Геометрическая классификация для IFC без понятных имён.
  const thinX = sx <= plateTol && sy > maxY * 0.45;
  const thinY = sy <= plateTol && sx > maxX * 0.45;
  const thinZ = sz <= plateTol && sx > maxX * 0.45 && sy > maxY * 0.35;

  const nearLeft = Math.abs(center.x - overallMin.x) <= Math.max(sx * 0.8, maxX * 0.04);
  const nearRight = Math.abs(overallMax.x - center.x) <= Math.max(sx * 0.8, maxX * 0.04);
  const nearBottom = Math.abs(center.y - overallMin.y) <= Math.max(sy * 0.8, maxY * 0.04);
  const nearTop = Math.abs(overallMax.y - center.y) <= Math.max(sy * 0.8, maxY * 0.04);
  const nearFront = Math.abs(overallMax.z - center.z) <= Math.max(sz * 1.2, maxZ * 0.05);
  const nearBack = Math.abs(center.z - overallMin.z) <= Math.max(sz * 1.2, maxZ * 0.05);

  if (thinZ && nearFront) {
    return { kind:"Фасад", label:"Фасад", confidence:"medium", reason:"геометрия + положение" };
  }
  if (thinZ && nearBack) {
    return { kind:"Задняя стенка", label:"Задняя стенка", confidence:"medium", reason:"геометрия + положение" };
  }
  if (thinX && (nearLeft || nearRight)) {
    return { kind:"Боковина", label:"Боковина", confidence:"medium", reason:"геометрия + край корпуса" };
  }
  if (thinX) {
    return { kind:"Вертикальная перегородка", label:"Вертикальная перегородка", confidence:"medium", reason:"геометрия" };
  }
  if (thinY && nearBottom) {
    return { kind:"Дно", label:"Дно", confidence:"medium", reason:"геометрия + нижняя граница" };
  }
  if (thinY && nearTop) {
    return { kind:"Крышка", label:"Крышка", confidence:"medium", reason:"геометрия + верхняя граница" };
  }
  if (thinY) {
    return { kind:"Полка", label:"Полка", confidence:"medium", reason:"горизонтальная геометрия" };
  }

  return { kind:"Нестандартная деталь", label:"Нестандартная деталь", confidence:"low", reason:"неоднозначная геометрия" };
}



function buildIfcTechnologyState() {
  if (!ifcImportedParts.length) return { ready:0, review:0 };

  const readyRoles = new Set([
    "Боковина",
    "Крышка",
    "Дно",
    "Полка",
    "Горизонтальная перегородка",
    "Вертикальная перегородка",
    "Задняя стенка",
    "Фасад",
    "Ящик",
    "Опора"
  ]);

  let ready = 0;
  let review = 0;

  ifcImportedParts.forEach(part => {
    const u = part.userData;
    const box = new THREE.Box3().setFromObject(part);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const thickness = Math.min(size.x, size.y, size.z);
    const role = u.recognizedKind || u.kind;

    u.geometryLocked = true;
    u.sourceGeometry = "IFC";
    u.technology = {
      role,
      status: readyRoles.has(role) && u.recognitionConfidence !== "low" ? "ready" : "review",
      confidence: u.recognitionConfidence,
      geometry: {
        min: { x:box.min.x, y:box.min.y, z:box.min.z },
        max: { x:box.max.x, y:box.max.y, z:box.max.z },
        size: { x:size.x, y:size.y, z:size.z },
        center: { x:center.x, y:center.y, z:center.z }
      },
      thicknessEstimate: Number(thickness.toFixed(2)),
      thicknessSource: "минимальный габарит IFC",
      editable: false,
      note: "Технологические операции рассчитываются поверх исходной IFC-геометрии; вершины IFC не изменяются."
    };

    if (u.technology.status === "ready") ready++;
    else review++;
  });

  return { ready, review };
}


function buildIfcHardwareSchedule() {
  const schedule = [];
  if (!ifcImportedParts.length) return schedule;

  const add = (type, quantity, part, reason, status="candidate") => {
    if (!quantity) return;
    schedule.push({
      id:"IFC-HW-"+String(schedule.length+1).padStart(3,"0"),
      type,
      quantity:Math.max(1,Math.round(quantity)),
      partNumber:part.userData.partNumber || "",
      partName:part.userData.name,
      role:part.userData.recognizedKind || part.userData.kind,
      status,
      reason,
      source:"IFC topology"
    });
  };

  ifcImportedParts.forEach(part=>{
    const u=part.userData;
    const joints=u.technology?.joints || [];
    const shelfJoints=joints.filter(j=>/полки/i.test(j.type));
    const cabinetJoints=joints.filter(j=>!/полки/i.test(j.type));

    if (u.recognizedKind==="Фасад") {
      const count = u.height > 1900 ? 5 : u.height > 1500 ? 4 : u.height > 900 ? 3 : 2;
      add("Петля с доводчиком",count,part,"Количество предварительно рассчитано по фактической высоте IFC","candidate");
    }
    if (shelfJoints.length) {
      add("Полкодержатель / штифт",shelfJoints.length*2,part,"Определено фактическое сопряжение полки с корпусом","candidate");
    }
    if (cabinetJoints.length) {
      add("Крепёж корпуса",cabinetJoints.length*2,part,"Определено фактическое сопряжение деталей","candidate");
    }
  });

  return schedule;
}

function buildIfcTechnologyOperations() {
  const result = { joints: [], operations: 0, review: 0 };
  if (!ifcImportedParts.length) return result;

  const boxes = ifcImportedParts.map(part => ({
    part,
    box: new THREE.Box3().setFromObject(part),
    size: new THREE.Vector3()
  }));
  boxes.forEach(x => x.box.getSize(x.size));

  const compatible = (a,b) => {
    const pair = new Set([a,b]);
    return (
      pair.has("Боковина") && (pair.has("Полка") || pair.has("Горизонтальная перегородка") || pair.has("Крышка") || pair.has("Дно") || pair.has("Вертикальная перегородка"))
    ) || (
      pair.has("Вертикальная перегородка") && (pair.has("Крышка") || pair.has("Дно") || pair.has("Горизонтальная перегородка") || pair.has("Полка"))
    );
  };

  const overlapLength = (aMin,aMax,bMin,bMax) => Math.max(0, Math.min(aMax,bMax)-Math.max(aMin,bMin));
  const axisGap = (aMin,aMax,bMin,bMax) => Math.max(bMin-aMax, aMin-bMax);

  for(let i=0;i<boxes.length;i++){
    const A=boxes[i];
    const ua=A.part.userData;
    ua.technology.operations=[];
    ua.technology.joints=[];
    ua.technology.edgeOperations=(ua.edges||[]).map((edge,index)=>({
      type:"Кромление",
      edge:index+1,
      material:edge,
      status:"ready",
      source:"IFC-параметр",
      note:"Кромка назначена как технологический атрибут; IFC-геометрия не изменяется."
    }));
    ua.technology.operations.push(...ua.technology.edgeOperations);
    result.operations += ua.technology.edgeOperations.length;
  }

  for(let i=0;i<boxes.length;i++){
    for(let j=i+1;j<boxes.length;j++){
      const A=boxes[i], B=boxes[j];
      const ua=A.part.userData, ub=B.part.userData;
      const ka=ua.recognizedKind||ua.kind, kb=ub.recognizedKind||ub.kind;
      if(!compatible(ka,kb)) continue;

      const gaps=[
        axisGap(A.box.min.x,A.box.max.x,B.box.min.x,B.box.max.x),
        axisGap(A.box.min.y,A.box.max.y,B.box.min.y,B.box.max.y),
        axisGap(A.box.min.z,A.box.max.z,B.box.min.z,B.box.max.z)
      ];
      const overlap=[
        overlapLength(A.box.min.x,A.box.max.x,B.box.min.x,B.box.max.x),
        overlapLength(A.box.min.y,A.box.max.y,B.box.min.y,B.box.max.y),
        overlapLength(A.box.min.z,A.box.max.z,B.box.min.z,B.box.max.z)
      ];
      const contactAxis=gaps.indexOf(Math.min(...gaps));
      const other=overlap.filter((_,idx)=>idx!==contactAxis);
      const hasContact=gaps[contactAxis] <= 2 && other.every(v=>v >= 20);

      if(!hasContact) continue;

      const minBox=new THREE.Vector3(
        Math.max(A.box.min.x,B.box.min.x),
        Math.max(A.box.min.y,B.box.min.y),
        Math.max(A.box.min.z,B.box.min.z)
      );
      const maxBox=new THREE.Vector3(
        Math.min(A.box.max.x,B.box.max.x),
        Math.min(A.box.max.y,B.box.max.y),
        Math.min(A.box.max.z,B.box.max.z)
      );
      const center=minBox.add(maxBox).multiplyScalar(0.5);

      const roleSet=new Set([ka,kb]);
      const jointType=roleSet.has("Полка") ? "Соединение полки с корпусом" :
        roleSet.has("Крышка") ? "Соединение крышки с корпусом" :
        roleSet.has("Дно") ? "Соединение дна с корпусом" :
        "Соединение перегородки с корпусом";

      const joint={
        id:"IFC-J"+(result.joints.length+1),
        type:jointType,
        status:"candidate",
        confidence:"medium",
        partA:ua.partNumber || ua.name,
        partB:ub.partNumber || ub.name,
        roleA:ka,
        roleB:kb,
        contactAxis:["X","Y","Z"][contactAxis],
        gapMm:Number(gaps[contactAxis].toFixed(2)),
        contactCenter:{x:Number(center.x.toFixed(2)),y:Number(center.y.toFixed(2)),z:Number(center.z.toFixed(2))},
        source:"IFC bounding boxes",
        hardwareRecommendation: roleSet.has("Полка") ? "полкодержатель или штифт" : "конфирмат / стяжка",
        note:"Кандидат соединения определён по фактическому пересечению/контакту IFC. Отверстия не генерируются автоматически до подтверждения базы и направления сверления."
      };

      ua.technology.joints.push(joint);
      ub.technology.joints.push(joint);
      ua.technology.operations.push({
        type:"Соединение",
        operation:joint.type,
        status:"candidate",
        linkedPart:ub.partNumber || ub.name,
        contactCenter:joint.contactCenter,
        contactAxis:joint.contactAxis,
        hardwareRecommendation:joint.hardwareRecommendation
      });
      ub.technology.operations.push({
        type:"Соединение",
        operation:joint.type,
        status:"candidate",
        linkedPart:ua.partNumber || ua.name,
        contactCenter:joint.contactCenter,
        contactAxis:joint.contactAxis,
        hardwareRecommendation:joint.hardwareRecommendation
      });
      result.joints.push(joint);
      result.operations += 2;
      result.review += 2;
    }
  }

  ifcImportedParts.forEach(part=>{
    const u=part.userData;
    u.technology.jointCount=u.technology.joints.length;
    u.technology.operationCount=u.technology.operations.length;
    const hasUnconfirmedJoint = u.technology.joints.some(j=>j.status !== "ready");
    if (hasUnconfirmedJoint) u.technology.status = "review";
  });

  return result;
}

function syncIfcParametersFromRecognition() {
  if (!ifcImportedParts.length) return;

  const overall = new THREE.Box3();
  ifcImportedParts.forEach(part => overall.union(new THREE.Box3().setFromObject(part)));
  const size = overall.getSize(new THREE.Vector3());

  const setNumber = (id, value) => {
    const el = $(id);
    if (!el || !Number.isFinite(value) || value <= 0) return;
    el.value = Math.round(value);
  };

  const recognized = ifcImportedParts.map(p => p.userData.recognizedKind);
  const count = kind => recognized.filter(x => x === kind).length;

  // Эти параметры становятся производными от IFC, а не от шаблона нового шкафа.
  setNumber("width", size.x);
  setNumber("height", size.y);
  setNumber("depth", size.z);

  const verticalPartitions = count("Вертикальная перегородка");
  const shelves = count("Полка");
  const fixedHorizontals = count("Горизонтальная перегородка");
  const facades = count("Фасад");

  if ($("sections")) $("sections").value = Math.max(1, verticalPartitions + 1);
  if ($("shelves")) $("shelves").value = shelves;
  if ($("fixedPartitions")) $("fixedPartitions").value = fixedHorizontals;
  if ($("doors")) $("doors").value = facades;

  if ($("summary")) {
    $("summary").textContent =
      "IFC · " + Math.round(size.x) + " × " + Math.round(size.y) + " × " + Math.round(size.z) +
      " мм · " + ifcImportedParts.length + " элементов · технология привязана к IFC";
  }
}

function applyIfcMaterial() {
  const selected = $("material")?.value || "ldsp18";
  const palette = {
    ldsp18: 0xc69b68,
    ldsp16: 0xc69b68,
    mdf18: 0xd7d9dc,
    ply18: 0xb88a58
  };
  const color = new THREE.Color(palette[selected] || 0xc69b68);

  ifcImportedParts.forEach(part => {
    part.userData.material = selected;
    part.traverse(obj => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(mat => {
        if (mat.color) mat.color.copy(color);
        mat.needsUpdate = true;
      });
    });
  });
}

function applyIfcRecognition() {
  if (!ifcImportedParts.length) return { counts:{}, lowConfidence:0 };

  const overallBox = new THREE.Box3();
  ifcImportedParts.forEach(part => overallBox.union(new THREE.Box3().setFromObject(part)));

  const counters = {};
  let lowConfidence = 0;

  ifcImportedParts.forEach((part, index) => {
    const u = part.userData;
    const box = new THREE.Box3().setFromObject(part);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const result = recognizeIfcPart({
      name: u.sourceName || u.name,
      typeName: u.ifcType,
      size,
      center,
      overallBox
    });

    counters[result.kind] = (counters[result.kind] || 0) + 1;
    if (result.confidence === "low") lowConfidence++;

    u.kind = result.kind;
    u.recognizedKind = result.kind;
    u.recognitionConfidence = result.confidence;
    u.recognitionReason = result.reason;
    u.sourceName = u.sourceName || u.name;

    const sourceName = normalizeIfcText(u.sourceName);
    const genericSource = !sourceName ||
      sourceName === ("ifc элемент " + u.expressId) ||
      sourceName === "ifc element " + u.expressId;

    // Только если имя IFC было техническим/неинформативным,
    // заменяем отображаемое имя на технологическое.
    if (genericSource) {
      const sameKind = ifcImportedParts.filter(p => p.userData.recognizedKind === result.kind).indexOf(part) + 1;
      u.name = result.label + " " + sameKind;
    }

    u.width = size.x;
    u.height = size.y;
    u.depth = size.z;
    u.thickness = Math.min(size.x, size.y, size.z);
    u.recognitionIndex = index + 1;
  });

  return { counts:counters, lowConfidence };
}

async function importIfcIntoFurnitureCore(file) {
  if (!file) return;

  const target = $("ifcRecognition");
  const geometryStatus = $("ifcGeometry");
  const objectsStatus = $("ifcProjectObjects");

  try {
    target && (target.textContent = "Импорт IFC: чтение геометрии…");

    const api = await ensureIfcApi();
    // Сначала инвалидируем старый проект и закрываем старый IFC,
    // затем открываем новый IFC. Нельзя очищать модель после OpenModel(),
    // потому что clearModel() закрывает активный IFC-документ.
    clearModel();

    const data = new Uint8Array(await file.arrayBuffer());
    ifcModelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });

    if (ifcModelId === -1) {
      throw new Error("IFC не удалось открыть.");
    }

    const candidateIds = new Set();
    for (const name of ["IFCFURNITURE", "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY"]) {
      const code = WebIFC[name];
      if (typeof code !== "number") continue;
      vectorToArray(api.GetLineIDsWithType(ifcModelId, code)).forEach(id => candidateIds.add(id));
    }

    // Если IFC не классифицировал мебель отдельным типом, используем все
    // геометрические элементы как резервный режим. Геометрия не меняется.
    let expressIds = [...candidateIds];
    if (!expressIds.length) {
      expressIds = vectorToArray(api.GetAllLines(ifcModelId)).filter(id => {
        try {
          const line = api.GetLine(ifcModelId, id);
          return Boolean(line && line.type && api.IsIfcElement?.(line.type));
        } catch {
          return false;
        }
      });
    }

    let rendered = 0;
    for (const expressId of expressIds) {
      let line = null;
      try { line = api.GetLine(ifcModelId, expressId); } catch {}

      let flatMesh = null;
      try { flatMesh = api.GetFlatMesh(ifcModelId, expressId); } catch {}
      if (!flatMesh || !flatMesh.geometries || !flatMesh.geometries.size()) continue;

      const name =
        String(ifcScalar(line?.Name) || ifcScalar(line?.ObjectType) ||
        ifcScalar(line?.Tag) || ("IFC элемент " + expressId));

      const typeName = line?.type ? api.GetNameFromTypeCode(line.type) : "IFC";
      const group = new THREE.Group();
      group.name = name;

      for (let i = 0; i < flatMesh.geometries.size(); i++) {
        const placed = flatMesh.geometries.get(i);
        const mesh = makeIfcMesh(api, ifcModelId, placed);
        group.add(mesh);
      }

      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) continue;

      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      group.userData = {
        source: "IFC",
        expressId,
        ifcType: typeName,
        kind: classifyIfcType(typeName),
        recognizedKind: classifyIfcType(typeName),
        recognitionConfidence: "pending",
        recognitionReason: "ожидает геометрической классификации",
        sourceName: name,
        name,
        width: size.x,
        height: size.y,
        depth: size.z,
        thickness: Math.min(size.x, size.y, size.z),
        quantity: 1,
        material: $("material")?.value || "ldsp18",
        edges: edgeLabels(),
        base: center.clone(),
        partNumber: ""
      };

      root.add(group);
      parts.push(group);
      ifcImportedParts.push(group);
      rendered++;
    }

    if (!rendered) throw new Error("В IFC не найдены элементы с геометрией.");

    const recognition = applyIfcRecognition();
    ifcMode = true;
    syncIfcParametersFromRecognition();
    applyIfcMaterial();
    const technology = buildIfcTechnologyState();
    assignPartNumbers();
    const ifcTechnologyOps = buildIfcTechnologyOperations();
    const ifcHardwareSchedule = buildIfcHardwareSchedule();
    ifcImportedParts.forEach(part => {
      part.userData.ifcHardwareSchedule = ifcHardwareSchedule.filter(
        item => item.partNumber === part.userData.partNumber
      );
    });
    const detailingPipeline = rebuildDetailingPipeline();
    const constructionQC = runConstructionQC(detailingPipeline);
    const releaseGate = runReleaseGate();
    renderPartsTable();
    fitView();

    const recognitionSummary = Object.entries(recognition.counts)
      .map(([kind, count]) => kind + ": " + count)
      .join(" · ");

    if (target) target.textContent =
      "IFC импортирован: " + rendered + " элементов. Автораспознавание деталей завершено.";

    if (geometryStatus) geometryStatus.textContent =
      "Реальная IFC-геометрия: " + rendered + " элементов. Геометрия не изменялась.";

    if (objectsStatus) objectsStatus.textContent =
      "Распознано: " + recognitionSummary +
      (recognition.lowConfidence ? " · требуют проверки: " + recognition.lowConfidence : " · неоднозначных деталей нет") +
      " · технология: готово " + technology.ready + ", на проверке " + technology.review +
      " · соединения-кандидаты: " + ifcTechnologyOps.joints.length +
      " · позиции крепежа-кандидаты: " + ifcHardwareSchedule.length +
      " · деталировка: готово " + detailingPipeline.ready + ", на проверке " + detailingPipeline.review +
      " · Construction QC: " + constructionQC.status +
      " · Release Gate: " + releaseGate.status;

    if ($("projectName")) $("projectName").textContent = file.name;
    if ($("status")) $("status").textContent = "IFC импортирован · геометрия является источником истины";

    validate(
      technology.review || detailingPipeline.review || !constructionQC.passed
        ? "IFC импортирован. Construction QC требует проверки: " + constructionQC.issueCount + " замечаний."
        : "IFC импортирован. Construction QC PASS: цепочка конструкция → детали → присадка → деталировка согласована. Геометрия не изменена.",
      technology.review || detailingPipeline.review || !constructionQC.passed ? "error" : "ok"
    );
  } catch (error) {
    console.error(error);
    target && (target.textContent = "Ошибка IFC: " + (error?.message || error));
    geometryStatus && (geometryStatus.textContent = "Геометрия IFC не импортирована.");
    validate("Ошибка импорта IFC: " + (error?.message || error), "error");
  }
}

$("ifcImport")?.addEventListener("click", async () => {
  const file = $("ifcFile")?.files?.[0];
  await importIfcIntoFurnitureCore(file);
});

$("ifcFile")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await importIfcIntoFurnitureCore(file);
});


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
  if (u.source === "IFC") {
    (u.technology?.edgeOperations || []).forEach(op => operations.push({
      type:"Кромление", operation:"Кромление",
      edge:op.edge, material:op.material, status:op.status, source:"IFC"
    }));
    (u.technology?.drilling || []).forEach(op => operations.push({
      type:op.type, operation:"Кандидат сверления",
      diameter:op.diameter, depth:op.depth,
      x:op.x, y:op.y, z:op.z,
      linkedHardware:op.linkedPart || "",
      status:op.status, source:op.source, needsReference:op.needsReference
    }));
    (u.technology?.operations || []).filter(op=>op.type==="Соединение").forEach(op => operations.push({
      type:"Соединение", operation:op.operation,
      status:op.status, linkedPart:op.linkedPart,
      contactCenter:op.contactCenter, contactAxis:op.contactAxis,
      hardwareRecommendation:op.hardwareRecommendation, source:"IFC"
    }));
    return operations;
  }
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

  // Геометрическая целостность параметрической модели.
  // Для IFC источник геометрии остаётся неизменным, поэтому эти проверки
  // применяются только к модели, построенной Furniture Core.
  if (!ifcMode) {
    const innerW = p.width - 2 * p.thickness;
    const innerH = p.height - 2 * p.thickness;
    const eps = 0.5;

    parts.forEach(part => {
      const u = part.userData;
      if (![u.width, u.height, u.depth].every(v => Number.isFinite(Number(v)) && Number(v) > 0)) {
        issues.push("Некорректные габариты детали: " + u.name);
      }

      if (u.kind === "Полка") {
        const left = part.position.x - u.width / 2;
        const right = part.position.x + u.width / 2;
        if (left < -innerW / 2 - eps || right > innerW / 2 + eps) {
          issues.push("Полка выходит за пределы внутренней секции: " + u.name);
        }
        if (u.height > p.thickness + eps) {
          issues.push("Толщина полки не соответствует материалу: " + u.name);
        }
      }

      if (u.kind === "Вертикальная перегородка") {
        const x = part.position.x;
        if (x < -innerW / 2 - eps || x > innerW / 2 + eps) {
          issues.push("Вертикальная перегородка выходит за корпус: " + u.name);
        }
      }

      if (u.kind === "Горизонтальная перегородка") {
        const y = part.position.y;
        if (y < p.thickness - eps || y > p.height - p.thickness + eps) {
          issues.push("Горизонтальная перегородка выходит за корпус: " + u.name);
        }
      }

      if (u.kind === "Фасад") {
        const left = part.position.x - u.width / 2;
        const right = part.position.x + u.width / 2;
        const bottom = part.position.y - u.height / 2;
        const top = part.position.y + u.height / 2;
        if (left < -p.width / 2 - eps || right > p.width / 2 + eps ||
            bottom < -eps || top > p.height + eps) {
          issues.push("Фасад выходит за габариты корпуса: " + u.name);
        }
      }
    });

    if (innerW <= 0 || innerH <= 0) {
      issues.push("Внутренний объём корпуса имеет недопустимый размер.");
    }
  }
  parts.forEach(part => {
    const u = part.userData;
    const minDrillEdge = 4;
    (u.drilling || []).forEach(h => {
      if (h.depth > Math.max(u.depth, u.width, u.height)) issues.push("Глубина отверстия превышает толщину/габарит детали: " + u.name);
      if (Math.min(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) < minDrillEdge) {
        issues.push("Отверстие слишком близко к базовой грани: " + u.name + " / " + h.id);
      }
    });
    if (u.source === "IFC") {
      (u.technology?.joints || []).forEach(joint => {
        if (joint.status !== "ready") issues.push("IFC-соединение требует подтверждения: " + u.name + " / " + (joint.id || "joint"));
      });
      (u.technology?.drilling || []).forEach(op => {
        if (op.status === "review") issues.push("IFC-присадка требует подтверждения базы: " + u.name + " / " + op.id);
        if (!Number.isFinite(op.depth) || op.depth <= 0) issues.push("Недопустимая глубина IFC-присадки: " + u.name + " / " + op.id);
        if (op.depth > Math.max(0, Number(u.technology?.thicknessEstimate || 0) - 1)) {
          issues.push("Глубина IFC-присадки превышает безопасную толщину детали: " + u.name + " / " + op.id);
        }
      });
    }
    if (u.kind === "Полка" && u.width < 100) issues.push("Полка слишком узкая: " + u.name);
    if (u.kind === "Фасад" && (u.width < 100 || u.height < 200)) issues.push("Недопустимые габариты фасада: " + u.name);
  });
  if (p.doors > 1 && p.frontGapBetween < 2) issues.push("Зазор между соседними фасадами меньше 2 мм.");
  if (p.frontGapTB < 1) issues.push("Верхний/нижний технологический зазор фасада меньше 1 мм.");
  if (p.depth < 300 && p.shelves > 0) issues.push("Малая глубина корпуса: проверьте рабочую глубину полок и крепежа.");
  return [...new Set(issues)];
}

/*
 * Construction QC Gate
 * Единая контрольная точка перед передачей деталировки в раскрой.
 *
 * Порядок:
 * параметры → конструкция → детали → присадка → деталировка → QC → раскрой.
 *
 * QC ничего не исправляет автоматически и не меняет IFC-геометрию.
 * Он только собирает результаты уже выполненных проверок в единый контракт.
 */
function runConstructionQC(pipelineResult = { ready:0, review:0, issues:[] }) {
  const baseIssues = [
    ...constructionChecks(
      parts.flatMap(part => part.userData.bodyFasteners || []),
      parts.flatMap(part => part.userData.shelfSupportDrilling || []),
      parts.flatMap(part => part.userData.secondaryFasteners || [])
    ),
    ...constructionChecksDetailed(),
    ...(pipelineResult.issues || [])
  ];

  const uniqueIssues = [...new Set(baseIssues.filter(Boolean))];
  const detailStatuses = parts.map(part => ({
    partNumber: part.userData.partNumber || "",
    name: part.userData.name || "",
    role: part.userData.recognizedKind || part.userData.kind || "",
    status: part.userData.detailing?.status || "review",
    processingCount: part.userData.detailing?.processing?.length || 0,
    holesCount: part.userData.detailing?.holes?.length || 0,
    cuttingEligible: Boolean(part.userData.detailing?.cutting?.eligible)
  }));

  const unresolvedDetails = detailStatuses.filter(item => item.status !== "ready");
  const missingCuttingLink = detailStatuses.filter(item => !item.cuttingEligible);
  const geometrySourceErrors = parts.filter(part =>
    part.userData.source === "IFC" && part.userData.geometryLocked !== true
  );

  const checks = {
    parameters: uniqueIssues.filter(x =>
      /размер|зазор|угол|секци|глубин|толщин|объём/i.test(x)
    ).length === 0,
    construction: uniqueIssues.length === 0,
    detailing: unresolvedDetails.length === 0,
    cuttingLink: missingCuttingLink.length === 0,
    ifcGeometryLocked: geometrySourceErrors.length === 0
  };

  const passed = Object.values(checks).every(Boolean);

  const report = {
    gate: "CONSTRUCTION_QC",
    status: passed ? "PASS" : "REVIEW",
    passed,
    checks,
    issueCount: uniqueIssues.length,
    issues: uniqueIssues,
    details: detailStatuses,
    summary: {
      parts: parts.length,
      detailingReady: Number(pipelineResult.ready || 0),
      detailingReview: Number(pipelineResult.review || 0),
      unresolvedDetails: unresolvedDetails.length,
      missingCuttingLink: missingCuttingLink.length,
      geometrySourceErrors: geometrySourceErrors.length
    }
  };

  parts.forEach(part => {
    const number = part.userData.partNumber || "";
    const item = detailStatuses.find(x => x.partNumber === number);
    part.userData.constructionQC = {
      status: item?.status === "ready" && passed ? "PASS" : "REVIEW",
      sourceGeometry: part.userData.source === "IFC" ? "IFC" : "Furniture Core",
      detailingReady: item?.status === "ready",
      cuttingEligible: Boolean(item?.cuttingEligible),
      processingCount: item?.processingCount || 0,
      holesCount: item?.holesCount || 0
    };
  });

  report.modelRevision = modelRevision;
  window._constructionQC = report;
  return report;
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

/*
 * Единая точка сборки цепочки:
 * конструкция → деталь → присадка → деталировка → раскрой.
 * Никаких новых геометрических данных здесь не создаётся.
 * Источником размеров остаётся userData детали, а для IFC — исходная IFC-геометрия.
 */
function rebuildDetailingPipeline() {
  const issues = [];
  let ready = 0;
  let review = 0;

  parts.forEach(part => {
    const u = part.userData;

    // Деталировка является производным состоянием.
    // Перед каждой пересборкой удаляем только предыдущий производный результат,
    // не изменяя исходную геометрию и исходные технологические источники.
    delete u.detailing;
    delete u.detailingContinuity;
    delete u.processing;

    const processing = buildDetailedProcessing(part);
    u.processing = processing;

    const holes = [
      ...(u.drilling || []),
      ...(u.bodyFasteners || []),
      ...(u.shelfSupportDrilling || []),
      ...(u.secondaryFasteners || []),
      ...((u.technology && u.technology.drilling) || [])
    ];

    const spec = getSheetSpec(part);
    const sourceGeometry = u.source === "IFC" ? "IFC" : "Furniture Core";

    const partIssues = [];
    if (!u.partNumber) partIssues.push("нет номера детали");
    if (u.source === "IFC" && u.recognitionConfidence === "low") {
      partIssues.push("низкая уверенность IFC-распознавания; требуется ручная проверка");
    }
    if (u.source === "IFC" && (u.technology?.joints || []).some(j => j.status === "candidate")) {
      partIssues.push("есть неподтверждённое IFC-соединение; требуется ручное подтверждение технологии");
    }
    if (![u.width, u.height, u.depth].every(v => Number.isFinite(Number(v)) && Number(v) > 0)) {
      partIssues.push("некорректные габариты");
    }
    processing.forEach((op, index) => {
      if (!op || !op.type) partIssues.push("операция №" + (index + 1) + " без типа");
      if (op.type === "Сверление" || /сверлен|отверст/i.test(op.operation || "")) {
        if (!Number.isFinite(Number(op.diameter)) || Number(op.diameter) <= 0) {
          partIssues.push("присадка без диаметра");
        }
        if (!Number.isFinite(Number(op.depth)) || Number(op.depth) <= 0) {
          partIssues.push("присадка без глубины");
        }
      }
    });

    const detailStatus = partIssues.length ? "review" : "ready";
    if (detailStatus === "ready") ready++; else review++;
    issues.push(...partIssues.map(issue => "Деталь " + (u.partNumber || u.name) + ": " + issue));

    u.detailing = {
      number: u.partNumber,
      name: u.name,
      length: Math.round(u.width),
      width: Math.round(u.height),
      thickness: Math.round(u.depth),
      quantity: Number(u.quantity || 1),
      material: u.material,
      edges: [...(u.edges || [])],
      processing: [...processing],
      holes: [...holes],
      milling: processing.filter(op => /фрез|паз|выбор/i.test(op.operation || "")),
      construction: {
        source: sourceGeometry,
        role: u.recognizedKind || u.kind || "",
        confidence: u.recognitionConfidence || "n/a",
        jointCount: Number(u.technology?.jointCount || 0),
        operationCount: processing.length
      },
      cutting: {
        thickness: spec.thickness,
        length: spec.length,
        width: spec.width,
        quantity: Number(u.quantity || 1),
        eligible: detailStatus === "ready"
      },
      status: detailStatus,
      notes: partIssues,
      modelRevision
    };

    u.detailingContinuity = {
      construction: Boolean(u.kind || u.recognizedKind),
      detail: Boolean(u.partNumber),
      processingCount: processing.length,
      holesCount: holes.length,
      cuttingReady: detailStatus === "ready",
      sourceGeometry,
      modelRevision
    };
  });

  return { ready, review, issues: [...new Set(issues)] };
}

function getSheetSpec(part) {
  const u = part.userData;
  if (Number.isFinite(Number(u.sheetThickness)) &&
      Number.isFinite(Number(u.sheetLength)) &&
      Number.isFinite(Number(u.sheetWidth))) {
    return {
      thickness: Math.round(u.sheetThickness),
      length: Math.round(u.sheetLength),
      width: Math.round(u.sheetWidth)
    };
  }

  const target = Number($("thickness")?.value || 18);
  const dims = [
    {axis:"width", value:Number(u.width)},
    {axis:"height", value:Number(u.height)},
    {axis:"depth", value:Number(u.depth)}
  ].filter(d => Number.isFinite(d.value));
  dims.sort((a,b) => Math.abs(a.value-target) - Math.abs(b.value-target));
  const thickness = dims[0]?.value || target;
  const remaining = dims.filter(d => d !== dims[0]).map(d => Math.round(d.value));
  u.sheetThickness = Math.round(thickness);
  u.sheetLength = remaining[0] || Math.round(u.width);
  u.sheetWidth = remaining[1] || Math.round(u.height);
  return {
    thickness: u.sheetThickness,
    length: u.sheetLength,
    width: u.sheetWidth
  };
}

function buildCuttingGroups() {
  const groups = new Map();

  // Раскрой больше не читает конструкционные поля напрямую.
  // Источник для него — уже согласованная деталировка.
  parts.forEach(part => {
    const u = part.userData;
    const d = u.detailing;
    if (!d) return;

    const key = [
      d.material,
      d.cutting.thickness,
      d.edges.join("|"),
      d.cutting.length,
      d.cutting.width
    ].join("::");

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        material: d.material,
        thickness: d.cutting.thickness,
        length: d.cutting.length,
        width: d.cutting.width,
        edges: [...d.edges],
        quantity: 0,
        partNumbers: [],
        details: [],
        detailingStatus: d.status
      });
    }

    const g = groups.get(key);
    const quantity = Number(d.quantity || 1);
    g.quantity += quantity;
    g.partNumbers.push(d.number);
    g.details.push({
      number: d.number,
      length: d.cutting.length,
      width: d.cutting.width,
      thickness: d.cutting.thickness,
      quantity,
      material: d.material,
      edges: [...d.edges]
    });
    if (d.status !== "ready") g.detailingStatus = "review";
  });

  return [...groups.values()].map((g, index) => ({
    ...g,
    groupNumber: String(index + 1).padStart(3, "0")
  }));
}


function buildSheetLayout(sheetLength, sheetWidth, kerf, margin) {
  const groups = buildCuttingGroups();
  const sheets = [];
  let sheetIndex = 1;

  const newSheet = (material) => ({
    sheetNumber: sheetIndex++,
    material,
    thickness: null,
    length: sheetLength,
    width: sheetWidth,
    placements: []
  });

  const items = [];
  groups.forEach(group => {
    // Номер детали берём из конкретной записи деталировки.
    // Нельзя индексировать group.partNumbers по общей quantity:
    // quantity может быть больше числа исходных деталей.
    group.details.forEach(detail => {
      const quantity = Math.max(1, Number(detail.quantity || 1));
      for (let q = 0; q < quantity; q++) {
        items.push({
          groupNumber: group.groupNumber,
          partNumber: detail.number || "",
          material: detail.material || group.material,
          length: detail.length,
          width: detail.width,
          thickness: detail.thickness,
          edges: [...(detail.edges || group.edges || [])]
        });
      }
    });
  });

  items.sort((a, b) => (b.length * b.width) - (a.length * a.width));

  const tryPlace = (sheet, item) => {
    const rows = [];
    const rowMap = new Map();
    sheet.placements.forEach(p => {
      const key = p.y;
      if (!rowMap.has(key)) rowMap.set(key, []);
      rowMap.get(key).push(p);
    });

    for (const [y, row] of [...rowMap.entries()].sort((a,b) => a[0]-b[0])) {
      const right = row.reduce((m,p) => Math.max(m, p.x + p.length), margin);
      if (right + kerf + item.length <= sheetLength - margin &&
          y + item.width <= sheetWidth - margin) {
        return { x:right + kerf, y, length:item.length, width:item.width };
      }
    }

    const maxY = sheet.placements.reduce(
      (m,p) => Math.max(m, p.y + p.width + kerf),
      margin
    );
    if (margin + item.length <= sheetLength - margin &&
        maxY + item.width <= sheetWidth - margin) {
      return { x:margin, y:maxY, length:item.length, width:item.width };
    }

    if (sheet.placements.length === 0 &&
        margin + item.length <= sheetLength - margin &&
        margin + item.width <= sheetWidth - margin) {
      return { x:margin, y:margin, length:item.length, width:item.width };
    }

    return null;
  };

  items.forEach(item => {
    let sheet = [...sheets].reverse().find(s =>
      s.material === item.material && Number(s.thickness) === Number(item.thickness)
    );
    let placement = sheet ? tryPlace(sheet, item) : null;

    if (!placement) {
      sheet = newSheet(item.material);
      sheet.thickness = item.thickness;
      sheets.push(sheet);
      placement = tryPlace(sheet, item);
    }

    sheet.placements.push({
      sheetNumber: sheet.sheetNumber,
      groupNumber: item.groupNumber,
      partNumber: item.partNumber,
      x: placement ? Math.round(placement.x) : margin,
      y: placement ? Math.round(placement.y) : margin,
      length: item.length,
      width: item.width,
      thickness: item.thickness,
      material: item.material,
      overflow: !placement,
      edges: [...item.edges]
    });
  });

  return { sheetLength, sheetWidth, kerf, margin, sheets };
}

function renderCuttingMap(layout) {
  const panel = $("cuttingMap");
  if (!panel) return;

  panel.innerHTML = "";
  layout.sheets.forEach(sheet => {
    const card = document.createElement("div");
    card.className = "cutting-sheet";

    const title = document.createElement("div");
    title.className = "cutting-sheet-title";
    title.textContent =
      "Лист " + sheet.sheetNumber + " · " + sheet.material +
      " · " + sheet.length + " × " + sheet.width + " мм";
    card.appendChild(title);

    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = Math.max(300, Math.round(900 * sheet.width / sheet.length));
    canvas.className = "cutting-canvas";

    const ctx = canvas.getContext("2d");
    const sx = canvas.width / sheet.length;
    const sy = canvas.height / sheet.width;

    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    sheet.placements.forEach(p => {
      const x = p.x * sx, y = p.y * sy;
      const w = p.length * sx, h = p.width * sy;

      ctx.fillStyle = p.overflow ? "#fecaca" : "#dbeafe";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#334155";
      ctx.strokeRect(x, y, w, h);

      ctx.fillStyle = "#111827";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = Math.max(11, Math.min(24, Math.min(w,h)*0.18)) + "px Arial";
      ctx.fillText(p.partNumber, x + w/2, y + h/2);
      ctx.font = "11px Arial";
      ctx.fillText(
        Math.round(p.length) + "×" + Math.round(p.width),
        x + w/2,
        y + h/2 + 16
      );

      if (p.overflow) {
        ctx.fillStyle = "#991b1b";
        ctx.fillText("НЕ ПОМЕЩАЕТСЯ", x + w/2, y + h/2 + 31);
      }
    });

    panel.appendChild(card);
  });

  panel.hidden = false;
}

function cuttingOperationList(part) {
  const detailing = part.userData?.detailing;
  const sources = Array.isArray(detailing?.holes) ? detailing.holes : [];
  return sources.map((op, index) => ({
    number: index + 1,
    type: op.operation || op.type || "Сверление",
    diameter: Number.isFinite(Number(op.diameter)) ? Number(op.diameter) : null,
    depth: Number.isFinite(Number(op.depth)) ? Number(op.depth) : null,
    x: Number.isFinite(Number(op.x)) ? Number(op.x) : null,
    y: Number.isFinite(Number(op.y)) ? Number(op.y) : null,
    hardware: op.linkedHardware || op.linkedPart || op.type || "",
    quantity: Number.isFinite(Number(op.quantity)) ? Number(op.quantity) : 1
  }));
}

function edgeSummary(edges) {
  return (edges || []).map((e, i) => "С" + (i + 1) + ": " + e).join(" · ");
}

function drillingSchematic(part) {
  const u = part.userData;
  const ops = cuttingOperationList(part);
  const W = 420, H = 240, pad = 28;
  const dw = Math.max(40, Number(u.width) || 40);
  const dh = Math.max(40, Number(u.height) || 40);

  const circles = ops.map((op, i) => {
    const rx = Number(op.x);
    const ry = Number(op.y);
    const px = Number.isFinite(rx) ? Math.max(0.03, Math.min(0.97, (rx + dw/2) / dw)) : 0.12 + (i % 6) * 0.15;
    const py = Number.isFinite(ry) ? Math.max(0.03, Math.min(0.97, (ry + dh/2) / dh)) : 0.12 + (Math.floor(i/6) % 5) * 0.19;
    const cx = pad + px * (W - pad*2);
    const cy = pad + py * (H - pad*2);
    const r = Math.max(4, Math.min(10, Number(op.diameter || 6)));
    const label = op.number + (op.quantity > 1 ? " ×"+op.quantity : "");
    return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) +
      '" r="' + r.toFixed(1) + '" fill="none" stroke="#111827" stroke-width="2"/>' +
      '<text x="' + (cx+8).toFixed(1) + '" y="' + (cy-8).toFixed(1) +
      '" font-size="10" fill="#111827">' + label + '</text>';
  }).join("");

  return '<svg viewBox="0 0 '+W+' '+H+'" class="drilling-schematic">' +
    '<rect x="'+pad+'" y="'+pad+'" width="'+(W-pad*2)+'" height="'+(H-pad*2)+'" fill="#f8fafc" stroke="#334155" stroke-width="2"/>' +
    '<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="#94a3b8"/>' +
    '<line x1="'+pad+'" y1="'+pad+'" x2="'+pad+'" y2="'+(H-pad)+'" stroke="#94a3b8"/>' +
    circles +
    '<text x="'+W/2+'" y="15" text-anchor="middle" font-size="12" font-weight="bold">Схема присадки · номера соответствуют перечню</text>' +
    '<text x="'+(W/2)+'" y="'+(H-8)+'" text-anchor="middle" font-size="9" fill="#475569">X →</text>' +
    '<text x="10" y="'+(H/2)+'" text-anchor="middle" font-size="9" fill="#475569" transform="rotate(-90 10 '+(H/2)+')">Y →</text>' +
    '</svg>';
}

function buildCuttingPdfHtml(layout, gatedParts = parts) {
  const projectName = $("projectName")?.textContent || "Furniture AI Designer";
  const gatedCount = gatedParts.length;
  const detailPages = gatedParts.map(part => {
    const u = part.userData;
    const d = u.detailing;
    const ops = cuttingOperationList(part);
    const rows = ops.length ? ops.map(op =>
      '<tr><td>'+op.number+'</td><td>'+op.type+'</td><td>'+
      (op.x ?? "—")+'</td><td>'+(op.y ?? "—")+'</td><td>'+
      (op.diameter ?? "—")+'</td><td>'+(op.depth ?? "—")+
      '</td><td>'+op.quantity+'</td><td>'+op.hardware+'</td></tr>'
    ).join("") : '<tr><td colspan="8">Присадка не задана</td></tr>';

    return '<section class="detail-page">' +
      '<h2>Деталь №'+u.partNumber+' — '+u.name+'</h2>' +
      '<div class="detail-meta"><b>Размер:</b> '+d.length+' × '+d.width+' × '+d.thickness+' мм · '+
      '<b>Материал:</b> '+d.material+' · <b>Количество:</b> '+(d.quantity || 1)+'</div>' +
      '<div class="detail-meta"><b>Кромка:</b> '+edgeSummary(d.edges)+'</div>' +
      '<div class="detail-meta"><b>Источник геометрии:</b> '+(u.source || "Furniture Core")+'</div>' +
      '<div class="detail-meta"><b>Операций присадки:</b> '+ops.length+' · <b>Всего отверстий:</b> '+ops.reduce((sum, op) => sum + (op.quantity || 1), 0)+'</div>' +
      (ops.length ? drillingSchematic(part) : '<div class="no-drilling">Присадка и сверловка отсутствуют.</div>') +
      '<table><thead><tr><th>№</th><th>Операция</th><th>X, мм</th><th>Y, мм</th><th>Ø, мм</th><th>Глубина, мм</th><th>Количество</th><th>Фурнитура / назначение</th></tr></thead><tbody>'+
      rows+'</tbody></table></section>';
  }).join("");

  const sheetPages = layout.sheets.map(sheet => {
    const rects = sheet.placements.map(p => {
      const x = p.x / sheet.length * 760;
      const y = p.y / sheet.width * 510;
      const w = p.length / sheet.length * 760;
      const h = p.width / sheet.width * 510;
      const label = p.partNumber + '  ' + Math.round(p.length) + '×' + Math.round(p.width);
      return '<g><rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="#e5e7eb" stroke="#111827"/>' +
        '<text x="'+(x+w/2).toFixed(1)+'" y="'+(y+h/2).toFixed(1)+'" text-anchor="middle" dominant-baseline="middle" font-size="12">'+label+'</text>'+
        (p.overflow ? '<text x="'+(x+w/2).toFixed(1)+'" y="'+(y+h/2+18).toFixed(1)+'" text-anchor="middle" font-size="11" fill="#991b1b">НЕ ПОМЕЩАЕТСЯ</text>' : '')+
        '</g>';
    }).join("");

    return '<section class="sheet-page">' +
      '<h2>Карта раскроя · лист '+sheet.sheetNumber+'</h2>' +
      '<div class="sheet-meta">'+sheet.material+' · '+sheet.length+' × '+sheet.width+' мм · пропил '+sheet.kerf+' мм</div>' +
      '<svg viewBox="0 0 760 510" class="sheet-svg"><rect x="0" y="0" width="760" height="510" fill="white" stroke="#111827" stroke-width="3"/>'+rects+'</svg>' +
      '<table><thead><tr><th>№ детали</th><th>Размер</th><th>Материал</th><th>Кромка</th></tr></thead><tbody>'+
      sheet.placements.map(p => {
        return '<tr><td>'+p.partNumber+'</td><td>'+Math.round(p.length)+' × '+Math.round(p.width)+' × '+Math.round(p.thickness || 0)+' мм</td><td>'+
          (p.material || sheet.material)+'</td><td>'+edgeSummary(p.edges)+'</td></tr>';
      }).join("")+'</tbody></table></section>';
  }).join("");

  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Карта раскроя — '+projectName+'</title><style>'+
    '@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111827;margin:0;font-size:10pt}h1{font-size:20pt;margin:0 0 8mm}h2{font-size:15pt;margin:0 0 4mm}.cover{page-break-after:always}.sheet-page{page-break-after:always}.detail-page{page-break-after:always}.sheet-meta,.detail-meta{margin:2mm 0}.sheet-svg{width:100%;height:auto;border:1px solid #111827}.drilling-schematic{width:100%;max-width:180mm;height:auto;margin:5mm 0}table{width:100%;border-collapse:collapse;margin-top:5mm}th,td{border:1px solid #6b7280;padding:3px 4px;text-align:left;vertical-align:top}th{font-weight:700}.no-drilling{margin:8mm 0;padding:5mm;border:1px solid #9ca3af}'+
    '</style></head><body><section class="cover"><h1>Карта раскроя</h1><p><b>Проект:</b> '+projectName+'</p><p><b>Листов:</b> '+layout.sheets.length+' · <b>Деталей:</b> '+gatedCount+'</p><p>Документ для производственного использования: листы раскроя, детали, кромка, присадка и сверловка.</p></section>'+
    sheetPages + detailPages + '</body></html>';
}

function runReleaseGate() {
  const qc = window._constructionQC;
  const canBuild = Boolean(qc && qc.status === "PASS" && parts.length);

  const cuttingGroups = canBuild ? buildCuttingGroups() : [];
  const sheetLayout = canBuild ? buildSheetLayout(
    Number($("sheetLength")?.value || 2800),
    Number($("sheetWidth")?.value || 2070),
    Number($("cutKerf")?.value || 4),
    Number($("sheetMargin")?.value || 10)
  ) : null;

  const partStates = parts.map(part => {
    const u = part.userData || {};
    return {
      number: u.partNumber || "",
      name: u.name || "",
      sourceGeometry: u.source === "IFC" ? "IFC" : "Furniture Core",
      geometryLocked: u.geometryLocked === true,
      detailing: u.detailing || null
    };
  });

  const report = evaluateReleaseGateState({
    qc,
    partsCount: parts.length,
    partStates,
    cuttingGroups,
    sheetLayout,
    modelRevision
  });

  report.modelRevision = modelRevision;
  report.sheetLayout = sheetLayout;
  report.cuttingGroups = cuttingGroups;
  report.gatedParts = parts.map(part => ({
    partNumber: part.userData?.partNumber || "",
    name: part.userData?.name || "",
    sourceGeometry: part.userData?.source === "IFC" ? "IFC" : "Furniture Core",
    detailing: structuredClone(part.userData?.detailing || null)
  }));
  report.gatedPartsRevision = modelRevision;
  window._releaseGate = report;
  return report;
}

function showCuttingMap() {
  const releaseGate = runReleaseGate();
  if (!releaseGate.passed) {
    validate("Release Gate: просмотр карты раскроя заблокирован. " + releaseGate.issues.join(" "), "error");
    return;
  }
  if (!releaseGate.sheetLayout) {
    validate("Release Gate: отсутствует проверенная раскладка листа.", "error");
    return;
  }
  renderCuttingMap(releaseGate.sheetLayout);
  validate("Карта раскроя показана из проверенной раскладки Release Gate.", "ok");
}

function exportSheetLayout() {
  const releaseGate = runReleaseGate();
  if (!releaseGate.passed) {
    validate("Release Gate: выпуск PDF заблокирован. " + releaseGate.issues.join(" "), "error");
    return;
  }
  // После успешного Release Gate PDF обязан использовать именно
  // проверенную раскладку этого же Gate. Повторная самостоятельная
  // генерация layout здесь запрещена.
  const layout = releaseGate.sheetLayout;
  if (!layout) {
    validate("Release Gate: отсутствует проверенная раскладка листа. Выпуск PDF заблокирован.", "error");
    return;
  }

  renderCuttingMap(layout);

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    validate("Браузер заблокировал окно PDF. Разрешите всплывающие окна для приложения.", "error");
    return;
  }

  printWindow.document.open();
  if (Number(releaseGate.gatedPartsRevision) !== Number(releaseGate.modelRevision)) {
    validate("Release Gate: состав деталей относится к другой ревизии модели. Выпуск PDF заблокирован.", "error");
    return;
  }
  const gatedParts = (releaseGate.gatedParts || []).map(snapshot => ({
    userData: {
      partNumber: snapshot.partNumber,
      name: snapshot.name,
      source: snapshot.sourceGeometry === "IFC" ? "IFC" : "Furniture Core",
      detailing: snapshot.detailing
    }
  }));
  printWindow.document.write(buildCuttingPdfHtml(layout, gatedParts));
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 250);
  validate("Карта раскроя подготовлена. В окне печати выберите «Сохранить как PDF».", "ok");
}
function createPartLabel(part) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "rgba(30,40,50,0.9)";
  ctx.lineWidth = 4;
  ctx.roundRect(4, 4, 248, 88, 14);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#111820";
  ctx.font = "bold 48px Arial";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(part.userData.partNumber, 128, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, transparent: true, depthTest: false}));
  const scale = Math.max(part.userData.width, part.userData.height, part.userData.depth) * 0.11;
  sprite.scale.set(scale * 2.0, scale * 0.75, 1);
  sprite.position.copy(part.position).add(new THREE.Vector3(0, Math.max(part.userData.height, 80) * 0.6, 0));
  sprite.renderOrder = 1000;
  sprite.userData.isPartLabel = true;
  sprite.userData.partNumber = part.userData.partNumber;
  sprite.userData.part = part;
  root.add(sprite);
  part.userData.label = sprite;
}

function rebuildPartLabels() {
  root.children.filter(o => o.userData?.isPartLabel).forEach(label => {
    root.remove(label);
    label.material.map?.dispose();
    label.material.dispose();
  });
  parts.forEach(part => createPartLabel(part));
}

function syncPartLabels() {
  parts.forEach(part => {
    const label = part.userData.label;
    if (!label) return;
    label.position.copy(part.position).add(new THREE.Vector3(
      0,
      Math.max(part.userData.height, 80) * 0.6,
      0
    ));
  });
}

function clearModel() {
  modelRevision += 1;
  window._modelRevision = modelRevision;
  window._constructionQC = null;
  window._releaseGate = null;

  while (root.children.length) {
    const object = root.children.pop();
    if (object.geometry?.dispose) object.geometry.dispose();
    if (object.material?.map?.dispose) object.material.map.dispose();
    if (object.material?.dispose) object.material.dispose();
  }
  parts.length = 0;
  ifcImportedParts = [];
  closeIfcModel();
}

function parseIfcGeometry(source) {
  const points=[];
  const pointRe=/#(\\d+)\\s*=\\s*IFCCARTESIANPOINT\\s*\\(\\s*\\(\\s*([^)]*)\\)\\s*\\)\\s*;/gi;
  let m;
  while((m=pointRe.exec(source))!==null){
    const coords=m[2].split(",").map(v=>Number(v.trim())).filter(Number.isFinite);
    if(coords.length>=2) points.push({id:m[1],x:coords[0],y:coords[1],z:coords[2]||0});
  }
  const placements=[];
  const placeRe=/#(\\d+)\\s*=\\s*IFCLOCALPLACEMENT\\s*\\(\\s*(?:#(\\d+)|\\$)\\s*,\\s*#(\\d+)\\s*\\)\\s*;/gi;
  while((m=placeRe.exec(source))!==null) placements.push({id:m[1],relative:m[2]||null,axis:m[3]});
  return {points,placements};
}

function detectIfcLengthScale(source) {
  if (/IFCSIUNIT[^;]*LENGTHUNIT[^;]*MILLI(METRE|METER)/i.test(source)) return 1;
  if (/IFCSIUNIT[^;]*LENGTHUNIT[^;]*METRE/i.test(source)) return 1000;
  return 1;
}

function renderIfcGeometryPreview(result) {
  const old=$("ifcPreviewGroup");
  if(old) old.remove();
  if(!result?.geometry?.points?.length) return;
  const points=result.geometry.points;
  const scale=detectIfcLengthScale(result.sourceText||"");
  const xs=points.map(p=>p.x*scale), ys=points.map(p=>p.y*scale), zs=points.map(p=>p.z*scale);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const minZ=Math.min(...zs), maxZ=Math.max(...zs);
  const w=Math.max(100,maxX-minX), d=Math.max(100,maxY-minY), h=Math.max(100,maxZ-minZ);
  const geo=new THREE.BoxGeometry(w,h,d);
  const mat=new THREE.MeshBasicMaterial({color:0x6b7280,wireframe:true});
  const mesh=new THREE.Mesh(geo,mat);
  mesh.position.set((minX+maxX)/2,(minZ+maxZ)/2,(minY+maxY)/2);
  const group=new THREE.Group();
  group.name="IFC Preview";
  group.id="ifcPreviewGroup";
  group.add(mesh);
  scene.add(group);
  validate("IFC 3D-оболочка построена по исходным CartesianPoint. Размер: "+Math.round(w)+"×"+Math.round(h)+"×"+Math.round(d)+" мм.","ok");
}

function attachIfcGeometry(result, source) {
  const geometry=parseIfcGeometry(source);
  const pointById=new Map(geometry.points.map(p=>[p.id,p]));
  result.sourceText=source;
  result.geometry={pointCount:geometry.points.length,placementCount:geometry.placements.length,points:geometry.points};
  result.furniture=(result.furniture||[]).map((o,i)=>{
    const nums=o.numericValues||[];
    const p=geometry.points[i % Math.max(1,geometry.points.length)];
    return {...o,geometry:{
      position:p ? {x:p.x,y:p.y,z:p.z} : {x:0,y:0,z:0},
      dimensions:{width:nums[0]||0,height:nums[1]||0,depth:nums[2]||0},
      source:"IFC geometry references / attributes"
    }};
  });
  return result;
}

function parseIfcFurniture(text) {
  const source=String(text||"");
  const objects=[];
  const re=/#(\\d+)\\s*=\\s*(IFCFURNISHINGELEMENT|IFCBUILDINGELEMENTPROXY)\\s*\\((.*)\\);/g;
  let m;
  while((m=re.exec(source))!==null){
    const attrs=m[3];
    const quoted=[...attrs.matchAll(/'([^']*)'/g)].map(x=>x[1]).filter(Boolean);
    const name=quoted[0] || "IFC-объект";
    objects.push({id:m[1],type:m[2],name});
  }
  return {
    format:"IFC",
    furniture:objects.filter(o=>o.type==="IFCFURNISHINGELEMENT"),
    proxies:objects.filter(o=>o.type==="IFCBUILDINGELEMENTPROXY"),
    total:objects.length
  };
}

function mapIfcFurnitureToProject(result){
  return (result.furniture||[]).map((o,index)=>({
    ifcId:o.id,name:o.name,sourceType:o.type,
    projectObjectType:"Мебель",sourceIndex:index,
    geometry:o.geometry||null,
    attributes:o.attributes||[],numericValues:o.numericValues||[]
  }));
}

function renderIfcResult(result){
  const target=$("ifcRecognition");
  if(!target) return;
  const furniture=result.furniture||[];
  target.innerHTML="<b>IFC распознан.</b><div>Мебельных объектов: "+furniture.length+"</div>"+
    (furniture.length ? "<ul>"+furniture.map(o=>"<li>#"+o.id+" — "+o.name+"</li>").join("")+"</ul>" :
    "<div class='status'>IFC содержит объекты, но мебель IFC не обнаружена.</div>");
  window._ifcResult=result;
  window._ifcProjectObjects=mapIfcFurnitureToProject(result);
  const g=$("ifcGeometry"); if(g) g.innerHTML="<b>IFC-геометрия</b><div>Точек: "+(result.geometry?.pointCount||0)+"; размещений: "+(result.geometry?.placementCount||0)+"</div>";
  const p=$("ifcProjectObjects");
  if(p) p.innerHTML="<b>Объекты проекта</b>"+(window._ifcProjectObjects.length ? "<ul>"+window._ifcProjectObjects.map(o=>"<li>#"+o.ifcId+" — "+o.name+"</li>").join("")+"</ul>" : "<div>Нет IFCFURNISHINGELEMENT.</div>");
}

function importIfcFile(file){
  if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    const result=attachIfcGeometry(parseIfcFurniture(reader.result), reader.result);
    renderIfcGeometryPreview(result);
    renderIfcResult(result);
    validate("IFC импортирован: найдено объектов "+result.total+", мебельных "+result.furniture.length+".","ok");
  };
  reader.readAsText(file);
}

function analyzeFurnitureImageMetadata(file) {
  if (!file) return null;
  const result = {fileName:file.name,type:file.type||"unknown",recognized:[],params:{},confidence:"низкая"};
  if (/^image\\//.test(file.type || "")) {
    result.recognized.push("изображение мебели загружено");
    result.recognized.push("требуется визуальное распознавание конструкции");
  }
  result.confirmation = "Я распознал конструкцию следующим образом: " + result.recognized.join(", ") + ".";
  return result;
}
function renderAiImageRecognition(result) {
  const target=$("aiImageRecognition");
  if(!target || !result) return;
  target.innerHTML="<b>"+result.confirmation+"</b><div class='status'>Файл: "+result.fileName+"</div><div class='status'>Геометрия автоматически не изменяется до подтверждения AI-анализа.</div>";
  window._aiImageRecognition=result;
}

function recognizeFurnitureText(text) {
  const source = String(text || "").toLowerCase().replace(/,/g, ".");
  const nums = source.match(/(\d+(?:\.\d+)?)\s*[×xх*]\s*(\d+(?:\.\d+)?)\s*[×xх*]\s*(\d+(?:\.\d+)?)/i);
  const result = {recognized:[], params:{}};
  if (nums) {
    result.params.width = Math.round(Number(nums[1]));
    result.params.height = Math.round(Number(nums[2]));
    result.params.depth = Math.round(Number(nums[3]));
    result.recognized.push("габариты " + result.params.width + "×" + result.params.height + "×" + result.params.depth + " мм");
  }
  const rules = [
    ["sections",/(\d+)\s*(?:секц|отдел|отсек)/i,"секций"],
    ["shelves",/(\d+)\s*(?:съ[её]мн(?:ых|ые)?\s*)?пол(?:к|ок|ки)/i,"съёмных полок"],
    ["doors",/(\d+)\s*(?:фасад|двер)/i,"фасадов"],
    ["fixedPartitions",/(\d+)\s*(?:горизонтальн(?:ых|ые)?\s*)?перегород/i,"горизонтальных перегородок"]
  ];
  rules.forEach(([key,re,label]) => {
    const m=source.match(re);
    if(m){ result.params[key]=Number(m[1]); result.recognized.push(m[1]+" "+label); }
  });
  if (/мдф/.test(source)) { result.params.material="mdf18"; result.recognized.push("МДФ 18 мм"); }
  else if (/фанер/.test(source)) { result.params.material="ply18"; result.recognized.push("фанера 18 мм"); }
  else if (/лдсп\s*16/.test(source)) { result.params.material="ldsp16"; result.recognized.push("ЛДСП 16 мм"); }
  else if (/лдсп/.test(source)) { result.params.material="ldsp18"; result.recognized.push("ЛДСП 18 мм"); }
  result.confirmation = result.recognized.length ?
    "Я распознал конструкцию следующим образом: " + result.recognized.join(", ") + "." :
    "Не удалось распознать параметры конструкции.";
  return result;
}

function renderAiRecognition(result) {
  const target=$("aiRecognition");
  if(!target) return;
  target.innerHTML="<b>"+result.confirmation+"</b>" +
    (result.recognized.length ? "<div class='status'>Проверьте распознанные параметры. Модель не изменена.</div>" :
    "<div class='status error'>Добавьте размеры и параметры мебели.</div>");
  window._aiRecognized=result;
}

function applyAiRecognition() {
  const result=window._aiRecognized;
  if(!result || !result.recognized.length) return;
  Object.entries(result.params).forEach(([key,value])=>{
    const el=$(key);
    if(el && key !== "material") el.value=value;
    if(key==="material" && $("material")) $("material").value=value;
  });
  build();
  validate("AI-распознавание применено: параметрическая модель построена.", "ok");
}

function build() {
  const p = readParams();
  const error = validateParams(p);
  if (error) {
    validate(error, "error");
    return;
  }

  clearModel();
  ifcMode = false;

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
  const detailingPipeline = rebuildDetailingPipeline();
  const constructionQC = runConstructionQC(detailingPipeline);
  const releaseGate = runReleaseGate();
  rebuildPartLabels();
  exploded = false;
  $("explode").textContent = "Взрыв";
  $("partsCount").textContent = parts.length;
  $("summary").textContent = parts.length + " деталей · " + p.width + " × " + p.height + " × " + p.depth + " мм · фасадные зазоры " + p.frontGapTB + "/" + p.frontGapBetween + " мм";

  renderPartsTable();
  const drillingCount = parts.reduce((sum, part) => sum + (part.userData.drilling?.length || 0), 0);
  const bodyFastenerCount = bodyFasteners.length;
  const shelfSupportCount = shelfSupportDrilling.length;
  const constructionIssues = constructionQC.issues;
  if (!releaseGate.passed) validate("Release Gate: " + releaseGate.issues.join(" "), "error");
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
  syncPartLabels();

  $("explode").textContent = on ? "Свернуть" : "Взрыв";
}

function frontView() {
  const p = readParams();
  controls.target.set(0, p.height / 2, 0);
  camera.position.set(0, p.height / 2, Math.max(p.width, p.height) * 2.2);
  controls.update();
}


$("build")?.addEventListener("click", build);
$("explode")?.addEventListener("click", () => setExplode(!exploded));
$("resetExplode")?.addEventListener("click", () => setExplode(false));
$("frontView")?.addEventListener("click", frontView);
$("isoView")?.addEventListener("click", fitView);
$("material")?.addEventListener("change", build);
[1,2,3,4].forEach(i => $("edge"+i)?.addEventListener("change", build));

const technologyBuildFields = [
  "frontType","hingeType","hingeLimiter","openingAngle",
  "fastenerType","confirmatDiameter","connectorDiameter",
  "secondaryFastener","dowelDiameter","eccentricDiameter",
  "shelfSupportType","shelfFrontOffset"
];
technologyBuildFields.forEach(id => $(id)?.addEventListener("change", () => {
  if (ifcMode) {
    validate("Для IFC технологические атрибуты задаются исходной моделью. Геометрия IFC не изменена.", "ok");
    return;
  }
  build();
}));

$("aiRecognize")?.addEventListener("click", () => {
  const result = recognizeFurnitureText($("aiPrompt")?.value || "");
  renderAiRecognition(result);
});
$("aiApply")?.addEventListener("click", applyAiRecognition);
$("aiImageAnalyze")?.addEventListener("click", () => {
  const file=$("aiImageFile")?.files?.[0];
  if(!file){ validate("Загрузите изображение мебели.","error"); return; }
  const result=analyzeFurnitureImageMetadata(file);
  renderAiImageRecognition(result);
});
document.querySelectorAll(".exportSheetLayout").forEach(button => button.addEventListener("click", exportSheetLayout));
document.querySelectorAll(".showCuttingMap").forEach(button => button.addEventListener("click", showCuttingMap));
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
  const data = {version: projectVersion,name:"Furniture AI Designer",parameters};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
  const link=document.createElement("a"); link.href=url; link.download="furniture-ai-project.json"; link.click(); URL.revokeObjectURL(url);
});
$("loadProject").addEventListener("change",(event)=>{
  const file=event.target.files[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const data=JSON.parse(reader.result);
      Object.entries(data.parameters||{}).forEach(([key,value])=>{if($(key))$(key).value=value;});
      (data.parameters?.edges||[]).forEach((value,index)=>{if($("edge"+(index+1)))$("edge"+(index+1)).value=value;});
      build();
    }catch{validate("Не удалось прочитать проект JSON.","error");}
  };
  reader.readAsText(file);
});
function resize(){
  const width=viewer.clientWidth,height=viewer.clientHeight;
  camera.aspect=width/Math.max(height,1); camera.updateProjectionMatrix(); renderer.setSize(width,height);
}
window.addEventListener("resize",resize); resize();