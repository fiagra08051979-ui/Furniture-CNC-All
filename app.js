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

function convexHull2D(points) {
  const pts = points
    .map(p => [Number(p[0]), Number(p[1])])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a,b) => a[0]-b[0] || a[1]-b[1]);

  const unique = [];
  pts.forEach(p => {
    const last = unique[unique.length-1];
    if (!last || Math.hypot(p[0]-last[0], p[1]-last[1]) > 0.01) unique.push(p);
  });
  if (unique.length <= 2) return unique;

  const cross = (o,a,b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const lower=[];
  unique.forEach(p=>{
    while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  });
  const upper=[];
  for(let i=unique.length-1;i>=0;i--){
    const p=unique[i];
    while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function polygonArea2D(path) {
  if (!path || path.length < 3) return 0;
  let area=0;
  for(let i=0;i<path.length;i++){
    const a=path[i], b=path[(i+1)%path.length];
    area += a[0]*b[1]-b[0]*a[1];
  }
  return Math.abs(area)/2;
}

function extractIfcPlanarContour(part) {
  const vertices = [];
  const addVertex = (v) => vertices.push(v.clone());

  part.traverse(obj => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const pos = obj.geometry.attributes.position;
    const matrix = obj.matrixWorld;
    for(let i=0;i<pos.count;i++){
      addVertex(new THREE.Vector3(pos.getX(i),pos.getY(i),pos.getZ(i)).applyMatrix4(matrix));
    }
  });

  if (vertices.length < 4) return {ready:false, reason:"недостаточно вершин IFC"};

  const box = new THREE.Box3().setFromObject(part);
  const size = box.getSize(new THREE.Vector3());
  const dims=[size.x,size.y,size.z];
  const thinAxis=dims.indexOf(Math.min(...dims));

  const projected=vertices.map(v=>{
    if(thinAxis===0) return [v.y,v.z];
    if(thinAxis===1) return [v.x,v.z];
    return [v.x,v.y];
  });

  const hull=convexHull2D(projected);
  const area=polygonArea2D(hull);

  const maxA = Math.max(
    Math.abs(size.x*size.y),
    Math.abs(size.x*size.z),
    Math.abs(size.y*size.z)
  );
  const ratio=maxA>0 ? area/maxA : 0;

  // Для серийного CNC разрешаем автоматический контур только
  // для плоской детали, у которой фактическая геометрия практически
  // совпадает с прямоугольной оболочкой.
  const rectangular = hull.length === 4 && ratio >= 0.995;

  let path = hull;
  if (thinAxis===0) path=hull.map(([a,b])=>[b,a]);
  if (thinAxis===1) path=hull.map(([a,b])=>[a,b]);
  if (thinAxis===2) path=hull.map(([a,b])=>[a,b]);

  return {
    ready: rectangular,
    axis: ["X","Y","Z"][thinAxis],
    ratio,
    hullPoints: hull.length,
    path,
    reason: rectangular
      ? "плоская прямоугольная геометрия IFC"
      : "контур IFC не является безопасным прямоугольным контуром"
  };
}

function updateIfcCncReadiness() {
  if (!ifcImportedParts.length) return {ready:0, blocked:0};

  let ready=0, blocked=0;
  ifcImportedParts.forEach(part=>{
    const u=part.userData;
    const contour=extractIfcPlanarContour(part);
    u.ifcContour=contour;
    u.geometryCncReady=Boolean(contour.ready);
    if(contour.ready) ready++; else blocked++;
  });
  return {ready, blocked};
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

function buildIfcDrillingPlan() {
  if (!ifcImportedParts.length) return { candidates:0, ready:0, blocked:0 };
  let candidates=0, ready=0, blocked=0;
  const surfaceTolerance=2.5, edgeClearance=12;
  ifcImportedParts.forEach(part=>{
    const u=part.userData;
    u.technology.drilling=[];
    const box=new THREE.Box3().setFromObject(part);
    const size=box.getSize(new THREE.Vector3()), center=box.getCenter(new THREE.Vector3());
    const dims=[size.x,size.y,size.z], thinAxis=dims.indexOf(Math.min(...dims));
    const axisName=["X","Y","Z"][thinAxis], planarAxes=[0,1,2].filter(a=>a!==thinAxis);
    const thickness=Math.min(...dims);
    (u.technology.joints||[]).forEach(j=>{
      const contact=new THREE.Vector3(j.contactCenter.x,j.contactCenter.y,j.contactCenter.z);
      const axisValue=contact.getComponent(thinAxis);
      const minFace=box.min.getComponent(thinAxis), maxFace=box.max.getComponent(thinAxis);
      const fromMin=Math.abs(axisValue-minFace), fromMax=Math.abs(maxFace-axisValue);
      const useMin=fromMin<=fromMax, surface=useMin?minFace:maxFace;
      const inward=useMin?1:-1, surfaceDistance=Math.min(fromMin,fromMax);
      const p0=contact.getComponent(planarAxes[0]), p1=contact.getComponent(planarAxes[1]);
      const min0=box.min.getComponent(planarAxes[0]), max0=box.max.getComponent(planarAxes[0]);
      const min1=box.min.getComponent(planarAxes[1]), max1=box.max.getComponent(planarAxes[1]);
      const local0=p0-(min0+max0)/2, local1=p1-(min1+max1)/2;
      const planarSafe=Math.abs(local0)<=Math.max(0,(max0-min0)/2-edgeClearance) &&
        Math.abs(local1)<=Math.max(0,(max1-min1)/2-edgeClearance);
      const contourReady=Boolean(u.ifcContour?.ready);
      const depth=/полки/i.test(j.type)?Math.min(12,Math.max(1,thickness-2)):Math.min(35,Math.max(1,thickness-2));
      const surfaceConfirmed=surfaceDistance<=surfaceTolerance;
      const valid=contourReady&&surfaceConfirmed&&planarSafe&&depth<thickness;
      const candidate={
        id:"IFC-D-"+String(u.technology.drilling.length+1).padStart(3,"0"),
        type:"Сверление соединения", status:valid?"ready":"review",
        diameter:/полки/i.test(j.type)?5:7, depth:Number(depth.toFixed(2)),
        x:Number(local0.toFixed(2)), y:Number(local1.toFixed(2)), z:0,
        worldContact:{x:Number(contact.x.toFixed(2)),y:Number(contact.y.toFixed(2)),z:Number(contact.z.toFixed(2))},
        localBasis:{plane:planarAxes.map(a=>["X","Y","Z"][a]),drillAxis:axisName,drillDirection:inward>0?"+":"-",face:useMin?"MIN":"MAX",origin:{x:Number(center.x.toFixed(2)),y:Number(center.y.toFixed(2)),z:Number(center.z.toFixed(2))}},
        contactAxis:j.contactAxis, linkedPart:j.partB===(u.partNumber||u.name)?j.partA:j.partB,
        source:"IFC contact geometry", needsReference:!valid,
        checks:{contourReady,surfaceConfirmed,planarSafe,depthSafe:depth<thickness,surfaceDistance:Number(surfaceDistance.toFixed(2)),edgeClearance},
        note:valid?"База и направление сверления определены по фактическому габариту IFC; операция разрешена к CNC-предпроверке.":"Требуется проверка базовой поверхности/положения контакта перед передачей в CNC."
      };
      u.technology.drilling.push(candidate); candidates++;
      if(valid) ready++; else blocked++;
    });
    u.technology.drillingStatus=u.technology.drilling.length?(u.technology.drilling.every(x=>x.status==="ready")?"ready":"review"):"none";
    u.technology.drillingBasis={plane:planarAxes.map(a=>["X","Y","Z"][a]),drillAxis:axisName,thickness:Number(thickness.toFixed(2)),method:"AABB IFC + контактная зона"};
  });
  return {candidates,ready,blocked};
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
    u.technology.status = u.technology.status==="ready" && u.technology.joints.every(j=>j.status==="candidate" || j.status==="ready")
      ? "ready"
      : u.technology.status;
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
    closeIfcModel();

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

    clearModel();
    parts.length = 0;

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
    const ifcDrillingPlan = buildIfcDrillingPlan();
    ifcImportedParts.forEach(part => { part.userData.processing = buildDetailedProcessing(part); });
    const cncReadiness = updateIfcCncReadiness();
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
      " · CNC-контур: готов " + cncReadiness.ready + ", заблокирован " + cncReadiness.blocked +
      " · соединения-кандидаты: " + ifcTechnologyOps.joints.length +
      " · позиции крепежа-кандидаты: " + ifcHardwareSchedule.length;

    if ($("projectName")) $("projectName").textContent = file.name;
    if ($("status")) $("status").textContent = "IFC импортирован · геометрия является источником истины";

    validate(
      technology.review
        ? "IFC импортирован. Распознавание завершено. Технология готова для " + technology.ready + " деталей; " + technology.review + " требуют проверки роли."
        : "IFC импортирован. Распознавание и технологическая привязка завершены для всех деталей. Геометрия не изменена.",
      technology.review ? "error" : "ok"
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
    const u = part.userData;
    u.partNumber = String(index + 1).padStart(3, "0");
    u.detailing = {
      number: u.partNumber,
      name: u.name,
      length: Math.round(u.width),
      width: Math.round(u.height),
      thickness: Math.round(u.depth),
      quantity: u.quantity,
      material: u.material,
      edges: [...u.edges],
      processing: [...(u.processing || [])],
      holes: [...(u.drilling || []), ...(u.shelfSupportDrilling || [])],
      milling: (u.processing || []).filter(op => /фрез|паз|выбор/i.test(op.operation || "")),
      notes: []
    };
  });
}

function buildCuttingGroups() {
  const groups = new Map();
  parts.forEach(part => {
    const u = part.userData;
    const key = [
      u.material,
      Math.round(u.depth),
      u.edges.join("|"),
      Math.round(u.width),
      Math.round(u.height)
    ].join("::");
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        material: u.material,
        thickness: Math.round(u.depth),
        length: Math.round(u.width),
        width: Math.round(u.height),
        edges: [...u.edges],
        quantity: 0,
        partNumbers: []
      });
    }
    const g = groups.get(key);
    g.quantity += Number(u.quantity || 1);
    g.partNumbers.push(u.partNumber);
  });
  return [...groups.values()].map((g, index) => ({...g, groupNumber: String(index + 1).padStart(3, "0")}));
}

