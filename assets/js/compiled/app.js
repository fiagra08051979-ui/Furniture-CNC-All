(() => {
  const SAMPLE_IFC_URL = "assets/ifc/Building-Structural.ifc";
  const SOURCE_REPO_URL = "https://github.com/isaddiq/IFC_Web_Viewer";
  const AUTHOR_URL = "https://isaddiq.github.io/";
  function viewerStateReducer(state, action) {
    switch (action.type) {
      case "select": {
        const ids = action.ids || [];
        if (action.multi) {
          const ns = new Set(state.selectedIds);
          ids.forEach((id) => {
            ns.has(id) ? ns.delete(id) : ns.add(id);
          });
          return { ...state, selectedIds: ns };
        }
        return { ...state, selectedIds: new Set(ids) };
      }
      case "clear-selection":
        return { ...state, selectedIds: /* @__PURE__ */ new Set() };
      case "toggle-hide": {
        const ns = new Set(state.hiddenIds);
        const anyHidden = action.ids.some((id) => ns.has(id));
        action.ids.forEach((id) => {
          anyHidden ? ns.delete(id) : ns.add(id);
        });
        return { ...state, hiddenIds: ns };
      }
      case "show-all":
        return { ...state, hiddenIds: /* @__PURE__ */ new Set(), isolatedIds: /* @__PURE__ */ new Set() };
      case "isolate": {
        const ns = new Set(action.ids);
        if (state.isolatedIds.size === ns.size && [...ns].every((i) => state.isolatedIds.has(i))) {
          return { ...state, isolatedIds: /* @__PURE__ */ new Set() };
        }
        return { ...state, isolatedIds: ns };
      }
      case "set-color": {
        const m = new Map(state.colorOverrides);
        if (action.color) m.set(action.id, action.color);
        else m.delete(action.id);
        return { ...state, colorOverrides: m };
      }
      case "set-opacity": {
        const m = new Map(state.opacityOverrides);
        if (action.opacity != null) m.set(action.id, action.opacity);
        else m.delete(action.id);
        return { ...state, opacityOverrides: m };
      }
      case "set-opacity-many": {
        const m = new Map(state.opacityOverrides);
        (action.ids || []).forEach((id) => {
          if (action.opacity != null) m.set(id, action.opacity);
          else m.delete(id);
        });
        return { ...state, opacityOverrides: m };
      }
      case "set-query":
        return { ...state, queryResults: action.ids, queryMatchText: action.match || {} };
      case "clear-query":
        return { ...state, queryResults: [], queryMatchText: {} };
      case "save-view": {
        const view = {
          id: Math.random().toString(36).slice(2, 9),
          name: action.name || `View ${state.savedViews.length + 1}`,
          timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
          camera: action.camera,
          hiddenIds: [...state.hiddenIds],
          isolatedIds: [...state.isolatedIds]
        };
        return { ...state, savedViews: [...state.savedViews, view] };
      }
      case "restore-view": {
        const v = state.savedViews.find((x) => x.id === action.id);
        if (!v) return state;
        return { ...state, hiddenIds: new Set(v.hiddenIds), isolatedIds: new Set(v.isolatedIds), _restoreCamera: v.camera };
      }
      case "delete-view":
        return { ...state, savedViews: state.savedViews.filter((v) => v.id !== action.id) };
      case "save-set":
        return { ...state, selectionSets: [...state.selectionSets, { id: Math.random().toString(36).slice(2, 9), name: action.name || `Set ${state.selectionSets.length + 1}`, ids: [...state.selectedIds] }] };
      case "restore-set": {
        const s = state.selectionSets.find((x) => x.id === action.id);
        if (!s) return state;
        return { ...state, selectedIds: new Set(s.ids) };
      }
      case "delete-set":
        return { ...state, selectionSets: state.selectionSets.filter((s) => s.id !== action.id) };
      case "add-anno":
        return { ...state, annotations: [...state.annotations, action.anno] };
      case "delete-anno":
        return { ...state, annotations: state.annotations.filter((a) => a.id !== action.id) };
      case "update-anno":
        return { ...state, annotations: state.annotations.map((a) => a.id === action.id ? { ...a, ...action.patch } : a) };
      case "add-measure":
        return { ...state, measurements: [...state.measurements, action.measure] };
      case "clear-measures":
        return { ...state, measurements: [] };
      case "reset":
        return initialViewerState();
      default:
        return state;
    }
  }
  function initialViewerState() {
    return {
      selectedIds: /* @__PURE__ */ new Set(),
      hiddenIds: /* @__PURE__ */ new Set(),
      isolatedIds: /* @__PURE__ */ new Set(),
      colorOverrides: /* @__PURE__ */ new Map(),
      opacityOverrides: /* @__PURE__ */ new Map(),
      queryResults: [],
      queryMatchText: {},
      savedViews: [],
      selectionSets: [],
      annotations: [],
      measurements: []
    };
  }
  const PANEL_LAYOUT_STORAGE_KEY = "ifc-viewer-panel-layout-v1";
  const DEFAULT_PANEL_LAYOUT = { left: 280, right: 340, bottom: 200 };
  function applyPanelLayoutStyles(body, layout) {
    if (!body || !layout) return;
    body.style.gridTemplateColumns = `${layout.left}px minmax(360px, 1fr) ${layout.right}px`;
    body.style.gridTemplateRows = `minmax(240px, 1fr) ${layout.bottom}px`;
    body.style.setProperty("--left-panel-width", `${layout.left}px`);
    body.style.setProperty("--right-panel-width", `${layout.right}px`);
    body.style.setProperty("--bottom-panel-height", `${layout.bottom}px`);
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function getInitialPanelLayout() {
    try {
      const raw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
      if (!raw) return DEFAULT_PANEL_LAYOUT;
      const parsed = JSON.parse(raw);
      return {
        left: clamp(Number(parsed.left) || DEFAULT_PANEL_LAYOUT.left, 220, 520),
        right: clamp(Number(parsed.right) || DEFAULT_PANEL_LAYOUT.right, 260, 620),
        bottom: clamp(Number(parsed.bottom) || DEFAULT_PANEL_LAYOUT.bottom, 120, 460)
      };
    } catch (e) {
      return DEFAULT_PANEL_LAYOUT;
    }
  }
  function runQuery(model, q) {
    const query = q.trim();
    if (!query) return { ids: [], match: {} };
    const matchText = {};
    const ids = [];
    const lower = query.toLowerCase();
    const colon = query.indexOf(":");
    let key = null, val = null;
    if (colon > 0 && colon < query.length - 1) {
      key = query.substring(0, colon).trim();
      val = query.substring(colon + 1).trim();
    }
    model.elements.forEach((el) => {
      if (el.isType) return;
      let matched = null;
      if (key) {
        for (const ps of el.propertySets) {
          for (const p of ps.properties) {
            if (p.name.toLowerCase() === key.toLowerCase()) {
              const pv = String(p.value).toLowerCase();
              if (pv.includes(val.toLowerCase())) {
                matched = `${ps.name}.${p.name} = ${p.value}`;
                break;
              }
            }
          }
          if (matched) break;
        }
        if (!matched && el.typeExpressId) {
          const typeObj = model.byId.get(el.typeExpressId);
          if (typeObj) {
            for (const ps of typeObj.propertySets) {
              for (const p of ps.properties) {
                if (p.name.toLowerCase() === key.toLowerCase() && String(p.value).toLowerCase().includes(val.toLowerCase())) {
                  matched = `${ps.name}.${p.name} (type) = ${p.value}`;
                  break;
                }
              }
              if (matched) break;
            }
          }
        }
        if (!matched) {
          for (const qs of el.quantitySets) {
            for (const p of qs.properties) {
              if (p.name.toLowerCase() === key.toLowerCase() && String(p.value).toLowerCase().includes(val.toLowerCase())) {
                matched = `${qs.name}.${p.name} = ${p.value}`;
                break;
              }
            }
            if (matched) break;
          }
        }
      } else {
        if (el.ifcClass.toLowerCase() === lower || el.ifcClass.toLowerCase().includes(lower)) {
          matched = `IFC class: ${el.ifcClass}`;
        } else if ((el.name || "").toLowerCase().includes(lower)) {
          matched = `Name: ${el.name}`;
        } else if (el.globalId.toLowerCase().includes(lower)) {
          matched = `GlobalId: ${el.globalId}`;
        } else if ((query.startsWith("#") || query.startsWith("@")) && String(el.expressId) === query.substring(1)) {
          matched = `Express ID: #${el.expressId}`;
        } else if (el.materials.some((m) => m.name.toLowerCase().includes(lower))) {
          matched = `Material: ${el.materials[0].name}`;
        } else if (el.storey && el.storey.name.toLowerCase().includes(lower)) {
          matched = `Storey: ${el.storey.name}`;
        } else if (el.classifications.some((c) => c.code.toLowerCase().includes(lower) || c.name.toLowerCase().includes(lower))) {
          matched = `Classification: ${el.classifications[0].code}`;
        } else if (el.objectType && el.objectType.toLowerCase().includes(lower)) {
          matched = `Object type: ${el.objectType}`;
        } else if (el.predefinedType && el.predefinedType.toLowerCase().includes(lower)) {
          matched = `Predefined: .${el.predefinedType}.`;
        }
      }
      if (matched) {
        ids.push(el.expressId);
        matchText[el.expressId] = matched;
      }
    });
    return { ids, match: matchText };
  }
  function ViewCube({ viewerRef }) {
    const [rot, setRot] = useState({ yaw: 30, pitch: -25 });
    useEffect(() => {
      let raf;
      const tick = () => {
        const v = viewerRef.current;
        if (v) {
          const { theta, phi } = v.getCameraOrientation();
          setRot({ yaw: -theta * 180 / Math.PI, pitch: (phi - Math.PI / 2) * 180 / Math.PI });
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, []);
    const set = (preset) => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.setCameraPreset(preset);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "view-cube-3d", title: "View cube" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-home", title: "Zoom to extents and isometric view", onClick: () => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.frameAll({ resetView: true });
    } }, /* @__PURE__ */ React.createElement(Icons.Home, { size: 13 })), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "scene",
        style: { transform: `rotateX(${rot.pitch}deg) rotateY(${rot.yaw}deg)` }
      },
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-front", title: "Front view", onClick: () => set("front") }, "Front"),
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-back", title: "Back view", onClick: () => set("back") }, "Back"),
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-right", title: "Right view", onClick: () => set("right") }, "Right"),
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-left", title: "Left view", onClick: () => set("left") }, "Left"),
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-top", title: "Top view", onClick: () => set("top") }, "Top"),
      /* @__PURE__ */ React.createElement("button", { type: "button", className: "vc-face vc-bottom", title: "Bottom view", onClick: () => set("bottom") }, "Bottom")
    ));
  }
  function SectionBoxControls({ enabled, box, bounds, onChange, onReset }) {
    if (!enabled || !box || !bounds) return null;
    const size = {
      x: Math.max(bounds.xMax - bounds.xMin, 1e-3),
      y: Math.max(bounds.yMax - bounds.yMin, 1e-3),
      z: Math.max(bounds.zMax - bounds.zMin, 1e-3)
    };
    const sides = [
      { k: "left", label: "Left", axis: "x", edge: "min", opposite: "right" },
      { k: "right", label: "Right", axis: "x", edge: "max", opposite: "left" },
      { k: "bottom", label: "Bottom", axis: "y", edge: "min", opposite: "top" },
      { k: "top", label: "Top", axis: "y", edge: "max", opposite: "bottom" },
      { k: "back", label: "Back", axis: "z", edge: "min", opposite: "front" },
      { k: "front", label: "Front", axis: "z", edge: "max", opposite: "back" }
    ];
    const cutValue = (side) => {
      const minKey = `${side.axis}Min`;
      const maxKey = `${side.axis}Max`;
      if (side.edge === "min") return (box[minKey] - bounds[minKey]) / size[side.axis];
      return (bounds[maxKey] - box[maxKey]) / size[side.axis];
    };
    const update = (side, raw) => {
      const opposite = sides.find((s) => s.k === side.opposite);
      const maxCut = Math.max(0, 0.96 - (opposite ? cutValue(opposite) : 0));
      const cut = Math.min(Math.max(parseFloat(raw) / 100 || 0, 0), maxCut);
      const next = { ...box };
      const minKey = `${side.axis}Min`;
      const maxKey = `${side.axis}Max`;
      if (side.edge === "min") next[minKey] = bounds[minKey] + size[side.axis] * cut;
      else next[maxKey] = bounds[maxKey] - size[side.axis] * cut;
      onChange(next);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "section-panel" }, /* @__PURE__ */ React.createElement("h4", null, /* @__PURE__ */ React.createElement("span", null, "Section box"), /* @__PURE__ */ React.createElement("button", { className: "reset", onClick: onReset, type: "button" }, "Reset")), /* @__PURE__ */ React.createElement("p", { className: "section-hint" }, "Drag the cube faces in the 3D view or use the sliders to cut from all six sides."), sides.map((side) => {
      const percent = Math.round(cutValue(side) * 100);
      return /* @__PURE__ */ React.createElement("div", { className: "section-axis", key: side.k }, /* @__PURE__ */ React.createElement("span", { className: "axis" }, side.label), /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "range",
          min: "0",
          max: "95",
          step: "1",
          value: percent,
          onChange: (e) => update(side, e.target.value),
          title: `${side.label} cut: ${percent}%`
        }
      ), /* @__PURE__ */ React.createElement("b", null, percent, "%"));
    }));
  }
  function TopToolbar({ model, loadProgress, viewerState, dispatch, onUpload, onLoadSample, onReset, onSearch, onOpenSummary, onOpenSchema, onOpenHelp, viewMode, onSetViewMode, onTheme }) {
    const [searchValue, setSearchValue] = useState("");
    const inputRef = useRef(null);
    useEffect(() => {
      const handler = (e) => {
        var _a;
        if ((e.ctrlKey || e.metaKey) && e.key === "f") {
          e.preventDefault();
          (_a = inputRef.current) == null ? void 0 : _a.focus();
        }
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, []);
    const submit = (e) => {
      if (e.key === "Enter") {
        onSearch(searchValue);
      } else if (e.key === "Escape") {
        setSearchValue("");
        onSearch("");
      }
    };
    return /* @__PURE__ */ React.createElement("div", { className: "toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "tb-brand" }, /* @__PURE__ */ React.createElement("img", { className: "tb-logo", src: "assets/logos/ifc-logo.png", alt: "IFC" }), /* @__PURE__ */ React.createElement("div", { className: "tb-name" }, "IFC Static Web Viewer")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", onClick: onUpload }, /* @__PURE__ */ React.createElement(Icons.Upload, { size: 12 }), "Load IFC"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: onLoadSample, title: "Open the sample IFC from the old viewer" }, /* @__PURE__ */ React.createElement(Icons.Cube, { size: 12 }), "Sample"), model && /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: onReset, title: "Close model" }, /* @__PURE__ */ React.createElement(Icons.Reset, { size: 12 }), "Reset"), model && /* @__PURE__ */ React.createElement("div", { className: "tb-file" }, /* @__PURE__ */ React.createElement(Icons.Cube, { size: 12, style: { color: "var(--accent)" } }), /* @__PURE__ */ React.createElement("span", { className: "tb-file-name" }, model.fileName), /* @__PURE__ */ React.createElement("span", { className: "tb-file-meta" }, formatSize(model.fileSize), " \xB7 ", model.schemaVersion, " \xB7 ", model.elements.length.toLocaleString(), " elements"), loadProgress < 1 && /* @__PURE__ */ React.createElement("div", { className: "tb-progress" }, /* @__PURE__ */ React.createElement("div", { style: { width: `${loadProgress * 100}%` } }))), model && /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: onOpenSummary, title: "View model summary" }, /* @__PURE__ */ React.createElement(Icons.Info, { size: 12 }), "Summary"), /* @__PURE__ */ React.createElement("div", { className: "tb-spacer" }), model && /* @__PURE__ */ React.createElement("span", { style: { display: "contents" } }, /* @__PURE__ */ React.createElement("div", { className: "btn-group" }, /* @__PURE__ */ React.createElement("button", { className: "btn", "data-active": viewMode === "shaded", title: "Shaded", onClick: () => onSetViewMode("shaded") }, /* @__PURE__ */ React.createElement(Icons.Shaded, { size: 12 })), /* @__PURE__ */ React.createElement("button", { className: "btn", "data-active": viewMode === "xray", title: "X-Ray", onClick: () => onSetViewMode("xray") }, /* @__PURE__ */ React.createElement(Icons.Xray, { size: 12 })), /* @__PURE__ */ React.createElement("button", { className: "btn", "data-active": viewMode === "wireframe", title: "Wireframe", onClick: () => onSetViewMode("wireframe") }, /* @__PURE__ */ React.createElement(Icons.Wireframe, { size: 12 })))), /* @__PURE__ */ React.createElement("div", { className: "tb-search" }, /* @__PURE__ */ React.createElement(Icons.Search, { size: 11, style: { color: "var(--fg-3)" } }), /* @__PURE__ */ React.createElement(
      "input",
      {
        ref: inputRef,
        placeholder: 'Search: IfcWall, GUID, "FireRating:REI 90", #expressId\u2026',
        value: searchValue,
        onChange: (e) => setSearchValue(e.target.value),
        onKeyDown: submit,
        disabled: !model
      }
    ), searchValue ? /* @__PURE__ */ React.createElement("button", { className: "tree-action", onClick: () => {
      setSearchValue("");
      onSearch("");
    } }, /* @__PURE__ */ React.createElement(Icons.X, { size: 10 })) : /* @__PURE__ */ React.createElement("kbd", null, "\u2318F")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", disabled: !model, onClick: onOpenSchema, title: "IFC schema explorer" }, /* @__PURE__ */ React.createElement(Icons.Schema, { size: 13 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: `Switch to ${onTheme.value === "light" ? "dark" : "light"} mode`, onClick: () => onTheme.set(onTheme.value === "light" ? "dark" : "light") }, onTheme.value === "light" ? /* @__PURE__ */ React.createElement(Icons.Moon, { size: 13 }) : /* @__PURE__ */ React.createElement(Icons.Sun, { size: 13 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Help", onClick: onOpenHelp }, /* @__PURE__ */ React.createElement(Icons.Help, { size: 13 })), /* @__PURE__ */ React.createElement("a", { className: "btn btn-ghost", href: SOURCE_REPO_URL, target: "_blank", rel: "noopener noreferrer", title: "GitHub repository" }, /* @__PURE__ */ React.createElement(Icons.Code, { size: 12 }), "Source"), /* @__PURE__ */ React.createElement("a", { className: "btn btn-ghost btn-icon", href: AUTHOR_URL, target: "_blank", rel: "noopener noreferrer", title: "Author site" }, /* @__PURE__ */ React.createElement(Icons.Globe, { size: 13 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", title: "Visitor statistics", onClick: () => {
      var _a;
      return (_a = document.getElementById("vc-popover")) == null ? void 0 : _a.classList.toggle("vc-open");
    } }, /* @__PURE__ */ React.createElement(Icons.Globe, { size: 12 }), "Visitors"));
  }
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  function ViewerCanvas({
    model,
    viewerState,
    dispatch,
    viewMode,
    showEdges,
    showAxes,
    explode,
    sectionEnabled,
    sectionBox,
    onSectionBoxChange,
    measureMode,
    annoMode,
    hoverId,
    onSetHoverId,
    lastMeasure,
    onContext,
    toast,
    viewerRef,
    selectedStoreyId,
    slabsTransparent,
    onStoreyChange,
    onToggleSlabsTransparent,
    onFocusMEP,
    onFocusBeams,
    onResetOldViewerTools,
    secondaryLoading
  }) {
    const hostRef = useRef(null);
    const [annoPositions, setAnnoPositions] = useState([]);
    const [modelBounds, setModelBounds] = useState(null);
    useEffect(() => {
      if (!hostRef.current) return;
      const v = new ThreeViewer(hostRef.current);
      viewerRef.current = v;
      window.__viewer = v;
      v.on("pick", (e) => {
        if (e.expressId == null) {
          if (!e.multi) dispatch({ type: "clear-selection" });
          return;
        }
        dispatch({ type: "select", ids: [e.expressId], multi: e.multi });
      });
      v.on("hover", (e) => onSetHoverId(e.expressId));
      v.on("measure", (m) => {
        dispatch({ type: "add-measure", measure: { id: Math.random().toString(36).slice(2, 9), distance: m.distance, a: m.a.toArray(), b: m.b.toArray() } });
        toast({ kind: "ok", msg: "Distance measured", sub: `${m.distance.toFixed(3)} m` });
      });
      v.on("sectionBox", ({ box }) => onSectionBoxChange(box));
      v.on("anno", (e) => {
        const anno = {
          id: Math.random().toString(36).slice(2, 9),
          position: e.position.toArray(),
          elementId: e.elementId,
          title: "New issue",
          description: "",
          status: "open",
          priority: "medium",
          author: "You",
          timestamp: (/* @__PURE__ */ new Date()).toLocaleString()
        };
        dispatch({ type: "add-anno", anno });
        toast({ kind: "info", msg: "Annotation created", sub: "Edit the details in the issues panel" });
      });
      return () => {
        v.dispose();
        viewerRef.current = null;
        window.__viewer = null;
      };
    }, []);
    useEffect(() => {
      if (!viewerRef.current) return;
      if (!model) {
        setModelBounds(null);
        return;
      }
      window.__currentModel = model;
      setModelBounds(null);
      (async () => {
        await viewerRef.current.loadModel(model);
        const b = viewerRef.current.getModelBounds();
        if (b) setModelBounds(b);
      })();
    }, [model]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setSelection(viewerState.selectedIds);
    }, [viewerState.selectedIds]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setHidden(viewerState.hiddenIds);
    }, [viewerState.hiddenIds]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setIsolated(viewerState.isolatedIds);
    }, [viewerState.isolatedIds]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setColorOverrides(viewerState.colorOverrides);
    }, [viewerState.colorOverrides]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setOpacityOverrides(viewerState.opacityOverrides);
    }, [viewerState.opacityOverrides]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setHover(hoverId ? [hoverId] : []);
    }, [hoverId]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setViewMode(viewMode);
    }, [viewMode]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setShowEdges(showEdges);
    }, [showEdges]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setShowAxes(showAxes);
    }, [showAxes]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setExplode(explode);
    }, [explode]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setSectionBox(sectionEnabled, sectionBox, modelBounds);
    }, [sectionEnabled, sectionBox, modelBounds]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setMeasureMode(measureMode);
    }, [measureMode]);
    useEffect(() => {
      var _a;
      (_a = viewerRef.current) == null ? void 0 : _a.setAnnotationMode(annoMode);
    }, [annoMode]);
    useEffect(() => {
      if (!viewerRef.current) return;
      let raf;
      const update = () => {
        const v = viewerRef.current;
        if (v) {
          setAnnoPositions(viewerState.annotations.map((a) => {
            const w = new THREE.Vector3().fromArray(a.position);
            const s = v.worldToScreen(w);
            return { ...a, screen: s };
          }));
        }
        raf = requestAnimationFrame(update);
      };
      raf = requestAnimationFrame(update);
      return () => cancelAnimationFrame(raf);
    }, [viewerState.annotations]);
    return /* @__PURE__ */ React.createElement("div", { className: "viewer-wrap", ref: hostRef, onContextMenu: onContext }, /* @__PURE__ */ React.createElement("div", { className: "viewer-overlay" }, model && /* @__PURE__ */ React.createElement("div", { className: "viewer-hud" }, /* @__PURE__ */ React.createElement("div", { className: "viewer-left-rail", "aria-label": "Viewer tools" }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Zoom to extents", onClick: () => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.frameAll();
    } }, /* @__PURE__ */ React.createElement(Icons.Globe, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Zoom to selection (F)", onClick: () => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.frameElements([...viewerState.selectedIds]);
    }, disabled: viewerState.selectedIds.size === 0 }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Zoom in", onClick: () => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.zoomIn();
    } }, /* @__PURE__ */ React.createElement(Icons.Plus, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Zoom out", onClick: () => {
      var _a;
      return (_a = viewerRef.current) == null ? void 0 : _a.zoomOut();
    } }, /* @__PURE__ */ React.createElement(Icons.Minus, { size: 16 })), /* @__PURE__ */ React.createElement("div", { className: "sep" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Show all (A)", onClick: () => dispatch({ type: "show-all" }) }, /* @__PURE__ */ React.createElement(Icons.Eye, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Hide selected (H)", disabled: viewerState.selectedIds.size === 0, onClick: () => dispatch({ type: "toggle-hide", ids: [...viewerState.selectedIds] }) }, /* @__PURE__ */ React.createElement(Icons.EyeOff, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Isolate selected (I)", disabled: viewerState.selectedIds.size === 0, onClick: () => dispatch({ type: "isolate", ids: [...viewerState.selectedIds] }) }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 16 })), /* @__PURE__ */ React.createElement("div", { className: "sep" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", "data-active": sectionEnabled, title: "Section box (S)", onClick: () => window.__toggleSection() }, /* @__PURE__ */ React.createElement(Icons.Section, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", "data-active": measureMode, title: "Measure", onClick: () => window.__toggleMeasure() }, /* @__PURE__ */ React.createElement(Icons.Ruler, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", "data-active": annoMode, title: "Annotate", onClick: () => window.__toggleAnno() }, /* @__PURE__ */ React.createElement(Icons.Pin, { size: 16 })), /* @__PURE__ */ React.createElement("div", { className: "sep" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", "data-active": showEdges, title: "Toggle edges", onClick: () => window.__toggleEdges() }, /* @__PURE__ */ React.createElement(Icons.Edge, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", "data-active": showAxes, title: showAxes ? "Hide axis" : "Show axis", onClick: () => window.__toggleAxes() }, /* @__PURE__ */ React.createElement(Icons.Move, { size: 16 })), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Screenshot", onClick: () => {
      const d = viewerRef.current.screenshot();
      const a = document.createElement("a");
      a.href = d;
      a.download = "ifc-screenshot.png";
      a.click();
      toast({ kind: "ok", msg: "Screenshot saved", sub: "ifc-screenshot.png" });
    } }, /* @__PURE__ */ React.createElement(Icons.Camera, { size: 16 }))), /* @__PURE__ */ React.createElement("div", { className: "old-viewer-tools", "aria-label": "Old viewer navigation and visibility tools" }, /* @__PURE__ */ React.createElement(
      "select",
      {
        value: selectedStoreyId,
        onChange: (e) => onStoreyChange(e.target.value),
        title: "Storey navigation"
      },
      /* @__PURE__ */ React.createElement("option", { value: "all" }, "All levels"),
      model.storeys.map((storey) => /* @__PURE__ */ React.createElement("option", { key: storey.expressId, value: storey.expressId }, storey.name || `Storey ${storey.expressId}`))
    ), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", "data-active": slabsTransparent, title: "Make slabs and coverings transparent", onClick: onToggleSlabsTransparent }, /* @__PURE__ */ React.createElement(Icons.Layer, { size: 14 }), " Slabs"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", title: "Isolate distribution and MEP elements", onClick: onFocusMEP }, /* @__PURE__ */ React.createElement(Icons.Relationship, { size: 14 }), " MEP"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", title: "Isolate beams and structural members", onClick: onFocusBeams }, /* @__PURE__ */ React.createElement(Icons.Box, { size: 14 }), " Beams"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", title: "Reset old viewer filters", onClick: onResetOldViewerTools }, /* @__PURE__ */ React.createElement(Icons.Reset, { size: 14 }))), /* @__PURE__ */ React.createElement("div", { className: "viewer-nav-corner" }, /* @__PURE__ */ React.createElement(ViewCube, { viewerRef })), /* @__PURE__ */ React.createElement("div", { className: "viewer-mode-pill" }, /* @__PURE__ */ React.createElement("span", { className: "dot" }), /* @__PURE__ */ React.createElement("span", null, viewMode === "shaded" ? "Shaded" : viewMode === "xray" ? "X-Ray" : "Wireframe"), sectionEnabled && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--accent)" } }, "\xB7 section box"), measureMode && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--accent)" } }, "\xB7 measure"), annoMode && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--accent)" } }, "\xB7 annotate")), secondaryLoading && /* @__PURE__ */ React.createElement("div", { className: "viewer-secondary-pill" }, /* @__PURE__ */ React.createElement("div", { className: "spin viewer-secondary-spin" }), /* @__PURE__ */ React.createElement("span", null, "Indexing properties\u2026")), sectionEnabled && modelBounds && sectionBox && /* @__PURE__ */ React.createElement("div", { className: "viewer-section-overlay" }, /* @__PURE__ */ React.createElement(
      SectionBoxControls,
      {
        enabled: sectionEnabled,
        box: sectionBox,
        bounds: modelBounds,
        onChange: onSectionBoxChange,
        onReset: () => onSectionBoxChange({ ...modelBounds })
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "viewer-bottom-tools" }, /* @__PURE__ */ React.createElement("div", { className: "viewer-exploded" }, /* @__PURE__ */ React.createElement("label", null, /* @__PURE__ */ React.createElement("span", null, "Exploded view"), /* @__PURE__ */ React.createElement("span", { className: "v" }, (explode * 100).toFixed(0), "%")), /* @__PURE__ */ React.createElement("input", { type: "range", min: "0", max: "1", step: "0.01", value: explode, onChange: (e) => window.__setExplode(parseFloat(e.target.value)) }))), annoPositions.map((a) => a.screen.behind ? null : /* @__PURE__ */ React.createElement(
      "div",
      {
        key: a.id,
        className: "anno-pin",
        "data-status": a.status === "resolved" ? "resolved" : a.status === "progress" ? "progress" : "open",
        style: { left: a.screen.x, top: a.screen.y },
        title: a.title,
        onClick: () => window.__editAnno && window.__editAnno(a.id)
      },
      /* @__PURE__ */ React.createElement("span", null, viewerState.annotations.findIndex((x) => x.id === a.id) + 1)
    )))));
  }
  function StartDashboard({ onLoadDemo, onUpload, onLoadFile }) {
    const [dragOver, setDragOver] = useState(false);
    return /* @__PURE__ */ React.createElement("div", { className: "dash" }, /* @__PURE__ */ React.createElement("div", { className: "dash-inner" }, /* @__PURE__ */ React.createElement("div", { className: "dash-hero" }, /* @__PURE__ */ React.createElement("h1", null, "Inspect any IFC model in your browser."), /* @__PURE__ */ React.createElement("p", null, "Open an Industry Foundation Classes file to explore its geometry, hierarchy, property sets, and schema relationships. Everything runs locally \u2014 your model never leaves the browser.")), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "dropzone",
        "data-over": dragOver,
        onClick: onUpload,
        onDragOver: (e) => {
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e) => {
          var _a, _b;
          e.preventDefault();
          setDragOver(false);
          const file = (_b = (_a = e.dataTransfer) == null ? void 0 : _a.files) == null ? void 0 : _b[0];
          if (file) onLoadFile(file, "Dropped file");
          else onUpload();
        }
      },
      /* @__PURE__ */ React.createElement("div", { className: "icon" }, /* @__PURE__ */ React.createElement(Icons.Upload, { size: 20 })),
      /* @__PURE__ */ React.createElement("h3", null, "Drop an IFC file or click to browse"),
      /* @__PURE__ */ React.createElement("p", null, "The file is parsed locally with web-ifc WASM. Geometry stays out of React state for predictable performance on large models."),
      /* @__PURE__ */ React.createElement("div", { className: "formats" }, /* @__PURE__ */ React.createElement("span", null, ".ifc"), /* @__PURE__ */ React.createElement("span", null, ".ifcXML"), /* @__PURE__ */ React.createElement("span", null, ".ifcZIP"), /* @__PURE__ */ React.createElement("span", { style: { borderColor: "var(--accent-line)", color: "var(--accent)" } }, "IFC2x3 \xB7 IFC4 \xB7 IFC4.3"))
    ), /* @__PURE__ */ React.createElement("div", { className: "dash-tip" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("kbd", null, "O"), " open"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("kbd", null, "?"), " shortcuts"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("kbd", null, "Esc"), " clear selection")), /* @__PURE__ */ React.createElement("div", { className: "dash-recent" }, /* @__PURE__ */ React.createElement("h4", null, "Try the old viewer sample"), /* @__PURE__ */ React.createElement("div", { className: "dash-recent-list" }, /* @__PURE__ */ React.createElement("div", { className: "dash-recent-row", onClick: onLoadDemo }, /* @__PURE__ */ React.createElement(Icons.Cube, { size: 14, style: { color: "var(--accent)" } }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "name" }, "Building-Structural.ifc"), /* @__PURE__ */ React.createElement("div", { className: "meta" }, "Loaded from the old IFC_Web_Viewer sample assets")), /* @__PURE__ */ React.createElement("div", { className: "meta" }, "289 KB"), /* @__PURE__ */ React.createElement(Icons.ChevronRight, { size: 12, style: { color: "var(--fg-3)" } }))))));
  }
  const LOAD_STEPS = [
    "Validate file extension and size",
    "Initialize web-ifc WASM runtime",
    "Parse STEP header and schema",
    "Decode geometric representations",
    "Build Three.js scene graph",
    "Extract spatial hierarchy",
    "Index entity types",
    "Extract property sets and quantities",
    "Resolve materials and classifications",
    "Map relationships and types",
    "Build searchable indexes",
    "Hand off to renderer"
  ];
  function LoadingOverlay({ visible, fileName, progress }) {
    if (!visible) return null;
    const currentStep = Math.floor(progress * LOAD_STEPS.length);
    return /* @__PURE__ */ React.createElement("div", { className: "load-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "load-card" }, /* @__PURE__ */ React.createElement("h3", null, "Loading IFC model"), /* @__PURE__ */ React.createElement("div", { className: "file" }, fileName), /* @__PURE__ */ React.createElement("div", { className: "load-bar" }, /* @__PURE__ */ React.createElement("div", { style: { width: `${progress * 100}%` } })), /* @__PURE__ */ React.createElement("div", { className: "load-steps" }, LOAD_STEPS.map((s, i) => {
      const state = i < currentStep ? "done" : i === currentStep ? "doing" : "todo";
      return /* @__PURE__ */ React.createElement("div", { key: i, className: "load-step", "data-state": state }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, state === "done" ? /* @__PURE__ */ React.createElement(Icons.Check, { size: 9 }) : state === "doing" ? /* @__PURE__ */ React.createElement("div", { className: "spin", style: { width: 8, height: 8, border: "1.5px solid currentColor", borderTopColor: "transparent", borderRadius: "50%" } }) : /* @__PURE__ */ React.createElement("span", { style: { width: 4, height: 4, background: "currentColor", borderRadius: "50%" } })), /* @__PURE__ */ React.createElement("span", null, s));
    }))));
  }
  function SummaryCard({ model, onClose }) {
    if (!model) return null;
    const classCounts = useMemo(() => {
      const m = /* @__PURE__ */ new Map();
      model.elements.forEach((e) => {
        if (!e.isType) m.set(e.ifcClass, (m.get(e.ifcClass) || 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    }, [model]);
    const missingNames = model.elements.filter((e) => !e.isType && (!e.name || e.name.trim() === "")).length;
    const spaces = model.elements.filter((e) => e.ifcClass === "IfcSpace").length;
    return /* @__PURE__ */ React.createElement("div", { className: "modal-backdrop summary-backdrop", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "summary-card", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "summary-card-head" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", null, model.fileName), /* @__PURE__ */ React.createElement("div", { className: "sub" }, model.schemaVersion, " \xB7 ", formatSize(model.fileSize), " \xB7 loaded ", (/* @__PURE__ */ new Date()).toLocaleTimeString())), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", onClick: onClose }, /* @__PURE__ */ React.createElement(Icons.X, { size: 12 }))), /* @__PURE__ */ React.createElement("div", { className: "summary-stats" }, /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Entities"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.totalEntities.toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Geometry items"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.totalGeometryItems)), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Storeys"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.storeys.length)), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Spaces"), /* @__PURE__ */ React.createElement("div", { className: "v" }, spaces)), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Classes"), /* @__PURE__ */ React.createElement("div", { className: "v" }, classCounts.length)), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Property sets"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.elements.reduce((a, e) => a + e.propertySets.length, 0))), /* @__PURE__ */ React.createElement("div", { className: "summary-stat" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Relationships"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.relationships.length)), /* @__PURE__ */ React.createElement("div", { className: "summary-stat", style: { background: missingNames ? "oklch(0.82 0.13 80 / 0.1)" : "var(--bg-2)" } }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Missing names"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { color: missingNames ? "var(--warn)" : "var(--fg-0)" } }, missingNames))), /* @__PURE__ */ React.createElement("div", { className: "summary-classes" }, /* @__PURE__ */ React.createElement("h4", null, "Top 10 IFC classes by count"), /* @__PURE__ */ React.createElement("ul", null, classCounts.map(([cls, n]) => /* @__PURE__ */ React.createElement("li", { key: cls }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(cls) } }), /* @__PURE__ */ React.createElement("span", { className: "lbl" }, cls), /* @__PURE__ */ React.createElement("span", { className: "cnt" }, n)))))));
  }
  function HelpPanel({ onClose }) {
    const shortcuts = [
      ["F", "Fit selected"],
      ["A", "Show all"],
      ["H", "Hide selected"],
      ["I", "Isolate selected"],
      ["Esc", "Clear selection"],
      ["Ctrl + F", "Focus search"],
      ["M", "Measurement mode"],
      ["S", "Section box (6 sides)"],
      ["E", "Toggle edges"],
      ["X", "Toggle x-ray"],
      ["W", "Toggle wireframe"],
      ["1\u20136", "Camera presets"],
      ["?", "This help panel"],
      ["Right-click", "Context menu"]
    ];
    return /* @__PURE__ */ React.createElement("div", { className: "modal-backdrop", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "kbd-panel", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("h2", null, "Keyboard shortcuts"), /* @__PURE__ */ React.createElement("div", { className: "kbd-grid" }, shortcuts.map(([k, l]) => /* @__PURE__ */ React.createElement("div", { key: k, className: "row" }, /* @__PURE__ */ React.createElement("span", { className: "l" }, l), /* @__PURE__ */ React.createElement("span", { className: "k" }, k)))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 18, fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 } }, /* @__PURE__ */ React.createElement("strong", { style: { color: "var(--fg-0)" } }, "Mouse:"), " Left-click picks. Ctrl/Shift+click multi-selects. Middle-drag or Shift+drag pans. Right-drag orbits. Wheel zooms. Right-click for context menu.")));
  }
  function ToastContainer({ toasts }) {
    return /* @__PURE__ */ React.createElement("div", { className: "toasts" }, toasts.map((t) => /* @__PURE__ */ React.createElement("div", { key: t.id, className: `toast ${t.kind || "info"}` }, /* @__PURE__ */ React.createElement("div", { className: "ic" }, t.kind === "ok" ? /* @__PURE__ */ React.createElement(Icons.Check, { size: 11 }) : t.kind === "warn" ? /* @__PURE__ */ React.createElement(Icons.Alert, { size: 11 }) : t.kind === "error" ? /* @__PURE__ */ React.createElement(Icons.X, { size: 11 }) : /* @__PURE__ */ React.createElement(Icons.Info, { size: 11 })), /* @__PURE__ */ React.createElement("div", { className: "msg" }, /* @__PURE__ */ React.createElement("div", null, t.msg), t.sub && /* @__PURE__ */ React.createElement("div", { className: "sub" }, t.sub)))));
  }
  function ContextMenu({ menu, onClose, dispatch, onZoomTo, model, toast }) {
    if (!menu) return null;
    const ids = menu.ids;
    return /* @__PURE__ */ React.createElement("div", { className: "ctx-menu", style: { left: menu.x, top: menu.y }, onMouseLeave: onClose }, /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      dispatch({ type: "select", ids });
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Check, { size: 11 }), " Select ", ids.length > 1 ? `${ids.length} items` : "", " ", /* @__PURE__ */ React.createElement("span", { className: "sc" }, "Click")), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      onZoomTo(ids);
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 }), " Zoom to ", /* @__PURE__ */ React.createElement("span", { className: "sc" }, "F")), /* @__PURE__ */ React.createElement("div", { className: "sep" }), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      dispatch({ type: "isolate", ids });
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 11 }), " Isolate ", /* @__PURE__ */ React.createElement("span", { className: "sc" }, "I")), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      dispatch({ type: "toggle-hide", ids });
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.EyeOff, { size: 11 }), " Hide ", /* @__PURE__ */ React.createElement("span", { className: "sc" }, "H")), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      dispatch({ type: "show-all" });
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Eye, { size: 11 }), " Show all ", /* @__PURE__ */ React.createElement("span", { className: "sc" }, "A")), /* @__PURE__ */ React.createElement("div", { className: "sep" }), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      var _a;
      const el = model.byId.get(ids[0]);
      if (el) {
        (_a = navigator.clipboard) == null ? void 0 : _a.writeText(el.globalId);
        toast({ kind: "ok", msg: "GlobalId copied" });
      }
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Copy, { size: 11 }), " Copy GlobalId"), /* @__PURE__ */ React.createElement("div", { className: "item", onClick: () => {
      const rows = ids.map((id) => model.byId.get(id)).filter(Boolean);
      exportJSON(rows, toast);
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Export, { size: 11 }), " Export as JSON"));
  }
  function App() {
    const [theme, setTheme] = useState("light");
    const [model, setModel] = useState(null);
    const [loading, setLoading] = useState(null);
    const [showSummary, setShowSummary] = useState(false);
    const [showSchema, setShowSchema] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [viewMode, setViewMode] = useState("shaded");
    const [showEdges, setShowEdges] = useState(false);
    const [showAxes, setShowAxes] = useState(true);
    const [explode, setExplode] = useState(0);
    const [sectionEnabled, setSectionEnabled] = useState(false);
    const [sectionBox, setSectionBox] = useState(null);
    const [measureMode, setMeasureMode] = useState(false);
    const [annoMode, setAnnoMode] = useState(false);
    const [secondaryLoading, setSecondaryLoading] = useState(false);
    const [hoverId, setHoverId] = useState(null);
    const [log, setLog] = useState([]);
    const [toasts, setToasts] = useState([]);
    const [contextMenu, setContextMenu] = useState(null);
    const [viewerState, dispatch] = useReducer(viewerStateReducer, void 0, initialViewerState);
    const [panelLayout, setPanelLayout] = useState(getInitialPanelLayout);
    const [selectedStoreyId, setSelectedStoreyId] = useState("all");
    const [slabsTransparent, setSlabsTransparent] = useState(false);
    const fileInputRef = useRef(null);
    const viewerRef = useRef(null);
    const appBodyRef = useRef(null);
    const panelLayoutDragRef = useRef(null);
    useEffect(() => {
      try {
        localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(panelLayout));
      } catch (e) {
      }
    }, [panelLayout]);
    const startPanelResize = useCallback((edge, e) => {
      if (!model) return;
      e.preventDefault();
      const body = appBodyRef.current;
      const rect = body == null ? void 0 : body.getBoundingClientRect();
      const start = { ...panelLayout };
      const startX = e.clientX;
      const startY = e.clientY;
      document.body.classList.add("is-resizing-layout");
      const layoutFromPointer = (ev) => {
        const width = (rect == null ? void 0 : rect.width) || window.innerWidth;
        const height = (rect == null ? void 0 : rect.height) || window.innerHeight;
        const next = { ...start };
        if (edge === "left") {
          const maxLeft = Math.max(220, width - start.right - 420);
          next.left = clamp(start.left + ev.clientX - startX, 220, maxLeft);
        } else if (edge === "right") {
          const maxRight = Math.max(260, width - start.left - 420);
          next.right = clamp(start.right - (ev.clientX - startX), 260, maxRight);
        } else if (edge === "bottom") {
          const maxBottom = Math.max(120, height - 260);
          next.bottom = clamp(start.bottom - (ev.clientY - startY), 120, Math.min(460, maxBottom));
        }
        return next;
      };
      const onMove = (ev) => {
        var _a, _b;
        const next = layoutFromPointer(ev);
        panelLayoutDragRef.current = next;
        applyPanelLayoutStyles(body, next);
        (_b = (_a = viewerRef.current) == null ? void 0 : _a.scheduleResize) == null ? void 0 : _b.call(_a);
      };
      const onUp = () => {
        document.body.classList.remove("is-resizing-layout");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const finalLayout = panelLayoutDragRef.current || start;
        panelLayoutDragRef.current = null;
        setPanelLayout(finalLayout);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    }, [model, panelLayout]);
    const resetPanelLayout = useCallback(() => {
      setPanelLayout(DEFAULT_PANEL_LAYOUT);
    }, []);
    useEffect(() => {
      const warmup = () => {
        var _a, _b;
        (_b = (_a = window.ensureWebIfc) == null ? void 0 : _a.call(window, () => {
        })) == null ? void 0 : _b.catch(() => {
        });
      };
      let handle;
      if (typeof requestIdleCallback !== "undefined") {
        handle = requestIdleCallback(warmup, { timeout: 2e3 });
        return () => cancelIdleCallback(handle);
      } else {
        handle = setTimeout(warmup, 50);
        return () => clearTimeout(handle);
      }
    }, []);
    const toast = useCallback((t) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((ts) => [...ts, { ...t, id }]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3e3);
    }, []);
    const addLog = useCallback((level, msg) => {
      setLog((l) => [...l, { time: (/* @__PURE__ */ new Date()).toLocaleTimeString(), level, msg }]);
    }, []);
    const loadIfcFile = useCallback(async (file, sourceLabel = "User selected") => {
      var _a, _b, _c;
      if (!file) return;
      if (!/\.(ifc|ifcxml|ifczip)$/i.test(file.name)) {
        toast({ kind: "error", msg: "Unsupported file", sub: "Please choose a .ifc / .ifcxml / .ifczip file" });
        return;
      }
      (_a = model == null ? void 0 : model.close) == null ? void 0 : _a.call(model);
      window.__currentModel = null;
      setModel(null);
      setShowSummary(false);
      setShowSchema(false);
      setLog([]);
      dispatch({ type: "reset" });
      setSelectedStoreyId("all");
      setSlabsTransparent(false);
      setExplode(0);
      setSectionEnabled(false);
      setSectionBox(null);
      setMeasureMode(false);
      setAnnoMode(false);
      setLoading({ fileName: file.name, progress: 0.01 });
      addLog("info", `${sourceLabel} <span class="hl">${file.name}</span> (${formatSize(file.size)})`);
      try {
        addLog("info", "Checking IFC schema from STEP header");
        const schema = await ((_b = window.readIfcSchema) == null ? void 0 : _b.call(window, file));
        if (schema) {
          addLog("ok", `Schema header: <span class="hl">${schema}</span>`);
          if (!((_c = window.isSupportedIfcSchema) == null ? void 0 : _c.call(window, schema))) {
            throw new Error(`Unsupported schema: ${schema}. Supported: IFC2X3, IFC4 and IFC4X3.`);
          }
        } else {
          addLog("warn", "Schema header not found before parse; web-ifc will detect it during load");
        }
        addLog("info", "Initializing web-ifc and streaming geometry");
        const m = await window.loadRealIfc(file, {
          onProgress: (p) => setLoading({ fileName: file.name, progress: p }),
          onLog: addLog
        });
        addLog("ok", `Indexed <span class="hl">${m.elements.length}</span> elements \xB7 <span class="hl">${m.totalGeometryItems}</span> with geometry \xB7 <span class="hl">${m.relationships.length}</span> relationships`);
        setModel(m);
        setLoading(null);
        if (m._ensureSecondaryData) {
          setSecondaryLoading(true);
          m._ensureSecondaryData().finally(() => setSecondaryLoading(false));
        }
        toast({ kind: "ok", msg: "Model loaded", sub: `${m.elements.length} elements \xB7 ${m.schemaVersion}` });
      } catch (err) {
        console.error(err);
        addLog("error", `Failed to load IFC: ${err.message || err}`);
        setLoading(null);
        toast({ kind: "error", msg: "IFC load failed", sub: String(err.message || err).slice(0, 80) });
      }
    }, [addLog, toast, model]);
    const loadDemoModel = useCallback(async () => {
      try {
        const response = await fetch(SAMPLE_IFC_URL);
        if (!response.ok) throw new Error(`Sample file returned HTTP ${response.status}`);
        const blob = await response.blob();
        const file = new File([blob], "Building-Structural.ifc", { type: "application/octet-stream" });
        await loadIfcFile(file, "Opened old viewer sample");
      } catch (err) {
        console.error(err);
        addLog("error", `Failed to open sample IFC: ${err.message || err}`);
        toast({ kind: "error", msg: "Sample load failed", sub: String(err.message || err).slice(0, 80) });
      }
    }, [addLog, loadIfcFile, toast]);
    const onUpload = useCallback(() => {
      var _a;
      (_a = fileInputRef.current) == null ? void 0 : _a.click();
    }, []);
    const onFileSelected = async (e) => {
      var _a;
      const file = (_a = e.target.files) == null ? void 0 : _a[0];
      await loadIfcFile(file);
      e.target.value = "";
    };
    useEffect(() => {
      document.body.setAttribute("data-theme", theme);
      if (window.__viewer) window.__viewer.setTheme(theme);
    }, [theme]);
    const onReset = useCallback(() => {
      var _a;
      (_a = model == null ? void 0 : model.close) == null ? void 0 : _a.call(model);
      window.__currentModel = null;
      setModel(null);
      setLog([]);
      setSecondaryLoading(false);
      dispatch({ type: "reset" });
      setSelectedStoreyId("all");
      setSlabsTransparent(false);
      setExplode(0);
      setSectionEnabled(false);
      setSectionBox(null);
      setMeasureMode(false);
      setAnnoMode(false);
      setShowSummary(false);
      toast({ kind: "info", msg: "Model closed" });
    }, [model, toast]);
    const onPick = useCallback((id, e) => {
      const multi = e && (e.ctrlKey || e.metaKey || e.shiftKey);
      dispatch({ type: "select", ids: [id], multi });
    }, []);
    const onZoomTo = useCallback((ids) => {
      var _a;
      (_a = window.__viewer) == null ? void 0 : _a.frameElements(ids);
    }, []);
    const focusIdsFromOldViewerTool = useCallback((ids, label) => {
      var _a;
      if (!ids.length) {
        toast({ kind: "warn", msg: "No matching elements", sub: label });
        return;
      }
      dispatch({ type: "isolate", ids });
      (_a = window.__viewer) == null ? void 0 : _a.frameElements(ids);
      toast({ kind: "info", msg: label, sub: `${ids.length} element${ids.length === 1 ? "" : "s"}` });
    }, [toast]);
    const onStoreyChange = useCallback((storeyId) => {
      var _a;
      setSelectedStoreyId(storeyId);
      if (!model) return;
      if (storeyId === "all") {
        dispatch({ type: "isolate", ids: [] });
        (_a = window.__viewer) == null ? void 0 : _a.frameAll();
        return;
      }
      const numericId = Number(storeyId);
      const ids = model.elements.filter((el) => {
        var _a2;
        return !el.isType && el.geometry && ((_a2 = el.storey) == null ? void 0 : _a2.expressId) === numericId;
      }).map((el) => el.expressId);
      const storey = model.storeys.find((s) => s.expressId === numericId);
      focusIdsFromOldViewerTool(ids, (storey == null ? void 0 : storey.name) || "Storey");
    }, [focusIdsFromOldViewerTool, model]);
    const onToggleSlabsTransparent = useCallback(() => {
      if (!model) return;
      const ids = model.elements.filter((el) => ["IfcSlab", "IfcSlabStandardCase", "IfcSlabElementedCase", "IfcCovering", "IfcRoof"].includes(el.ifcClass)).map((el) => el.expressId);
      setSlabsTransparent((value) => {
        const next = !value;
        dispatch({ type: "set-opacity-many", ids, opacity: next ? 0.18 : null });
        toast({ kind: "info", msg: next ? "Slabs transparent" : "Slabs restored", sub: `${ids.length} element${ids.length === 1 ? "" : "s"}` });
        return next;
      });
    }, [model, toast]);
    const onFocusMEP = useCallback(() => {
      if (!model) return;
      const ids = model.elements.filter((el) => !el.isType && el.geometry && (el.ifcClass === "IfcDistributionElement" || el.ifcClass.startsWith("IfcFlow") || ["IfcDuctSegment", "IfcDuctFitting", "IfcPipeSegment", "IfcPipeFitting", "IfcCableSegment", "IfcCableCarrierSegment", "IfcAirTerminal", "IfcOutlet", "IfcSwitchingDevice", "IfcLightFixture"].includes(el.ifcClass))).map((el) => el.expressId);
      focusIdsFromOldViewerTool(ids, "MEP systems");
    }, [focusIdsFromOldViewerTool, model]);
    const onFocusBeams = useCallback(() => {
      if (!model) return;
      const ids = model.elements.filter((el) => !el.isType && el.geometry && ["IfcBeam", "IfcBeamStandardCase", "IfcMember", "IfcColumn", "IfcColumnStandardCase"].includes(el.ifcClass)).map((el) => el.expressId);
      focusIdsFromOldViewerTool(ids, "Beams and structure");
    }, [focusIdsFromOldViewerTool, model]);
    const onResetOldViewerTools = useCallback(() => {
      var _a;
      if (!model) return;
      const slabIds = model.elements.filter((el) => ["IfcSlab", "IfcSlabStandardCase", "IfcSlabElementedCase", "IfcCovering", "IfcRoof"].includes(el.ifcClass)).map((el) => el.expressId);
      setSelectedStoreyId("all");
      setSlabsTransparent(false);
      dispatch({ type: "set-opacity-many", ids: slabIds, opacity: null });
      dispatch({ type: "isolate", ids: [] });
      (_a = window.__viewer) == null ? void 0 : _a.frameAll();
    }, [model]);
    const onSearch = useCallback((q) => {
      if (!model) return;
      if (!q || !q.trim()) {
        dispatch({ type: "clear-query" });
        return;
      }
      const { ids, match } = runQuery(model, q);
      dispatch({ type: "set-query", ids, match });
      addLog("info", `Query <span class="hl">${q}</span> matched <span class="hl">${ids.length}</span> element${ids.length === 1 ? "" : "s"}`);
      toast({ kind: ids.length ? "info" : "warn", msg: `${ids.length} match${ids.length === 1 ? "" : "es"}`, sub: q });
    }, [model, addLog, toast]);
    const onContext = useCallback((e, id) => {
      if (e.preventDefault) e.preventDefault();
      if (!model) return;
      const ids = id ? [id] : [...viewerState.selectedIds];
      if (ids.length === 0) return;
      setContextMenu({ x: e.clientX, y: e.clientY, ids });
    }, [model, viewerState.selectedIds]);
    useEffect(() => {
      window.__toggleSection = () => {
        setSectionEnabled((v) => {
          var _a;
          const next = !v;
          if (next) {
            const b = (_a = viewerRef.current) == null ? void 0 : _a.getModelBounds();
            if (b) setSectionBox({ ...b });
          }
          return next;
        });
      };
      window.__toggleMeasure = () => setMeasureMode((v) => {
        if (!v) setAnnoMode(false);
        return !v;
      });
      window.__toggleAnno = () => setAnnoMode((v) => {
        if (!v) setMeasureMode(false);
        return !v;
      });
      window.__toggleEdges = () => setShowEdges((v) => !v);
      window.__toggleAxes = () => setShowAxes((v) => !v);
      window.__setExplode = (e) => setExplode(e);
    }, []);
    useEffect(() => {
      const handler = (e) => {
        var _a, _b, _c, _d, _e, _f;
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        const sel = [...viewerState.selectedIds];
        switch (e.key.toLowerCase()) {
          case "f":
            if (sel.length) onZoomTo(sel);
            break;
          case "h":
            if (sel.length) dispatch({ type: "toggle-hide", ids: sel });
            break;
          case "i":
            if (sel.length) dispatch({ type: "isolate", ids: sel });
            break;
          case "a":
            dispatch({ type: "show-all" });
            break;
          case "escape":
            dispatch({ type: "clear-selection" });
            setContextMenu(null);
            break;
          case "m":
            setMeasureMode((v) => !v);
            break;
          case "s":
            window.__toggleSection && window.__toggleSection();
            break;
          case "e":
            setShowEdges((v) => !v);
            break;
          case "x":
            setViewMode((m) => m === "xray" ? "shaded" : "xray");
            break;
          case "w":
            setViewMode((m) => m === "wireframe" ? "shaded" : "wireframe");
            break;
          case "?":
            setShowHelp(true);
            break;
          case "o":
            onUpload();
            break;
          case "1":
            (_a = window.__viewer) == null ? void 0 : _a.setCameraPreset("iso");
            break;
          case "2":
            (_b = window.__viewer) == null ? void 0 : _b.setCameraPreset("top");
            break;
          case "3":
            (_c = window.__viewer) == null ? void 0 : _c.setCameraPreset("front");
            break;
          case "4":
            (_d = window.__viewer) == null ? void 0 : _d.setCameraPreset("back");
            break;
          case "5":
            (_e = window.__viewer) == null ? void 0 : _e.setCameraPreset("left");
            break;
          case "6":
            (_f = window.__viewer) == null ? void 0 : _f.setCameraPreset("right");
            break;
        }
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [viewerState.selectedIds, onZoomTo, onUpload]);
    useEffect(() => {
      if (!contextMenu) return;
      const handler = () => setContextMenu(null);
      setTimeout(() => window.addEventListener("click", handler), 0);
      return () => window.removeEventListener("click", handler);
    }, [contextMenu]);
    const lastMeasure = viewerState.measurements[viewerState.measurements.length - 1];
    return /* @__PURE__ */ React.createElement("div", { className: "app" }, /* @__PURE__ */ React.createElement(
      TopToolbar,
      {
        model,
        loadProgress: loading ? loading.progress : 1,
        viewerState,
        dispatch,
        onUpload,
        onLoadSample: loadDemoModel,
        onReset,
        onSearch,
        onOpenSummary: () => setShowSummary(true),
        onOpenSchema: () => setShowSchema(true),
        onOpenHelp: () => setShowHelp(true),
        viewMode,
        onSetViewMode: setViewMode,
        onTheme: { value: theme, set: setTheme }
      }
    ), /* @__PURE__ */ React.createElement("input", { ref: fileInputRef, type: "file", accept: ".ifc,.ifcxml,.ifczip", style: { display: "none" }, onChange: onFileSelected }), /* @__PURE__ */ React.createElement(
      "div",
      {
        ref: appBodyRef,
        className: "app-body",
        style: {
          gridTemplateColumns: `${panelLayout.left}px minmax(360px, 1fr) ${panelLayout.right}px`,
          gridTemplateRows: `minmax(240px, 1fr) ${panelLayout.bottom}px`,
          "--left-panel-width": `${panelLayout.left}px`,
          "--right-panel-width": `${panelLayout.right}px`,
          "--bottom-panel-height": `${panelLayout.bottom}px`
        }
      },
      model && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { className: "resize-handle resize-handle-left", "aria-label": "Resize left panel", title: "Resize left panel", onPointerDown: (e) => startPanelResize("left", e) }), /* @__PURE__ */ React.createElement("button", { className: "resize-handle resize-handle-right", "aria-label": "Resize right panel", title: "Resize right panel", onPointerDown: (e) => startPanelResize("right", e) }), /* @__PURE__ */ React.createElement("button", { className: "resize-handle resize-handle-bottom", "aria-label": "Resize bottom panel", title: "Resize bottom panel", onPointerDown: (e) => startPanelResize("bottom", e), onDoubleClick: resetPanelLayout })),
      /* @__PURE__ */ React.createElement(
        LeftSidebar,
        {
          model,
          viewerState,
          dispatch,
          onPick,
          onZoomTo,
          onContext
        }
      ),
      /* @__PURE__ */ React.createElement(
        ViewerCanvas,
        {
          model,
          viewerState,
          dispatch,
          viewMode,
          showEdges,
          showAxes,
          explode,
          sectionEnabled,
          sectionBox,
          onSectionBoxChange: setSectionBox,
          measureMode,
          annoMode,
          hoverId,
          onSetHoverId: setHoverId,
          lastMeasure,
          onContext: (e) => onContext(e, null),
          toast,
          viewerRef,
          selectedStoreyId,
          slabsTransparent,
          onStoreyChange,
          onToggleSlabsTransparent,
          onFocusMEP,
          onFocusBeams,
          onResetOldViewerTools,
          secondaryLoading
        }
      ),
      /* @__PURE__ */ React.createElement(Inspector, { model, viewerState, dispatch, onZoomTo, toast }),
      /* @__PURE__ */ React.createElement(BottomPanel, { model, viewerState, dispatch, log, onPick, toast })
    ), !model && !loading && /* @__PURE__ */ React.createElement(StartDashboard, { onLoadDemo: loadDemoModel, onUpload, onLoadFile: loadIfcFile }), loading && /* @__PURE__ */ React.createElement(LoadingOverlay, { visible: true, fileName: loading.fileName, progress: loading.progress }), model && showSummary && /* @__PURE__ */ React.createElement(SummaryCard, { model, onClose: () => setShowSummary(false) }), showSchema && /* @__PURE__ */ React.createElement(SchemaExplorer, { model, onClose: () => setShowSchema(false), onSelectClass: (ids) => dispatch({ type: "select", ids }), dispatch }), showHelp && /* @__PURE__ */ React.createElement(HelpPanel, { onClose: () => setShowHelp(false) }), /* @__PURE__ */ React.createElement(ContextMenu, { menu: contextMenu, onClose: () => setContextMenu(null), dispatch, onZoomTo, model, toast }), /* @__PURE__ */ React.createElement(ToastContainer, { toasts }));
  }
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(/* @__PURE__ */ React.createElement(App, null));
})();
