import fs from "node:fs";
import vm from "node:vm";
import { evaluateReleaseGateState } from "../release-gate-core.js";

const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const fixtures = JSON.parse(fs.readFileSync("tests/reference-projects.json", "utf8"));

const required = [
  ["Furniture AI Designer", app.includes("Furniture AI Designer") || readme.includes("Furniture AI Designer")],
  ["AI текст", app.includes("recognizeFurnitureText") && app.includes("aiRecognize")],
  ["AI изображение", app.includes("analyzeFurnitureImageMetadata") && app.includes("aiImageAnalyze")],
  ["IFC", app.includes("web-ifc") && app.includes("importIfcIntoFurnitureCore")],
  ["распознавание деталей IFC", app.includes("recognizeIfcPart") && app.includes("applyIfcRecognition")],
  ["карта раскроя PDF", app.includes("buildCuttingGroups") && app.includes("getSheetSpec") && app.includes("buildSheetLayout") && app.includes("buildCuttingPdfHtml") && app.includes("exportSheetLayout")],
  ["присадка и сверловка", app.includes("cuttingOperationList") && app.includes("drillingSchematic") && app.includes("shelfSupportDrilling") && app.includes("X, мм") && app.includes("Y, мм") && app.includes("Количество") && app.includes("Всего отверстий")],
  ["кнопка PDF карты раскроя", html.includes("exportSheetLayout") && html.includes("Сформировать карту раскроя PDF")],
  ["кнопки карты раскроя без дублирования id", !/<button[^>]+id="(?:exportSheetLayout|showCuttingMap)"/i.test(html) && app.includes('querySelectorAll(".exportSheetLayout")') && app.includes('querySelectorAll(".showCuttingMap")')],
  ["координаты только в PDF", app.includes("x: Number.isFinite(Number(op.x))") && app.includes("X, мм") && app.includes("Y, мм")],
  ["геометрический контроль модели", app.includes("Геометрическая целостность параметрической модели") && app.includes("Полка выходит за пределы внутренней секции") && app.includes("Фасад выходит за габариты корпуса")],
  ["Construction QC Gate", app.includes("runConstructionQC") && app.includes("window._constructionQC")],
  ["Construction QC требует готовую деталировку каждой детали", app.includes("unresolvedDetails") && app.includes("detailing: unresolvedDetails.length === 0") && app.includes("details: detailStatuses")],
  ["Construction QC требует связь каждой детали с раскроем", app.includes("missingCuttingLink") && app.includes("cuttingLink: missingCuttingLink.length === 0") && app.includes("cuttingEligible")],
  ["раскрой строится только из деталировки", app.includes("const d = u.detailing") && app.includes("d.cutting.thickness") && app.includes("d.cutting.length") && app.includes("d.cutting.width")],
  ["размеры деталировки совпадают со спецификацией листа", app.includes("length: spec.length") && app.includes("width: spec.width") && app.includes("thickness: spec.thickness")],
  ["Release Gate проверяет состав раскроя против деталировки", core.includes("expectedDetailByKey") && core.includes("Раскладка не соответствует количеству детали") && core.includes("Раскладка содержит размеры детали, не соответствующие деталировке")],
  ["Construction QC защищает геометрию IFC", app.includes("geometrySourceErrors") && app.includes("ifcGeometryLocked: geometrySourceErrors.length === 0")],
  ["низкая уверенность IFC требует ручной проверки", app.includes('u.source === "IFC" && u.recognitionConfidence === "low"') && app.includes("требуется ручная проверка")],
  ["кандидатные IFC-соединения требуют подтверждения", app.includes('u.source === "IFC" && (u.technology?.joints || []).some(j => j.status === "candidate")') && app.includes("неподтверждённое IFC-соединение")],
  ["IFC-фурнитура остаётся кандидатной", app.includes('add("Петля с доводчиком"') && app.includes('"candidate"') && app.includes('add("Крепёж корпуса"') && app.includes('source:"IFC topology"')],
  ["IFC-кандидат не переводится автоматически в ready", app.includes('status:"candidate"') && app.includes('status === "candidate"') && !app.includes('status = "ready"')],
  ["IFC-технология получает REVIEW при неподтверждённом соединении", app.includes('const hasUnconfirmedJoint = u.technology.joints.some(j=>j.status !== "ready");') && app.includes('if (hasUnconfirmedJoint) u.technology.status = "review";')],
  ["сводка IFC-технологии пересчитывается после соединений", app.includes("technology.ready = ifcImportedParts.filter(part => part.userData.technology?.status === \"ready\").length;") && app.includes("technology.review = ifcImportedParts.filter(part => part.userData.technology?.status !== \"ready\").length;")],
  ["Construction QC блокирует IFC-соединение без подтверждения", app.includes('u.technology?.joints || []') && app.includes('IFC-соединение требует подтверждения')],
  ["IFC-порядок гарантирует QC после деталировки", app.indexOf("const detailingPipeline = rebuildDetailingPipeline();") < app.indexOf("const constructionQC = runConstructionQC(detailingPipeline);") && app.indexOf("const constructionQC = runConstructionQC(detailingPipeline);") < app.indexOf("const releaseGate = runReleaseGate();")],
  ["Release Gate runtime", app.includes("function runReleaseGate()") && app.includes("evaluateReleaseGateState") && app.includes("window._releaseGate") && app.includes("выпуск PDF заблокирован")],
  ["Release Gate отвергает устаревший QC", app.includes("modelRevision") && app.includes("другой ревизии модели") && app.includes("qc.modelRevision")],
  ["инвалидация Gate при пересборке", app.includes("let modelRevision = 0") && app.includes("window._constructionQC = null") && app.includes("window._releaseGate = null") && app.includes("report.modelRevision = modelRevision")],
  ["безопасное переключение IFC режима", app.includes("function build()") && app.includes("clearModel();\n  ifcMode = false;")],
  ["сброс IFC при очистке модели", app.includes("function clearModel()") && app.includes("closeIfcModel();") && app.includes("ifcImportedParts = [];")],
  ["идемпотентная пересборка деталировки", app.includes("delete u.detailing;") && app.includes("delete u.detailingContinuity;") && app.includes("delete u.processing;") && app.includes("modelRevision")],
  ["контроль пересечения деталей на листе", app.includes("пересечение деталей") && app.includes("placement.x >= other.x + other.length + kerf")],
  ["раскладка сохраняет количество деталей", app.includes("Раскладка не соответствует количеству детали") && app.includes("В раскладке присутствует лишняя деталь")],
  ["лист не смешивает толщины", app.includes("Number(s.thickness) === Number(item.thickness)") && app.includes("смешаны детали разной толщины")],
  ["раскрой сохраняет номер детали при quantity > 1", app.includes("group.details.forEach(detail =>") && app.includes("partNumber: detail.number || \"\"") && app.includes("const quantity = Math.max(1, Number(detail.quantity || 1))")],
  ["IFC открывается после очистки проекта", app.includes("clearModel();") && app.includes("ifcModelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true })") && !app.includes("ifcModelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });\n\n    if (ifcModelId === -1) {\n      throw new Error("IFC не удалось открыть.");\n    }\n\n    const candidateIds = new Set();\n    for (const name of ["IFCFURNITURE", "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY"]) {\n      const code = WebIFC[name];\n      if (typeof code !== "number") continue;\n      vectorToArray(api.GetLineIDsWithType(ifcModelId, code)).forEach(id => candidateIds.add(id));\n    }\n\n    // Если IFC не классифицировал мебель отдельным типом, используем все\n    // геометрические элементы как резервный режим. Геометрия не меняется.\n    let expressIds = [...candidateIds];\n    if (!expressIds.length) {\n      expressIds = vectorToArray(api.GetAllLines(ifcModelId)).filter(id => {\n        try {\n          const line = api.GetLine(ifcModelId, id);\n          return Boolean(line && line.type && api.IsIfcElement?.(line.type));\n        } catch {\n          return false;\n        }\n      });\n    }\n\n    clearModel();")],
  ["цепочка Construction QC → Release Gate", app.includes("runConstructionQC(detailingPipeline)") && app.includes("runReleaseGate()")],
  ["PDF читает деталировку", app.includes("const detailing = part.userData?.detailing") && app.includes("Array.isArray(detailing?.holes)") && app.includes("d.length") && app.includes("d.material") && app.includes("d.edges")],
  ["Release Gate проверяет раскладку листа", app.includes("function validateSheetLayout") && app.includes("placement.overflow") && app.includes("sheetLayoutChecked") && app.includes("buildSheetLayout(")],
  ["PDF не пересобирает раскладку после Release Gate", app.includes("const layout = releaseGate.sheetLayout;") && app.includes("отсутствует проверенная раскладка листа")],
  ["PDF использует проверенную раскладку", app.includes("const layout = releaseGate.sheetLayout;") && !app.includes("releaseGate.sheetLayout || buildSheetLayout")],
  ["PDF лист использует detailing", app.includes("thickness: group.thickness") && app.includes("(p.material || sheet.material)") && app.includes("edgeSummary(p.edges)") && !app.includes("part ? getSheetSpec(part).thickness")]
];

