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

  // Для серийного ЧПУ разрешаем автоматический контур только
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
        note:valid?"База и направление сверления определены по фактическому габариту IFC; операция разрешена к ЧПУ-предпроверке.":"Требуется проверка базовой поверхности/положения контакта перед передачей в ЧПУ."
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
    const cncReadiness = updateIfcCncReadiness();
    const ifcDrillingPlan = buildIfcDrillingPlan();
    ifcImportedParts.forEach(part => {
      part.userData.processing = buildDetailedProcessing(part);
      refreshPartTechnologyRecord(part);
    });
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
      " · ЧПУ-контур: готов " + cncReadiness.ready + ", заблокирован " + cncReadiness.blocked +
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
  if (setup.safeZ <= 0) issues.push({level:"error",message:"Безопасная высота Z должен быть больше 0 мм."});
  if (setup.defaultFeed <= 0) issues.push({level:"error",message:"Подача должна быть больше 0 мм/мин."});
  if (setup.spindle <= 0) issues.push({level:"error",message:"Обороты шпинделя должны быть больше 0 об/мин."});
  if (setup.workZ > 0) issues.push({level:"warning",message:"Рабочий Z выше нулевой плоскости детали."});
  if (setup.safeZ <= Math.abs(setup.workZ)) issues.push({level:"error",message:"Безопасная высота Z должен быть выше рабочей глубины."});
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
  validate("Настройки ЧПУ применены: Безопасная высота Z " + setup.safeZ + " мм, подача " + setup.defaultFeed + " мм/мин.", "ok");
  return setup;
}

function buildProductionOperationPassport(part){
  const plan=getCompiledManufacturingPlan(part);
  const u=part.userData||{};
  const operations=(plan.operations||[]).map((op,index)=>{
    const group=(plan.technologyGroups||[]).find(g=>g.operations?.includes(op.id));
    const path=(plan.compensatedToolpaths||[]).find(p=>p.operationId===op.id);
    const trace={
      traceId:"OP-"+String(index+1).padStart(4,"0"),
      operationId:op.id,
      expressId:op.expressId||op.sourceExpressId||null,
      role:u.role||u.recognizedKind||null,
      source:op.source||plan.source,
      toolId:op.toolId||null,
      toolName:group?.toolName||null,
      technologyGroupKey:group?.key||null,
      rpm:group?.rpm||null,
      feed:group?.feed||null,
      plunge:group?.plunge||null,
      passDepth:group?.passDepth||null,
      depth:op.depth||0,
      pathPoints:path?.points?.length||0,
      lifecycle:(plan.lifecycle||[]).find(x=>x.operationId===op.id)?.status||"READY"
    };
    return trace;
  });
  return {
    partNumber:u.partNumber||plan.partNumber,
    source:plan.source,
    expressId:u.expressId||null,
    role:u.role||u.recognizedKind||null,
    material:plan.material,
    thickness:plan.thickness,
    operationCount:operations.length,
    operations,
    validation:plan.validation||[],
    machineReady:plan.machineReady
  };
}
function buildCncJobManifest() {
  const post = getPostprocessor();
  const machineSetup = applyCncMachineSetup();
  const preflight = cncPreflight();
  const integrity = parts.flatMap(part => validateIfcManufacturingIntegrity(part).map(issue => ({...issue,partNumber:part.userData.partNumber})));
  const plans = parts.map(part => getCompiledManufacturingPlan(part));
  const jobs = plans.map(plan => ({
    partNumber:plan.partNumber,
    material:plan.material,
    thickness:plan.thickness,
    safeZ:plan.machineSetup.safeZ,
    zeroPoint:plan.machineSetup.origin || "top-center",
    operations:plan.operations,
    operationJournal:plan.operationJournal,
    productionOperationPassport:buildProductionOperationPassport(parts.find(p=>p.userData?.partNumber===plan.partNumber)||{userData:{},userData2:{}}),
    toolTechnology:plan.toolTechnology,
    technologyGroups:plan.technologyGroups || [],
    technologyGroupValidation:plan.technologyGroupValidation || [],
    manufacturingLifecycle:plan.lifecycle,
    manufacturingIntegrity:plan.manufacturingIntegrity,
    preflight:plan.preflight,
    manufacturingPlanStatus:plan.status
  }));
  const tools = [];
  jobs.forEach(job => (job.operations || []).forEach(op => {
    if (op.toolId && !tools.some(t => t.id === op.toolId)) {
      tools.push({id:op.toolId, number:op.toolNumber, name:op.toolName, diameter:op.toolDiameter});
    }
  }));
  return {
    format:"Furniture AI Designer — ПРОГРАММА ЧПУ Job",
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
    manufacturingIntegrity: integrity,
    readyForMachine:preflight.filter(i => i.level === "error").length === 0,
    manufacturingPreflight: preflight.some(i => i.level === "error") ? "ERROR" : "OK",
    compiledPlanValidation: plans.flatMap(plan => (plan.validation || []).map(issue => ({...issue,partNumber:plan.partNumber}))),
    machineReady: plans.every(plan => plan.machineReady),
    readinessStatus: plans.every(plan => plan.machineReady) ? "MACHINE_READY" : "BLOCKED",
    toolTechnology: plans.map(plan => ({
      partNumber:plan.partNumber,
      groups:plan.toolTechnology || []
    })),
    typedToolpathValidation: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.typedToolpathValidation||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.typedToolpathValidation || []
    })),
    generatedProgramTraceability: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:"Готово после постпроверки",
      note:"Паспорт происхождения формируется для каждой операции при генерации управляющей программы.",
      operations:plan.operations.map(op=>({
        operationId:op.id,
        expressId:op.expressId||op.sourceExpressId||null,
        source:op.source||plan.source,
        technologyGroup:(plan.technologyGroups||[]).find(g=>g.operations?.includes(op.id))?.key||null
      }))
    })),
    compensatedToolpaths: plans.map(plan => ({
      partNumber:plan.partNumber,
      count:(plan.compensatedToolpaths||[]).length,
      paths:plan.compensatedToolpaths || []
    })),
    toolpathClearance: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.toolpathClearance||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.toolpathClearance || []
    })),
    toolRadiusCompensation: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.toolRadiusCompensation||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.toolRadiusCompensation || []
    })),
    segmentToolpathValidation: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.segmentToolpathValidation||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.segmentToolpathValidation || []
    })),
    geometryToolpathValidation: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.geometryToolpathValidation||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.geometryToolpathValidation || []
    })),
    toolpathValidation: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.toolpathValidation||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      operationCount:(plan.toolpaths||[]).length,
      issues:plan.toolpathValidation || []
    })),
    motionSafety: plans.map(plan => ({
      partNumber:plan.partNumber,
      status:(plan.motionSafety||[]).some(i=>i.level==="error") ? "BLOCKED" : "READY",
      issues:plan.motionSafety || []
    })),
    machineCompatibility: plans.map(plan => ({
      partNumber:plan.partNumber,
      postprocessor:plan.machineCompatibility?.postprocessor,
      status:plan.machineCompatibility?.machineReady ? "READY" : "BLOCKED",
      issues:plan.machineCompatibility?.issues || []
    }))
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
    "ЧПУ Job Manifest сформирован: критических ошибок нет." :
    "ЧПУ Job Manifest сформирован, но обнаружены ошибки Preflight.", manifest.readyForMachine ? "ok" : "error");
}

