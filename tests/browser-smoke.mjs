import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on("pageerror", error => errors.push("PAGEERROR: " + error.message));
page.on("console", message => {
  if (message.type() === "error") errors.push("CONSOLE: " + message.text());
});

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle", timeout: 60000 });

await page.locator("#build").click();
await page.waitForTimeout(1500);

const count = Number(await page.locator("#partsCount").textContent());
if (!(count > 0)) throw new Error("После построения не появились детали.");

const gateBeforeInterior = await page.evaluate(() => ({
  status: window._releaseGate?.status || null,
  passed: window._releaseGate?.passed === true,
  modelRevision: window._releaseGate?.modelRevision ?? null
}));
if (!gateBeforeInterior.passed || gateBeforeInterior.status !== "PASS") {
  throw new Error("Визуализация интерьера запущена без успешного Release Gate: " + JSON.stringify(gateBeforeInterior));
}

await page.locator("#explode").click();
await page.locator("#resetExplode").click();
await page.locator("#frontView").click();
await page.locator("#isoView").click();
await page.locator("#interiorView").click();
await page.waitForTimeout(500);

const interiorStatus = await page.locator("#validation").textContent();
if (!interiorStatus.includes("Мебель вписана в интерьер")) {
  throw new Error("Визуализация интерьера не подтвердила успешное выполнение.");
}

await page.locator("#aiPrompt").fill("Сделай шкаф 2400x2200x600, 3 секции, 6 полок и 3 фасада, ЛДСП 18 мм");
await page.locator("#aiRecognize").click();
await page.waitForTimeout(300);
await page.locator("#aiApply").click();
await page.waitForTimeout(1000);

const aiCount = Number(await page.locator("#partsCount").textContent());
if (!(aiCount > 0)) throw new Error("AI text не построил параметрическую модель.");

const aiImageSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="260"><rect width="320" height="260" fill="white"/><rect x="40" y="30" width="240" height="200" fill="none" stroke="black" stroke-width="8"/><line x1="160" y1="30" x2="160" y2="230" stroke="black" stroke-width="8"/><line x1="40" y1="100" x2="280" y2="100" stroke="black" stroke-width="8"/><line x1="40" y1="170" x2="280" y2="170" stroke="black" stroke-width="8"/></svg>';
await page.locator("#aiImageFile").setInputFiles({name:"cabinet-test.svg",mimeType:"image/svg+xml",buffer:Buffer.from(aiImageSvg)});
await page.locator("#aiImageAnalyze").click();
await page.waitForSelector("#aiImageApply",{timeout:10000});
await page.locator("#aiImageApply").click();
await page.waitForTimeout(1000);
const aiImageStatus = await page.locator("#validation").textContent();
if (!aiImageStatus.includes("AI-распознавание изображения применено")) throw new Error("AI image не применил распознанную конструкцию.");

await page.locator("#ifcFile").setInputFiles("tests/fixtures/tableX.ifc");
await page.locator("#ifcImport").click();
await page.waitForTimeout(3000);
const ifcStatus = await page.locator("#ifcGeometry").textContent();
if (!ifcStatus.includes("Реальная IFC-геометрия")) throw new Error("IFC runtime импорт не сформировал реальную геометрию: " + ifcStatus);
const ifcObjects = await page.locator("#ifcProjectObjects").textContent();
if (!ifcObjects.includes("Распознано:")) throw new Error("IFC runtime не завершил распознавание деталей.");

const ifcValidation = await page.locator("#validation").textContent();
if (!ifcValidation.includes("IFC импортирован")) throw new Error("IFC runtime не завершил импорт: " + ifcValidation);

const ifcGeometryTextBeforeRefresh = await page.locator("#ifcGeometry").textContent();
const ifcPartsCountBeforeRefresh = Number(await page.locator("#partsCount").textContent());
const ifcRevisionBeforeRefresh = await page.evaluate(() => window._modelRevision);
if (!ifcGeometryTextBeforeRefresh.includes("Реальная IFC-геометрия") || !(ifcPartsCountBeforeRefresh > 0)) {
  throw new Error("После IFC импорта не подтверждена доступная реальная геометрия.");
}