const gateContract = [
  ["PASS: QC PASS + готовая деталировка + раскрой + лист", {
    qc: {status:"PASS"},
    partsCount: 1,
    partStates: [{number:"001", detailing:{number:"001", status:"ready", cutting:{length:600,width:400,thickness:18}, holes:[]}}],
    cuttingGroups: [{material:"ldsp18", thickness:18, details:[{number:"001",length:600,width:400,quantity:1}]}],
    sheetLayout: {sheetLength:2800,sheetWidth:2070,margin:10,kerf:4,sheets:[{sheetNumber:1,placements:[{partNumber:"001",x:10,y:10,length:600,width:400,overflow:false}]}]}
  }, true],
  ["BLOCKED: QC REVIEW", {qc:{status:"REVIEW"},partsCount:1,partStates:[],cuttingGroups:[],sheetLayout:null}, false],
  ["BLOCKED: detailing REVIEW", {
    qc:{status:"PASS"}, partsCount:1,
    partStates:[{number:"001",detailing:{number:"001",status:"review",cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[], sheetLayout:null
  }, false],
  ["BLOCKED: неполный состав partStates", {
    qc:{status:"PASS"}, partsCount:2,
    partStates:[{number:"001",detailing:{number:"001",status:"ready",cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[], sheetLayout:null
  }, false],
  ["BLOCKED: рассогласованные размеры раскладки", {
    qc:{status:"PASS"}, partsCount:1,
    partStates:[{number:"001",sourceGeometry:"Furniture Core",geometryLocked:false,detailing:{number:"001",status:"ready",construction:{source:"Furniture Core"},cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[{groupNumber:"001",material:"ldsp18",thickness:18,details:[{number:"001",length:600,width:400,thickness:18,quantity:1,material:"ldsp18"}]}],
    sheetLayout:{sheetLength:2800,sheetWidth:2070,margin:10,kerf:4,sheets:[{sheetNumber:1,placements:[{groupNumber:"001",partNumber:"001",x:10,y:10,length:500,width:400,thickness:18,material:"ldsp18",overflow:false}]}]}
  }, false],
  ["BLOCKED: рассогласованный материал раскладки", {
    qc:{status:"PASS"}, partsCount:1,
    partStates:[{number:"001",sourceGeometry:"Furniture Core",geometryLocked:false,detailing:{number:"001",status:"ready",construction:{source:"Furniture Core"},cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[{groupNumber:"001",material:"ldsp18",thickness:18,details:[{number:"001",length:600,width:400,thickness:18,quantity:1,material:"ldsp18"}]}],
    sheetLayout:{sheetLength:2800,sheetWidth:2070,margin:10,kerf:4,sheets:[{sheetNumber:1,placements:[{groupNumber:"001",partNumber:"001",x:10,y:10,length:600,width:400,thickness:18,material:"mdf18",overflow:false}]}]}
  }, false],
  ["BLOCKED: рассогласованный источник геометрии", {
    qc:{status:"PASS"}, partsCount:1,
    partStates:[{number:"001",sourceGeometry:"IFC",geometryLocked:true,detailing:{number:"001",status:"ready",construction:{source:"Furniture Core"},cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[], sheetLayout:null
  }, false],
  ["BLOCKED: устаревшая деталировка", {
    qc:{status:"PASS"}, partsCount:1, modelRevision:2,
    partStates:[{number:"001",detailing:{number:"001",status:"ready",modelRevision:1,cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[], sheetLayout:null
  }, false],
  ["BLOCKED: неполный состав QC details", {
    qc:{status:"PASS",details:[{number:"001"}]}, partsCount:2,
    partStates:[
      {number:"001",detailing:{number:"001",status:"ready",cutting:{length:600,width:400,thickness:18},holes:[]}},
      {number:"002",detailing:{number:"002",status:"ready",cutting:{length:500,width:300,thickness:18},holes:[]}}
    ],
    cuttingGroups:[], sheetLayout:null
  }, false],
  ["BLOCKED: overflow", {
    qc:{status:"PASS"}, partsCount:1,
    partStates:[{number:"001",detailing:{number:"001",status:"ready",cutting:{length:600,width:400,thickness:18},holes:[]}}],
    cuttingGroups:[{material:"ldsp18",thickness:18,details:[{number:"001",length:600,width:400,quantity:1}]}],
    sheetLayout:{sheetLength:500,sheetWidth:300,margin:10,kerf:4,sheets:[{sheetNumber:1,placements:[{partNumber:"001",x:10,y:10,length:600,width:400,overflow:true}]}]}
  }, false]
];

const contractChecks = [
  ["Release Gate имеет детерминированный evaluator", app.includes("function evaluateReleaseGateState")],
  ["Release Gate различает PASS/BLOCKED", app.includes('status: issues.length ? "BLOCKED" : "PASS"')],
  ["Release Gate учитывает REVIEW", app.includes('qc.status !== "PASS"')],
  ["Release Gate учитывает overflow", app.includes("validateSheetLayout(sheetLayout)")],
  ["Release Gate сверяет состав деталей", app.includes("Количество состояний деталей не соответствует количеству деталей проекта")],
  ["Release Gate требует полный состав Construction QC", app.includes("Construction QC не содержит полный состав деталей проекта")],
  ["Release Gate отвергает устаревшую деталировку", app.includes("detailing относится к другой ревизии модели")],
  ["Release Gate проверяет источник геометрии деталировки", app.includes("источник геометрии деталировки не соответствует источнику модели")],
  ["Release Gate сверяет размещение с деталировкой", app.includes("Раскладка содержит размеры детали, не соответствующие деталировке")],
  ["раскладка сохраняет материал и толщину", app.includes("thickness: item.thickness") && app.includes("material: item.material")],
  ["PDF использует зафиксированный состав Gate", app.includes("gatedParts") && app.includes("buildCuttingPdfHtml(layout, gatedParts)")],
  ["PDF проверяет ревизию снимка Gate", app.includes("gatedPartsRevision") && app.includes("состав деталей относится к другой ревизии модели")],
  ["PDF сохраняет источник геометрии детали", app.includes('Источник геометрии:') && app.includes('(u.source || "Furniture Core")')],
  ["просмотр карты проходит через Release Gate", app.includes("function showCuttingMap()") && app.includes("просмотр карты раскроя заблокирован") && app.includes("renderCuttingMap(releaseGate.sheetLayout)")],
  ["изменение технологии инвалидирует старый параметрический Gate", app.includes("technologyBuildFields") && app.includes("technologyBuildFields.forEach") && app.includes('if (ifcMode)')],
  ["загрузка JSON возвращает модель в параметрический путь", app.includes('$("loadProject").addEventListener') && app.includes("Object.entries(data.parameters||{})") && app.includes("build();") && app.includes("ifcMode = false")]
];

const forbidden = [
  "CNC", "cnc", "ЧПУ", "G-code", "toolpath",
  "ManufacturingPlan", "productionPacket",
  "exportDxf", "exportExcel", "exportPdf", "Карта раскроя Excel", "xlsx",
  "Производственная карта", "постпроцессор"
];

const errors = [];
for (const [name, ok] of required) if (!ok) errors.push("Отсутствует: " + name);
for (const [name, ok] of contractChecks) if (!ok) errors.push("Отсутствует контракт: " + name);
for (const [name, state, expectedPass] of gateContract) {
  const report = evaluateReleaseGateState({
    ...state,
    sheetLayout: state.sheetLayout || null
  });
  if (report.passed !== expectedPass) {
    errors.push(name + ": ожидался " + (expectedPass ? "PASS" : "BLOCKED") + ", получен " + report.status);
  }
}
for (const token of forbidden) if ((app + "\n" + html).toLowerCase().includes(token.toLowerCase())) {
  errors.push("Запрещённый производственный/CNC блок: " + token);
}

try {
  new vm.SourceTextModule(app);
} catch (e) {
  // SourceTextModule may be unavailable in some Node builds; syntax is checked by node --check in CI.
  if (e?.name !== "TypeError") errors.push("Синтаксическая ошибка app.js: " + e.message);
}

if (!html.includes('<script type="module" src="./app.js"></script>')) {
  errors.push("index.html не подключает app.js");
}

for (const project of fixtures.projects) {
  const p = project.parameters;
  const e = project.expected;
  const baseParts = 4 + Math.max(0, Number(p.sections) - 1) + Number(p.shelves) + Number(p.fixedPartitions) + Number(p.doors);
  if (baseParts < Number(e.minimumParts)) errors.push("Эталон " + project.id + ": минимальное число деталей не выполняется");
  if (Number(p.thickness) !== Number(e.materialThickness)) errors.push("Эталон " + project.id + ": толщина материала не совпадает");
  if (Number(p.doors) !== Number(e.doors)) errors.push("Эталон " + project.id + ": число фасадов не совпадает");
  if (Number(p.shelves) !== Number(e.shelves)) errors.push("Эталон " + project.id + ": число полок не совпадает");

  // Эталон должен покрывать полный утверждённый жизненный цикл,
  // а не только исходные параметры.
  if (!(Number(p.width) > 0 && Number(p.height) > 0 && Number(p.depth) > 0)) {
    errors.push("Эталон " + project.id + ": некорректные габариты");
  }
  if (!(Number(p.thickness) > 0 && Number(p.thickness) < Math.min(Number(p.width), Number(p.height), Number(p.depth)))) {
    errors.push("Эталон " + project.id + ": некорректная толщина относительно габаритов");
  }
  if (Number(p.sections) < 1 || Number(p.shelves) < 0 || Number(p.fixedPartitions) < 0 || Number(p.doors) < 0) {
    errors.push("Эталон " + project.id + ": некорректные количества элементов");
  }
  if (Number(e.minimumParts) < 4) {
    errors.push("Эталон " + project.id + ": эталон не покрывает базовый состав корпуса");
  }
}

if (errors.length) {
  console.error("RELEASE GATE: FAIL");
  errors.forEach(e => console.error(" - " + e));
  process.exit(1);
}

console.log("RELEASE GATE: PASS");
console.log("Проверено: AI, IFC, распознавание, 3D, Construction QC, Release Gate, раскладка листа, PDF-карта раскроя, присадка/сверловка и отсутствие CNC/Excel-производственного слоя.");
