import fs from "node:fs";
import vm from "node:vm";
import { evaluateReleaseGateState } from "../release-gate-core.js";

const app = fs.readFileSync("app.js", "utf8");
const core = fs.readFileSync("release-gate-core.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const fixtures = JSON.parse(fs.readFileSync("tests/reference-projects.json", "utf8"));

const required = [
  ["Furniture AI Designer", app.includes("Furniture AI Designer") || readme.includes("Furniture AI Designer")],
  ["версия интерфейса синхронизирована с v1.0.0", app.includes('projectVersion = "1.0.0"') && html.includes("Furniture AI Designer v1.0.0")],
  ["дизайнер поддерживает материалы по отдельным деталям", app.includes("detail-material") && app.includes("applyPartMaterial(index, materialSelect.value)")],
  ["дизайнер поддерживает полный набор материалов и толщин", html.includes("ЛДСП 35 мм") && html.includes("МДФ 16 мм") && html.includes("Фанера 22 мм") && html.includes("ABS 0.8 мм") && html.includes("PVC 1 мм") && html.includes("PP 2 мм")],
  ["утвержден блок освещения", html.includes('id="lightingEnabled"') && html.includes('id="lightingMount"') && html.includes('id="shelfLighting"') && app.includes("lightingEnabled") && app.includes("shelfLighting")],
  ["утвержден блок фурнитуры", html.includes('id="hingeType"') && html.includes('id="hingeLimiter"') && html.includes('id="openingAngle"') && html.includes('id="fastenerType"') && html.includes('id="confirmatDiameter"') && html.includes('id="connectorDiameter"') && html.includes('id="secondaryFastener"') && html.includes('id="dowelDiameter"') && html.includes('id="eccentricDiameter"') && html.includes('id="shelfSupportType"') && html.includes('id="shelfFrontOffset"') && app.includes("hingeType") && app.includes("fastenerType") && app.includes("shelfSupportType")],
  ["утвержден блок столешницы", html.includes('id="countertopEnabled"') && html.includes('id="countertopThickness"') && html.includes('id="countertopMaterial"') && app.includes("countertopThickness") && app.includes("countertopMaterial")],
  ["утвержден блок библиотеки внешних фасадов", html.includes('id="facadeManufacturer"') && html.includes('id="facadeModel"') && html.includes('id="facadeLibraryItem"') && app.includes("facadeLibrary")],
  ["дизайнерские параметры сохраняются в JSON", app.includes('parameters.lightingEnabled = $("lightingEnabled").value') && app.includes('parameters.countertopThickness = $("countertopThickness").value') && app.includes('parameters.facadeModel = $("facadeModel").value')],
  ["утверждена визуализация мебели в интерьере", html.includes('id="interiorView"') && app.includes("function showInteriorView") && app.includes('name = "Визуализация интерьера"') && app.includes("Мебель вписана в интерьер.")],
  ["AI image распознает конструктивные элементы", app.includes("async function analyzeFurnitureImageMetadata") && app.includes("verticalPeaks") && app.includes("horizontalPeaks") && app.includes("params.sections") && app.includes("params.doors") && app.includes("params.shelves")],
  ["AI image применяет распознанную конструкцию", app.includes("function applyAiImageRecognition") && app.includes('aiImageApply') && app.includes("параметрическая модель построена.")],
  ["очистка пересборки удаляет интерьерную сцену", app.includes("clearInteriorView();") && app.includes("function clearInteriorView")],
  ["очистка пересборки удаляет IFC preview", app.includes('scene.getObjectByName("IFC Preview")') && app.includes('group.name="IFC Preview"')],
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
  ["неподтвержденная IFC-толщина блокирует деталировку", app.includes("sheetSpecConfidence === \"review\"") && app.includes("толщина листа IFC не подтверждена")],
  ["IFC без кромки блокирует деталировку", app.includes('u.source === "IFC"') && app.includes("u.edges.length !== 4") && app.includes("кромка IFC не определена")],
  ["присадка без координат блокирует деталировку", app.includes("без координат X/Y") && app.includes("holes.forEach")],
  ["деталировка проверяет материал и количество", app.includes("не задан материал детали") && app.includes("некорректное количество детали")],
  ["Release Gate сверяет кромку раскроя с деталировкой", core.includes("Раскладка содержит кромку, не соответствующую деталировке") && core.includes("JSON.stringify(actualEdges)")],
  ["Release Gate проверяет состав деталировки", core.includes("неполные данные кромки") && core.includes("некорректное количество") && core.includes("отсутствует материал") && core.includes("отверстие без координат X/Y")],
  ["Release Gate проверяет состав раскроя против деталировки", core.includes("expectedDetailByKey") && core.includes("Раскладка не соответствует количеству детали") && core.includes("Раскладка содержит размеры детали, не соответствующие деталировке")],
  ["Construction QC защищает геометрию IFC", app.includes("geometrySourceErrors") && app.includes("ifcGeometryLocked: geometrySourceErrors.length === 0")],
  ["низкая уверенность IFC требует ручной проверки", app.includes('u.source === "IFC" && u.recognitionConfidence === "low"') && app.includes("требуется ручная проверка")],
  ["кандидатные IFC-соединения требуют подтверждения", app.includes('u.source === "IFC" && (u.technology?.joints || []).some(j => j.status === "candidate")') && app.includes("неподтверждённое IFC-соединение")],
  ["IFC-фурнитура остаётся кандидатной", app.includes('add("Петля с доводчиком"') && app.includes('"candidate"') && app.includes('add("Крепёж корпуса"') && app.includes('source:"IFC topology"')],
  ["IFC-кандидат явно запрещает автогенерацию отверстий", app.includes("Отверстия не генерируются автоматически до подтверждения базы и направления сверления") && app.includes('status:"candidate"')],
  ["IFC-кандидат не переводится автоматически в ready", app.includes('status:"candidate"') && app.includes('status === "candidate"') && !app.includes('status = "ready"')],
  ["IFC-технология получает REVIEW при неподтверждённом соединении", app.includes('const hasUnconfirmedJoint = u.technology.joints.some(j=>j.status !== "ready");') && app.includes('if (hasUnconfirmedJoint) u.technology.status = "review";')],
  ["IFC low confidence требует ручной проверки", app.includes('u.recognitionConfidence === "low"') && app.includes("низкая уверенность IFC-распознавания; требуется ручная проверка")],
  ["сводка IFC-технологии пересчитывается после соединений", app.includes("technology.ready = ifcImportedParts.filter(part => part.userData.technology?.status === \"ready\").length;") && app.includes("technology.review = ifcImportedParts.filter(part => part.userData.technology?.status !== \"ready\").length;")],
  ["Construction QC блокирует IFC-соединение без подтверждения", app.includes('u.technology?.joints || []') && app.includes('IFC-соединение требует подтверждения')],
  ["IFC-порядок гарантирует QC после деталировки", app.indexOf("const detailingPipeline = rebuildDetailingPipeline();") < app.indexOf("const constructionQC = runConstructionQC(detailingPipeline);") && app.indexOf("const constructionQC = runConstructionQC(detailingPipeline);") < app.indexOf("const releaseGate = runReleaseGate();")],
  ["Release Gate runtime", app.includes("function runReleaseGate()") && app.includes("evaluateReleaseGateState") && app.includes("window._releaseGate") && app.includes("выпуск PDF заблокирован")],
  ["Release Gate отвергает устаревший QC", core.includes("Number(qc.modelRevision)") && core.includes("Construction QC относится к другой ревизии модели.")],
  ["инвалидация Gate при пересборке", app.includes("let modelRevision = 0") && app.includes("window._constructionQC = null") && app.includes("window._releaseGate = null") && app.includes("report.modelRevision = modelRevision")],
  ["безопасное переключение IFC режима", app.includes("function build()") && app.includes("clearModel();\n  ifcMode = false;")],
  ["IFC материал меняется без пересборки геометрии", app.includes("function refreshIfcTechnology()") && app.includes('if (ifcMode) {\n    refreshIfcTechnology();\n    return;\n  }') && app.includes("applyIfcMaterial()")],
  ["IFC кромка меняется без пересборки геометрии", app.includes('$("edge"+i)?.addEventListener("change"') && app.includes("refreshIfcTechnology()") && app.includes("part.userData.edges = [...selectedEdges]")],
  ["сброс IFC при очистке модели", app.includes("function clearModel()") && app.includes("closeIfcModel();") && app.includes("ifcImportedParts = [];")],
  ["идемпотентная пересборка деталировки", app.includes("delete u.detailing;") && app.includes("delete u.detailingContinuity;") && app.includes("delete u.processing;") && app.includes("modelRevision")],
  ["контроль пересечения деталей на листе", core.includes("пересечение деталей") && core.includes("placement.x >= other.x + other.length + kerf")],
  ["раскладка сохраняет количество деталей", core.includes("Раскладка не соответствует количеству детали") && core.includes("В раскладке присутствует лишняя деталь")],
  ["лист не смешивает толщины", core.includes("Number(placement.thickness || sheet.thickness) !== Number(sheet.thickness)") && core.includes("смешаны детали разной толщины")],
  ["раскрой сохраняет номер детали при quantity > 1", app.includes("group.details.forEach(detail =>") && app.includes("partNumber: detail.number || \"\"") && app.includes("const quantity = Math.max(1, Number(detail.quantity || 1))")],
  ["IFC открывается после очистки проекта", app.includes("clearModel();") && app.includes("api.OpenModel(data, { COORDINATE_TO_ORIGIN: true })") && app.includes("clearModel();")],
  ["цепочка Construction QC → Release Gate", app.includes("runConstructionQC(detailingPipeline)") && app.includes("runReleaseGate()")],
  ["PDF читает деталировку", app.includes("const detailing = part.userData?.detailing") && app.includes("Array.isArray(detailing?.holes)") && app.includes("d.length") && app.includes("d.material") && app.includes("d.edges")],
  ["Release Gate проверяет раскладку листа", core.includes("function validateSheetLayout") && core.includes("placement.overflow") && core.includes("sheetLayoutChecked") && app.includes("buildSheetLayout(")],
  ["PDF не пересобирает раскладку после Release Gate", app.includes("const layout = releaseGate.sheetLayout;") && app.includes("отсутствует проверенная раскладка листа")],
  ["PDF использует проверенную раскладку", app.includes("const layout = releaseGate.sheetLayout;") && !app.includes("releaseGate.sheetLayout || buildSheetLayout")],
  ["PDF лист использует detailing", app.includes("sheet.placements.map(p =>") && app.includes("(p.material || sheet.material)") && app.includes("edgeSummary(p.edges)") && app.includes("p.thickness")]
];

const gateContract = [
  ["PASS: Hardware → detailing → Release Gate", {
    qc:{status:"PASS", modelRevision:1, details:[{number:"001", status:"PASS"}]}, modelRevision:1, partsCount:1,
    partStates:[{number:"001",sourceGeometry:"Furniture Core",geometryLocked:false,detailing:{number:"001",status:"ready",modelRevision:1,construction:{source:"Furniture Core"},material:"ldsp18",quantity:1,edges:["PVC 1 мм","PVC 1 мм","нет","нет"],cutting:{length:600,width:400,thickness:18},holes:[{id:"H1",operation:"Чашка петли",diameter:35,depth:12.5,x:21.5,y:100},{id:"C1",operation:"Конфирмат",diameter:7,depth:36,x:120,y:280}]}}],
    cuttingGroups:[{groupNumber:"001",material:"ldsp18",thickness:18,details:[{number:"001",length:600,width:400,thickness:18,quantity:1,material:"ldsp18",edges:["PVC 1 мм","PVC 1 мм","нет","нет"]}]}],
    sheetLayout:{sheetLength:2800,sheetWidth:2070,margin:10,kerf:4,sheets:[{sheetNumber:1,placements:[{sheetNumber:1,groupNumber:"001",partNumber:"001",x:10,y:10,length:600,width:400,thickness:18,material:"ldsp18",edges:["PVC 1 мм","PVC 1 мм","нет","нет"],overflow:false}]}]}
  }, true],
  ["PASS: QC PASS + готовая деталировка + раскрой + лист", {
    qc: {status:"PASS", modelRevision:1, details:[{number:"001", status:"PASS"}]},
    modelRevision:1,
    partsCount: 1,
    partStates: [{
      number:"001", sourceGeometry:"Furniture Core", geometryLocked:false,
      detailing:{
        number:"001", status:"ready", modelRevision:1,
        construction:{source:"Furniture Core"}, material:"ldsp18", quantity:1,
        edges:["PVC 1 мм","PVC 1 мм","нет","нет"],
        cutting:{length:600,width:400,thickness:18}, holes:[]
      }
    }],
    cuttingGroups: [{groupNumber:"001",material:"ldsp18",thickness:18,details:[{
      number:"001",length:600,width:400,thickness:18,quantity:1,material:"ldsp18",
      edges:["PVC 1 мм","PVC 1 мм","нет","нет"]
    }]}],
    sheetLayout: {sheetLength:2800,sheetWidth:2070,margin:10,kerf:4,sheets:[{
      sheetNumber:1,placements:[{
        sheetNumber:1,groupNumber:"001",partNumber:"001",x:10,y:10,length:600,width:400,
        thickness:18,material:"ldsp18",edges:["PVC 1 мм","PVC 1 мм","нет","нет"],overflow:false
      }]
    }]}
  }, true],
  ["BLOCKED: QC REVIEW", {qc:{status:"REVIEW"},partsCount:1,partStates:[],cuttingGroups:[],sheetLayout:null}, false],
  ["BLOCKED: IFC low confidence → REVIEW → Release Gate", {qc:{status:"PASS"},partsCount:1,partStates:[{number:"001",sourceGeometry:"IFC",geometryLocked:true,recognitionConfidence:"low",detailing:{number:"001",status:"review",modelRevision:1,construction:{source:"IFC"},material:"ldsp18",quantity:1,edges:["PVC 1 мм","PVC 1 мм","нет","нет"],cutting:{length:600,width:400,thickness:18},holes:[]}}],cuttingGroups:[],sheetLayout:null,modelRevision:1}, false],
  ["BLOCKED: IFC thickness REVIEW → Release Gate", {qc:{status:"PASS"},partsCount:1,partStates:[{number:"001",sourceGeometry:"IFC",geometryLocked:true,detailing:{number:"001",status:"review",modelRevision:1,construction:{source:"IFC"},material:"ldsp18",quantity:1,edges:["PVC 1 мм","PVC 1 мм","нет","нет"],cutting:{length:600,width:400,thickness:18},holes:[],notes:["толщина листа IFC не подтверждена"]}}],cuttingGroups:[],sheetLayout:null,modelRevision:1}, false],
  ["BLOCKED: IFC edge REVIEW → Release Gate", {qc:{status:"PASS"},partsCount:1,partStates:[{number:"001",sourceGeometry:"IFC",geometryLocked:true,detailing:{number:"001",status:"review",modelRevision:1,construction:{source:"IFC"},material:"ldsp18",quantity:1,edges:["","","",""],cutting:{length:600,width:400,thickness:18},holes:[],notes:["кромка IFC не определена"]}}],cuttingGroups:[],sheetLayout:null,modelRevision:1}, false],
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
  ["Release Gate имеет детерминированный evaluator", core.includes("function evaluateReleaseGateState")],
  ["Release Gate различает PASS/BLOCKED", core.includes('status: issues.length ? "BLOCKED" : "PASS"')],
  ["Release Gate учитывает REVIEW", core.includes('qc.status !== "PASS"')],
  ["Release Gate учитывает overflow", core.includes("function validateSheetLayout") && core.includes("if (placement.overflow)")],
  ["Release Gate сверяет состав деталей", core.includes("Количество состояний деталей не соответствует количеству деталей проекта")],
  ["Release Gate требует полный состав Construction QC", core.includes("Construction QC не содержит полный состав деталей проекта")],
  ["Release Gate отвергает устаревшую деталировку", core.includes("detailing относится к другой ревизии модели")],
  ["Release Gate сверяет состав групп раскроя с деталировкой", core.includes("отсутствует запись в группах раскроя") && core.includes("Группа раскроя не соответствует деталировке детали") && core.includes("В группах раскроя присутствует деталь без готовой деталировки")],
  ["Release Gate запрещает дубли номеров деталей", core.includes("Дублируется номер детали") && core.includes("const detailNumbers = new Set()")],
  ["Release Gate сверяет номер детали с detailing", core.includes("в detailing отсутствует номер детали") && core.includes("номер детали не соответствует номеру в detailing")],
  ["Release Gate проверяет количество детали в группе раскроя", core.includes("в группах раскроя указано некорректное количество") && core.includes("Number(cutting.quantity) !== Number(detail.quantity)")],
  ["Release Gate проверяет принадлежность размещения листу", core.includes("размещение содержит неверный номер листа") && core.includes("placement.sheetNumber")],
  ["Release Gate проверяет источник геометрии деталировки", core.includes("источник геометрии деталировки не соответствует источнику модели")],
  ["Release Gate сверяет размещение с деталировкой", core.includes("Раскладка содержит размеры детали, не соответствующие деталировке")],
  ["раскладка сохраняет материал и толщину", app.includes("thickness: item.thickness") && app.includes("material: item.material")],
  ["PDF использует зафиксированный состав Gate", app.includes("gatedParts") && app.includes("buildCuttingPdfHtml(layout, gatedParts)")],
  ["PDF проверяет ревизию снимка Gate", app.includes("gatedPartsRevision") && app.includes("состав деталей относится к другой ревизии модели")],
  ["PDF не содержит внутренний источник геометрии", !app.includes('<b>Источник геометрии:</b>')],
  ["Схема сверловки использует размеры деталировки", app.includes("const d = u.detailing || {}") && app.includes("Number(d.length) || Number(u.width)") && app.includes("Number(d.width) || Number(u.height)")],
  ["просмотр карты проходит через Release Gate", app.includes("function showCuttingMap()") && app.includes("просмотр карты раскроя заблокирован") && app.includes("renderCuttingMap(releaseGate.sheetLayout)")],
  ["изменение технологии инвалидирует старый параметрический Gate", app.includes("technologyBuildFields") && app.includes("technologyBuildFields.forEach") && app.includes('if (ifcMode)')],
  ["загрузка JSON возвращает модель в параметрический путь", app.includes('$("loadProject").addEventListener') && app.includes("Object.entries(data.parameters||{})") && app.includes("build();") && app.includes("ifcMode = false")]
];

const forbidden = [
  "CNC", "cnc", "G-code", "toolpath",
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