await page.locator("#material").selectOption("mdf18");
await page.waitForTimeout(300);
for (const id of ["#edge1","#edge2","#edge3","#edge4"]) await page.locator(id).selectOption({label:"ABS 2 мм"});
await page.waitForTimeout(500);

const ifcGeometryTextAfterRefresh = await page.locator("#ifcGeometry").textContent();
const ifcPartsCountAfterRefresh = Number(await page.locator("#partsCount").textContent());
const ifcRevisionAfterRefresh = await page.evaluate(() => window._modelRevision);
if (!ifcGeometryTextAfterRefresh.includes("Реальная IFC-геометрия") ||
    ifcPartsCountAfterRefresh !== ifcPartsCountBeforeRefresh ||
    Number(ifcRevisionAfterRefresh) <= Number(ifcRevisionBeforeRefresh)) {
  throw new Error("Смена материала/кромки не сохранила IFC-геометрию или не обновила технологическую ревизию.");
}

await page.locator("#frontGapBetween").fill("2");
await page.locator("#width").fill("2400");
await page.locator("#height").fill("2200");
await page.locator("#depth").fill("600");
await page.locator("#sections").fill("3");
await page.locator("#shelves").fill("6");
await page.locator("#fixedPartitions").fill("0");
await page.locator("#doors").fill("3");
await page.locator("#build").click();
await page.waitForTimeout(1000);

await page.locator("#material").selectOption("mdf18");
await page.waitForTimeout(300);
for (const id of ["#edge1","#edge2","#edge3","#edge4"]) await page.locator(id).selectOption({label:"ABS 2 мм"});
await page.waitForTimeout(300);
const designCount = Number(await page.locator("#partsCount").textContent());
if (!(designCount > 0)) throw new Error("Изменение материала/кромки разрушило параметрическую модель.");

await page.locator("#shelfSupportType").selectOption({label:"Штифт Ø6"});
await page.locator("#shelfFrontOffset").fill("40");
await page.locator("#secondaryFastener").selectOption({label:"Дюбель + эксцентрик"});
await page.locator("#build").click();
await page.waitForTimeout(1000);
const drillingSummary = await page.locator("#drillingSummary").textContent();
if (!drillingSummary.includes("полкодержатели")) throw new Error("Цепочка Hardware/Drilling не дошла до сводки сверления.");
const validationAfterHardware = await page.locator("#validation").textContent();
if (validationAfterHardware.includes("PAGEERROR")) throw new Error("Ошибка после пересчёта Hardware/Drilling: " + validationAfterHardware);

const downloadPromise = page.waitForEvent("download");
await page.locator("#saveProject").click();
const projectDownload = await downloadPromise;
const projectPath = await projectDownload.path();
if (!projectPath) throw new Error("JSON-проект не был сохранён.");
await page.locator("#loadProject").setInputFiles(projectPath);
await page.waitForTimeout(1000);
const restoredCount = Number(await page.locator("#partsCount").textContent());
if (!(restoredCount > 0)) throw new Error("После загрузки JSON модель не восстановилась.");

await page.locator("#sheetLength").fill("3000");
await page.locator("#sheetWidth").fill("3000");
await page.locator(".showCuttingMap").first().click();
await page.waitForTimeout(300);
const quantityCheck = await page.evaluate(() => {
  const gate = window._releaseGate;
  const details = gate?.gatedParts || [];
  const expected = details.reduce((sum, part) => sum + Number(part?.detailing?.quantity || 1), 0);
  const placements = (gate?.sheetLayout?.sheets || []).flatMap(sheet => sheet.placements || []);
  return { expected, actual: placements.length };
});
if (quantityCheck.expected !== quantityCheck.actual) {
  throw new Error("Количество экземпляров в раскрое не соответствует деталировке: " + quantityCheck.expected + " != " + quantityCheck.actual);
}
await page.waitForTimeout(300);
const cuttingStatus = await page.locator("#validation").textContent();
if (!cuttingStatus.includes("Карта раскроя показана из проверенной раскладки Release Gate")) {
  throw new Error("Release Gate не пропустил проверенную карту раскроя. Статус: " + cuttingStatus);
}