function buildSheetLayout(sheetLength, sheetWidth, kerf, margin, allowRotation, grainMode) {
  const groups = buildCuttingGroups();
  const sheets = [];
  let sheetIndex = 1;
  const newSheet = (material) => ({
    sheetNumber: sheetIndex++, material, length: sheetLength, width: sheetWidth, placements: []
  });

  const items = [];
  groups.forEach(group => {
    for (let q = 0; q < group.quantity; q++) {
      items.push({
        groupNumber: group.groupNumber,
        partNumber: group.partNumbers[q] || group.partNumbers[0] || "",
        material: group.material,
        length: group.length,
        width: group.width,
        edges: group.edges
      });
    }
  });
  items.sort((a, b) => (b.length * b.width) - (a.length * a.width));

  const canRotate = allowRotation && grainMode === "нет";
  const tryPlace = (sheet, item) => {
    const candidates = [
      {w:item.length, h:item.width, rotated:false},
      ...(canRotate ? [{w:item.width, h:item.length, rotated:true}] : [])
    ];
    let best = null;
    sheet.placements.forEach(p => {
      for (const c of candidates) {
        const x = p.x + p.length + kerf;
        const y = p.y;
        if (x + c.w <= sheetLength - margin && y + c.h <= sheetWidth - margin) {
          best = best || {x, y, ...c};
        }
      }
    });
    for (const c of candidates) {
      const x = margin;
      const y = margin;
      if (x + c.w <= sheetLength - margin && y + c.h <= sheetWidth - margin) {
        best = best || {x, y, ...c};
      }
    }
    const rowYs = [...new Set(sheet.placements.map(p => p.y))].sort((x,y)=>x-y);
    for (const y of rowYs) {
      const row = sheet.placements.filter(p => p.y === y);
      const right = row.reduce((m,p)=>Math.max(m,p.x+p.length), margin);
      for (const c of candidates) {
        if (right + kerf + c.w <= sheetLength - margin && y + c.h <= sheetWidth - margin) {
          const candidate = {x:right+kerf,y,...c};
          if (!best || candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)) best = candidate;
        }
      }
    }
    return best;
  };

  items.forEach(item => {
    let sheet = [...sheets].reverse().find(s => s.material === item.material);
    let placement = sheet ? tryPlace(sheet, item) : null;
    if (!placement) {
      sheet = newSheet(item.material);
      sheets.push(sheet);
      placement = tryPlace(sheet, item);
    }
    if (!placement) {
      sheet.placements.push({
        sheetNumber: sheet.sheetNumber, groupNumber: item.groupNumber, partNumber: item.partNumber,
        x: margin, y: margin, length: item.length, width: item.width, rotated:false, overflow:true
      });
      return;
    }
    sheet.placements.push({
      sheetNumber: sheet.sheetNumber,
      groupNumber: item.groupNumber,
      partNumber: item.partNumber,
      x: Math.round(placement.x),
      y: Math.round(placement.y),
      length: placement.w,
      width: placement.h,
      rotated: placement.rotated,
      overflow:false,
      grain: grainMode
    });
  });

  return {sheetLength, sheetWidth, kerf, margin, allowRotation:canRotate, grainMode, sheets};
}

