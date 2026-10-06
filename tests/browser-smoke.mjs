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
await page.locator("#material").selectOption("mdf18");
await page.waitForTimeout(300);
await page.locator("#edge1").selectOption({label:"ABS 2 мм"});
await page.waitForTimeout(300);
const designCount = Number(await page.locator("#partsCount").textContent());
if (!(designCount > 0)) throw new Error("Изменение материала/кромки разрушило параметрическую модель.");

await page.locator(".showCuttingMap").first().click();
await page.waitForTimeout(300);
const cuttingStatus = await page.locator("#validation").textContent();
if (!cuttingStatus.includes("Карта раскроя показана из проверенной раскладки Release Gate")) {
  throw new Error("Release Gate не пропустил проверенную карту раскроя. Статус: " + cuttingStatus);
}

if (errors.length) throw new Error(errors.join("\n"));

console.log("BROWSER SMOKE: PASS");
console.log("Деталей после обычной сборки:", count);
console.log("Деталей после AI text:", aiCount);

await browser.close();