const gateInvalidationRevision = await page.evaluate(() => window._releaseGate?.modelRevision ?? null);
if (!Number.isFinite(Number(gateInvalidationRevision))) throw new Error("Release Gate не сохранил ревизию проверенной модели.");
await page.locator("#frontGapBetween").fill("0");
await page.locator("#build").click();
await page.waitForTimeout(1000);
const blockedGate = await page.evaluate(() => window._releaseGate);
if (!blockedGate || Number(blockedGate.modelRevision) === Number(gateInvalidationRevision) || blockedGate.passed) throw new Error("После изменения модели старый Release Gate не был заменён новым заблокированным Gate.");
const blockedPdfPromise = page.waitForEvent("popup", {timeout:1500}).catch(() => null);
await page.locator(".exportSheetLayout").first().click();
const blockedPdf = await blockedPdfPromise;
if (blockedPdf) { await blockedPdf.close(); throw new Error("PDF был открыт после изменения модели без нового Release Gate."); }
const blockedStatus = await page.locator("#validation").textContent();
if (!blockedStatus.includes("выпуск PDF заблокирован")) throw new Error("После изменения модели PDF не был заблокирован.");

await page.locator("#frontGapBetween").fill("2");
await page.locator("#width").fill("2400");
await page.locator("#build").click();
await page.waitForTimeout(1000);
await page.locator("#sheetLength").fill("3000");
await page.locator("#sheetWidth").fill("3000");
await page.locator(".showCuttingMap").first().click();
await page.waitForTimeout(300);
const restoredCuttingStatus = await page.locator("#validation").textContent();
if (!restoredCuttingStatus.includes("Карта раскроя показана из проверенной раскладки Release Gate")) {
  throw new Error("После новой сборки Release Gate не восстановил выпуск: " + restoredCuttingStatus);
}
await page.locator("#sheetLength").fill("100");
await page.locator("#sheetWidth").fill("100");
await page.locator(".showCuttingMap").first().click();
await page.waitForTimeout(300);
const blockedLayoutStatus = await page.locator("#validation").textContent();
if (!blockedLayoutStatus.includes("просмотр карты раскроя заблокирован")) {
  throw new Error("Release Gate не заблокировал раскрой при недопустимом размере листа.");
}
await page.locator("#sheetLength").fill("3000");
await page.locator("#sheetWidth").fill("3000");
await page.locator(".showCuttingMap").first().click();
await page.waitForTimeout(300);
const restoredLayoutStatus = await page.locator("#validation").textContent();
if (!restoredLayoutStatus.includes("Карта раскроя показана из проверенной раскладки Release Gate")) {
  throw new Error("После восстановления размеров листа Release Gate не восстановил выпуск.");
}

const pdfPromise = page.waitForEvent("popup", {timeout:10000});
await page.locator(".exportSheetLayout").first().click();
const pdfPage = await pdfPromise;
await pdfPage.waitForLoadState("domcontentloaded");
const pdfHtml = await pdfPage.locator("body").innerHTML();
if (!pdfHtml.includes("Карта раскроя") || !pdfHtml.includes("Деталей:")) {
  throw new Error("PDF-карта раскроя не сформирована из проверенной раскладки Release Gate.");
}
const pdfExpected = await page.evaluate(() => {
  const gate = window._releaseGate;
  const part = gate?.gatedParts?.[0];
  const d = part?.detailing;
  const op = d?.holes?.[0] || d?.processing?.find(item => item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)));
  return {
    partNumber: part?.partNumber || "",
    material: d?.material || "",
    edge: Array.isArray(d?.edges) ? d.edges[0] || "" : "",
    x: op?.x ?? null,
    y: op?.y ?? null
  };
});
for (const value of [pdfExpected.partNumber, pdfExpected.material, pdfExpected.edge]) {
  if (!value || !pdfHtml.includes(String(value))) throw new Error("PDF не содержит данные проверенной деталировки: " + value);
}
if (pdfExpected.x !== null && pdfExpected.y !== null) {
  if (!pdfHtml.includes(String(pdfExpected.x)) || !pdfHtml.includes(String(pdfExpected.y))) {
    throw new Error("PDF не содержит координаты присадки из проверенной деталировки.");
  }
}
await pdfPage.close();

if (errors.length) throw new Error(errors.join("\n"));

console.log("BROWSER SMOKE: PASS");
console.log("Деталей после обычной сборки:", count);
console.log("Деталей после AI text:", aiCount);

await browser.close();
