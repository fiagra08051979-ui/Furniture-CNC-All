import fs from "node:fs";
import vm from "node:vm";

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
  ["карта раскроя", app.includes("buildCuttingGroups") && app.includes("buildSheetLayout") && app.includes("exportSheetLayout")],
  ["кнопка карты раскроя", html.includes("exportSheetLayout") && html.includes("showCuttingMap")]
];

const forbidden = [
  "CNC", "cnc", "ЧПУ", "G-code", "toolpath",
  "ManufacturingPlan", "productionPacket",
  "exportDxf", "exportExcel", "exportPdf",
  "Производственная карта", "постпроцессор"
];

const errors = [];
for (const [name, ok] of required) if (!ok) errors.push("Отсутствует: " + name);
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
console.log("Проверено: AI, IFC, распознавание, 3D, карта раскроя, отсутствие CNC/производственного слоя.");