function showCuttingMap() {
  const layout = buildSheetLayout(
    Number($("sheetLength")?.value || 2800),
    Number($("sheetWidth")?.value || 2070),
    Number($("cutKerf")?.value || 4),
    Number($("sheetMargin")?.value || 10),
    Boolean($("allowRotation")?.checked),
    $("grainMode")?.value || "нет"
  );
  const panel = $("cuttingMap");
  if (!panel) return;
  panel.innerHTML = "";
  layout.sheets.forEach((sheet, index) => {
    const card = document.createElement("div");
    card.className = "cutting-sheet";
    const title = document.createElement("div");
    title.className = "cutting-sheet-title";
    title.textContent = "Лист " + sheet.sheetNumber + " · " + sheet.material + " · " + sheet.length + " × " + sheet.width + " мм";
    card.appendChild(title);
    const canvas = document.createElement("canvas");
    canvas.width = 900; canvas.height = Math.max(300, Math.round(900 * sheet.width / sheet.length));
    canvas.className = "cutting-canvas";
    const ctx = canvas.getContext("2d");
    const sx = canvas.width / sheet.length, sy = canvas.height / sheet.width;
    ctx.strokeStyle = "#334155"; ctx.lineWidth = 3; ctx.strokeRect(1,1,canvas.width-2,canvas.height-2);
    sheet.placements.forEach(p => {
      const x=p.x*sx, y=p.y*sy, w=p.length*sx, h=p.width*sy;
      ctx.fillStyle = p.overflow ? "#fecaca" : "#dbeafe";
      ctx.fillRect(x,y,w,h); ctx.strokeRect(x,y,w,h);
      ctx.fillStyle = "#111827"; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.font = Math.max(11, Math.min(24, Math.min(w,h)*0.18)) + "px Arial";
      ctx.fillText(p.partNumber, x+w/2, y+h/2);
      ctx.font = "11px Arial";
      ctx.fillText(Math.round(p.length)+"×"+Math.round(p.width), x+w/2, y+h/2+16);
      if (p.rotated) { ctx.font="10px Arial"; ctx.fillText("90°",x+w/2,y+h/2-16); }
      if (p.overflow) { ctx.fillStyle="#991b1b"; ctx.fillText("ВНЕ ЛИСТА",x+w/2,y+h/2+31); }
    });
    card.appendChild(canvas);
    panel.appendChild(card);
  });
  panel.hidden = false;
}

function exportSheetLayout() {
  if (!window.XLSX) { validate("Модуль Excel недоступен.", "error"); return; }
  const sheetLength = Number($("sheetLength")?.value || 2800);
  const sheetWidth = Number($("sheetWidth")?.value || 2070);
  const kerf = Number($("cutKerf")?.value || 4);
  const margin = Number($("sheetMargin")?.value || 10);
  const allowRotation = Boolean($("allowRotation")?.checked);
  const grainMode = $("grainMode")?.value || "нет";
  const layout = buildSheetLayout(sheetLength, sheetWidth, kerf, margin, allowRotation, grainMode);
  const rows = [];
  layout.sheets.forEach(sheet => sheet.placements.forEach(p => rows.push({
    "Лист": sheet.sheetNumber,
    "Группа": p.groupNumber,
    "№ детали": p.partNumber,
    "X, мм": p.x,
    "Y, мм": p.y,
    "Длина, мм": p.length,
    "Ширина, мм": p.width,
    "Поворот": p.rotated ? "90°" : "0°",
    "Направление текстуры": p.grain || "нет",
    "Переполнение": p.overflow ? "ДА" : "нет"
  })));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Карта раскроя");
  XLSX.writeFile(wb, "furniture-ai-sheet-layout.xlsx");
  validate("Карта раскроя рассчитана: " + layout.sheets.length + " лист(ов).", "ok");
}

