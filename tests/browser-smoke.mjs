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

if (errors.length) throw new Error(errors.join("\n"));

console.log("BROWSER SMOKE: PASS");
console.log("Деталей после обычной сборки:", count);
console.log("Деталей после AI text:", aiCount);

await browser.close();
