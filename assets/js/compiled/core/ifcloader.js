(() => {
  const KNOWN_IFC_CLASSES = [
    // Spatial
    "IfcProject",
    "IfcSite",
    "IfcBuilding",
    "IfcBuildingStorey",
    "IfcSpace",
    "IfcZone",
    // Architectural
    "IfcWall",
    "IfcWallStandardCase",
    "IfcWallElementedCase",
    "IfcSlab",
    "IfcSlabStandardCase",
    "IfcSlabElementedCase",
    "IfcRoof",
    "IfcCovering",
    "IfcCurtainWall",
    "IfcRailing",
    "IfcDoor",
    "IfcDoorStandardCase",
    "IfcWindow",
    "IfcWindowStandardCase",
    "IfcStair",
    "IfcStairFlight",
    "IfcRamp",
    "IfcRampFlight",
    // Structural
    "IfcColumn",
    "IfcColumnStandardCase",
    "IfcBeam",
    "IfcBeamStandardCase",
    "IfcPlate",
    "IfcMember",
    "IfcFooting",
    "IfcPile",
    "IfcReinforcingBar",
    "IfcReinforcingMesh",
    "IfcTendon",
    // MEP
    "IfcDistributionElement",
    "IfcFlowSegment",
    "IfcFlowFitting",
    "IfcFlowTerminal",
    "IfcFlowController",
    "IfcFlowMovingDevice",
    "IfcFlowStorageDevice",
    "IfcFlowTreatmentDevice",
    "IfcEnergyConversionDevice",
    "IfcCableSegment",
    "IfcCableCarrierSegment",
    "IfcCableCarrierFitting",
    "IfcDuctSegment",
    "IfcDuctFitting",
    "IfcDuctSilencer",
    "IfcPipeSegment",
    "IfcPipeFitting",
    "IfcAirTerminal",
    "IfcAirTerminalBox",
    "IfcOutlet",
    "IfcSwitchingDevice",
    "IfcLightFixture",
    "IfcSensor",
    "IfcActuator",
    "IfcController",
    "IfcAlarm",
    "IfcAudioVisualAppliance",
    "IfcCommunicationsAppliance",
    "IfcElectricAppliance",
    "IfcSanitaryTerminal",
    "IfcSpaceHeater",
    "IfcStackTerminal",
    "IfcTransportElement",
    "IfcWasteTerminal",
    // Furnishings
    "IfcFurnishingElement",
    "IfcFurniture",
    "IfcSystemFurnitureElement",
    // Catch-alls
    "IfcBuildingElementProxy",
    "IfcElement",
    "IfcElementAssembly",
    "IfcGeographicElement",
    "IfcShadingDevice",
    "IfcOpeningElement",
    "IfcChimney",
    "IfcSurfaceFeature"
  ];
  const TYPE_OBJECT_CLASSES = [
    "IfcWallType",
    "IfcSlabType",
    "IfcColumnType",
    "IfcBeamType",
    "IfcDoorType",
    "IfcDoorStyle",
    "IfcWindowType",
    "IfcWindowStyle",
    "IfcStairType",
    "IfcStairFlightType",
    "IfcRoofType",
    "IfcCoveringType",
    "IfcRailingType",
    "IfcMemberType",
    "IfcPlateType",
    "IfcFootingType",
    "IfcFurnitureType",
    "IfcFurnishingElementType",
    "IfcBuildingElementProxyType",
    "IfcFlowSegmentType",
    "IfcFlowFittingType",
    "IfcFlowTerminalType",
    "IfcPipeSegmentType",
    "IfcDuctSegmentType",
    "IfcCableSegmentType",
    "IfcLightFixtureType",
    "IfcOutletType"
  ];
  function classKey(name) {
    return "IFC" + name.slice(3).toUpperCase();
  }
  const IFC_LOADER_BUNDLE_URL = "assets/js/ifc-loader-bundle.js?v=web-ifc-0.0.35";
  const IFC_WASM_PATH = "web-ifc-0.0.35/";
  let _ifcPromise = null;
  let _ifcBundlePromise = null;
  function loadIfcLoaderBundle(onLog) {
    if (window.IFCLoader) return Promise.resolve();
    if (_ifcBundlePromise) return _ifcBundlePromise;
    _ifcBundlePromise = new Promise((resolve, reject) => {
      onLog && onLog("info", 'Loading bundled <span class="hl">web-ifc-three</span> IFC runtime');
      const script = document.createElement("script");
      script.src = IFC_LOADER_BUNDLE_URL;
      script.async = true;
      script.onload = () => {
        if (window.IFCLoader) {
          onLog && onLog("ok", "Loaded local IFC loader bundle");
          resolve();
        } else {
          reject(new Error("IFCLoader bundle loaded, but window.IFCLoader was not registered"));
        }
      };
      script.onerror = () => reject(new Error(`Failed to load ${IFC_LOADER_BUNDLE_URL}`));
      document.head.appendChild(script);
    });
    return _ifcBundlePromise;
  }
  function buildIfcConstants(typesMap) {
    const constants = {};
    Object.entries(typesMap || {}).forEach(([code, key]) => {
      constants[key] = Number(code);
    });
    return constants;
  }
  async function initIfcApi(api) {
    const originalLog = console.log;
    console.log = (...args) => {
      const message = args.map(String).join(" ");
      if (message.includes("web-ifc:") && message.includes("threading:")) return;
      originalLog.apply(console, args);
    };
    try {
      await api.Init();
    } finally {
      console.log = originalLog;
    }
  }
  function ensureWebIfc(onLog) {
    if (_ifcPromise) return _ifcPromise;
    _ifcPromise = (async () => {
      onLog && onLog("info", 'Initializing local <span class="hl">web-ifc</span> WASM runtime');
      await loadIfcLoaderBundle(onLog);
      const ifcLoader = new window.IFCLoader();
      await ifcLoader.ifcManager.setWasmPath(IFC_WASM_PATH);
      window.ifcLoader = ifcLoader;
      const api = ifcLoader.ifcManager.ifcAPI;
      if (!api.wasmModule) await initIfcApi(api);
      const mod = buildIfcConstants(ifcLoader.ifcManager.typesMap);
      onLog && onLog("ok", "Local WASM initialized via example IFCLoader");
      const codeToName = /* @__PURE__ */ new Map();
      const nameToCode = /* @__PURE__ */ new Map();
      [...KNOWN_IFC_CLASSES, ...TYPE_OBJECT_CLASSES].forEach((name) => {
        const key = classKey(name);
        const code = mod[key];
        if (code != null) {
          codeToName.set(code, name);
          nameToCode.set(name, code);
        }
      });
      return { mod, api, codeToName, nameToCode };
    })();
    return _ifcPromise;
  }
  function val(x) {
    if (x == null) return null;
    if (Array.isArray(x)) return x;
    if (typeof x === "object") {
      if ("expressID" in x) return x.expressID;
      if ("value" in x) return x.value;
    }
    return x;
  }
  function asArray(x) {
    if (x == null) return [];
    return Array.isArray(x) ? x : [x];
  }
  async function readIfcSchema(file) {
    if (!file || typeof file.slice !== "function") return null;
    const header = await file.slice(0, Math.min(file.size || 0, 1024 * 1024)).text();
    const match = header.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
    return match ? match[1].toUpperCase() : null;
  }
  function isSupportedIfcSchema(schema) {
    if (!schema) return true;
    const normalized = String(schema).replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return normalized === "IFC2X3" || normalized.startsWith("IFC4");
  }
  async function loadRealIfc(file, opts = {}) {
    const onProgress = opts.onProgress || (() => {
    });
    const onLog = opts.onLog || (() => {
    });
    const _ts = {};
    const _mark = (n) => {
      _ts[n] = performance.now();
    };
    _mark("total_start");
    onProgress(0.02);
    onLog("info", `Reading <span class="hl">${file.name}</span> (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    _mark("wasm_start");
    const { mod: W, api, codeToName, nameToCode } = await ensureWebIfc(onLog);
    _mark("wasm_end");
    onProgress(0.15);
    _mark("buf_start");
    const buffer = new Uint8Array(await file.arrayBuffer());
    _mark("buf_end");
    onProgress(0.2);
    onLog("info", "Parsing STEP (IFC)\u2026");
    _mark("open_start");
    const modelID = api.OpenModel(buffer, {
      COORDINATE_TO_ORIGIN: true,
      USE_FAST_BOOLS: true
    });
    _mark("open_end");
    onProgress(0.35);
    let schemaVersion = await readIfcSchema(file) || "IFC4";
    try {
      schemaVersion = api.GetModelSchema ? api.GetModelSchema(modelID) || schemaVersion : schemaVersion;
    } catch (e) {
    }
    onLog("ok", `Opened model \xB7 schema <span class="hl">${schemaVersion}</span>`);
    onLog("info", "Indexing spatial relationships\u2026");
    _mark("rel_start");
    const aggMap = await relMap(W.IFCRELAGGREGATES, "RelatingObject", "RelatedObjects");
    const containMap = await relMap(W.IFCRELCONTAINEDINSPATIALSTRUCTURE, "RelatingStructure", "RelatedElements");
    const typeByEl = await buildTypeIndex();
    _mark("rel_end");
    onProgress(0.45);
    onLog("info", "Scanning entity types\u2026");
    _mark("scan_start");
    const spatialClasses = ["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace"];
    const elementIds = /* @__PURE__ */ new Set();
    const idToClass = /* @__PURE__ */ new Map();
    function scanClass(cls) {
      const code = nameToCode.get(cls);
      if (code == null) return [];
      const ids = api.GetLineIDsWithType(modelID, code);
      const out = [];
      for (let i = 0; i < ids.size(); i++) {
        const id = ids.get(i);
        if (!idToClass.has(id)) idToClass.set(id, cls);
        out.push(id);
      }
      return out;
    }
    spatialClasses.forEach(scanClass);
    KNOWN_IFC_CLASSES.forEach((cls) => {
      if (spatialClasses.includes(cls)) return;
      scanClass(cls).forEach((id) => elementIds.add(id));
    });
    TYPE_OBJECT_CLASSES.forEach(scanClass);
    _mark("scan_end");
    onLog("info", "Extracting element metadata\u2026");
    _mark("elem_start");
    const elements = [];
    const byId = /* @__PURE__ */ new Map();
    const storeyByElement = /* @__PURE__ */ new Map();
    let project = null, site = null, building = null;
    const storeys = [];
    function add(el) {
      elements.push(el);
      byId.set(el.expressId, el);
      return el;
    }
    function buildElement(id, cls, parentExpressId, storey) {
      const line = api.GetLine(modelID, id, true);
      const typeExpressId = typeByEl.get(id) || null;
      const el = {
        expressId: id,
        globalId: val(line.GlobalId) || "",
        ifcClass: cls,
        name: val(line.Name),
        description: val(line.Description),
        objectType: val(line.ObjectType),
        tag: val(line.Tag),
        predefinedType: val(line.PredefinedType),
        longName: val(line.LongName),
        elevation: val(line.Elevation),
        typeExpressId,
        typeGlobalId: null,
        isType: TYPE_OBJECT_CLASSES.includes(cls),
        storey,
        parentExpressId,
        childrenExpressIds: [],
        // Deferred secondary refs — backfilled by _buildSecondaryData()
        _psetIds: [],
        _matIds: [],
        _classIds: [],
        _expanded: false,
        propertySets: [],
        quantitySets: [],
        materials: [],
        classifications: [],
        visibility: true,
        geometry: null,
        colorOverride: null,
        opacityOverride: null,
        rawAttributes: null
      };
      return add(el);
    }
    const projIds = api.GetLineIDsWithType(modelID, W.IFCPROJECT);
    if (projIds.size() === 0) throw new Error("No IfcProject found in file");
    const projId = projIds.get(0);
    project = buildElement(projId, "IfcProject", null, null);
    function walkAggregate(parent) {
      const children = aggMap.get(parent.expressId) || [];
      parent.childrenExpressIds = children;
      children.forEach((cid) => {
        const cls = idToClass.get(cid);
        if (!cls) return;
        const ch = buildElement(cid, cls, parent.expressId, null);
        if (cls === "IfcSite" && !site) site = ch;
        if (cls === "IfcBuilding" && !building) building = ch;
        if (cls === "IfcBuildingStorey") storeys.push(ch);
        walkAggregate(ch);
      });
    }
    walkAggregate(project);
    storeys.forEach((st) => {
      const contained = containMap.get(st.expressId) || [];
      contained.forEach((cid) => {
        const cls = idToClass.get(cid);
        if (!cls || !elementIds.has(cid)) return;
        storeyByElement.set(cid, st);
        const el = buildElement(cid, cls, st.expressId, st);
        st.childrenExpressIds.push(cid);
        walkAggregate(el);
      });
    });
    elementIds.forEach((id) => {
      if (!byId.has(id)) {
        const cls = idToClass.get(id);
        if (!cls) return;
        buildElement(id, cls, (building == null ? void 0 : building.expressId) || project.expressId, null);
      }
    });
    TYPE_OBJECT_CLASSES.forEach((cls) => {
      const code = nameToCode.get(cls);
      if (code == null) return;
      const ids = api.GetLineIDsWithType(modelID, code);
      for (let i = 0; i < ids.size(); i++) {
        const id = ids.get(i);
        if (!byId.has(id)) buildElement(id, cls, project.expressId, null);
      }
    });
    byId.forEach((el) => {
      if (el.typeExpressId) {
        const t = byId.get(el.typeExpressId);
        if (t) el.typeGlobalId = t.globalId;
      }
    });
    if (!site) site = { name: "\u2014" };
    if (!building) building = { name: "\u2014" };
    _mark("elem_end");
    onProgress(0.6);
    onLog("info", "Streaming geometry\u2026");
    _mark("stream_start");
    const geomByEl = /* @__PURE__ */ new Map();
    let geomCount = 0;
    api.StreamAllMeshes(modelID, (flatMesh) => {
      const id = flatMesh.expressID;
      const placed = flatMesh.geometries;
      const buffers = [];
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = api.GetGeometry(modelID, pg.geometryExpressID);
        const vData = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const iData = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        buffers.push({
          vData: new Float32Array(vData),
          iData: new Uint32Array(iData),
          transform: new Float32Array(pg.flatTransformation),
          color: pg.color && { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w }
        });
        geomCount++;
      }
      geomByEl.set(id, buffers);
    });
    _mark("stream_end");
    onLog("ok", `Streamed <span class="hl">${geomCount}</span> placed geometr${geomCount === 1 ? "y" : "ies"} for <span class="hl">${geomByEl.size}</span> element${geomByEl.size === 1 ? "" : "s"}`);
    onProgress(0.78);
    _mark("bake_start");
    let totalTris = 0;
    let baked = 0;
    const geomEntries = [...geomByEl.entries()];
    const BAKE_CHUNK = 64;
    for (let i = 0; i < geomEntries.length; i++) {
      const [id, buffers] = geomEntries[i];
      const el = byId.get(id);
      if (el) {
        const combined = combineBuffers(buffers);
        el.geometry = {
          kind: "mesh",
          positions: combined.positions,
          indices: combined.indices,
          color: combined.color
        };
        totalTris += combined.indices.length / 3;
      }
      baked++;
      if (baked % BAKE_CHUNK === 0 || baked === geomEntries.length) {
        onProgress(0.78 + 0.17 * (baked / geomEntries.length));
        await yieldUI();
      }
    }
    _mark("bake_end");
    onLog("ok", `Baked ${totalTris.toLocaleString()} triangles`);
    onProgress(0.97);
    const relationships = [];
    let rid = 1;
    aggMap.forEach((kids, parentId) => {
      relationships.push({
        expressId: -rid++,
        relationshipType: "IfcRelAggregates",
        sourceExpressId: parentId,
        targetExpressIds: kids,
        description: "Decomposed into"
      });
    });
    containMap.forEach((els, spId) => {
      relationships.push({
        expressId: -rid++,
        relationshipType: "IfcRelContainedInSpatialStructure",
        sourceExpressId: spId,
        targetExpressIds: els,
        description: "Spatial containment"
      });
    });
    typeByEl.forEach((typeId, elId) => {
      relationships.push({
        expressId: -rid++,
        relationshipType: "IfcRelDefinesByType",
        sourceExpressId: typeId,
        targetExpressIds: [elId],
        description: "Type definition"
      });
    });
    _mark("total_end");
    _logTiming(_ts, file);
    onProgress(1);
    const ctx = { api, W, modelID };
    let _secPromise = null;
    const _buildSecondaryData = () => {
      if (_secPromise) return _secPromise;
      _secPromise = (async () => {
        try {
          _mark("sec_start");
          const psetMap = await buildLinks(W.IFCRELDEFINESBYPROPERTIES, "RelatingPropertyDefinition");
          await yieldUI();
          const matMap = await buildLinks(W.IFCRELASSOCIATESMATERIAL, "RelatingMaterial");
          await yieldUI();
          const classMap = await buildLinks(W.IFCRELASSOCIATESCLASSIFICATION, "RelatingClassification");
          byId.forEach((el) => {
            el._psetIds = psetMap.get(el.expressId) || [];
            el._matIds = matMap.get(el.expressId) || [];
            el._classIds = classMap.get(el.expressId) || [];
          });
          _mark("sec_end");
          const secMs = (_ts["sec_end"] - _ts["sec_start"]).toFixed(0);
          console.log(`[IFC] Secondary data ready in ${secMs} ms (psets: ${psetMap.size}, mats: ${matMap.size}, class: ${classMap.size})`);
        } catch (err) {
          console.warn("[IFC] Secondary data build error:", err);
        }
      })();
      return _secPromise;
    };
    setTimeout(_buildSecondaryData, 200);
    async function expandElement(expressId) {
      const el = byId.get(expressId);
      if (!el) return null;
      if (el._expanded) return el;
      await _buildSecondaryData();
      if (el._expanded) return el;
      el._expanded = true;
      if (!el.rawAttributes) {
        try {
          const line = api.GetLine(modelID, expressId, true);
          el.rawAttributes = computeRawAttrs(line, el);
        } catch (e) {
          el.rawAttributes = [];
        }
      }
      for (const propDefId of el._psetIds) {
        try {
          const propDef = api.GetLine(modelID, propDefId, true);
          const isQto = propDef.type === W.IFCELEMENTQUANTITY;
          const data = { name: val(propDef.Name) || "", properties: [] };
          if (isQto) {
            for (const q of asArray(propDef.Quantities)) {
              let qLine;
              try {
                qLine = api.GetLine(modelID, val(q), true);
              } catch (e) {
                continue;
              }
              const valueKey = ["LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"].find((k) => qLine[k] != null);
              const unit = { LengthValue: "m", AreaValue: "m\xB2", VolumeValue: "m\xB3", CountValue: "", WeightValue: "kg", TimeValue: "s" }[valueKey] || "";
              data.properties.push({
                name: val(qLine.Name) || "",
                value: valueKey ? val(qLine[valueKey]) : null,
                unit,
                type: valueKey || "IfcQuantity"
              });
            }
            el.quantitySets.push(data);
          } else {
            for (const p of asArray(propDef.HasProperties)) {
              let pLine;
              try {
                pLine = api.GetLine(modelID, val(p), true);
              } catch (e) {
                continue;
              }
              const nominal = pLine.NominalValue;
              let value = null, type = "IfcValue";
              if (nominal && typeof nominal === "object") {
                value = nominal.value != null ? nominal.value : null;
                type = nominal.name || nominal.label || nominal.type_name || "IfcValue";
              } else if (nominal != null) {
                value = nominal;
              }
              data.properties.push({ name: val(pLine.Name) || "", value, unit: null, type });
            }
            el.propertySets.push(data);
          }
        } catch (e) {
        }
      }
      for (const matRefId of el._matIds) {
        try {
          const matLine = api.GetLine(modelID, matRefId, true);
          const mats = extractMaterial(matLine);
          el.materials.push(...mats);
        } catch (e) {
        }
      }
      for (const refId of el._classIds) {
        try {
          const ref = api.GetLine(modelID, refId, true);
          let systemName = "Unknown";
          if (ref.ReferencedSource) {
            try {
              const src = api.GetLine(modelID, val(ref.ReferencedSource), true);
              systemName = val(src.Name) || val(src.Source) || "Unknown";
            } catch (e) {
            }
          }
          el.classifications.push({
            system: systemName,
            code: val(ref.Identification) || val(ref.ItemReference) || "",
            name: val(ref.Name) || ""
          });
        } catch (e) {
        }
      }
      return el;
    }
    function close() {
      try {
        api.CloseModel(modelID);
      } catch (e) {
      }
    }
    return {
      elements,
      byId,
      relationships,
      project,
      site,
      building,
      storeys,
      materials: {},
      schemaVersion,
      fileName: file.name,
      fileSize: file.size,
      totalEntities: elements.length + relationships.length,
      totalGeometryItems: geomByEl.size,
      // Lazy access
      expandElement,
      close,
      _ifcContext: ctx,
      // Exposed so callers can track when secondary data (psets/mats/classes) is ready.
      _ensureSecondaryData: _buildSecondaryData
    };
    function _logTiming(ts, f) {
      const d = (a, b) => ts[a] != null && ts[b] != null ? (ts[b] - ts[a]).toFixed(0) + " ms" : "\u2013";
      const rows = {
        "ensureWebIfc (WASM init)": d("wasm_start", "wasm_end"),
        "file.arrayBuffer": d("buf_start", "buf_end"),
        "OpenModel (STEP parse)": d("open_start", "open_end"),
        "Rel indexes (agg+contain+type)": d("rel_start", "rel_end"),
        "Entity type scan": d("scan_start", "scan_end"),
        "Build element records": d("elem_start", "elem_end"),
        "StreamAllMeshes": d("stream_start", "stream_end"),
        "Bake buffers": d("bake_start", "bake_end"),
        "\u2500 TOTAL (critical path)": d("total_start", "total_end")
      };
      console.group(`\u26A1 IFC Load Timing \u2014 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
      console.table(rows);
      console.groupEnd();
    }
    function relMap(typeCode, parentField, childrenField) {
      return (async () => {
        const out = /* @__PURE__ */ new Map();
        if (typeCode == null) return out;
        const ids = api.GetLineIDsWithType(modelID, typeCode);
        const n = ids.size();
        for (let i = 0; i < n; i++) {
          const rel = api.GetLine(modelID, ids.get(i), true);
          const pId = val(rel[parentField]);
          const kids = asArray(rel[childrenField]).map(val).filter((v) => v != null);
          if (pId != null && kids.length) {
            out.set(pId, (out.get(pId) || []).concat(kids));
          }
          if (i > 0 && i % 800 === 0) await yieldUI();
        }
        return out;
      })();
    }
    function buildLinks(typeCode, relatingField) {
      return (async () => {
        const out = /* @__PURE__ */ new Map();
        if (typeCode == null) return out;
        const ids = api.GetLineIDsWithType(modelID, typeCode);
        const n = ids.size();
        for (let i = 0; i < n; i++) {
          const rel = api.GetLine(modelID, ids.get(i), true);
          const ref = val(rel[relatingField]);
          if (ref == null) continue;
          for (const o of asArray(rel.RelatedObjects)) {
            const objId = val(o);
            if (!out.has(objId)) out.set(objId, []);
            out.get(objId).push(ref);
          }
          if (i > 0 && i % 1500 === 0) await yieldUI();
        }
        return out;
      })();
    }
    function buildTypeIndex() {
      return (async () => {
        const out = /* @__PURE__ */ new Map();
        if (W.IFCRELDEFINESBYTYPE == null) return out;
        const ids = api.GetLineIDsWithType(modelID, W.IFCRELDEFINESBYTYPE);
        const n = ids.size();
        for (let i = 0; i < n; i++) {
          const rel = api.GetLine(modelID, ids.get(i), true);
          const typeId = val(rel.RelatingType);
          for (const o of asArray(rel.RelatedObjects)) out.set(val(o), typeId);
          if (i > 0 && i % 800 === 0) await yieldUI();
        }
        return out;
      })();
    }
    function extractMaterial(line) {
      const tn = codeToName.get(line.type) || "";
      if (tn === "" && line.Name) {
        return [{ name: val(line.Name) || "(material)" }];
      }
      if (line.Name && line.type === W.IFCMATERIAL) {
        return [{ name: val(line.Name) }];
      }
      if (line.type === W.IFCMATERIALLAYERSET || line.type === W.IFCMATERIALLAYERSETUSAGE) {
        let setHandle = line.type === W.IFCMATERIALLAYERSETUSAGE ? line.ForLayerSet : line;
        try {
          const set = line.type === W.IFCMATERIALLAYERSETUSAGE ? api.GetLine(modelID, val(setHandle), true) : line;
          const layers = asArray(set.MaterialLayers).map((lh) => {
            var _a;
            try {
              const layer = api.GetLine(modelID, val(lh), true);
              const matName = layer.Material ? ((_a = api.GetLine(modelID, val(layer.Material), true).Name) == null ? void 0 : _a.value) || "" : "";
              return { name: matName, thickness: (val(layer.LayerThickness) || 0) * 1e3 };
            } catch (e) {
              return null;
            }
          }).filter(Boolean);
          return [{ name: val(set.LayerSetName) || "Layer Set", layers }];
        } catch (e) {
          return [];
        }
      }
      if (line.type === W.IFCMATERIALLIST) {
        return asArray(line.Materials).map((mh) => {
          try {
            return { name: val(api.GetLine(modelID, val(mh), true).Name) || "" };
          } catch (e) {
            return { name: "?" };
          }
        });
      }
      if (line.type === W.IFCMATERIALCONSTITUENTSET) {
        return asArray(line.MaterialConstituents).map((ch) => {
          try {
            const c = api.GetLine(modelID, val(ch), true);
            const matName = c.Material ? val(api.GetLine(modelID, val(c.Material), true).Name) : "";
            return { name: `${val(c.Name) || matName || "Constituent"}: ${matName || "\u2014"}` };
          } catch (e) {
            return { name: "?" };
          }
        });
      }
      if (line.Name) return [{ name: val(line.Name) }];
      return [];
    }
    function describeUnit(unitLine) {
      if (!unitLine) return null;
      if (unitLine.Prefix || unitLine.Name) {
        const prefix = val(unitLine.Prefix) || "";
        const name = val(unitLine.Name) || "";
        return (prefix + name).toString().replace(/_/g, "");
      }
      return null;
    }
    function computeRawAttrs(line, el) {
      const ATTR_ORDER = ["GlobalId", "OwnerHistory", "Name", "Description", "ObjectType", "ObjectPlacement", "Representation", "Tag", "PredefinedType", "OverallHeight", "OverallWidth", "Elevation", "LongName", "CompositionType"];
      const out = [];
      let idx = 1;
      for (const attr of ATTR_ORDER) {
        if (!(attr in line)) continue;
        const v = line[attr];
        let value = null, ref = false;
        if (v == null) {
          value = null;
        } else if (Array.isArray(v)) {
          value = `(${v.length} refs)`;
          ref = true;
        } else if (typeof v === "object" && "value" in v) {
          const inner = v.value;
          if (v.type === 5 && typeof inner === "number") {
            value = `#${inner}`;
            ref = true;
          } else if (typeof inner === "string" && (attr === "PredefinedType" || attr === "CompositionType")) {
            value = `.${inner}.`;
          } else {
            value = inner;
          }
        } else {
          value = v;
        }
        out.push({ idx, name: attr, value, ref });
        idx++;
      }
      return out;
    }
  }
  function yieldUI() {
    return new Promise((r) => setTimeout(r, 0));
  }
  function combineBuffers(buffers) {
    let totalV = 0;
    let totalI = 0;
    for (const b of buffers) {
      totalV += b.vData.length / 6;
      totalI += b.iData.length;
    }
    const positions = new Float32Array(totalV * 3);
    const indices = new Uint32Array(totalI);
    let vOff = 0;
    let iOff = 0;
    let baseIdx = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let aSum = 0;
    let cN = 0;
    for (const b of buffers) {
      const tx = b.transform;
      const vN = b.vData.length / 6;
      for (let v = 0; v < vN; v++) {
        const x = b.vData[v * 6 + 0];
        const y = b.vData[v * 6 + 1];
        const z = b.vData[v * 6 + 2];
        const o = (vOff + v) * 3;
        positions[o] = tx[0] * x + tx[4] * y + tx[8] * z + tx[12];
        positions[o + 1] = tx[1] * x + tx[5] * y + tx[9] * z + tx[13];
        positions[o + 2] = tx[2] * x + tx[6] * y + tx[10] * z + tx[14];
      }
      for (let i = 0; i < b.iData.length; i++) indices[iOff + i] = b.iData[i] + baseIdx;
      vOff += vN;
      iOff += b.iData.length;
      baseIdx += vN;
      if (b.color) {
        rSum += b.color.r;
        gSum += b.color.g;
        bSum += b.color.b;
        aSum += b.color.a;
        cN++;
      }
    }
    const color = cN > 0 ? { r: rSum / cN, g: gSum / cN, b: bSum / cN, a: aSum / cN } : null;
    return { positions, indices, color };
  }
  Object.assign(window, { loadRealIfc, ensureWebIfc, readIfcSchema, isSupportedIfcSchema });
})();