function exportCuttingStructure() {
  if (!window.XLSX) { validate("Модуль Excel недоступен.", "error"); return; }
  const groups = buildCuttingGroups();
  const rows = groups.map(g => ({
    "Группа раскроя": g.groupNumber,
    "Материал": g.material,
    "Толщина, мм": g.thickness,
    "Длина, мм": g.length,
    "Ширина, мм": g.width,
    "Кромка 1": g.edges[0],
    "Кромка 2": g.edges[1],
    "Кромка 3": g.edges[2],
    "Кромка 4": g.edges[3],
    "Количество": g.quantity,
    "№ деталей": g.partNumbers.join(", ")
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Раскрой");
  XLSX.writeFile(wb, "furniture-ai-cutting.xlsx");
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
  while (root.children.length) {
    const object = root.children.pop();
    object.geometry.dispose();
    object.material.dispose();
  }
  parts.length = 0;
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
  ifcMode = false;
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
  rebuildPartLabels();
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
  syncPartLabels();

  $("explode").textContent = on ? "Свернуть" : "Взрыв";
}

function frontView() {
  const p = readParams();
  controls.target.set(0, p.height / 2, 0);
  camera.position.set(0, p.height / 2, Math.max(p.width, p.height) * 2.2);
  controls.update();
}

function dxfPair(code, value) { return code + "\n" + value + "\n"; }

function buildMillingGeometry(part) {
  const u = part.userData;
  const ops = [];
  (u.processing || []).filter(op => /паз|фрез|выбор|карман/i.test(op.operation || "")).forEach((op, i) => {
    const width = Math.max(1, Number(op.width) || Number(op.diameter) || 6);
    const length = Math.max(width, Number(op.length) || width);
    const depth = Math.max(0.1, Number(op.depth) || 3);
    const x = Number(op.x) || 0;
    const y = Number(op.y) || 0;
    ops.push({
      id:"M"+(i+1), type:"POCKET",
      operation:op.operation || "Фрезеровка",
      partNumber:u.partNumber,
      x,y,z:Number(op.z)||0,width,length,depth,
      path:[
        [x-length/2,y-width/2],
        [x+length/2,y-width/2],
        [x+length/2,y+width/2],
        [x-length/2,y+width/2],
        [x-length/2,y-width/2]
      ]
    });
  });
  return ops;
}

function buildCncToolPlan(part) {
  const material = part.userData.material || "Не задан";
  const ordered = optimizeCncOperationSequence(part);
  let previousToolId = null;
  return ordered.map((op, i) => {
    const enriched = cncOperationWithTool(op, material);
    const toolNumber = enriched.toolId === "TBD" ? 0 :
      (enriched.toolId === "DRILL-5" ? 1 :
      enriched.toolId === "DRILL-6" ? 2 :
      enriched.toolId === "DRILL-35" ? 3 :
      enriched.toolId === "MILL-6" ? 4 : 5);
    const toolChange = i === 0 || enriched.toolId !== previousToolId;
    previousToolId = enriched.toolId;
    return {...enriched, toolNumber, toolChange};
  });
}

function readCncMachineSetup() {
  return {
    units: $("cncUnits")?.value || "mm",
    origin: $("cncOrigin")?.value || "top-center",
    safeZ: Number($("cncSafeZ")?.value || 5),
    workZ: Number($("cncWorkZ")?.value || 0),
    defaultFeed: Number($("cncFeed")?.value || 300),
    spindle: Number($("cncSpindle")?.value || 18000)
  };
}

function validateCncMachineSetup(setup = readCncMachineSetup()) {
  const issues = [];
  if (setup.safeZ <= 0) issues.push({level:"error",message:"Safe Z должен быть больше 0 мм."});
  if (setup.defaultFeed <= 0) issues.push({level:"error",message:"Подача должна быть больше 0 мм/мин."});
  if (setup.spindle <= 0) issues.push({level:"error",message:"Обороты шпинделя должны быть больше 0 об/мин."});
  if (setup.workZ > 0) issues.push({level:"warning",message:"Рабочий Z выше нулевой плоскости детали."});
  if (setup.safeZ <= Math.abs(setup.workZ)) issues.push({level:"error",message:"Safe Z должен быть выше рабочей глубины."});
  return issues;
}

function applyCncMachineSetup() {
  const setup = readCncMachineSetup();
  const setupIssues = validateCncMachineSetup(setup);
  if (setupIssues.some(i => i.level === "error")) {
    validate(setupIssues.map(i => i.message).join(" "), "error");
    return setup;
  }
  CNC_POSTPROCESSORS.generic.safeZ = setup.safeZ;
  CNC_POSTPROCESSORS.generic.drillFeed = setup.defaultFeed;
  validate("Настройки CNC применены: Safe Z " + setup.safeZ + " мм, подача " + setup.defaultFeed + " мм/мин.", "ok");
  return setup;
}

function buildCncJobManifest() {
  const post = getPostprocessor();
  const machineSetup = applyCncMachineSetup();
  const preflight = cncPreflight();
  const jobs = parts.map(part => buildCncJob(part));
  const tools = [];
  jobs.forEach(job => (job.operations || []).forEach(op => {
    if (op.toolId && !tools.some(t => t.id === op.toolId)) {
      tools.push({id:op.toolId, number:op.toolNumber, name:op.toolName, diameter:op.toolDiameter});
    }
  }));
  return {
    format:"Furniture AI Designer CNC Job",
    version:"2.7",
    postprocessor:post.name,
    postprocessorStatus: post.name === "Universal G-code" ? "generic" : "template-unvalidated",
    units:"mm",
    zeroPoint:"G54 / XY — по центру детали, Z0 — верх детали",
    safeZ:post.safeZ,
    machineSetup,
    parts:jobs,
    tools,
    preflight,
    readyForMachine:preflight.filter(i => i.level === "error").length === 0
  };
}

function exportCncJobManifest() {
  const manifest = buildCncJobManifest();
  const blob = new Blob([JSON.stringify(manifest,null,2)], {type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download="cnc-job-manifest.json";
  link.click();
  URL.revokeObjectURL(link.href);
  validate(manifest.readyForMachine ?
    "CNC Job Manifest сформирован: критических ошибок нет." :
    "CNC Job Manifest сформирован, но обнаружены ошибки Preflight.", manifest.readyForMachine ? "ok" : "error");
}

function buildCncJob(part) {
  const u = part.userData;
  return {
    partNumber:u.partNumber,
    material:u.material || "Не задан",
    thickness:Number(u.thickness || 0),
    safeZ:5,
    zeroPoint:"G54",
    operations:buildCncToolPlan(part)
  };
}

function optimizeCncOperationSequence(part) {
  const ops = buildCncOperations(part).map(op => ({...op}));
  const priority = {CONTOUR: 30, POCKET: 20, MILL: 20, DRILL: 10};
  ops.sort((x,y) => (priority[x.type]||50) - (priority[y.type]||50) ||
    Math.hypot(Number(x.x)||0,Number(x.y)||0) - Math.hypot(Number(y.x)||0,Number(y.y)||0));
  let last = null;
  return ops.map((op,i) => {
    const x=Number(op.x)||0, y=Number(op.y)||0;
    const travel=last ? Math.hypot(x-last.x,y-last.y) : 0;
    last={x,y};
    return {...op, sequence:i+1, rapidTravel:Math.round(travel*100)/100, safeZ:5};
  });
}

function cncSequenceChecks(part) {
  const ops = optimizeCncOperationSequence(part);
  const issues=[];
  let lastType="";
  ops.forEach((op,i)=>{
    if (i && op.rapidTravel > 1000)
      issues.push({level:"warning",operation:op.sequence,message:"Большой холостой переход инструмента: "+op.rapidTravel+" мм"});
    if (lastType==="CONTOUR" && op.type==="DRILL")
      issues.push({level:"warning",operation:op.sequence,message:"Сверление выполняется после чистового контура"});
    lastType=op.type;
    if (op.safeZ <= 0)
      issues.push({level:"error",operation:op.sequence,message:"Недопустимая безопасная высота Z"});
  });
  return {ops,issues};
}

function cncCollisionChecks(part) {
  const u = part.userData;
  const issues = [];
  const w = Number(u.width)||0, h = Number(u.height)||0;
  buildCncOperations(part).forEach(op => {
    if (op.type === "CONTOUR_BLOCKED") {
      issues.push({level:"error",operation:op.sequence,message:"CNC-контур IFC не подтверждён: автоматический экспорт запрещён до проверки геометрии"});
      return;
    }
    if (op.type === "TECH_BLOCKED") {
      issues.push({level:"error",operation:op.sequence,message:"Технологическая присадка IFC не подтверждена: автоматический экспорт запрещён"});
      return;
    }
    if (op.x !== undefined && (Math.abs(Number(op.x)) > w/2 || Math.abs(Number(op.y)||0) > h/2)) {
      issues.push({level:"error",operation:op.sequence,message:"Операция выходит за границы детали"});
    }
    if (op.depth !== undefined && Number(op.depth) > Number(u.thickness || u.depth || 0)) {
      issues.push({level:"error",operation:op.sequence,message:"Глубина обработки превышает толщину детали"});
    }
    if (op.type === "DRILL" && Number(op.diameter) > Number(u.thickness || u.depth || 0)) {
      issues.push({level:"warning",operation:op.sequence,message:"Диаметр сверления больше толщины детали"});
    }
  });
  return issues;
}

function cncPreflight() {
  const result = [];
  parts.forEach(part => {
    const issues = [...cncCollisionChecks(part), ...cncSequenceChecks(part).issues];
    issues.forEach(issue => result.push({...issue,partNumber:part.userData.partNumber}));
  });
  return result;
}

function renderCncPreflight() {
  const target = $("cncPreflight");
  if (!target) return;
  const issues = cncPreflight();
  target.innerHTML = "<b>Проверка CNC перед экспортом</b>" +
    (issues.length ? "<div>" + issues.map(i =>
      "<div class='status " + i.level + "'>Деталь " + i.partNumber +
      ", операция " + i.operation + ": " + i.message + "</div>").join("") + "</div>" :
      "<div class='status ok'>Ошибок и предупреждений не обнаружено.</div>");
  return issues;
}

function buildCncOperations(part) {
  const u = part.userData;
  const ops = [];
  const add = (type, operation, data={}) => ops.push({
    sequence: ops.length + 1,
    type, operation,
    partNumber: u.partNumber,
    ...data
  });
  if (u.source === "IFC") {
    if (u.technology?.drillingStatus === "review") {
      add("TECH_BLOCKED","Технологическая присадка IFC требует подтверждения базы",{
        reason:"Направление сверления и базовая поверхность ещё не подтверждены",
        source:"IFC technology"
      });
    }
    if (!u.geometryCncReady || !u.ifcContour?.path?.length) {
      add("CONTOUR_BLOCKED","Контур детали IFC — требуется проверка геометрии",{
        reason:u.ifcContour?.reason || "контур не подготовлен автоматически"
      });
    } else {
      add("CONTOUR","Контур детали по геометрии IFC",{
        width:Number(u.width)||0,
        height:Number(u.height)||0,
        depth:Number(u.thickness)||Number(u.depth)||0,
        path:u.ifcContour.path,
        toolId:"MILL-8",
        toolName:"Фреза Ø8 мм",
        source:"IFC"
      });
    }
  } else {
    add("CONTOUR","Контур детали",{
      width:Number(u.width)||0,
      height:Number(u.height)||0,
      depth:Number(u.thickness)||Number(u.depth)||0,
      path:[
        [-Number(u.width||0)/2,-Number(u.height||0)/2],
        [ Number(u.width||0)/2,-Number(u.height||0)/2],
        [ Number(u.width||0)/2, Number(u.height||0)/2],
        [-Number(u.width||0)/2, Number(u.height||0)/2]
      ],
      toolId:"MILL-8",
      toolName:"Фреза Ø8 мм"
    });
  }
  const ifcDrilling = u.source === "IFC" ? (u.technology?.drilling || []).filter(h => h.status === "ready") : [];
  [...(u.drilling || []), ...ifcDrilling].forEach(h => add("DRILL","Сверление",{
    x:Number(h.x)||0, y:Number(h.y)||0, z:Number(h.z)||0,
    diameter:Number(h.diameter)||0, depth:Number(h.depth)||0,
    linkedHardware:h.linkedHardware || h.type || "",
    source:h.source || "Furniture Core"
  }));
  (u.bodyFasteners || []).forEach(h => add("DRILL","Крепёж корпуса",{
    x:Number(h.x)||0,y:Number(h.y)||0,z:Number(h.z)||0,
    diameter:Number(h.diameter)||0,depth:Number(h.depth)||0,linkedHardware:h.type
  }));
  (u.shelfSupportDrilling || []).forEach(h => add("DRILL","Полкодержатель",{
    x:Number(h.x)||0,y:Number(h.y)||0,z:Number(h.z)||0,
    diameter:Number(h.diameter)||0,depth:Number(h.depth)||0,linkedHardware:h.type
  }));
  (u.secondaryFasteners || []).forEach(h => add("DRILL","Соединитель",{
    x:Number(h.x)||0,y:Number(h.y)||0,z:Number(h.z)||0,
    diameter:Number(h.diameter)||0,depth:Number(h.depth)||0,linkedHardware:h.type
  }));
  buildMillingGeometry(part).forEach(m => add("POCKET",m.operation,{
    x:m.x,y:m.y,z:m.z,width:m.width,length:m.length,depth:m.depth,
    path:m.path,source:m.operation
  }));
  return ops;
}

function buildCncProgram(part) {
  const u = part.userData;
  const ops = buildCncOperations(part).map(op => cncOperationWithTool(op, material));
  const lines = [
    "; Furniture AI Designer CNC",
    "; Detail: " + u.partNumber + " " + u.name,
    "; Size: " + Math.round(u.width) + " x " + Math.round(u.height) + " x " + Math.round(u.depth),
    "G21",
    "G90",
    "G17",
    "G54"
  ];
  ops.forEach(op => {
    if (op.type === "CONTOUR") {
      lines.push("; CONTOUR " + op.width + " X " + op.height);
      lines.push("G0 Z5.000");
      op.path.forEach(([x,y], i) => {
        if (i === 0) lines.push("G0 X" + x.toFixed(3) + " Y" + y.toFixed(3));
        else lines.push("G1 X" + x.toFixed(3) + " Y" + y.toFixed(3) + " F600");
      });
      lines.push("G1 X" + op.path[0][0].toFixed(3) + " Y" + op.path[0][1].toFixed(3) + " F600");
    } else if (op.type === "DRILL") {
      lines.push("; " + op.operation + " " + op.diameter + " x " + op.depth);
      lines.push("G0 X" + op.x.toFixed(3) + " Y" + op.y.toFixed(3));
      lines.push("G0 Z5.000");
      lines.push("G1 Z-" + op.depth.toFixed(3) + " F300");
      lines.push("G0 Z5.000");
    } else if (op.type === "MILL") {
      lines.push("; " + op.operation);
      lines.push("G0 X" + op.x.toFixed(3) + " Y" + op.y.toFixed(3));
      lines.push("G0 Z5.000");
      lines.push("G1 Z-" + op.depth.toFixed(3) + " F300");
      lines.push("G0 Z5.000");
    }
  });
  lines.push("M5","M30");
  return lines.join("\n");
}

function exportCncProgram(part) {
  const blob = new Blob([buildCncProgram(part)], {type:"text/plain"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "detail-" + part.userData.partNumber + ".nc";
  link.click();
  URL.revokeObjectURL(link.href);
}

const CNC_TOOL_LIBRARY = {
  drilling: [
    {id:"DRILL-5",name:"Сверло Ø5 мм",diameter:5,kind:"drill",materials:["ЛДСП","МДФ","Фанера"]},
    {id:"DRILL-6",name:"Сверло Ø6 мм",diameter:6,kind:"drill",materials:["ЛДСП","МДФ","Фанера"]},
    {id:"DRILL-35",name:"Сверло чашечное Ø35 мм",diameter:35,kind:"drill",materials:["ЛДСП","МДФ","Фанера"]}
  ],
  milling: [
    {id:"MILL-6",name:"Фреза Ø6 мм",diameter:6,kind:"mill",materials:["ЛДСП","МДФ","Фанера"]},
    {id:"MILL-8",name:"Фреза Ø8 мм",diameter:8,kind:"mill",materials:["ЛДСП","МДФ","Фанера"]}
  ]
};

function selectCncTool(op, material) {
  const family = op.type === "DRILL" ? CNC_TOOL_LIBRARY.drilling : CNC_TOOL_LIBRARY.milling;
  const candidates = family.filter(t => t.materials.includes(material));
  if (op.diameter > 0) {
    const exact = candidates.find(t => t.diameter === op.diameter);
    if (exact) return exact;
  }
  return candidates[0] || family[0];
}

function cncOperationWithTool(op, material) {
  const tool = selectCncTool(op, material);
  return {
    ...op,
    toolId: tool ? tool.id : "TBD",
    toolName: tool ? tool.name : "Инструмент не назначен",
    toolDiameter: tool ? tool.diameter : 0
  };
}

function buildCncTechCard(part) {
  const u = part.userData;
  const material = u.material || "Не задан";
  const thickness = Number(u.thickness || u.depth || 0);
  const post = getPostprocessor();
  const ops = optimizeCncOperationSequence(part);
  return {
    partNumber: u.partNumber || "",
    name: u.name || "",
    material,
    thickness,
    size: { length:Number(u.width)||0, width:Number(u.height)||0, depth:Number(u.depth)||0 },
    machine: post.name,
    zeroPoint: "G54 / XY — по центру детали, Z0 — верх детали",
    safeZ: post.safeZ,
    tool: "TBD — назначается технологом",
    spindle: "TBD — назначается технологом",
    feed: post.drillFeed,
    operations: ops
  };
}

function renderCncTechCard(part) {
  const card = buildCncTechCard(part);
  const target = $("cncTechCard");
  if (!target) return;
  target.innerHTML =
    "<b>CNC-карточка детали " + card.partNumber + "</b>" +
    "<div>Материал: " + card.material + " | Толщина: " + card.thickness + " мм</div>" +
    "<div>Размер: " + Math.round(card.size.length) + " × " + Math.round(card.size.width) + " × " + Math.round(card.size.depth) + " мм</div>" +
    "<div>Постпроцессор: " + card.machine + " | Нулевая точка: " + card.zeroPoint + "</div>" +
    "<div>Safe Z: " + card.safeZ + " мм | Подача: " + card.feed + " мм/мин</div>" +
    "<div>Инструмент: " + card.tool + " | Обороты: " + card.spindle + "</div>" +
    "<div>Операций: " + card.operations.length + "</div>";
}

function exportCncTechCards() {
  const cards = parts.map(buildCncTechCard);
  const blob = new Blob([JSON.stringify({
    format:"Furniture AI CNC Tech Card",
    version:"2.0",
    postprocessor:getPostprocessor().name,
    cards
  }, null, 2)], {type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download="cnc-tech-cards.json";
  link.click();
  URL.revokeObjectURL(link.href);
  validate("Технологическая карта CNC экспортирована.", "ok");
}

const CNC_POSTPROCESSORS = {
  generic: {
    name: "Universal G-code",
    extension: ".nc",
    header: ["G21","G90","G17","G54"],
    footer: ["M5","M30"],
    drillFeed: 300,
    safeZ: 5
  },
  biesse: {
    name: "Biesse — базовый шаблон",
    extension: ".cix",
    header: ["; BIESSE CNC PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  },
  homag: {
    name: "Homag — базовый шаблон",
    extension: ".mpr",
    header: ["; HOMAG CNC PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  },
  scm: {
    name: "SCM — базовый шаблон",
    extension: ".pgm",
    header: ["; SCM CNC PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  }
};

function getPostprocessor() {
  return CNC_POSTPROCESSORS[$("cncPostprocessor")?.value || "generic"] || CNC_POSTPROCESSORS.generic;
}

function buildCncJobProgram(part) {
  const job = buildCncJob(part);
  const lines = [
    "; Furniture AI Designer CNC JOB",
    "; DETAIL " + job.partNumber,
    "; MATERIAL " + job.material,
    "; THICKNESS " + job.thickness,
    "G21","G90","G17","G54"
  ];
  let currentTool = null;
  job.operations.forEach(op => {
    if (op.toolChange && op.toolNumber > 0) {
      lines.push("; TOOL CHANGE T" + op.toolNumber + " " + op.toolName);
      lines.push("M5");
      lines.push("T" + op.toolNumber + " M6");
      currentTool = op.toolNumber;
    }
    if (op.type === "DRILL") {
      lines.push("; DRILL " + op.operation);
      lines.push("G0 Z5.000");
      lines.push("G0 X" + (op.x||0).toFixed(3) + " Y" + (op.y||0).toFixed(3));
      lines.push("G1 Z-" + (Number(op.depth)||0).toFixed(3) + " F300");
      lines.push("G0 Z5.000");
    } else if (op.type === "POCKET") {
      lines.push("; POCKET " + op.operation);
      (op.path || []).forEach(([x,y],idx)=>{
        lines.push((idx===0?"G0":"G1")+" X"+x.toFixed(3)+" Y"+y.toFixed(3)+(idx===0?"":" F600"));
      });
      lines.push("G0 Z5.000");
    } else if (op.type === "CONTOUR") {
      lines.push("; CONTOUR");
      (op.path || []).forEach(([x,y],idx)=>{
        lines.push((idx===0?"G0":"G1")+" X"+x.toFixed(3)+" Y"+y.toFixed(3)+(idx===0?"":" F600"));
      });
      lines.push("G0 Z5.000");
    }
  });
  lines.push("M5","M30");
  return lines.join("\n");
}

function buildPostprocessedProgram(part) {
  const post = getPostprocessor();
  const u = part.userData;
  const ops = buildCncOperations(part);
  const lines = [
    ...post.header,
    "; DETAIL " + u.partNumber + " " + u.name,
    "; SIZE " + Math.round(u.width) + " X " + Math.round(u.height) + " X " + Math.round(u.depth)
  ];
  ops.forEach(op => {
    if (op.type === "DRILL") {
      lines.push("; DRILL " + op.diameter + " DEPTH " + op.depth);
      lines.push("G0 X" + op.x.toFixed(3) + " Y" + op.y.toFixed(3));
      lines.push("G0 Z" + post.safeZ.toFixed(3));
      lines.push("G1 Z-" + op.depth.toFixed(3) + " F" + post.drillFeed);
      lines.push("G0 Z" + post.safeZ.toFixed(3));
    } else if (op.type === "MILL") {
      lines.push("; MILL " + (op.source || "operation"));
      lines.push("G0 X" + op.x.toFixed(3) + " Y" + op.y.toFixed(3));
      lines.push("G0 Z" + post.safeZ.toFixed(3));
      lines.push("G1 Z-" + op.depth.toFixed(3) + " F" + post.drillFeed);
      lines.push("G0 Z" + post.safeZ.toFixed(3));
    }
  });
  lines.push(...post.footer);
  return lines.join("\n");
}

function exportAllCnc() {
  const setupIssues = validateCncMachineSetup();
  const preflightIssues = cncPreflight();
  const critical = [...setupIssues, ...preflightIssues].filter(i => i.level === "error");
  if (critical.length) {
    validate("CNC-экспорт заблокирован: обнаружены критические ошибки. Исправьте их в Preflight.", "error");
    renderCncPreflight();
    renderCncSetupValidation();
    return;
  }
  const post = getPostprocessor();
  parts.forEach(part => {
    const blob = new Blob([buildCncJobProgram(part)], {type:"text/plain"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "detail-" + part.userData.partNumber + post.extension;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  validate("CNC-файлы подготовлены после успешного Preflight: " + post.name, "ok");
}


  parts.forEach(part => exportCncProgram(part));
  validate("CNC-программы подготовлены для " + parts.length + " деталей.", "ok");
}

function addMillingEntities(lines, part) {
  buildMillingGeometry(part).forEach(m => {
    lines.push("0","LWPOLYLINE","8","MILLING","90",m.path.length,"70",1);
    m.path.forEach(([x,y]) => lines.push("10",x,"20",y));
  });
}

function buildPartDxf(part) {
  const u = part.userData;
  const w = Number(u.width), h = Number(u.height);
  const lines = ["0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC","0","SECTION","2","ENTITIES"];
  addMillingEntities(lines, part);
  const addLine = (x1,y1,x2,y2,layer="OUTLINE") => {
    lines.push("0","LINE","8",layer,"10",x1,"20",y1,"30",0,"11",x2,"21",y2,"31",0);
  };
  const addCircle = (x,y,r,layer="DRILLING") => {
    lines.push("0","CIRCLE","8",layer,"10",x,"20",y,"30",0,"40",r);
  };
  const addPolyline = (points, layer="MILLING") => {
    lines.push("0","LWPOLYLINE","8",layer,"90",points.length,"70",1);
    points.forEach(([x,y]) => lines.push("10",x,"20",y));
  };
  addLine(-w/2,-h/2,w/2,-h/2);
  addLine(w/2,-h/2,w/2,h/2);
  addLine(w/2,h/2,-w/2,h/2);
  addLine(-w/2,h/2,-w/2,-h/2);

  const holes = [...(u.drilling || []), ...(u.shelfSupportDrilling || []), ...(u.bodyFasteners || []), ...(u.secondaryFasteners || [])];
  holes.forEach(hole => {
    const x = Number(hole.x) || 0, y = Number(hole.y) || 0;
    const r = (Number(hole.diameter) || 5) / 2;
    addCircle(x,y,r,"DRILLING");
  });

  (u.processing || []).filter(op => /паз|фрез|выбор|карман/i.test(op.operation || "")).forEach(op => {
    const x=Number(op.x)||0, y=Number(op.y)||0, d=Math.max(2,Number(op.diameter)||5);
    addCircle(x,y,d/2,"MILLING");
  });

  if (u.partNumber) {
    lines.push("0","TEXT","8","INFO","10",-w/2,"20",h/2+12,"30",0,"40",8,"1",String(u.partNumber));
  }
  lines.push("0","ENDSEC","0","EOF");
  return lines.join("\n");
}

function downloadDxf(part) {
  const blob = new Blob([buildPartDxf(part)], {type:"application/dxf"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "detail-" + part.userData.partNumber + ".dxf";
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportAllDxf() {
  parts.forEach(part => downloadDxf(part));
  validate("DXF подготовлены для " + parts.length + " деталей.", "ok");
}

function exportExcel() {
  if (!window.XLSX) { validate("Модуль Excel недоступен.", "error"); return; }
  const rows = parts.map((part, i) => ({
    "№": part.userData.partNumber, "Деталь": part.userData.name,
    "Тип": part.userData.kind, "Количество": part.userData.quantity,
    "Длина": Math.round(part.userData.width), "Ширина": Math.round(part.userData.height),
    "Глубина": Math.round(part.userData.depth), "Материал": part.userData.material,
    "Деталировка L×W×T": part.userData.detailing ? part.userData.detailing.length + " × " + part.userData.detailing.width + " × " + part.userData.detailing.thickness : "",
    "Обработка": part.userData.detailing?.processing?.map(h => h.operation + " Ø" + h.diameter + "×" + h.depth).join(" | ") || "",
    "Отверстия": part.userData.detailing?.holes?.map(h => h.operation + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Фрезеровка": part.userData.detailing?.milling?.map(h => h.operation).join(" | ") || "",
    "Примечания деталировки": part.userData.detailing?.notes?.join(" | ") || "",
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
    "Обработка": part.userData.detailing?.processing?.map(h => h.operation + " " + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
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

$("build").addEventListener("click", () => {
  ifcMode = false;
  build();
});
$("explode").addEventListener("click", () => setExplode(!exploded));
$("resetExplode").addEventListener("click", () => setExplode(false));
$("frontView").addEventListener("click", frontView);
$("isoView").addEventListener("click", fitView);
$("material").addEventListener("change", () => {
  if (ifcMode && ifcImportedParts.length) {
    applyIfcMaterial();
    renderPartsTable();
    validate("Материал IFC-модели обновлён без изменения исходной геометрии.", "ok");
  } else {
    build();
  }
});
[1, 2, 3, 4].forEach(i => $("edge" + i).addEventListener("change", () => {
  if (ifcMode && ifcImportedParts.length) {
    ifcImportedParts.forEach(part => part.userData.edges = edgeLabels());
    renderPartsTable();
    validate("Кромка назначена как технологический параметр IFC-деталей. Геометрия не изменена.", "ok");
  } else {
    build();
  }
}));
$("exportExcel").addEventListener("click", exportExcel);
if ($("exportCutting")) $("exportCutting").addEventListener("click", exportCuttingStructure);
if ($("exportSheetLayout")) $("exportSheetLayout").addEventListener("click", exportSheetLayout);
if ($("exportDxf")) $("exportDxf").addEventListener("click", exportAllDxf);
if ($("exportCnc")) $("exportCnc").addEventListener("click", exportAllCnc);
if ($("exportCncTech")) $("exportCncTech").addEventListener("click", exportCncTechCards);
if ($("exportCncManifest")) $("exportCncManifest").addEventListener("click", exportCncJobManifest);
if ($("exportCnc")) $("exportCnc").addEventListener("click", renderCncPreflight);
function renderCncSetupValidation() {
  const target=$("cncSetupValidation");
  if(!target) return;
  const issues=validateCncMachineSetup();
  target.innerHTML="<b>Проверка настроек станка</b>"+(issues.length ?
    issues.map(i=>"<div class='status "+i.level+"'>"+i.message+"</div>").join("") :
    "<div class='status ok'>Настройки CNC корректны.</div>");
}
["cncSafeZ","cncWorkZ","cncFeed","cncSpindle"].forEach(id=>{
  const el=$(id);
  if(el) el.addEventListener("input",renderCncSetupValidation);
});
renderCncSetupValidation();
function renderCncOperations() {
  const target=$("cncOperationsTable");
  if(!target || !parts.length) return;
  const rows=parts.flatMap(p=>buildCncOperations(p).map(op=>"<tr><td>"+op.partNumber+"</td><td>"+op.sequence+"</td><td>"+op.type+"</td><td>"+op.operation+"</td><td>"+(op.diameter||"—")+"</td><td>"+(op.depth||"—")+"</td></tr>"));
  target.innerHTML="<b>CNC-операции</b><table><thead><tr><th>№</th><th>№ оп.</th><th>Тип</th><th>Операция</th><th>Ø</th><th>Глубина</th></tr></thead><tbody>"+rows.join("")+"</tbody></table>";
}
setTimeout(renderCncOperations, 0);

if ($("showCuttingMap")) $("showCuttingMap").addEventListener("click", showCuttingMap);
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
