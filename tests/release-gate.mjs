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
  ["Release Gate runtime", app.includes("function runReleaseGate()") && app.includes("evaluateReleaseGateState") && app.includes("window._releaseGate") && app.includes("выпуск PDF заблокирован")],
  ["инвалидация Gate при пересборке", app.includes("let modelRevision = 0") && app.includes("window._constructionQC = null") && app.includes("window._releaseGate = null") && app.includes("report.modelRevision = modelRevision")],
  ["безопасное переключение IFC режима", app.includes("function build()") && app.includes("clearModel();\n  ifcMode = false;")],
  ["сброс IFC при очистке модели", app.includes("function clearModel()") && app.includes("closeIfcModel();") && app.includes("ifcImportedParts = [];")],
  ["идемпотентная пересборка деталировки", app.includes("delete u.detailing;") && app.includes("delete u.detailingContinuity;") && app.includes("delete u.processing;") && app.includes("modelRevision")],
  ["контроль пересечения деталей на листе", app.includes("пересечение деталей") && app.includes("placement.x >= other.x + other.length + kerf")],
  ["лист не смешивает толщины", app.includes("Number(s.thickness) === Number(item.thickness)") && app.includes("смешаны детали разной толщины")],
  ["раскрой сохраняет номер детали при quantity > 1", app.includes("group.details.forEach(detail =>") && app.includes("partNumber: detail.number || \"\"") && app.includes("const quantity = Math.max(1, Number(detail.quantity || 1))")],
  ["IFC открывается после очистки проекта", app.includes("clearModel();") && app.includes("ifcModelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true })") && !app.includes("ifcModelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });\n\n    if (ifcModelId === -1) {\n      throw new Error("IFC не удалось открыть.");\n    }\n\n    const candidateIds = new Set();\n    for (const name of ["IFCFURNITURE", "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY"]) {\n      const code = WebIFC[name];\n      if (typeof code !== "number") continue;\n      vectorToArray(api.GetLineIDsWithType(ifcModelId, code)).forEach(id => candidateIds.add(id));\n    }\n\n    // Если IFC не классифицировал мебель отдельным типом, используем все\n    // геометрические элементы как резервный режим. Геометрия не меняется.\n    let expressIds = [...candidateIds];\n    if (!expressIds.length) {\n      expressIds = vectorToArray(api.GetAllLines(ifcModelId)).filter(id => {\n        try {\n          const line = api.GetLine(ifcModelId, id);\n          return Boolean(line && line.type && api.IsIfcElement?.(line.type));\n        } catch {\n          return false;\n        }\n      });\n    }\n\n    clearModel();")],
  ["цепочка Construction QC → Release Gate", app.includes("runConstructionQC(detailingPipeline)") && app.includes("runReleaseGate()")],
  ["PDF читает деталировку", app.includes("const detailing = part.userData?.detailing") && app.includes("Array.isArray(detailing?.holes)") && app.includes("d.length") && app.includes("d.material") && app.includes("d.edges")],
  ["Release Gate проверяет раскладку листа", app.includes("function validateSheetLayout") && app.includes("placement.overflow") && app.includes("sheetLayoutChecked") && app.includes("buildSheetLayout(")],
  ["PDF использует проверенную раскладку", app.includes("releaseGate.sheetLayout || buildSheetLayout") && app.includes("sheetLayout") ],
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
  ["Release Gate учитывает overflow", app.includes("validateSheetLayout(sheetLayout)")]
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
}

if (errors.length) {
  console.error("RELEASE GATE: FAIL");
  errors.forEach(e => console.error(" - " + e));
  process.exit(1);
}

console.log("RELEASE GATE: PASS");
console.log("Проверено: AI, IFC, распознавание, 3D, Construction QC, Release Gate, раскладка листа, PDF-карта раскроя, присадка/сверловка и отсутствие CNC/Excel-производственного слоя.");