function buildCncJob(part) {
  const plan=getCompiledManufacturingPlan(part);
  return {
    partNumber:plan.partNumber,
    material:plan.material,
    thickness:plan.thickness,
    safeZ:plan.machineSetup.safeZ,
    zeroPoint:plan.machineSetup.origin || "top-center",
    operations:plan.operations,
    operationJournal:plan.operationJournal,
    manufacturingLifecycle:plan.lifecycle,
    manufacturingIntegrity:plan.manufacturingIntegrity,
    preflight:plan.preflight,
    manufacturingPlanStatus:plan.status
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
    return {...op, sequence:i+1, rapidTravel:Math.round(travel*100)/100, safeZ:readCncMachineSetup().safeZ};
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
  const operations = buildCncOperations(part);
  const drills = operations.filter(op => op.type === "DRILL");
  for (let i=0;i<drills.length;i++) {
    for (let j=i+1;j<drills.length;j++) {
      const a=drills[i], b=drills[j];
      const dx=(Number(a.x)||0)-(Number(b.x)||0);
      const dy=(Number(a.y)||0)-(Number(b.y)||0);
      const distance=Math.hypot(dx,dy);
      const required=((Number(a.diameter)||0)+(Number(b.diameter)||0))/2+2;
      if (distance < required) {
        issues.push({
          level:"error",
          operation:b.sequence,
          message:"Столкновение отверстий: операции "+a.sequence+" и "+b.sequence+
            " находятся ближе допустимого расстояния ("+distance.toFixed(1)+" мм)"
        });
      }
    }
  }
  operations.forEach(op => {
    if (op.type === "CONTOUR_BLOCKED") {
      issues.push({level:"error",operation:op.sequence,message:"ЧПУ-контур IFC не подтверждён: автоматический экспорт запрещён до проверки геометрии"});
      return;
    }
    if (op.type === "TECH_BLOCKED") {
      issues.push({level:"error",operation:op.sequence,message:"Технологическая присадка IFC не подтверждена: автоматический экспорт запрещён"});
      return;
    }
    if (op.x !== undefined && (Math.abs(Number(op.x)) > w/2 || Math.abs(Number(op.y)||0) > h/2)) {
      issues.push({level:"error",operation:op.sequence,message:"Операция выходит за границы детали"});
    }
    if (op.type === "DRILL" && u.source === "IFC") {
      const tech = (u.technology?.drilling || []).find(d =>
        Math.abs((Number(d.x)||0)-(Number(op.x)||0)) < 0.01 &&
        Math.abs((Number(d.y)||0)-(Number(op.y)||0)) < 0.01 &&
        Math.abs((Number(d.depth)||0)-(Number(op.depth)||0)) < 0.01
      );
      if (!tech) {
        issues.push({level:"error",operation:op.sequence,message:"IFC-сверление не имеет подтверждённой технологической записи"});
      }
      if (tech && tech.status !== "ready") {
        issues.push({level:"error",operation:op.sequence,message:"IFC-сверление не подтверждено технологией"});
      }
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

function validateIfcManufacturingIntegrity(part) {
  const u=part.userData;
  if(u.source!=="IFC") return [];
  const packet=u.productionPacket || buildIfcProductionPacket(part);
  const cnc=buildIfcManufacturingOperations(part);
  const issues=[];
  const ids=new Set();
  cnc.forEach(op=>{
    if(!op.id) issues.push({level:"error",operation:op.sequence,message:"IFC ЧПУ-операция не имеет стабильного ID"});
    else if(ids.has(op.id)) issues.push({level:"error",operation:op.sequence,message:"Дублирование IFC ЧПУ operation ID: "+op.id});
    else ids.add(op.id);
  });
  const packetReady=(packet?.contour?.ready ? 1 : 0) + (packet?.drilling||[]).filter(d=>d.status==="ready").length +
    (packet?.operations||[]).filter(o=>o.status==="ready" && (o.type==="MILL" || o.type==="POCKET")).length;
  if(packetReady !== cnc.length)
    issues.push({level:"error",operation:"MANUFACTURING",message:"Несоответствие Manufacturing Plan и ЧПУ: "+packetReady+" подтверждённых операций против "+cnc.length+" ЧПУ-операций"});
  const expectedDrills=(packet?.drilling||[]).filter(d=>d.status==="ready").map(d=>d.id).filter(Boolean);
  const cncDrills=cnc.filter(o=>o.type==="DRILL").map(o=>o.id);
  expectedDrills.forEach(id=>{
    if(!cncDrills.includes(id)) issues.push({level:"error",operation:id,message:"Подтверждённое IFC-сверление потеряно при передаче в ЧПУ"});
  });
  return issues;
}

function manufacturingPreflight(part) {
  const u=part.userData;
  const issues=[];
  const ops=optimizeCncOperationSequence(part);
  const setup=readCncMachineSetup();
  ops.forEach(op=>{
    if(op.type==="CONTOUR_BLOCKED" || op.type==="TECH_BLOCKED") return;
    const tool=selectCncTool(op,u.material || "Не задан");
    if(!tool) {
      issues.push({level:"error",operation:op.sequence,message:"Не найден совместимый инструмент для операции "+op.id});
      return;
    }
    if(op.type==="DRILL") {
      if(Number(op.diameter)<=0) issues.push({level:"error",operation:op.sequence,message:"Некорректный диаметр сверления"});
      if(Number(op.depth)<=0) issues.push({level:"error",operation:op.sequence,message:"Некорректная глубина сверления"});
      if(Number(op.depth)>Number(u.depth||0)+0.01)
        issues.push({level:"error",operation:op.sequence,message:"Глубина сверления "+op.depth+" мм превышает толщину детали "+u.depth+" мм"});
      if(Number(op.diameter)>Number(u.depth||0))
        issues.push({level:"error",operation:op.sequence,message:"Диаметр сверла "+op.diameter+" мм превышает толщину детали"});
      if(op.source==="IFC" && !op.localBasis)
        issues.push({level:"error",operation:op.sequence,message:"IFC-сверление не содержит подтверждённой локальной базы"});
    }
    if((op.type==="MILL" || op.type==="POCKET" || op.type==="CONTOUR") && Number(op.depth||0)>Number(u.depth||0)+0.01)
      issues.push({level:"error",operation:op.sequence,message:"Глубина обработки превышает толщину детали"});
    if(op.type==="CONTOUR" && (!Array.isArray(op.path) || op.path.length<3))
      issues.push({level:"error",operation:op.sequence,message:"Контур не содержит достаточного количества точек"});
    if(op.toolId && op.toolId!=="TBD" && tool.id!==op.toolId)
      issues.push({level:"error",operation:op.sequence,message:"Несоответствие назначенного инструмента библиотеке ЧПУ"});
  });
  if(setup.safeZ<=0) issues.push({level:"error",operation:"SETUP",message:"Безопасная высота Z должен быть больше 0"});
  return issues;
}

function cncPreflight() {
  const result = [];
  parts.forEach(part => {
    const issues = [
      ...cncCollisionChecks(part),
      ...cncSequenceChecks(part).issues,
      ...validateIfcManufacturingIntegrity(part),
      ...manufacturingPreflight(part)
    ];
    issues.forEach(issue => result.push({...issue,partNumber:part.userData.partNumber}));
  });
  return result;
}

function cncIssueStage(issue) {
  const text=String(issue.message || "").toLowerCase();
  if(issue.operation==="SETUP" || text.includes("safe z") || text.includes("подач") || text.includes("шпиндел")) return "СТАНОК";
  if(text.includes("контур") || text.includes("точек контура") || text.includes("геометр")) return "ГЕОМЕТРИЯ";
  if(text.includes("баз") || text.includes("localbasis") || text.includes("локальной")) return "БАЗА";
  if(text.includes("отверст") || text.includes("сверл") || text.includes("диаметр") || text.includes("глубин")) return "ОБРАБОТКА";
  if(text.includes("инструмент") || text.includes("сверло") || text.includes("фрез")) return "ИНСТРУМЕНТ";
  if(text.includes("последователь") || text.includes("холостой")) return "ПОСЛЕДОВАТЕЛЬНОСТЬ";
  if(text.includes("postprocessor") || text.includes("постпроцесс")) return "ПОСТПРОЦЕССОР";
  if(text.includes("manufacturing") || text.includes("ifc cnc") || text.includes("потерян") || text.includes("дублирован")) return "СВЯЗНОСТЬ";
  return "ПРОИЗВОДСТВО";
}

function renderCncPreflight() {
  const target = $("cncPreflight");
  if (!target) return;
  const issues = cncPreflight();
  const stageOrder=["ГЕОМЕТРИЯ","БАЗА","ОБРАБОТКА","ИНСТРУМЕНТ","ПОСЛЕДОВАТЕЛЬНОСТЬ","СТАНОК","СВЯЗНОСТЬ","ПОСТПРОЦЕССОР","ПРОИЗВОДСТВО"];
  const grouped={};
  issues.forEach(i=>{ const stage=cncIssueStage(i); (grouped[stage] ||= []).push(i); });
  const stageHtml=stageOrder.filter(stage=>grouped[stage]?.length).map(stage=>{
    const list=grouped[stage];
    return "<div class='cnc-preflight-stage'><b>"+stage+" · "+list.length+"</b>"+
      list.map(i=>"<div class='status "+i.level+"'>Деталь "+i.partNumber+
      ", операция "+i.operation+": "+i.message+"</div>").join("")+"</div>";
  }).join("");
  target.innerHTML = "<b>Проверка ЧПУ перед экспортом</b>" +
    (issues.length ? stageHtml : "<div class='status ok'>Все звенья производственной цепочки прошли проверку.</div>");
  return issues;
}

function buildIfcManufacturingOperations(part) {
  const u=part.userData;
  if(u.source!=="IFC") return [];
  const packet=u.productionPacket || buildIfcProductionPacket(part);
  const ops=[];
  const add=(type,operation,data={})=>ops.push({
    id:data.id || ("IFC-" + type + "-" + (ops.length+1)),
    type, operation, partNumber:u.partNumber, source:"IFC",
    technologyStatus:"ready", ...data
  });
  if(packet?.contour?.ready && packet.contour.path?.length>=3)
    add("CONTOUR","Контур детали по геометрии IFC",{id:"IFC-CONTOUR",path:packet.contour.path,width:Number(u.width)||0,height:Number(u.height)||0,depth:Number(u.thickness||u.depth)||0,toolId:"MILL-8",toolName:"Фреза Ø8 мм"});
  packet?.drilling?.filter(d=>d.status==="ready").forEach(d=>add("DRILL","Сверление",{
    id:d.id || ("IFC-DRILL-"+(ops.length+1)),x:Number(d.x)||0,y:Number(d.y)||0,z:Number(d.z)||0,
    diameter:Number(d.diameter)||0,depth:Number(d.depth)||0,linkedPart:d.linkedPart,worldContact:d.worldContact,
    localBasis:d.localBasis,checks:d.checks
  }));
  packet?.operations?.filter(o=>o.status==="ready" && (o.type==="MILL" || o.type==="POCKET")).forEach(o=>add(o.type,o.operation,{id:o.id,x:o.x,y:o.y,z:o.z,width:o.width,length:o.length,depth:o.depth,path:o.path}));
  return ops;
}

function buildCncOperations(part) {
  const u=part.userData;
  const ops=[];
  const add=(type,operation,data={})=>ops.push({id:data.id || ("CORE-"+type+"-"+(ops.length+1)),sequence:ops.length+1,type,operation,partNumber:u.partNumber,...data});
  if(u.source==="IFC") {
    const packet=u.productionPacket || buildIfcProductionPacket(part);
    if(packet && !packet.cncReady) {
      if(!packet.contour.ready) add("CONTOUR_BLOCKED","Контур детали IFC — требуется проверка геометрии",{reason:"IFC contour not ready",source:"IFC"});
      if(packet.drilling.some(d=>d.status==="review")) add("TECH_BLOCKED","Технологическая присадка IFC требует подтверждения базы",{reason:"IFC drilling basis review",source:"IFC"});
    }
    buildIfcManufacturingOperations(part).forEach(op=>ops.push({...op,sequence:ops.length+1}));
    return ops;
  }
  add("CONTOUR","Контур детали",{width:Number(u.width)||0,height:Number(u.height)||0,depth:Number(u.thickness||u.depth)||0,path:[[-Number(u.width||0)/2,-Number(u.height||0)/2],[Number(u.width||0)/2,-Number(u.height||0)/2],[Number(u.width||0)/2,Number(u.height||0)/2],[-Number(u.width||0)/2,Number(u.height||0)/2]],toolId:"MILL-8",toolName:"Фреза Ø8 мм"});
  [...(u.drilling||[]),...(u.bodyFasteners||[]),...(u.shelfSupportDrilling||[]),...(u.secondaryFasteners||[])].forEach(h=>add("DRILL",h.operation||"Сверление",{x:Number(h.x)||0,y:Number(h.y)||0,z:Number(h.z)||0,diameter:Number(h.diameter)||0,depth:Number(h.depth)||0,linkedHardware:h.linkedHardware||h.type||"",source:h.source||"Furniture Core"}));
  buildMillingGeometry(part).forEach(m=>add("POCKET",m.operation,{x:m.x,y:m.y,z:m.z,width:m.width,length:m.length,depth:m.depth,path:m.path,source:m.operation}));
  return ops;
}

function assertManufacturingLifecycleReady(part) {
  const plan=getCompiledManufacturingPlan(part);
  const lifecycle=plan.lifecycle;
  const blocked=lifecycle.filter(x=>!x.valid);
  if(blocked.length || !plan.machineReady) {
    const validation=(plan.validation||[]).map(x=>x.code || x.message).join(", ");
    throw new Error("ЧПУ заблокирован: "+blocked.map(x=>x.operationId+"="+x.status).join(", ")+(validation ? " | "+validation : ""));
  }
  return lifecycle;
}

function buildCncProgram(part) {
  const plan=getCompiledManufacturingPlan(part);
  assertManufacturingLifecycleReady(part);
  const u = part.userData;
  const rawOps = plan.operations;
  if (rawOps.some(op => op.type === "CONTOUR_BLOCKED" || op.type === "TECH_BLOCKED"))
    throw new Error("ЧПУ export blocked: IFC technology is not confirmed.");
  const ops = rawOps.map(op => cncOperationWithTool(op, u.material));
  const lines = [
    "; Furniture AI Designer — ПРОГРАММА ЧПУ",
    "; Detail: " + u.partNumber + " " + u.name,
    "; Size: " + Math.round(u.width) + " x " + Math.round(u.height) + " x " + Math.round(u.depth),
    "G21",
    "G90",
    "G17",
    "G54"
  ];
  ops.forEach(op => {
    if (op.type === "CONTOUR") {
      lines.push("; КОНТУР " + op.width + " X " + op.height);
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

function cncMaterialFamily(material) {
  const m=String(material||"").toLowerCase();
  if(m.includes("ldsp") || m.includes("лдсп")) return "ЛДСП";
  if(m.includes("mdf") || m.includes("мдф")) return "МДФ";
  if(m.includes("ply") || m.includes("фанер")) return "Фанера";
  return "";
}

function selectCncTool(op, material) {
  const family = op.type === "DRILL" ? CNC_TOOL_LIBRARY.drilling : CNC_TOOL_LIBRARY.milling;
  const familyName=cncMaterialFamily(material);
  const candidates = family.filter(t => t.materials.includes(familyName));
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

function resolveManufacturingLifecycleStatus(op, issues=[]) {
  if (issues.some(i=>i.level==="error")) return "BLOCKED";
  if (issues.some(i=>i.level==="warning")) return "REVIEW";
  const tech=String(op.technologyStatus||"").toLowerCase();
  if(tech==="candidate") return "CANDIDATE";
  if(tech==="review") return "REVIEW";
  if(tech==="validated" || tech==="ready") return "READY";
  if(tech==="exported") return "EXPORTED";
  return "READY";
}

function validateManufacturingLifecycle(part) {
  return buildCncOperationJournal(part).map(op=>({
    operationId:op.id,
    sequence:op.sequence,
    status:op.lifecycleStatus,
    valid:["READY","EXPORTED"].includes(op.lifecycleStatus),
    reason:op.lifecycleStatus==="BLOCKED" ? "Есть критическая ошибка Preflight." :
      op.lifecycleStatus==="REVIEW" ? "Требуется проверка технологом." :
      op.lifecycleStatus==="CANDIDATE" ? "Операция ещё не подтверждена." : "Операция прошла контроль."
  }));
}

function compileManufacturingPlan(part) {
  const operations=buildCncToolPlan(part);
  const journal=buildCncOperationJournal(part);
  const toolTechnology=buildCncToolTechnologyPlan({operations,material:part.userData.material,thickness:part.userData.thickness});
  const integrity=validateIfcManufacturingIntegrity(part);
  const preflight=manufacturingPreflight(part);
  const lifecycle=validateManufacturingLifecycle(part);
  const errors=[
    ...integrity,
    ...preflight
  ].filter(i=>i.level==="error");
  return {
    version:"1.0",
    partNumber:part.userData.partNumber,
    source:part.userData.source || "Furniture Core",
    material:part.userData.material || "Не задан",
    thickness:Number(part.userData.thickness || 0),
    machineSetup:readCncMachineSetup(),
    operations,
    toolTechnology,\n    technologyGroups:buildCncTechnologyGroups({operations,material:part.userData.material,thickness:part.userData.thickness}),
    operationJournal:journal,
    manufacturingIntegrity:integrity,
    preflight,
    toolChangeSequence:buildCncToolChangeSequence({toolTechnology}),
    toolChangeValidation:validateToolChangeSequence({toolTechnology}),\n    technologyGroupValidation:validateCncTechnologyGroups({technologyGroups:buildCncTechnologyGroups({operations,material:part.userData.material,thickness:part.userData.thickness})}),
    lifecycle,
    status:errors.length ? "BLOCKED" : lifecycle.some(x=>x.status==="REVIEW") ? "REVIEW" : "READY"
  };
}

function buildCncOperationJournal(part) {
  const u=part.userData;
  const packet=u.source==="IFC" ? (u.productionPacket || buildIfcProductionPacket(part)) : null;
  const ops=optimizeCncOperationSequence(part);
  return ops.map(op=>{
    const tool=selectCncTool(op,u.material || "Не задан");
    const issues=[
      ...validateIfcManufacturingIntegrity(part),
      ...manufacturingPreflight(part)
    ].filter(i=>String(i.operation)===String(op.sequence) || String(i.operation)===String(op.id));
    const sourceOp=packet?.drilling?.find(d=>d.id===op.id) || packet?.operations?.find(o=>o.id===op.id) || null;
    return {
      id:op.id,
      sequence:op.sequence,
      type:op.type,
      operation:op.operation,
      source:op.source || (u.source==="IFC" ? "IFC" : "Furniture Core"),
      expressId:u.source==="IFC" ? u.expressId : null,
      technologyStatus:op.technologyStatus || (sourceOp?.status || "ready"),
      coordinates:{x:op.x ?? null,y:op.y ?? null,z:op.z ?? null},
      depth:op.depth ?? null,
      diameter:op.diameter ?? null,
      basis:op.localBasis || sourceOp?.localBasis || packet?.basis || null,
      linkedPart:op.linkedPart || sourceOp?.linkedPart || null,
      tool:tool ? {id:tool.id,name:tool.name,diameter:tool.diameter} : null,
      checks:op.checks || sourceOp?.checks || null,
      preflightStatus:issues.some(i=>i.level==="error") ? "ERROR" : issues.some(i=>i.level==="warning") ? "WARNING" : "OK",
      lifecycleStatus:resolveManufacturingLifecycleStatus(op,issues),
      preflightIssues:issues.map(i=>({level:i.level,operation:i.operation,message:i.message}))
    };
  });
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
    operations: ops,
    productionPacket: buildIfcProductionPacket(part),
    operationJournal: buildCncOperationJournal(part),
    productionOperationPassport: buildProductionOperationPassport(part),
    productionOperationLinks: buildProductionOperationLinks(part)
  };
}

function cncDisplayType(type){
  return ({DRILL:"Сверление",MILL:"Фрезерование",POCKET:"Карман",CONTOUR:"Контур",INNER_CONTOUR:"Внутренний контур",OUTER_CONTOUR:"Наружный контур",OTHER:"Другое"})[type] || type || "Другое";
}
function cncDisplayStatus(status){
  return ({READY:"ГОТОВО",REVIEW:"ТРЕБУЕТ ПРОВЕРКИ",BLOCKED:"ЗАБЛОКИРОВАНО",EXPORTED:"ЭКСПОРТИРОВАНО",ERROR:"ОШИБКА",WARNING:"ПРЕДУПРЕЖДЕНИЕ",OK:"ОК",CANDIDATE:"КАНДИДАТ"})[status] || status || "НЕИЗВЕСТНО";
}
function renderCncOperationJournal(part) {
  const target=$("cncOperationJournal");
  if(!target) return;
  const journal=buildCncOperationJournal(part);
  target.innerHTML="<b>Операционный журнал ЧПУ · "+part.userData.partNumber+"</b>"+
    (journal.length ? "<div>"+journal.map(op=>
      "<div class='cnc-journal-row'><b>"+op.sequence+". "+op.id+"</b> · "+cncDisplayType(op.type)+
      " · "+cncDisplayStatus(op.preflightStatus)+
      " · "+(op.tool?.name || "инструмент не назначен")+
      (op.coordinates.x!==null ? " · XYZ "+op.coordinates.x+";"+op.coordinates.y+";"+op.coordinates.z : "")+
      "</div>").join("")+"</div>" :
      "<div class='status ok'>Операций нет.</div>");
  return journal;
}

function renderCncTechCard(part) {
  const card = buildCncTechCard(part);
  renderCncOperationJournal(part);
  const target = $("cncTechCard");
  if (!target) return;
  target.innerHTML =
    "<b>ЧПУ-карточка детали " + card.partNumber + "</b>" +
    "<div>Материал: " + card.material + " | Толщина: " + card.thickness + " мм</div>" +
    "<div>Размер: " + Math.round(card.size.length) + " × " + Math.round(card.size.width) + " × " + Math.round(card.size.depth) + " мм</div>" +
    "<div>Постпроцессор: " + card.machine + " | Нулевая точка: " + card.zeroPoint + "</div>" +
    "<div>Безопасная высота Z: " + card.safeZ + " мм | Подача: " + card.feed + " мм/мин</div>" +
    "<div>Инструмент: " + card.tool + " | Обороты: " + card.spindle + "</div>" +
    "<div>Операций: " + card.operations.length + "</div>";
}

function exportCncOperationJournals() {
  const payload={
    format:"Furniture AI ЧПУ Operation Journal",
    version:"1.0",
    generatedAt:new Date().toISOString(),
    parts:parts.map(part=>({
      partNumber:part.userData.partNumber,
      name:part.userData.name,
      source:part.userData.source || "Furniture Core",
      journal:buildCncOperationJournal(part)
    }))
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download="cnc-operation-journal.json";
  link.click();
  URL.revokeObjectURL(link.href);
  validate("Операционный журнал ЧПУ экспортирован.", "ok");
}

function exportCncTechCards() {
  const cards = parts.map(buildCncTechCard);
  const blob = new Blob([JSON.stringify({
    format:"Furniture AI ЧПУ Tech Card",
    version:"2.0",
    postprocessor:getPostprocessor().name,
    cards
  }, null, 2)], {type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download="cnc-tech-cards.json";
  link.click();
  URL.revokeObjectURL(link.href);
  validate("Технологическая карта ЧПУ экспортирована.", "ok");
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
    header: ["; BIESSE ЧПУ PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  },
  homag: {
    name: "Homag — базовый шаблон",
    extension: ".mpr",
    header: ["; HOMAG ЧПУ PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  },
  scm: {
    name: "SCM — базовый шаблон",
    extension: ".pgm",
    header: ["; SCM ЧПУ PROGRAM","; Furniture AI Designer"],
    footer: ["; END"],
    drillFeed: 300,
    safeZ: 5
  }
};

function getPostprocessor() {
  return CNC_POSTPROCESSORS[$("cncPostprocessor")?.value || "generic"] || CNC_POSTPROCESSORS.generic;
}

function buildIfcProductionPacket(part) {
  const u=part.userData;
  if (u.source !== "IFC") return null;
  const tech=u.technology || {};
  return {
    source:"IFC",
    expressId:u.expressId,
    role:u.recognizedKind || u.kind,
    recognition:{confidence:u.recognitionConfidence,reason:u.recognitionReason},
    geometryLocked:Boolean(u.geometryLocked),
    contour:{
      ready:Boolean(u.ifcContour?.ready),
      axis:u.ifcContour?.axis || "",
      path:u.ifcContour?.path || []
    },
    basis:tech.drillingBasis || null,
    joints:(tech.joints || []).map(j=>({
      id:j.id,type:j.type,status:j.status,partA:j.partA,partB:j.partB,
      contactAxis:j.contactAxis,contactCenter:j.contactCenter,
      hardwareRecommendation:j.hardwareRecommendation
    })),
    drilling:(tech.drilling || []).map(d=>({
      id:d.id,status:d.status,diameter:d.diameter,depth:d.depth,
      x:d.x,y:d.y,z:d.z,worldContact:d.worldContact,
      localBasis:d.localBasis,checks:d.checks,linkedPart:d.linkedPart
    })),
    operations:(tech.operations || []).map(o=>({...o})),
    cncReady:Boolean(u.geometryCncReady && tech.drillingStatus !== "review")
  };
}

function refreshPartTechnologyRecord(part) {
  const u=part.userData;
  u.detailing = {
    ...(u.detailing || {}),
    number:u.partNumber,
    name:u.name,
    length:Math.round(u.width),
    width:Math.round(u.height),
    thickness:Math.round(u.depth),
    quantity:u.quantity,
    material:u.material,
    edges:[...(u.edges || [])],
    processing:[...(u.processing || [])],
    holes:[
      ...(u.drilling || []),
      ...(u.source === "IFC" ? (u.technology?.drilling || []).filter(h=>h.status==="ready") : []),
      ...(u.shelfSupportDrilling || []),
      ...(u.bodyFasteners || []),
      ...(u.secondaryFasteners || [])
    ],
    milling:(u.processing || []).filter(op=>/фрез|паз|выбор/i.test(op.operation || "")),
    notes:[]
  };
  u.productionPacket=buildIfcProductionPacket(part);
  return u.detailing;
}

function cncProgramTechnologyLines(op,currentTool){
  const lines=[];
  if(op.toolId && op.toolId!==currentTool){
    lines.push("; СМЕНА ИНСТРУМЕНТА "+op.toolId,"M5","G0 Z"+Number(op.safeZ||5).toFixed(3),"T"+op.toolId+" M6");
  }
  if(Number(op.rpm)>0) lines.push("S"+Math.round(op.rpm)+" M3");
  if(Number(op.feed)>0) lines.push("F"+Math.round(op.feed));
  return lines;
}
function buildCncJobProgram(part) {
  const plan=getCompiledManufacturingPlan(part);
  assertManufacturingLifecycleReady(part);
  if(!plan.compiledToolpathProgram?.length) throw new Error("ЧПУ заблокировано: отсутствует скомпилированная траектория.");
  const u=part.userData, lines=["; Furniture AI Designer — ПРОГРАММА ЧПУ","; ДЕТАЛЬ "+plan.partNumber,"; МАТЕРИАЛ "+plan.material,"; ТОЛЩИНА "+plan.thickness,"G21","G90","G17","G54"];
  let currentTool=null,currentTechKey=null;
  plan.compiledToolpathProgram.forEach(op=>{
    const techKey=op.technologyGroupKey||"";
    if(techKey!==currentTechKey){
      if(currentTool!==null) lines.push("G0 Z"+Number(op.safeZ||5).toFixed(3));
      lines.push(...cncProgramTechnologyLines(op,currentTool));
      currentTool=op.toolId||currentTool;
      currentTechKey=techKey;
    }
    lines.push("; "+op.type+" "+op.operationId);
    op.points.forEach((p,i)=>{
      const rapid=i===0 || Number(p.z)>=Number(op.safeZ||5);
      const feed=Number(op.feed)>0 ? " F"+Math.round(op.feed) : "";
      const plunge=Number(op.plunge)>0 && Number(p.z)<Number(op.safeZ||5) ? " F"+Math.round(op.plunge) : "";
      lines.push((rapid?"G0":"G1")+" X"+p.x.toFixed(3)+" Y"+p.y.toFixed(3)+" Z"+p.z.toFixed(3)+(rapid?"":(plunge||feed)));
    });
  });
  lines.push("G0 Z"+Number(plan.machineSetup?.safeZ||5).toFixed(3),"M5","M30");
  return lines.join("\n");
}

function buildPostprocessedProgram(part) {
  const post=getPostprocessor(), plan=getCompiledManufacturingPlan(part);
  assertManufacturingLifecycleReady(part);
  if(!plan.compiledToolpathProgram?.length) throw new Error("Постпроцессор заблокирован: отсутствует скомпилированная траектория ЧПУ.");
  const u=part.userData, lines=[...post.header,"; ДЕТАЛЬ "+u.partNumber+" "+u.name,"; ИСТОЧНИК: СКОМПИЛИРОВАННАЯ ТРАЕКТОРИЯ"];
  let currentTool=null,currentTechKey=null;
  plan.compiledToolpathProgram.forEach(op=>{
    const techKey=op.technologyGroupKey||"";
    if(techKey!==currentTechKey){
      lines.push("G0 Z"+Number(op.safeZ||5).toFixed(3));
      lines.push(...cncProgramTechnologyLines(op,currentTool));
      currentTool=op.toolId||currentTool;
      currentTechKey=techKey;
    }
    lines.push("; "+op.type+" "+op.operationId);
    op.points.forEach((p,i)=>{
      const rapid=i===0 || Number(p.z)>=Number(op.safeZ||5);
      const feed=Number(op.feed)>0 ? " F"+Math.round(op.feed) : "";
      const plunge=Number(op.plunge)>0 && Number(p.z)<Number(op.safeZ||5) ? " F"+Math.round(op.plunge) : "";
      lines.push((rapid?"G0":"G1")+" X"+p.x.toFixed(3)+" Y"+p.y.toFixed(3)+" Z"+p.z.toFixed(3)+(rapid?"":(plunge||feed)));
    });
  });
  lines.push("G0 Z"+Number(plan.machineSetup?.safeZ||5).toFixed(3),...post.footer);
  return lines.join("\n");
}
function buildCncTraceabilityJournal(program,plan){
  const lines=String(program||"").split(/\\r?\\n/);
  const rows=[]; let active=null;
  lines.forEach((line,index)=>{
    const m=line.match(/^;\\s*(.+?)\\s+([^\\s]+)$/);
    if(m && m[1] && plan.operations?.some(o=>o.id===m[2])){
      const op=plan.operations.find(o=>o.id===m[2]);
      const group=(plan.technologyGroups||[]).find(g=>g.operations?.includes(op.id));
      active={lineStart:index+1,lineEnd:index+1,operationId:op.id,toolId:op.toolId||null,type:op.type,
        technologyGroupKey:group?.key||null,technologyGroup:group?{toolId:group.toolId,rpm:group.rpm,feed:group.feed,plunge:group.plunge,passDepth:group.passDepth}:null,
        expressId:op.expressId||op.sourceExpressId||null,source:op.source||plan.source,material:plan.material,thickness:plan.thickness,
        depth:op.depth||0,points:[],geometrySource:plan.source==="IFC"?"IFC":"Furniture Core"};
      rows.push(active);
    } else if(active && line.trim() && !line.trim().startsWith(";")){
      active.lineEnd=index+1;
      const xy=line.match(/X(-?[0-9.]+)\\s+Y(-?[0-9.]+)\\s+Z(-?[0-9.]+)/i);
      if(xy) active.points.push({x:Number(xy[1]),y:Number(xy[2]),z:Number(xy[3])});
    }
  });
  return rows.map((r,i)=>({...r,traceId:"GCODE-"+String(i+1).padStart(4,"0"),sourceGeometryReference:r.expressId!=null?"IFC ExpressID "+r.expressId:"Внутренняя геометрия"}));
}

function validateCncTraceability(program,plan){
  const issues=[];
  const journal=buildCncTraceabilityJournal(program,plan);
  (plan.operations||[]).forEach(op=>{
    const rows=journal.filter(x=>x.operationId===op.id);
    if(!rows.length) issues.push({level:"error",code:"GCODE_ORPHAN_OPERATION",message:"Операция отсутствует в трассировке управляющей программы.",operation:op.id});
    rows.forEach(row=>{
      if(op.toolId && row.toolId!==op.toolId) issues.push({level:"error",code:"GCODE_TRACE_TOOL_MISMATCH",message:"Инструмент управляющей программы не соответствует операции.",operation:op.id});
      if(op.expressId!=null && row.expressId!=null && String(op.expressId)!==String(row.expressId))
        issues.push({level:"error",code:"GCODE_TRACE_EXPRESSID_MISMATCH",message:"ExpressID не соответствует исходной операции.",operation:op.id});
      const group=(plan.technologyGroups||[]).find(g=>g.operations?.includes(op.id));
      if(group && row.technologyGroupKey!==group.key) issues.push({level:"error",code:"GCODE_TRACE_GROUP_MISMATCH",message:"Технологическая группа управляющей программы не соответствует операции.",operation:op.id});
      if(!row.points?.length) issues.push({level:"error",code:"GCODE_TRACE_NO_MOTION",message:"Для операции не найдены координаты движения.",operation:op.id});
    });
  });
  const ids=new Set();
  journal.forEach(row=>{
    if(ids.has(row.traceId)) issues.push({level:"error",code:"GCODE_TRACE_DUPLICATE",message:"Дублируется идентификатор трассировки.",operation:row.operationId});
    ids.add(row.traceId);
    if(row.lineEnd<row.lineStart) issues.push({level:"error",code:"GCODE_TRACE_RANGE",message:"Некорректный диапазон строк управляющей программы.",operation:row.operationId});
  });
  return {issues,journal};
}

function validateGeneratedCncProgram(program,plan){
  const issues=[];
  const lines=String(program||"").split(/\\r?\\n/);
  let currentTool=null,currentRpm=null,currentFeed=null,currentSafeZ=null;
  const toolIds=new Set((plan.operations||[]).map(o=>o.toolId).filter(Boolean));
  lines.forEach((line,index)=>{
    const n=index+1, t=line.trim();
    if(/^T\\S+\\s+M6/i.test(t)){
      const m=t.match(/^T(\\S+)\\s+M6/i); currentTool=m?.[1]||null;
      if(currentTool && !toolIds.has(currentTool)) issues.push({level:"error",code:"GCODE_TOOL_UNKNOWN",message:"В управляющей программе указан инструмент, отсутствующий в плане.",line:n});
    }
    const sm=t.match(/^S([0-9.]+)\\s+M3/i); if(sm) currentRpm=Number(sm[1]);
    const fm=t.match(/\\sF([0-9.]+)/i); if(fm) currentFeed=Number(fm[1]);
    const zm=t.match(/\\sZ(-?[0-9.]+)/i); if(zm){
      const z=Number(zm[1]);
      if(z>=0) currentSafeZ=Math.max(currentSafeZ??-Infinity,z);
      if(z<0 && (!currentTool || !currentRpm || !currentFeed))
        issues.push({level:"error",code:"GCODE_TECH_STATE","message:"Рабочее движение выполнено без полного технологического состояния.",line:n});
      if(z<0 && Math.abs(z)>Number(plan.thickness||0)+0.001)
        issues.push({level:"error",code:"GCODE_DEPTH","message:"Глубина управляющей программы превышает толщину детали.",line:n});
    }
    if(/^G0\\s/i.test(t) && /\\sZ-/.test(t))
      issues.push({level:"error",code:"GCODE_RAPID_Z","message:"Быстрое перемещение G0 уходит ниже нулевой плоскости.",line:n});
  });
  if(!lines.some(l=>/^M30\\s*$/i.test(l.trim()))) issues.push({level:"error",code:"GCODE_END","message:"В управляющей программе отсутствует команда завершения M30."});
  return issues;
}
function buildValidatedCncProgram(part){
  const plan=getCompiledManufacturingPlan(part);
  const program=buildCncJobProgram(part);
  const validation=validateGeneratedCncProgram(program,plan);
  const traceability=validateCncTraceability(program,plan);
  const traceabilityReady=traceability.issues.every(x=>x.level!=="error");
  if(validation.some(x=>x.level==="error") || traceability.issues.some(x=>x.level==="error")) throw new Error("ЧПУ заблокировано: проверка управляющей программы обнаружила ошибки трассировки.");
  return {program,validation,traceability,traceabilityReady};
}
function exportAllCnc() {
  const setupIssues = validateCncMachineSetup();
  const preflightIssues = cncPreflight();
  const critical = [...setupIssues, ...preflightIssues].filter(i => i.level === "error");
  if (critical.length) {
    validate("Экспорт ЧПУ заблокирован: обнаружены критические ошибки. Исправьте их в предварительной проверке.", "error");
    renderCncPreflight();
    renderCncSetupValidation();
    return;
  }
  const post = getPostprocessor();
  parts.forEach(part => {
    const generated=buildValidatedCncProgram(part);\n    const blob = new Blob([generated.program], {type:"text/plain"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "detail-" + part.userData.partNumber + post.extension;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  validate("Файлы ЧПУ подготовлены после успешной предварительной проверки: " + post.name, "ok");
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
  const addPolyline = (points, layer="OUTLINE") => {
    if (!points || points.length < 2) return;
    lines.push("0","LWPOLYLINE","8",layer,"90",points.length,"70",1);
    points.forEach(([x,y]) => lines.push("10",Number(x),"20",Number(y)));
  };
  if (u.source === "IFC" && u.ifcContour?.ready && u.ifcContour.path?.length >= 3) {
    addPolyline(u.ifcContour.path,"IFC_OUTLINE");
  } else {
    addMillingEntities(lines, part);
  }
  const addLine = (x1,y1,x2,y2,layer="OUTLINE") => {
    lines.push("0","LINE","8",layer,"10",x1,"20",y1,"30",0,"11",x2,"21",y2,"31",0);
  };
  const addCircle = (x,y,r,layer="DRILLING") => {
    lines.push("0","CIRCLE","8",layer,"10",x,"20",y,"30",0,"40",r);
  };
  if (!(u.source === "IFC" && u.ifcContour?.ready && u.ifcContour.path?.length >= 3)) {
    addLine(-w/2,-h/2,w/2,-h/2);
    addLine(w/2,-h/2,w/2,h/2);
    addLine(w/2,h/2,-w/2,h/2);
    addLine(-w/2,h/2,-w/2,-h/2);
  }

  const manufacturing = u.source === "IFC" ? buildIfcManufacturingOperations(part) : [];
  const holes = (u.source === "IFC" ? manufacturing.filter(op=>op.type==="DRILL") : [...(u.drilling||[]),...(u.shelfSupportDrilling||[]),...(u.bodyFasteners||[]),...(u.secondaryFasteners||[])]);
  holes.forEach(hole => {
    const x=Number(hole.x)||0, y=Number(hole.y)||0, r=(Number(hole.diameter)||5)/2;
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
    "Сверление": [...(part.userData.drilling || []), ...(part.userData.source === "IFC" ? (part.userData.technology?.drilling || []) : [])]
      .map(h => h.operation + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ") [" + (h.status || "ready") + "]").join(" | ") || "",
    "Крепёж корпуса": part.userData.bodyFasteners?.map(h => h.type + " Ø" + h.diameter + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Полкодержатели": part.userData.shelfSupportDrilling?.map(h => h.type + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Дюбели/эксцентрики": part.userData.secondaryFasteners?.map(h => h.type + " Ø" + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "Обработка": part.userData.detailing?.processing?.map(h => h.operation + " " + h.diameter + "×" + h.depth + " (" + h.x + ";" + h.y + ";" + h.z + ")").join(" | ") || "",
    "IFC-контур": part.userData.source === "IFC" ? (part.userData.ifcContour?.ready ? "подтверждён" : "заблокирован") : "",
    "Идентификатор производства IFC": part.userData.source === "IFC" ? (part.userData.productionPacket?.expressId || "") : "",
    "Операции ЧПУ IFC": part.userData.source === "IFC" ? buildIfcManufacturingOperations(part).map(op => op.id).join(" | ") : "",
    "Производственный паспорт": buildProductionOperationPassport(part).operations.map(op => op.operationId + " | " + (op.toolName || "Инструмент не назначен") + " | S" + (op.rpm || "") + " | F" + (op.feed || "") + " | глубина " + (op.depth || 0)).join(" || "),
    "Трассировка операции": buildProductionOperationPassport(part).operations.map(op => op.traceId + " → " + op.operationId + " → " + (op.expressId ?? "внутренняя геометрия")).join(" | "),
    "Готовность станка": buildProductionOperationPassport(part).machineReady ? "ГОТОВО" : "ЗАБЛОКИРОВАНО",
    "Целостность IFC": part.userData.source === "IFC" ? (validateIfcManufacturingIntegrity(part).length ? "ОШИБКА" : "OK") : "",
    "Предварительная проверка ЧПУ": manufacturingPreflight(part).length ? "ОШИБКА" : "OK",
    "Идентификаторы операций ЧПУ": buildCncOperationJournal(part).map(op=>op.id).join(" | "),
    "База сверления IFC": part.userData.source === "IFC" ? (part.userData.technology?.drillingStatus || "нет") : "",
    "Сопряжения IFC": part.userData.source === "IFC" ? (part.userData.technology?.jointCount || 0) : "",
    "Примечания": constructionChecksDetailed().filter(x => x.includes(part.userData.name)).join(" | ")
  }));
  const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Деталировка");
  XLSX.writeFile(wb, "furniture-ai-parts.xlsx");
}

function buildProductionOperationLinks(part) {
  const plan=getCompiledManufacturingPlan(part);
  const journal=buildCncOperationJournal(part);
  const traceProgram=buildValidatedCncProgram(part);
  const trace=traceProgram.traceability||[];
  const passport=buildProductionOperationPassport(part);
  return passport.operations.map((op,index)=>{
    const j=journal.find(x=>x.id===op.operationId)||{};
    const t=trace.find(x=>x.operationId===op.operationId)||{};
    return {
      mapNumber:index+1,
      operationId:op.operationId,
      traceId:op.traceId,
      expressId:op.expressId,
      toolId:op.toolId||j.tool?.id||null,
      toolName:op.toolName||j.tool?.name||null,
      technologyGroupKey:op.technologyGroupKey||null,
      lineStart:t.lineStart??null,
      lineEnd:t.lineEnd??null,
      gcodeLines:t.lineStart!=null && t.lineEnd!=null ? Math.max(0,t.lineEnd-t.lineStart+1) : 0,
      lifecycle:op.lifecycle,
      source:op.source,
      pathPoints:op.pathPoints,
      trajectories:(plan.compiledToolpathProgram||[]).filter(p=>p.operationId===op.operationId).map(p=>({
        passNumber:p.passNumber,
        pathIndex:p.pathIndex,
        start:p.workStart,
        end:p.workEnd
      })),
      coordinates:(()=>{
        const paths=(plan.compiledToolpathProgram||[]).filter(p=>p.operationId===op.operationId);
        const p=paths[0]?.workStart;
        return p ? {x:p.x,y:p.y,z:p.z} : null;
      })()
    };
  });
}

function drawProductionGeometryA3(doc, part, x0, y0, maxW, maxH) {
  const u=part.userData||{};
  const contour=u.ifcContour?.ready ? u.ifcContour.path : null;
  if(!contour || contour.length<3) {
    doc.setFontSize(9);
    doc.text("Графика: контур IFC не подтверждён — чертёжная геометрия не подставляется.",x0,y0+8);
    return {drawn:false};
  }
  const pts=contour.map(p=>({x:Number(p[0]),y:Number(p[1])})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(pts.length<3) return {drawn:false};
  const minX=Math.min(...pts.map(p=>p.x)), maxX=Math.max(...pts.map(p=>p.x));
  const minY=Math.min(...pts.map(p=>p.y)), maxY=Math.max(...pts.map(p=>p.y));
  const sx=maxX-minX, sy=maxY-minY;
  if(!(sx>0&&sy>0)) return {drawn:false};
  const scale=Math.min(maxW/sx,maxH/sy);
  const map=p=>({x:x0+(p.x-minX)*scale,y:y0+maxH-(p.y-minY)*scale});
  const mapped=pts.map(map);
  doc.setLineWidth(0.6);
  for(let i=0;i<mapped.length;i++){
    const a=mapped[i], b=mapped[(i+1)%mapped.length];
    doc.line(a.x,a.y,b.x,b.y);
  }

  const plan=getCompiledManufacturingPlan(part);
  const ops=(plan.operations||[]).filter(op=>op.type==="DRILL"||op.type==="MILL"||op.type==="POCKET"||op.type==="CONTOUR");
  const pathFor=(op)=>{
    const typed=(plan.compensatedToolpaths||[]).find(p=>p.operationId===op.id);
    if(typed?.points?.length>=2) return typed.points;
    if(op.path?.length>=2) return op.path;
    const x=Number(op.x), y=Number(op.y);
    return Number.isFinite(x)&&Number.isFinite(y) ? [[x,y]] : [];
  };
  const drawArrow=(a,b)=>{
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy);
    if(len<1) return;
    const ux=dx/len, uy=dy/len, al=Math.min(7,len*0.35);
    doc.line(a.x,a.y,b.x,b.y);
    doc.line(b.x,b.y,b.x-ux*al+uy*2,b.y-uy*al-ux*2);
    doc.line(b.x,b.y,b.x-ux*al-uy*2,b.y-uy*al+ux*2);
  };

  const drillOps=ops.filter(op=>op.type==="DRILL");
  drillOps.forEach((op,index)=>{
    const p=map({x:Number(op.x),y:Number(op.y)});
    const d=Number(op.diameter)||0;
    const depth=Number(op.depth)||0;
    const r=Math.max(1.5,Math.min(5,(d||5)*scale/2));
    doc.circle(p.x,p.y,r);
    doc.setFontSize(6);
    doc.text("О"+String(index+1),p.x+r+1,p.y-2);
    doc.text("Ø"+d+" × "+depth+" мм",p.x+r+1,p.y+3);
    const direction=op.localBasis?.drillDirection || op.drillDirection || u.technology?.drillingBasis?.direction;
    if(direction){
      const dx=Number(direction.x)||0, dy=Number(direction.y)||0, len=Math.hypot(dx,dy);
      if(len>0.01) drawArrow(p,{x:p.x+dx/len*8,y:p.y-dy/len*8});
    }
  });

  const routeOps=ops.filter(op=>op.type==="MILL"||op.type==="POCKET"||op.type==="CONTOUR");
  routeOps.forEach((op,index)=>{
    const path=pathFor(op).map(p=>map({x:Number(p[0]),y:Number(p[1])})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(path.length<2) return;
    doc.setLineWidth(op.type==="CONTOUR"?0.9:0.5);
    for(let j=0;j<path.length-1;j++) drawArrow(path[j],path[j+1]);
    if(op.type==="CONTOUR" && path.length>2) drawArrow(path[path.length-1],path[0]);
    const label=op.type==="POCKET"?"КАРМАН":op.type==="MILL"?"ФРЕЗЕРОВКА":"КОНТУР";
    const c=path[Math.floor(path.length/2)];
    doc.setFontSize(6);
    doc.text("О"+String(drillOps.length+index+1)+" "+label,c.x+2,c.y-2);
  });

  const basis=u.technology?.drillingBasis;
  if(basis?.origin && Number.isFinite(Number(basis.origin.x)) && Number.isFinite(Number(basis.origin.y))){
    const p=map({x:Number(basis.origin.x),y:Number(basis.origin.y)});
    doc.setFontSize(7);
    doc.line(p.x-5,p.y,p.x+5,p.y); doc.line(p.x,p.y-5,p.x,p.y+5);
    doc.text("БАЗА X0/Y0",p.x+6,p.y-3);
  }
  doc.setFontSize(7);
  doc.text("КОНТУР IFC",x0,y0+maxH+7);
  doc.text("Система координат: X/Y — локальная база детали; Z — направление обработки.",x0,y0+maxH+13);
  doc.text("Стрелки показывают направление технологического прохода.",x0,y0+maxH+19);
  return {drawn:true,scale,drillCount:drillOps.length,routeCount:routeOps.length,basis:!!basis};
}

function exportProductionPdf() {
  if (!window.jspdf) { validate("Модуль PDF недоступен.", "error"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({orientation:"landscape", unit:"mm", format:"a3"});
  const W=420, H=297;
  parts.forEach((part,index)=>{
    if(index) doc.addPage("a3","landscape");
    const u=part.userData||{};
    const passport=buildProductionOperationPassport(part);
    const operationLinks=buildProductionOperationLinks(part);
    doc.setFontSize(18);
    doc.text("ПРОИЗВОДСТВЕННАЯ КАРТА ДЕТАЛИ",14,16);
    doc.setFontSize(10);
    doc.text("Деталь: "+(u.partNumber||"")+"  "+(u.name||""),14,24);
    doc.text("Источник: "+(u.source||"Внутренняя модель")+"  ExpressID: "+(passport.expressId??"—"),14,30);
    doc.text("Роль: "+(passport.role||"—")+"  Материал: "+(passport.material||"—")+"  Толщина: "+(passport.thickness||0)+" мм",14,36);
    doc.text("Размер: "+Math.round(u.width||0)+" × "+Math.round(u.height||0)+" × "+Math.round(u.depth||0)+" мм",14,42);
    doc.text("Готовность станка: "+(passport.machineReady?"ГОТОВО":"ЗАБЛОКИРОВАНО")+"  Операций: "+passport.operationCount,14,48);
    doc.setFontSize(7);
    doc.text("Связь операций с G-кодом: "+operationLinks.filter(x=>x.lineStart!=null).length+" из "+operationLinks.length,14,53);
    drawProductionGeometryA3(doc, part, 14, 58, 180, 120);
    const tableX=205;
    doc.setFontSize(11); doc.text("Технологические операции",tableX,60);
    let y=67;
    doc.setFontSize(7);
    doc.text("№",tableX,y); doc.text("Операция",tableX+10,y); doc.text("Инстр.",tableX+52,y); doc.text("S",tableX+82,y); doc.text("F",tableX+96,y); doc.text("X/Y/Z",tableX+112,y); doc.text("Проход",tableX+143,y); doc.text("ExpressID",tableX+158,y); doc.text("G-код",tableX+190,y);
    y+=6;
    operationLinks.forEach((link)=>{
      if(y>275){ doc.addPage("a3","landscape"); y=18; }
      const op=passport.operations.find(x=>x.operationId===link.operationId)||{};
      doc.text(String(link.mapNumber),tableX,y);
      doc.text(String(link.operationId||"").slice(0,20),tableX+10,y);
      doc.text(String(link.toolName||"—").slice(0,13),tableX+52,y);
      doc.text(String(op.rpm??"—"),tableX+82,y);
      doc.text(String(op.feed??"—"),tableX+96,y);
      const c=link.coordinates;
      doc.text(c ? (Number(c.x).toFixed(1)+"/"+Number(c.y).toFixed(1)+"/"+Number(c.z).toFixed(1)) : "—",tableX+112,y);
      const passes=link.trajectories?.map(t=>t.passNumber).join(",")||"—";
      doc.text(String(passes).slice(0,8),tableX+143,y);
      doc.text(String(link.expressId??"—").slice(0,11),tableX+158,y);
      doc.text(link.lineStart!=null ? (link.lineStart+"-"+link.lineEnd) : "—",tableX+190,y);
      y+=5;
    });
    doc.setFontSize(9);
    doc.text("Состояние: "+(passport.machineReady?"машинно готово":"требует проверки")+" | Проверка производственного плана: "+((passport.validation||[]).filter(x=>x.level==="error").length?"ОШИБКИ":"ОК"),14,286);
  });
  doc.save("furniture-ai-production-map-a3.pdf");
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
    "<div class='status ok'>Настройки ЧПУ корректны.</div>");
}
["cncSafeZ","cncWorkZ","cncFeed","cncSpindle"].forEach(id=>{
  const el=$(id);
  if(el) el.addEventListener("input",renderCncSetupValidation);
});
renderCncSetupValidation();
function renderCncOperations() {
  const target=$("cncOperationsTable");
  if(!target || !parts.length) return;
  const rows=parts.flatMap(p=>buildCncOperations(p).map(op=>"<tr><td>"+op.partNumber+"</td><td>"+op.sequence+"</td><td>"+cncDisplayType(op.type)+"</td><td>"+op.operation+"</td><td>"+(op.diameter||"—")+"</td><td>"+(op.depth||"—")+"</td></tr>"));
  target.innerHTML="<b>Операции ЧПУ</b><table><thead><tr><th>№</th><th>№ оп.</th><th>Тип</th><th>Операция</th><th>Ø</th><th>Глубина</th></tr></thead><tbody>"+rows.join("")+"</tbody></table>";
}
setTimeout(renderCncOperations, 0);

if ($("showCuttingMap")) $("showCuttingMap").addEventListener("click", showCuttingMap);
$("exportPdf").addEventListener("click", exportPdf);
if ($("exportProductionPdf")) $("exportProductionPdf").addEventListener("click", exportProductionPdf);

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
function resolveCncCuttingParameters(op, tool, material, thickness) {
  const family=cncMaterialFamily(material);
  const t=Number(thickness)||18;
  const dia=Number(tool?.diameter||op.diameter||6);
  const base=family==="ЛДСП" ? {rpm:18000,feed:4500,plunge:1200} :
    family==="МДФ" ? {rpm:20000,feed:5000,plunge:1400} :
    family==="Фанера" ? {rpm:18000,feed:4000,plunge:1100} :
    {rpm:18000,feed:3500,plunge:1000};
  const depth=Math.min(Number(op.depth||t),t);
  const passDepth=Math.max(1,Math.min(depth, dia*0.75));
  return {
    rpm:base.rpm,
    feed:base.feed,
    plunge:base.plunge,
    depth,
    passDepth,
    passes:Math.max(1,Math.ceil(depth/passDepth)),
    safeZ:Number(readCncMachineSetup().safeZ)||5,
    materialFamily:family||"НЕИЗВЕСТНО"
  };
}

function buildCncTechnologyGroups(plan){
  const groups=[];
  (plan.operations||[]).forEach(op=>{
    const tool=CNC_TOOL_LIBRARY.find(t=>t.id===op.toolId);
    const p=resolveCncCuttingParameters(op,tool,plan.material,plan.thickness);
    const key=[op.toolId||"НЕТ",p.materialFamily,p.rpm,p.feed,p.plunge,p.passDepth].join("|");
    let group=groups.find(g=>g.key===key);
    if(!group){
      group={key,toolId:op.toolId||null,toolName:tool?.name||"Инструмент не назначен",diameter:tool?.diameter||null,materialFamily:p.materialFamily,rpm:p.rpm,feed:p.feed,plunge:p.plunge,passDepth:p.passDepth,depth:p.depth,safeZ:p.safeZ,operations:[]};
      groups.push(group);
    }
    group.operations.push(op.id);
    group.depth=Math.max(group.depth,p.depth);
  });
  return groups;
}
function validateCncTechnologyGroups(plan){
  const issues=[];
  (plan.technologyGroups||[]).forEach(g=>{
    if(!g.toolId) issues.push({level:"error",code:"TECH_TOOL_MISSING",message:"Не назначен инструмент для технологической группы.",operation:g.operations?.[0]});
    if(g.rpm<=0||g.feed<=0||g.plunge<=0) issues.push({level:"error",code:"TECH_CUTTING_PARAMS",message:"Некорректные режимы резания.",operation:g.operations?.[0]});
    if(g.passDepth<=0) issues.push({level:"error",code:"TECH_PASS_DEPTH",message:"Не задана глубина одного прохода.",operation:g.operations?.[0]});
  });
  return issues;
}
function buildCncToolChangeSequence(plan) {
  const groups=plan.technologyGroups || plan.toolTechnology || [];
  const order=[];
  groups.forEach((group,index)=>{
    const first=group.operations?.[0];
    order.push({
      sequence:index+1,
      toolId:group.toolId,
      toolName:group.toolName,
      diameter:group.toolDiameter,
      operationCount:group.operations?.length||0,
      rpm:group.rpm,
      feed:group.feed,
      plunge:group.plunge,
      safeZ:group.safeZ,
      firstOperation:first?.id||null,
      operations:(group.operations||[]).map(op=>op.id)
    });
  });
  return order;
}

function buildCncToolpaths(plan) {
  const safeZ=Number(plan.machineSetup?.safeZ)||5;
  const out=[];
  (plan.operations||[]).forEach(op=>{
    const toolId=op.toolId||null;
    const depth=Math.abs(Number(op.depth)||0);
    const tech=op.cuttingParameters||{};
    const passDepth=Math.max(0.1,Math.abs(Number(tech.passDepth)||Number(op.passDepth)||depth||0.1));
    const passes=Math.max(1,Math.ceil(depth/passDepth));
    const zLevels=Array.from({length:passes},(_,i)=>-Math.min(depth,(i+1)*passDepth));
    if(op.type==="DRILL" || op.type==="MILL") {
      const points=[];
      points.push({x:Number(op.x)||0,y:Number(op.y)||0,z:safeZ});
      zLevels.forEach(z=>points.push({x:Number(op.x)||0,y:Number(op.y)||0,z}));
      points.push({x:Number(op.x)||0,y:Number(op.y)||0,z:safeZ});
      out.push({operationId:op.id,type:op.type,toolId,passes,zLevels,points,source:"CNC_PASS_PLAN"});
    } else if(op.type==="CONTOUR" && Array.isArray(op.path)) {
      const base=op.path.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
      if(base.length<3) return;
      if(base[0].x!==base[base.length-1].x || base[0].y!==base[base.length-1].y) base.push({...base[0]});
      const points=[{x:base[0].x,y:base[0].y,z:safeZ}];
      zLevels.forEach(z=>{
        base.forEach(p=>points.push({x:p.x,y:p.y,z}));
        points.push({x:base[0].x,y:base[0].y,z:safeZ});
      });
      out.push({operationId:op.id,type:op.type,toolId,passes,zLevels,points,source:"CNC_PASS_PLAN"});
    } else if(op.type==="POCKET") {
      const typed=(plan.compensatedToolpaths||[]).filter(x=>x.operationId===op.id);
      if(typed.length) {
        typed.forEach(path=>out.push({...path,toolId,source:path.source||"IFC_POCKET_PASS"}));
      } else {
        out.push({operationId:op.id,type:op.type,toolId,passes,zLevels,points:[{x:Number(op.x)||0,y:Number(op.y)||0,z:safeZ}],source:"CNC_PASS_PLAN"});
      }
    }
  });
  return out;
}

function pointInPolygon2D(point, polygon) {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const xi=Number(polygon[i].x), yi=Number(polygon[i].y);
    const xj=Number(polygon[j].x), yj=Number(polygon[j].y);
    const intersect=((yi>point.y)!==(yj>point.y)) &&
      point.x < (xj-xi)*(point.y-yi)/((yj-yi)||1e-12)+xi;
    if(intersect) inside=!inside;
  }
  return inside;
}

function distancePointToSegment2D(p,a,b) {
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2=dx*dx+dy*dy;
  if(!len2) return Math.hypot(p.x-a.x,p.y-a.y);
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));
  return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));
}

function buildToolpathGeometryEnvelope(plan, part) {
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour) || contour.length<3) return null;
  const pts=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const minX=Math.min(...pts.map(p=>p.x)), maxX=Math.max(...pts.map(p=>p.x));
  const minY=Math.min(...pts.map(p=>p.y)), maxY=Math.max(...pts.map(p=>p.y));
  return {minX,maxX,minY,maxY,width:maxX-minX,height:maxY-minY,toolRadiusMax:Math.max(...(plan.operations||[]).map(o=>Number(o.toolDiameter||o.diameter||6)/2),0)};
}

function offsetContourForToolRadius(contour, radius) {
  if(!Array.isArray(contour) || contour.length<3 || radius<=0) return contour || [];
  const cx=contour.reduce((a,p)=>a+Number(p.x||0),0)/contour.length;
  const cy=contour.reduce((a,p)=>a+Number(p.y||0),0)/contour.length;
  return contour.map(p=>{
    const dx=Number(p.x||0)-cx, dy=Number(p.y||0)-cy;
    const len=Math.hypot(dx,dy)||1;
    return {x:Number(p.x||0)-dx/len*radius,y:Number(p.y||0)-dy/len*radius};
  });
}

function classifyContourSide(contour, path) {
  if(!Array.isArray(contour)||contour.length<3) return "НЕИЗВЕСТНО";
  if(path?.compensationSide==="INSIDE" || path?.compensationSide==="OUTSIDE") return path.compensationSide;
  // Один замкнутый IFC-контур без вложенного контура считаем наружным.
  // Для внутренних карманов сторона должна быть задана технологической операцией.
  return "OUTSIDE";
}

function classifyCncGeometryOperation(op) {
  const name=String(op.operation||op.name||"").toLowerCase();
  if(op.type==="CONTOUR") {
    if(op.compensationSide==="INSIDE" || name.includes("внутр") || name.includes("карман")) return "INNER_CONTOUR";
    return "OUTER_CONTOUR";
  }
  if(op.type==="POCKET" || name.includes("карман") || name.includes("pocket")) return "POCKET";
  return op.type || "OTHER";
}

function polygonSignedArea(points){
  let a=0;
  for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];a+=p.x*q.y-q.x*p.y;}
  return a/2;
}
function polygonConvexity(points){
  let sign=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],c=points[(i+2)%points.length];
    const z=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if(Math.abs(z)<1e-8) continue;
    const s=Math.sign(z); if(!sign) sign=s; else if(sign!==s) return false;
  }
  return true;
}
function offsetConvexPolygon(points, distance){
  if(!Array.isArray(points)||points.length<3) return null;
  const area=polygonSignedArea(points);
  if(Math.abs(area)<1e-8 || !polygonConvexity(points)) return null;
  const ccw=area>0, lines=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
    const nx=ccw ? -dy/len : dy/len, ny=ccw ? dx/len : -dx/len;
    lines.push({p:{x:a.x+nx*distance,y:a.y+ny*distance},n:{x:nx,y:ny}});
  }
  const out=[];
  for(let i=0;i<lines.length;i++){
    const l1=lines[(i+lines.length-1)%lines.length],l2=lines[i];
    const det=l1.n.x*l2.n.y-l1.n.y*l2.n.x;
    if(Math.abs(det)<1e-8) return null;
    const dx=l2.p.x-l1.p.x,dy=l2.p.y-l1.p.y;
    const t=(dx*l2.n.y-dy*l2.n.x)/det;
    out.push({x:l1.p.x+l1.n.x*t,y:l1.p.y+l1.n.y*t});
  }
  return out;
}
function buildPocketPasses(op, plan, part) {
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return [];
  let pts=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  if(pts.length>1 && pts[0].x===pts[pts.length-1].x && pts[0].y===pts[pts.length-1].y) pts=pts.slice(0,-1);
  if(!polygonConvexity(pts)) {
    op._pocketGeometryStatus="BLOCKED_NON_CONVEX";
    return [];
  }
  const tool=Math.max(0.1,Number(op.toolDiameter||op.diameter||6));
  const step=Math.max(0.1,Number(op.stepOver)||tool*0.4);
  const radius=tool/2;
  const depth=Math.abs(Number(op.depth)||1);
  const tech=op.cuttingParameters||{};
  const passDepth=Math.max(0.1,Math.abs(Number(tech.passDepth)||Number(op.passDepth)||depth));
  const zPasses=Math.max(1,Math.ceil(depth/passDepth));
  const result=[];
  for(let z=1;z<=zPasses;z++){
    const depthZ=-Math.min(depth,z*passDepth);
    for(let offset=radius,level=0;;offset+=step,level++){
      const path=offsetConvexPolygon(pts,-offset);
      if(!path || path.length<3 || Math.abs(polygonSignedArea(path))<0.01) break;
      path.push({...path[0],z:depthZ});
      for(let i=0;i<path.length-1;i++) path[i].z=depthZ;
      result.push({operationId:op.id,type:"POCKET",strategy:"CONCENTRIC_OFFSET",pass:z,level,stepOver:step,toolDiameter:tool,depth:depthZ,points:path,closed:true,source:"IFC_POCKET"});
    }
  }
  if(!result.length) op._pocketGeometryStatus="BLOCKED_TOOL_TOO_LARGE";
  return result;
}

function buildPocketToolpath(op, plan, part) {
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return null;
  const pts=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const cx=pts.reduce((a,p)=>a+p.x,0)/pts.length, cy=pts.reduce((a,p)=>a+p.y,0)/pts.length;
  const scale=Math.max(0.15,1-(Number(op.toolDiameter||op.diameter||6)/2)/Math.max(part.userData?.width||1,part.userData?.height||1));
  const pocket=pts.map(p=>({x:cx+(p.x-cx)*scale,y:cy+(p.y-cy)*scale,z:-(Number(op.depth)||1)}));
  pocket.push({...pocket[0]});
  return {operationId:op.id,type:"POCKET",strategy:"OFFSET_CENTER",points:pocket,source:"IFC_POCKET"};
}

function buildTypedCompensatedToolpaths(plan, part) {
  const result=[];
  (plan.operations||[]).forEach(op=>{
    const kind=classifyCncGeometryOperation(op);
    if(kind==="POCKET") result.push(...buildPocketPasses(op,plan,part));
    else if(kind==="INNER_CONTOUR" || kind==="OUTER_CONTOUR") {
      const paths=buildCompensatedContourToolpath({...plan,operations:[{...op,compensationSide:kind==="INNER_CONTOUR"?"INSIDE":"OUTSIDE"}]},part);
      result.push(...paths);
    }
  });
  return result;
}

function lineIntersection(a,b,c,d){
  const r={x:b.x-a.x,y:b.y-a.y}, q={x:d.x-c.x,y:d.y-c.y};
  const den=r.x*q.y-r.y*q.x;
  if(Math.abs(den)<1e-9) return null;
  const t=((c.x-a.x)*q.y-(c.y-a.y)*q.x)/den;
  return {x:a.x+t*r.x,y:a.y+t*r.y};
}
function buildOffsetContour(points,distance,side){
  if(!Array.isArray(points)||points.length<3) return null;
  let pts=points.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  if(pts.length>1 && pts[0].x===pts[pts.length-1].x && pts[0].y===pts[pts.length-1].y) pts=pts.slice(0,-1);
  const area=polygonSignedArea(pts);
  if(Math.abs(area)<1e-8) return null;
  const ccw=area>0;
  const outwardSign=ccw ? 1 : -1;
  const sign=side==="INSIDE" ? -1 : 1;
  const lines=[];
  for(let i=0;i<pts.length;i++){
    const a=pts[i],b=pts[(i+1)%pts.length],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
    const nx=outwardSign*dy/len, ny=outwardSign*-dx/len;
    lines.push({a:{x:a.x+nx*distance*sign,y:a.y+ny*distance*sign},b:{x:b.x+nx*distance*sign,y:b.y+ny*distance*sign}});
  }
  const out=[];
  for(let i=0;i<lines.length;i++){
    const hit=lineIntersection(lines[(i+pts.length-1)%pts.length].a,lines[(i+pts.length-1)%pts.length].b,lines[i].a,lines[i].b);
    if(!hit) return null;
    out.push(hit);
  }
  out.push({...out[0]});
  return out;
}
function buildCompensatedContourToolpath(plan, part) {
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return [];
  const points=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  return (plan.operations||[]).filter(op=>op.type==="CONTOUR").flatMap(op=>{
    const radius=Number(op.toolDiameter||op.diameter||6)/2;
    const side=op.compensationSide || classifyContourSide(points,op);
    const offset=buildOffsetContour(points,radius,side);
    if(!offset) return [];
    return [{operationId:op.id,side,radius,points:offset,closed:true,source:"IFC_COMPENSATED_NORMAL_OFFSET"}];
  });
}
function validateContourSelfIntersections(points){
  const issues=[];
  if(!Array.isArray(points)||points.length<4) return issues;
  for(let i=0;i<points.length-1;i++) for(let j=i+1;j<points.length-1;j++){
    if(j===i+1 || (i===0&&j===points.length-2)) continue;
    if(lineIntersection(points[i],points[i+1],points[j],points[j+1]))
      issues.push({level:"error",code:"CONTOUR_SELF_INTERSECTION",message:"Компенсированный контур содержит самопересечение."});
  }
  return issues;
}
function validateToolpathClearance(plan, part) {
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return issues;
  const polygon=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  (plan.toolpaths||[]).forEach(path=>{
    if(path.type!=="CONTOUR") return;
    const op=(plan.operations||[]).find(o=>o.id===path.operationId);
    const radius=Number(op?.toolDiameter||op?.diameter||6)/2;
    path.points.forEach((p,i)=>{
      const edge=Math.min(...polygon.map((a,j)=>distancePointToSegment2D({x:p.x,y:p.y},a,polygon[(j+1)%polygon.length])));
      if(edge<radius-0.01) issues.push({level:"error",code:"TOOL_CLEARANCE",message:"Недостаточный боковой зазор инструмента до края детали.",operation:path.operationId,point:i});
    });
  });
  return issues;
}

function optimizeCompiledToolpathSequence(program,plan){
  const remaining=[...(program||[])];
  const result=[];
  let currentTool=null, currentPoint={x:0,y:0};
  while(remaining.length){
    const sameTool=remaining.filter(x=>(x.toolId||null)===(currentTool||null));
    const pool=sameTool.length ? sameTool : remaining;
    let bestIndex=0,bestScore=Infinity;
    pool.forEach(candidate=>{
      const p=candidate.points?.find(x=>Number(x.z)<=candidate.safeZ) || candidate.points?.[0] || {x:0,y:0};
      const distance=Math.hypot((Number(p.x)||0)-currentPoint.x,(Number(p.y)||0)-currentPoint.y);
      const toolPenalty=currentTool && candidate.toolId!==currentTool ? 100000 : 0;
      const score=toolPenalty+distance;
      const idx=remaining.indexOf(candidate);
      if(score<bestScore){bestScore=score;bestIndex=idx;}
    });
    const selected=remaining.splice(bestIndex,1)[0];
    selected.sequence=result.length+1;
    selected.toolChange=selected.toolId!==currentTool;
    selected.approachSafeZ=true;
    selected.departureSafeZ=true;
    result.push(selected);
    currentTool=selected.toolId||null;
    const last=selected.points?.[selected.points.length-1];
    if(last) currentPoint={x:Number(last.x)||0,y:Number(last.y)||0};
  }
  return result;
}
function validateCompiledToolpathSequence(plan){
  const issues=[];
  const seq=plan.compiledToolpathProgram||[];
  let currentTool=null;
  seq.forEach((op,i)=>{
    if(op.sequence!==i+1) issues.push({level:"error",code:"SEQUENCE_NUMBER",message:"Нарушена нумерация последовательности операций.",operation:op.operationId});
    if(op.toolChange && !op.toolId) issues.push({level:"error",code:"SEQUENCE_TOOL","message":"Для смены инструмента не назначен инструмент.",operation:op.operationId});
    if(op.toolChange && currentTool===op.toolId) issues.push({level:"error",code:"SEQUENCE_DUPLICATE_TOOL",message:"Лишняя повторная смена одного и того же инструмента.",operation:op.operationId});
    if(!op.approachSafeZ || !op.departureSafeZ) issues.push({level:"error",code:"SEQUENCE_SAFE_Z",message:"Операция не имеет безопасного подхода или отхода.",operation:op.operationId});
    currentTool=op.toolId||currentTool;
  });
  return issues;
}
function applyTechnologyParametersToCompiledPath(path,operation,plan){
  const tool=CNC_TOOL_LIBRARY.find(t=>t.id===path.toolId);
  const p=resolveCncCuttingParameters(operation||{},tool,plan.material,plan.thickness);
  return {...path,rpm:p.rpm,feed:p.feed,plunge:p.plunge,passDepth:p.passDepth,passes:p.passes,
    materialFamily:p.materialFamily,safeZ:p.safeZ,
    technologyGroupKey:[path.toolId||"НЕТ",p.materialFamily,p.rpm,p.feed,p.plunge,p.passDepth].join("|")};
}
function validateCompiledToolpathTechnology(plan){
  const issues=[];
  (plan.compiledToolpathProgram||[]).forEach(path=>{
    if(!(Number(path.rpm)>0)) issues.push({level:"error",code:"PATH_RPM",message:"Для траектории не заданы обороты шпинделя.",operation:path.operationId});
    if(!(Number(path.feed)>0)) issues.push({level:"error",code:"PATH_FEED",message:"Для траектории не задана рабочая подача.",operation:path.operationId});
    if(!(Number(path.plunge)>0)) issues.push({level:"error",code:"PATH_PLUNGE",message:"Для траектории не задана подача врезания.",operation:path.operationId});
    if(!(Number(path.passDepth)>0)) issues.push({level:"error",code:"PATH_PASS_DEPTH",message:"Для траектории не задана глубина прохода.",operation:path.operationId});
    if(Number(path.passDepth)>Number(path.depth)+0.001) issues.push({level:"error",code:"PATH_PASS_DEPTH_LIMIT",message:"Глубина прохода превышает глубину операции.",operation:path.operationId});
  });
  return issues;
}
function buildCompiledToolpathProgram(plan,part){
  const safeZ=Number(plan.machineSetup?.safeZ)||5;
  const result=[];
  const paths=plan.compensatedToolpaths||[];
  paths.forEach((path,index)=>{
    const op=(plan.operations||[]).find(o=>o.id===path.operationId);
    const points=path.points||[];
    if(points.length<2) return;
    const toolId=path.toolId||op?.toolId||null;
    const depth=Number(path.depth||op?.depth||0);
    const passNumber=Number.isFinite(Number(path.pass)) ? Number(path.pass) : (Number.isFinite(Number(path.level)) ? Number(path.level) : index+1);
    const workPoints=points.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0,z:Number.isFinite(Number(p.z))?Number(p.z):0}));
    result.push({
      sequence:index+1,operationId:path.operationId,type:path.type||op?.type||"OTHER",toolId,safeZ,depth,
      passNumber,
      pathIndex:index+1,
      workStart:workPoints[0]||null,
      workEnd:workPoints[workPoints.length-1]||null,
      points:[
        {x:Number(points[0].x)||0,y:Number(points[0].y)||0,z:safeZ},
        ...points.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0,z:Number.isFinite(Number(p.z))?Number(p.z):0})),
        {x:Number(points[points.length-1].x)||0,y:Number(points[points.length-1].y)||0,z:safeZ}
      ],
      source:path.source||"COMPILED_TOOLPATH"
    });
  });
  result.forEach(path=>{
    const op=(plan.operations||[]).find(o=>o.id===path.operationId);
    Object.assign(path,applyTechnologyParametersToCompiledPath(path,op,plan));
  });
  return result;
}
function validateToolpathCollisions(plan,part){
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return issues;
  const polygon=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const paths=plan.compensatedToolpaths||[];
  paths.forEach((path,idx)=>{
    const op=(plan.operations||[]).find(o=>o.id===path.operationId);
    const radius=Number(path.radius||op?.toolDiameter||op?.diameter||6)/2;
    const pts=path.points||[];
    for(let i=0;i<pts.length;i++){
      const p=pts[i];
      if(Number(p.z)>0) continue;
      const edge=Math.min(...polygon.map((a,j)=>distancePointToSegment2D({x:p.x,y:p.y},a,polygon[(j+1)%polygon.length])));
      const kind=classifyCncGeometryOperation(op||{});
      if(kind==="OUTER_CONTOUR" && edge<radius-0.05)
        issues.push({level:"error",code:"TOOL_BOUNDARY_COLLISION",message:"Инструмент выходит за границу детали при наружном контуре.",operation:path.operationId,point:i});
    }
    for(let j=0;j<idx;j++){
      const prev=paths[j];
      if(prev.operationId!==path.operationId || prev.pass===path.pass) continue;
      const min=Math.min(...(prev.points||[]).map(a=>Math.min(...pts.map(b=>Math.hypot(a.x-b.x,a.y-b.y))));
      const prevRadius=Number(prev.radius||6);
      if(min < radius+prevRadius-0.05)
        issues.push({level:"error",code:"TOOLPATH_COLLISION",message:"Соседние траектории инструмента пересекаются с недостаточным зазором.",operation:path.operationId});
    }
  });
  return issues;
}
function validateContourMinimumWidth(plan,part){
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return issues;
  const pts=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const minEdge=Math.min(...pts.map((a,i)=>distancePointToSegment2D(a,pts[(i+1)%pts.length],pts[(i+2)%pts.length])));
  (plan.compensatedToolpaths||[]).filter(p=>p.type==="CONTOUR"||p.source==="IFC_COMPENSATED_NORMAL_OFFSET").forEach(path=>{
    if(path.radius*2>minEdge*2+0.001)
      issues.push({level:"warning",code:"CONTOUR_TOOL_LARGE",message:"Диаметр инструмента сопоставим с минимальной шириной геометрии; требуется проверка траектории.",operation:path.operationId});
  });
  return issues;
}
function validateContourCompensationGeometry(plan,part){
  const issues=[];
  (plan.compensatedToolpaths||[]).filter(p=>p.type==="CONTOUR"||p.source==="IFC_COMPENSATED_NORMAL_OFFSET").forEach(path=>{
    issues.push(...validateContourSelfIntersections(path.points).map(x=>({...x,operation:path.operationId})));
    if(path.points.length<4 || !path.closed) issues.push({level:"error",code:"CONTOUR_NOT_CLOSED",message:"Компенсированный контур не замкнут.",operation:path.operationId});
  });
  return issues;
}
function validateToolRadiusCompensation(plan, part) {
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour) || contour.length<3) return issues;
  (plan.operations||[]).filter(op=>op.type==="CONTOUR").forEach(op=>{
    const radius=Number(op.toolDiameter||op.diameter||6)/2;
    const compensated=offsetContourForToolRadius(contour,radius);
    if(compensated.length<3) {
      issues.push({level:"error",code:"TOOL_RADIUS_COMPENSATION",message:"Невозможно построить компенсацию радиуса инструмента.",operation:op.id});
      return;
    }
    const minX=Math.min(...compensated.map(p=>p.x)),maxX=Math.max(...compensated.map(p=>p.x));
    const minY=Math.min(...compensated.map(p=>p.y)),maxY=Math.max(...compensated.map(p=>p.y));
    const path=(plan.toolpaths||[]).find(x=>x.operationId===op.id);
    (path?.points||[]).forEach(p=>{
      if(p.x<minX-0.001||p.x>maxX+0.001||p.y<minY-0.001||p.y>maxY+0.001)
        issues.push({level:"error",code:"TOOL_RADIUS_COMPENSATION_OUTSIDE",message:"Центр фрезы выходит за компенсированную область контура.",operation:op.id});
    });
  });
  return issues;
}

function validateToolpathSegmentsAgainstGeometry(plan, part) {
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour) || contour.length<3) return issues;
  const polygon=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const inside=(p)=>pointInPolygon2D(p,polygon);
  const segmentSamples=(a,b,count=12)=>{
    const out=[];
    for(let i=0;i<=count;i++){const t=i/count;out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}
    return out;
  };
  (plan.toolpaths||[]).forEach(path=>{
    for(let i=1;i<path.points.length;i++){
      const a=path.points[i-1],b=path.points[i];
      if(Number(a.z)>0 || Number(b.z)>0) continue;
      const samples=segmentSamples(a,b);
      if(samples.some(p=>!inside(p))){
        issues.push({level:"error",code:"TOOLPATH_SEGMENT_OUTSIDE",message:"Сегмент траектории выходит за допустимую геометрию IFC.",operation:path.operationId,segment:i});
        break;
      }
    }
  });
  return issues;
}

function validateToolpathAgainstGeometry(plan, part) {
  const issues=[];
  const u=part.userData||{};
  const contour=u.ifcContour?.path;
  if(!Array.isArray(contour) || contour.length<3) return issues;
  const polygon=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  const maxToolRadius=Math.max(...(plan.operations||[]).map(op=>Number(op.toolDiameter||op.diameter||6)/2),0);
  (plan.toolpaths||[]).forEach(path=>{
    if(path.type==="CONTOUR") {
      path.points.forEach(p=>{
        const inside=pointInPolygon2D(p,polygon);
        if(!inside) issues.push({level:"error",code:"TOOLPATH_OUTSIDE_CONTOUR",message:"Траектория контура выходит за геометрию IFC.",operation:path.operationId});
      });
    } else if(path.type==="DRILL" || path.type==="MILL" || path.type==="POCKET") {
      const p=path.points[0];
      if(!pointInPolygon2D(p,polygon)) {
        issues.push({level:"error",code:"TOOLPATH_OUTSIDE_PART",message:"Центр инструмента находится вне допустимого IFC-контура.",operation:path.operationId});
      } else {
        const edgeDistance=Math.min(...polygon.map((a,i)=>distancePointToSegment2D(p,a,polygon[(i+1)%polygon.length])));
        const radius=Number((plan.operations||[]).find(o=>o.id===path.operationId)?.toolDiameter || 6)/2;
        if(edgeDistance<radius) issues.push({level:"warning",code:"TOOL_RADIUS_EDGE",message:"Радиус инструмента приближается к краю детали.",operation:path.operationId});
      }
    }
  });
  return issues;
}

function validatePocketGeometry(plan, part) {
  const issues=[];
  const contour=part.userData?.ifcContour?.path;
  if(!Array.isArray(contour)||contour.length<3) return issues;
  const polygon=contour.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0}));
  (plan.operations||[]).filter(o=>classifyCncGeometryOperation(o)==="POCKET").forEach(op=>{
    if(!polygonConvexity(polygon)) {
      issues.push({level:"error",code:"POCKET_NON_CONVEX_UNSUPPORTED",message:"Pocket с невыпуклым IFC-контуром заблокирован: требуется полноценный polygon offset.",operation:op.id});
      return;
    }
    const tool=Number(op.toolDiameter||op.diameter||6), radius=tool/2;
    const paths=(plan.compensatedToolpaths||[]).filter(p=>p.operationId===op.id);
    if(!paths.length) {
      issues.push({level:"error",code:"POCKET_OFFSET_MISSING",message:"Не сформированы геометрические offset-проходы Pocket.",operation:op.id});
      return;
    }
    paths.forEach(path=>{
      const xy=path.points||[];
      if(xy.length<4 || !path.closed) issues.push({level:"error",code:"POCKET_NOT_CLOSED",message:"Offset-проход Pocket не замкнут.",operation:op.id});
      xy.forEach(p=>{
        if(!pointInPolygon2D(p,polygon)) issues.push({level:"error",code:"POCKET_OFFSET_OUTSIDE",message:"Центр инструмента Pocket выходит за исходную геометрию.",operation:op.id});
        const edge=Math.min(...polygon.map((a,i)=>distancePointToSegment2D(p,a,polygon[(i+1)%polygon.length])));
        if(edge+0.001<radius) issues.push({level:"error",code:"POCKET_TOOL_CLEARANCE",message:"Недостаточный зазор радиуса фрезы у Pocket.",operation:op.id});
      });
    });
  });
  return issues;
}

function validateCncPassPlan(plan) {
  const issues=[];
  (plan.toolpaths||[]).forEach(path=>{
    const op=(plan.operations||[]).find(o=>o.id===path.operationId);
    if(!op) return;
    const depth=Math.abs(Number(op.depth)||0);
    const zLevels=Array.isArray(path.zLevels)?path.zLevels:[];
    if(depth>0 && !zLevels.length) issues.push({level:"error",code:"PASS_LEVELS_MISSING",message:"Не сформированы проходы по глубине.",operation:path.operationId});
    if(zLevels.length && Math.abs(Math.abs(zLevels[zLevels.length-1])-depth)>0.001)
      issues.push({level:"error",code:"PASS_FINAL_DEPTH",message:"Последний проход не достигает заданной глубины.",operation:path.operationId});
    if((path.type==="CONTOUR") && path.points.length>1) {
      const contour=path.points.filter(p=>Number(p.z)<=(Number(plan.machineSetup?.safeZ)||5)+0.001);
      if(contour.length>=2) {
        const first=contour[0], last=contour[contour.length-1];
        if(first.x!==last.x || first.y!==last.y)
          issues.push({level:"error",code:"PASS_CONTOUR_NOT_CLOSED",message:"Контурная траектория не замкнута.",operation:path.operationId});
      }
    }
    if(path.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z)))
      issues.push({level:"error",code:"PASS_COORDINATES","message":"Некорректные координаты прохода.",operation:path.operationId});
  });
  return issues;
}

function validateTypedCompensatedToolpaths(plan) {
  const issues=[];
  (plan.compensatedToolpaths||[]).forEach(path=>{
    if(path.type==="POCKET" && path.points.length<4)
      issues.push({level:"error",code:"POCKET_PATH",message:"Pocket содержит недостаточно точек.",operation:path.operationId});
    if((path.type==="CONTOUR" || path.type==="INNER_CONTOUR" || path.type==="OUTER_CONTOUR") && path.points.length<3)
      issues.push({level:"error",code:"CONTOUR_PATH",message:"Контурная траектория содержит недостаточно точек.",operation:path.operationId});
  });
  return issues;
}

function validateCncToolpaths(plan) {
  const issues=[];
  const thickness=Number(plan.thickness)||0;
  const safeZ=Number(plan.machineSetup?.safeZ);
  buildCncToolpaths(plan).forEach(path=>{
    if(!path.points.length) {
      issues.push({level:"error",code:"TOOLPATH_EMPTY",message:"Пустая траектория.",operation:path.operationId});
      return;
    }
    path.points.forEach((p,i)=>{
      if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z))
        issues.push({level:"error",code:"TOOLPATH_COORD",message:"Некорректная координата траектории.",operation:path.operationId});
      if(p.z>safeZ+0.001)
        issues.push({level:"error",code:"TOOLPATH_SAFE_Z",message:"Точка траектории выше допустимого Безопасная высота Z.",operation:path.operationId});
      if(p.z<-(thickness+0.001))
        issues.push({level:"error",code:"TOOLPATH_DEPTH",message:"Траектория выходит за толщину детали.",operation:path.operationId});
    });
    if(path.type==="CONTOUR" && path.points.length<3)
      issues.push({level:"error",code:"TOOLPATH_CONTOUR",message:"Контур содержит недостаточно точек.",operation:path.operationId});
  });
  return issues;
}

function validateCncMotionSafety(plan) {
  const issues=[];
  const safeZ=Number(plan.machineSetup?.safeZ ?? readCncMachineSetup().safeZ);
  let previous=null;
  (plan.operations||[]).forEach((op,index)=>{
    const x=Number(op.x), y=Number(op.y), z=Number(op.z);
    if(["DRILL","MILL","POCKET","CONTOUR"].includes(op.type)) {
      if(!Number.isFinite(x)||!Number.isFinite(y)) issues.push({level:"error",code:"MOTION_XY",message:"Некорректные XY координаты.",operation:op.id});
      if(op.type!=="CONTOUR" && !Number.isFinite(Number(op.depth))) issues.push({level:"error",code:"MOTION_DEPTH",message:"Не задана глубина операции.",operation:op.id});
      if(Number(op.depth)>Number(plan.thickness)) issues.push({level:"error",code:"MOTION_OVERDEPTH",message:"Глубина превышает толщину детали.",operation:op.id});
    }
    if(previous) {
      const changedTool=previous.toolId!==op.toolId;
      if(changedTool && safeZ<=0) issues.push({level:"error",code:"MOTION_TOOLCHANGE_Z",message:"Смена инструмента невозможна без положительного Безопасная высота Z.",operation:op.id});
    }
    previous=op;
  });
  (plan.toolTechnology||[]).forEach(group=>{
    const p=group.operations||[];
    p.forEach(op=>{
      const params=op.technologyParameters;
      if(params && params.passDepth<=0) issues.push({level:"error",code:"MOTION_PASS",message:"Некорректная глубина прохода.",operation:op.id});
      if(params && params.passes<1) issues.push({level:"error",code:"MOTION_PASSES",message:"Некорректное количество проходов.",operation:op.id});
    });
  });
  return issues;
}

function validateToolChangeSequence(plan) {
  const issues=[];
  const seen=new Set();
  buildCncToolChangeSequence(plan).forEach(group=>{
    if(seen.has(group.toolId)) issues.push({level:"error",code:"TOOL_SEQUENCE_DUPLICATE",message:"Дублируется группа инструмента "+group.toolId});
    seen.add(group.toolId);
    if(!group.toolId || group.toolId==="NONE") issues.push({level:"error",code:"TOOL_SEQUENCE_MISSING",message:"Операции без назначенного инструмента."});
    if(!Number.isFinite(Number(group.rpm)) || Number(group.rpm)<=0) issues.push({level:"error",code:"TOOL_RPM",message:"Некорректные обороты.",operation:group.firstOperation});
    if(!Number.isFinite(Number(group.feed)) || Number(group.feed)<=0) issues.push({level:"error",code:"TOOL_FEED",message:"Некорректная подача.",operation:group.firstOperation});
  });
  return issues;
}

function buildCncToolTechnologyPlan(plan) {
  const groups=[];
  (plan.operations||[]).forEach(op=>{
    const tool=CNC_TOOL_LIBRARY.find(t=>t.id===op.toolId);
    const parameters=resolveCncCuttingParameters(op,tool,plan.material,plan.thickness);
    let group=groups.find(g=>g.toolId===op.toolId);
    if(!group) {
      group={toolId:op.toolId||"NONE",toolName:tool?.name||"Не назначен",toolDiameter:tool?.diameter||null,
        materialFamily:parameters.materialFamily,rpm:parameters.rpm,feed:parameters.feed,plunge:parameters.plunge,
        safeZ:parameters.safeZ,operations:[]};
      groups.push(group);
    }
    group.operations.push({...op,technologyParameters:parameters});
  });
  return groups;
}

function validateMachineCompatibility(plan, post=getPostprocessor()) {
  const issues=[];
  const setup=plan.machineSetup || readCncMachineSetup();
  const safeZ=Number(setup.safeZ);
  if(!Number.isFinite(safeZ) || safeZ<=0) issues.push({level:"error",code:"MACHINE_SAFE_Z",message:"Некорректный Безопасная высота Z."});
  if(!setup.origin) issues.push({level:"error",code:"MACHINE_ORIGIN",message:"Не задана нулевая точка станка."});
  if(!post || !post.name) issues.push({level:"error",code:"POSTPROCESSOR_MISSING",message:"Постпроцессор не выбран."});
  if(post && post.safeZ!==undefined && Number(post.safeZ)>safeZ)
    issues.push({level:"error",code:"POST_SAFE_Z",message:"Безопасная высота Z постпроцессора превышает настройку станка."});
  (plan.operations||[]).forEach(op=>{
    const toolId=op.toolId;
    const tool=toolId && CNC_TOOL_LIBRARY.find(t=>t.id===toolId);
    if(!tool) issues.push({level:"error",code:"MACHINE_TOOL",message:"Инструмент не найден в библиотеке: "+(toolId||"NONE"),operation:op.id});
    if(op.depth!=null && Number(op.depth)>Number(plan.thickness||0))
      issues.push({level:"error",code:"MACHINE_DEPTH",message:"Глубина операции превышает толщину детали.",operation:op.id});
    if(op.diameter!=null && tool && Number(op.diameter)>Number(tool.diameter)+0.001)
      issues.push({level:"error",code:"MACHINE_DIAMETER",message:"Диаметр операции превышает диаметр выбранного инструмента.",operation:op.id});
  });
  const generic=post.name==="Universal G-code";
  return {postprocessor:post.name,postprocessorStatus:generic?"generic":"template-unvalidated",issues,machineReady:issues.length===0};
}

function validateCompiledManufacturingPlan(plan) {
  const issues=[];
  const ops=plan.operations || [];
  const journal=plan.operationJournal || [];
  const seen=new Set();
  ops.forEach((op,i)=>{
    if(!op.id) issues.push({level:"error",code:"PLAN_OP_ID",message:"Операция без ID.",operation:i+1});
    else if(seen.has(op.id)) issues.push({level:"error",code:"PLAN_DUPLICATE_ID",message:"Дублируется ID операции "+op.id,operation:op.id});
    else seen.add(op.id);
  });
  const journalIds=new Set(journal.map(x=>x.id));
  ops.forEach(op=>{
    if(!journalIds.has(op.id)) issues.push({level:"error",code:"PLAN_JOURNAL_LINK",message:"Операция отсутствует в Journal: "+op.id,operation:op.id});
  });
  journal.forEach(op=>{
    if(!seen.has(op.id)) issues.push({level:"error",code:"PLAN_ORPHAN_JOURNAL",message:"Journal содержит неизвестную операцию: "+op.id,operation:op.id});
    if(op.tool && op.tool.id && !op.tool.name) issues.push({level:"error",code:"PLAN_TOOL_META",message:"У инструмента нет имени: "+op.tool.id,operation:op.id});
  });
  const lifecycle=plan.lifecycle || [];
  lifecycle.forEach(item=>{
    if(!seen.has(item.operationId)) issues.push({level:"error",code:"PLAN_LIFECYCLE_LINK",message:"Lifecycle не связан с операцией: "+item.operationId,operation:item.operationId});
  });
  if(plan.status==="READY" && issues.some(x=>x.level==="error")) {
    issues.push({level:"error",code:"PLAN_STATUS_CONFLICT",message:"Plan помечен READY, но содержит ошибки."});
  }
  return issues;
}

function getCompiledManufacturingPlan(part) {
  if(!part.userData) part.userData={};
  const plan=compileManufacturingPlan(part);
  plan.compiledAt=new Date().toISOString();
  plan.validation=validateCompiledManufacturingPlan(plan);
  plan.machineCompatibility=validateMachineCompatibility(plan);
  plan.motionSafety=validateCncMotionSafety(plan);
  plan.compensatedToolpaths=buildTypedCompensatedToolpaths(plan,part);
  plan.toolpaths=buildCncToolpaths(plan);
  plan.compiledToolpathProgram=buildCompiledToolpathProgram(plan,part);
  plan.compiledToolpathProgram=optimizeCompiledToolpathSequence(plan.compiledToolpathProgram,plan);\n  plan.toolpathSequenceValidation=validateCompiledToolpathSequence(plan);
  plan.compiledToolpathTechnologyValidation=validateCompiledToolpathTechnology(plan);
  plan.toolpathValidation=validateCncToolpaths(plan);
  plan.toolpathGeometryEnvelope=buildToolpathGeometryEnvelope(plan,part);
  plan.geometryToolpathValidation=validateToolpathAgainstGeometry(plan,part);
  plan.segmentToolpathValidation=validateToolpathSegmentsAgainstGeometry(plan,part);
  plan.toolRadiusCompensation=validateToolRadiusCompensation(plan,part);
  plan.toolpathClearance=validateToolpathClearance(plan,part);
  plan.typedToolpathValidation=validateTypedCompensatedToolpaths(plan);
  plan.passPlanValidation=validateCncPassPlan(plan);
  plan.pocketGeometryValidation=validatePocketGeometry(plan,part);
  plan.contourCompensationValidation=validateContourCompensationGeometry(plan,part);
  plan.contourWidthValidation=validateContourMinimumWidth(plan,part);
  plan.toolpathCollisionValidation=validateToolpathCollisions(plan,part);
  plan.validation=[...plan.validation,...plan.toolChangeValidation,...plan.motionSafety,...plan.toolpathValidation,...plan.geometryToolpathValidation,...plan.segmentToolpathValidation,...plan.toolRadiusCompensation,...plan.toolpathClearance,...plan.typedToolpathValidation,...plan.passPlanValidation,...plan.pocketGeometryValidation,...plan.contourCompensationValidation,...plan.contourWidthValidation,...plan.toolpathCollisionValidation,...plan.toolpathSequenceValidation,...plan.compiledToolpathTechnologyValidation,...plan.technologyGroupValidation];
  plan.machineReady=plan.validation.every(x=>x.level!=="error") && plan.status==="READY" && plan.lifecycle.every(x=>x.valid) && plan.machineCompatibility.machineReady;
  plan.status=plan.machineReady ? "MACHINE_READY" : (plan.status==="BLOCKED" ? "BLOCKED" : "REVIEW");
  return plan;
}
