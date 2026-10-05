/** Main application shell. */

const SAMPLE_IFC_URL = 'assets/ifc/Building-Structural.ifc';
const SOURCE_REPO_URL = 'https://github.com/isaddiq/IFC_Web_Viewer';
const AUTHOR_URL = 'https://isaddiq.github.io/';

// ---------------------------------------------------------------------------
// Reducer for viewer state
// ---------------------------------------------------------------------------
function viewerStateReducer(state, action) {
  switch (action.type) {
    case 'select': {
      const ids = action.ids || [];
      if (action.multi) {
        const ns = new Set(state.selectedIds);
        ids.forEach(id => { ns.has(id) ? ns.delete(id) : ns.add(id); });
        return { ...state, selectedIds: ns };
      }
      return { ...state, selectedIds: new Set(ids) };
    }
    case 'clear-selection':
      return { ...state, selectedIds: new Set() };
    case 'toggle-hide': {
      const ns = new Set(state.hiddenIds);
      const anyHidden = action.ids.some(id => ns.has(id));
      action.ids.forEach(id => { anyHidden ? ns.delete(id) : ns.add(id); });
      return { ...state, hiddenIds: ns };
    }
    case 'show-all':
      return { ...state, hiddenIds: new Set(), isolatedIds: new Set() };
    case 'isolate': {
      const ns = new Set(action.ids);
      // toggle off if already isolated to same set
      if (state.isolatedIds.size === ns.size && [...ns].every(i => state.isolatedIds.has(i))) {
        return { ...state, isolatedIds: new Set() };
      }
      return { ...state, isolatedIds: ns };
    }
    case 'set-color': {
      const m = new Map(state.colorOverrides);
      if (action.color) m.set(action.id, action.color);
      else m.delete(action.id);
      return { ...state, colorOverrides: m };
    }
    case 'set-opacity': {
      const m = new Map(state.opacityOverrides);
      if (action.opacity != null) m.set(action.id, action.opacity);
      else m.delete(action.id);
      return { ...state, opacityOverrides: m };
    }
    case 'set-opacity-many': {
      const m = new Map(state.opacityOverrides);
      (action.ids || []).forEach(id => {
        if (action.opacity != null) m.set(id, action.opacity);
        else m.delete(id);
      });
      return { ...state, opacityOverrides: m };
    }
    case 'set-query':
      return { ...state, queryResults: action.ids, queryMatchText: action.match || {} };
    case 'clear-query':
      return { ...state, queryResults: [], queryMatchText: {} };
    case 'save-view': {
      const view = {
        id: Math.random().toString(36).slice(2, 9),
        name: action.name || `View ${state.savedViews.length + 1}`,
        timestamp: new Date().toLocaleTimeString(),
        camera: action.camera,
        hiddenIds: [...state.hiddenIds],
        isolatedIds: [...state.isolatedIds],
      };
      return { ...state, savedViews: [...state.savedViews, view] };
    }
    case 'restore-view': {
      const v = state.savedViews.find(x => x.id === action.id);
      if (!v) return state;
      return { ...state, hiddenIds: new Set(v.hiddenIds), isolatedIds: new Set(v.isolatedIds), _restoreCamera: v.camera };
    }
    case 'delete-view':
      return { ...state, savedViews: state.savedViews.filter(v => v.id !== action.id) };
    case 'save-set':
      return { ...state, selectionSets: [...state.selectionSets, { id: Math.random().toString(36).slice(2, 9), name: action.name || `Set ${state.selectionSets.length + 1}`, ids: [...state.selectedIds] }] };
    case 'restore-set': {
      const s = state.selectionSets.find(x => x.id === action.id);
      if (!s) return state;
      return { ...state, selectedIds: new Set(s.ids) };
    }
    case 'delete-set':
      return { ...state, selectionSets: state.selectionSets.filter(s => s.id !== action.id) };
    case 'add-anno':
      return { ...state, annotations: [...state.annotations, action.anno] };
    case 'delete-anno':
      return { ...state, annotations: state.annotations.filter(a => a.id !== action.id) };
    case 'update-anno':
      return { ...state, annotations: state.annotations.map(a => a.id === action.id ? { ...a, ...action.patch } : a) };
    case 'add-measure':
      return { ...state, measurements: [...state.measurements, action.measure] };
    case 'clear-measures':
      return { ...state, measurements: [] };
    case 'reset':
      return initialViewerState();
    default:
      return state;
  }
}

function initialViewerState() {
  return {
    selectedIds: new Set(),
    hiddenIds: new Set(),
    isolatedIds: new Set(),
    colorOverrides: new Map(),
    opacityOverrides: new Map(),
    queryResults: [],
    queryMatchText: {},
    savedViews: [],
    selectionSets: [],
    annotations: [],
    measurements: [],
  };
}

const PANEL_LAYOUT_STORAGE_KEY = 'ifc-viewer-panel-layout-v1';
const DEFAULT_PANEL_LAYOUT = { left: 280, right: 340, bottom: 200 };

function applyPanelLayoutStyles(body, layout) {
  if (!body || !layout) return;
  body.style.gridTemplateColumns = `${layout.left}px minmax(360px, 1fr) ${layout.right}px`;
  body.style.gridTemplateRows = `minmax(240px, 1fr) ${layout.bottom}px`;
  body.style.setProperty('--left-panel-width', `${layout.left}px`);
  body.style.setProperty('--right-panel-width', `${layout.right}px`);
  body.style.setProperty('--bottom-panel-height', `${layout.bottom}px`);
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
      bottom: clamp(Number(parsed.bottom) || DEFAULT_PANEL_LAYOUT.bottom, 120, 460),
    };
  } catch {
    return DEFAULT_PANEL_LAYOUT;
  }
}

// ---------------------------------------------------------------------------
// Search query engine
// ---------------------------------------------------------------------------
function runQuery(model, q) {
  const query = q.trim();
  if (!query) return { ids: [], match: {} };
  const matchText = {};
  const ids = [];
  const lower = query.toLowerCase();

  // property syntax  key:value
  const colon = query.indexOf(':');
  let key = null, val = null;
  if (colon > 0 && colon < query.length - 1) {
    key = query.substring(0, colon).trim();
    val = query.substring(colon + 1).trim();
  }

  model.elements.forEach(el => {
    if (el.isType) return;
    let matched = null;
    if (key) {
      // Check property sets
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
      // Inherited type psets
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
      // Check qtos
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
      // IFC class match
      if (el.ifcClass.toLowerCase() === lower || el.ifcClass.toLowerCase().includes(lower)) {
        matched = `IFC class: ${el.ifcClass}`;
      }
      // Name match
      else if ((el.name || '').toLowerCase().includes(lower)) {
        matched = `Name: ${el.name}`;
      }
      // GlobalId
      else if (el.globalId.toLowerCase().includes(lower)) {
        matched = `GlobalId: ${el.globalId}`;
      }
      // Express id like @123 or #123
      else if ((query.startsWith('#') || query.startsWith('@')) && String(el.expressId) === query.substring(1)) {
        matched = `Express ID: #${el.expressId}`;
      }
      // Material
      else if (el.materials.some(m => m.name.toLowerCase().includes(lower))) {
        matched = `Material: ${el.materials[0].name}`;
      }
      // Storey
      else if (el.storey && el.storey.name.toLowerCase().includes(lower)) {
        matched = `Storey: ${el.storey.name}`;
      }
      // Classification
      else if (el.classifications.some(c => c.code.toLowerCase().includes(lower) || c.name.toLowerCase().includes(lower))) {
        matched = `Classification: ${el.classifications[0].code}`;
      }
      // Type
      else if (el.objectType && el.objectType.toLowerCase().includes(lower)) {
        matched = `Object type: ${el.objectType}`;
      }
      // Predefined type
      else if (el.predefinedType && el.predefinedType.toLowerCase().includes(lower)) {
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

// ---------------------------------------------------------------------------
// ViewCube — CSS-3D cube tracking camera azimuth/polar
// ---------------------------------------------------------------------------
function ViewCube({ viewerRef }) {
  const [rot, setRot] = useState({ yaw: 30, pitch: -25 });
  useEffect(() => {
    let raf;
    const tick = () => {
      const v = viewerRef.current;
      if (v) {
        const { theta, phi } = v.getCameraOrientation();
        // Apply inverse camera rotation to the cube so it tracks orientation.
        setRot({ yaw: -theta * 180 / Math.PI, pitch: (phi - Math.PI / 2) * 180 / Math.PI });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const set = (preset) => viewerRef.current?.setCameraPreset(preset);
  return (
    <div className="view-cube-3d" title="View cube">
      <button type="button" className="vc-home" title="Zoom to extents and isometric view" onClick={() => viewerRef.current?.frameAll({ resetView: true })}>
        <Icons.Home size={13} />
      </button>
      <div
        className="scene"
        style={{ transform: `rotateX(${rot.pitch}deg) rotateY(${rot.yaw}deg)` }}
      >
        <button type="button" className="vc-face vc-front" title="Front view" onClick={() => set('front')}>Front</button>
        <button type="button" className="vc-face vc-back" title="Back view" onClick={() => set('back')}>Back</button>
        <button type="button" className="vc-face vc-right" title="Right view" onClick={() => set('right')}>Right</button>
        <button type="button" className="vc-face vc-left" title="Left view" onClick={() => set('left')}>Left</button>
        <button type="button" className="vc-face vc-top" title="Top view" onClick={() => set('top')}>Top</button>
        <button type="button" className="vc-face vc-bottom" title="Bottom view" onClick={() => set('bottom')}>Bottom</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section box controls
// ---------------------------------------------------------------------------
function SectionBoxControls({ enabled, box, bounds, onChange, onReset }) {
  if (!enabled || !box || !bounds) return null;
  const size = {
    x: Math.max(bounds.xMax - bounds.xMin, 0.001),
    y: Math.max(bounds.yMax - bounds.yMin, 0.001),
    z: Math.max(bounds.zMax - bounds.zMin, 0.001),
  };
  const sides = [
    { k: 'left', label: 'Left', axis: 'x', edge: 'min', opposite: 'right' },
    { k: 'right', label: 'Right', axis: 'x', edge: 'max', opposite: 'left' },
    { k: 'bottom', label: 'Bottom', axis: 'y', edge: 'min', opposite: 'top' },
    { k: 'top', label: 'Top', axis: 'y', edge: 'max', opposite: 'bottom' },
    { k: 'back', label: 'Back', axis: 'z', edge: 'min', opposite: 'front' },
    { k: 'front', label: 'Front', axis: 'z', edge: 'max', opposite: 'back' },
  ];
  const cutValue = (side) => {
    const minKey = `${side.axis}Min`;
    const maxKey = `${side.axis}Max`;
    if (side.edge === 'min') return (box[minKey] - bounds[minKey]) / size[side.axis];
    return (bounds[maxKey] - box[maxKey]) / size[side.axis];
  };
  const update = (side, raw) => {
    const opposite = sides.find(s => s.k === side.opposite);
    const maxCut = Math.max(0, 0.96 - (opposite ? cutValue(opposite) : 0));
    const cut = Math.min(Math.max(parseFloat(raw) / 100 || 0, 0), maxCut);
    const next = { ...box };
    const minKey = `${side.axis}Min`;
    const maxKey = `${side.axis}Max`;
    if (side.edge === 'min') next[minKey] = bounds[minKey] + size[side.axis] * cut;
    else next[maxKey] = bounds[maxKey] - size[side.axis] * cut;
    onChange(next);
  };
  return (
    <div className="section-panel">
      <h4>
        <span>Section box</span>
        <button className="reset" onClick={onReset} type="button">Reset</button>
      </h4>
      <p className="section-hint">Drag the cube faces in the 3D view or use the sliders to cut from all six sides.</p>
      {sides.map(side => {
        const percent = Math.round(cutValue(side) * 100);
        return (
        <div className="section-axis" key={side.k}>
          <span className="axis">{side.label}</span>
          <input
            type="range"
            min="0"
            max="95"
            step="1"
            value={percent}
            onChange={e => update(side, e.target.value)}
            title={`${side.label} cut: ${percent}%`}
          />
          <b>{percent}%</b>
        </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top toolbar
// ---------------------------------------------------------------------------
function TopToolbar({ model, loadProgress, viewerState, dispatch, onUpload, onLoadSample, onReset, onSearch, onOpenSummary, onOpenSchema, onOpenHelp, viewMode, onSetViewMode, onTheme }) {
  const [searchValue, setSearchValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const submit = (e) => {
    if (e.key === 'Enter') {
      onSearch(searchValue);
    } else if (e.key === 'Escape') {
      setSearchValue('');
      onSearch('');
    }
  };

  return (
    <div className="toolbar">
      <div className="tb-brand">
        <img className="tb-logo" src="assets/logos/ifc-logo.png" alt="IFC" />
        <div className="tb-name">IFC Static Web Viewer</div>
      </div>

      <button className="btn btn-primary" onClick={onUpload}>
        <Icons.Upload size={12} />
        Load IFC
      </button>
      <button className="btn" onClick={onLoadSample} title="Open the sample IFC from the old viewer">
        <Icons.Cube size={12} />
        Sample
      </button>
      {model && (
        <button className="btn" onClick={onReset} title="Close model">
          <Icons.Reset size={12} />
          Reset
        </button>
      )}

      {model && (
        <div className="tb-file">
          <Icons.Cube size={12} style={{ color: 'var(--accent)' }} />
          <span className="tb-file-name">{model.fileName}</span>
          <span className="tb-file-meta">{formatSize(model.fileSize)} · {model.schemaVersion} · {model.elements.length.toLocaleString()} elements</span>
          {loadProgress < 1 && (
            <div className="tb-progress"><div style={{ width: `${loadProgress * 100}%` }} /></div>
          )}
        </div>
      )}

      {model && (
        <button className="btn" onClick={onOpenSummary} title="View model summary">
          <Icons.Info size={12} />
          Summary
        </button>
      )}

      <div className="tb-spacer" />

      {model && (
        <span style={{display:'contents'}}>
          <div className="btn-group">
            <button className="btn" data-active={viewMode === 'shaded'} title="Shaded" onClick={() => onSetViewMode('shaded')}>
              <Icons.Shaded size={12} />
            </button>
            <button className="btn" data-active={viewMode === 'xray'} title="X-Ray" onClick={() => onSetViewMode('xray')}>
              <Icons.Xray size={12} />
            </button>
            <button className="btn" data-active={viewMode === 'wireframe'} title="Wireframe" onClick={() => onSetViewMode('wireframe')}>
              <Icons.Wireframe size={12} />
            </button>
          </div>
        </span>
      )}

      <div className="tb-search">
        <Icons.Search size={11} style={{ color: 'var(--fg-3)' }} />
        <input
          ref={inputRef}
          placeholder='Search: IfcWall, GUID, "FireRating:REI 90", #expressId…'
          value={searchValue}
          onChange={e => setSearchValue(e.target.value)}
          onKeyDown={submit}
          disabled={!model}
        />
        {searchValue ? (
          <button className="tree-action" onClick={() => { setSearchValue(''); onSearch(''); }}><Icons.X size={10} /></button>
        ) : (
          <kbd>⌘F</kbd>
        )}
      </div>

      <button className="btn btn-ghost btn-icon" disabled={!model} onClick={onOpenSchema} title="IFC schema explorer">
        <Icons.Schema size={13} />
      </button>
      <button className="btn btn-ghost btn-icon" title={`Switch to ${onTheme.value === 'light' ? 'dark' : 'light'} mode`} onClick={() => onTheme.set(onTheme.value === 'light' ? 'dark' : 'light')}>
        {onTheme.value === 'light' ? <Icons.Moon size={13} /> : <Icons.Sun size={13} />}
      </button>
      <button className="btn btn-ghost btn-icon" title="Help" onClick={onOpenHelp}>
        <Icons.Help size={13} />
      </button>
      <a className="btn btn-ghost" href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer" title="GitHub repository">
        <Icons.Code size={12} />
        Source
      </a>
      <a className="btn btn-ghost btn-icon" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" title="Author site">
        <Icons.Globe size={13} />
      </a>
      <button className="btn btn-ghost" title="Visitor statistics" onClick={() => document.getElementById('vc-popover')?.classList.toggle('vc-open')}>
        <Icons.Globe size={12} />
        Visitors
      </button>
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Viewer canvas + overlays
// ---------------------------------------------------------------------------
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
  secondaryLoading,
}) {
  const hostRef = useRef(null);
  const [annoPositions, setAnnoPositions] = useState([]);
  const [modelBounds, setModelBounds] = useState(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const v = new ThreeViewer(hostRef.current);
    viewerRef.current = v;
    window.__viewer = v;

    v.on('pick', (e) => {
      if (e.expressId == null) {
        if (!e.multi) dispatch({ type: 'clear-selection' });
        return;
      }
      dispatch({ type: 'select', ids: [e.expressId], multi: e.multi });
    });
    v.on('hover', (e) => onSetHoverId(e.expressId));
    v.on('measure', (m) => {
      dispatch({ type: 'add-measure', measure: { id: Math.random().toString(36).slice(2, 9), distance: m.distance, a: m.a.toArray(), b: m.b.toArray() } });
      toast({ kind: 'ok', msg: 'Distance measured', sub: `${m.distance.toFixed(3)} m` });
    });
    v.on('sectionBox', ({ box }) => onSectionBoxChange(box));
    v.on('anno', (e) => {
      const anno = {
        id: Math.random().toString(36).slice(2, 9),
        position: e.position.toArray(),
        elementId: e.elementId,
        title: 'New issue',
        description: '',
        status: 'open',
        priority: 'medium',
        author: 'You',
        timestamp: new Date().toLocaleString(),
      };
      dispatch({ type: 'add-anno', anno });
      toast({ kind: 'info', msg: 'Annotation created', sub: 'Edit the details in the issues panel' });
    });

    return () => {
      v.dispose();
      viewerRef.current = null;
      window.__viewer = null;
    };
  }, []);

  // Load model
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

  // Sync selection / hidden / isolated / colors
  useEffect(() => { viewerRef.current?.setSelection(viewerState.selectedIds); }, [viewerState.selectedIds]);
  useEffect(() => { viewerRef.current?.setHidden(viewerState.hiddenIds); }, [viewerState.hiddenIds]);
  useEffect(() => { viewerRef.current?.setIsolated(viewerState.isolatedIds); }, [viewerState.isolatedIds]);
  useEffect(() => { viewerRef.current?.setColorOverrides(viewerState.colorOverrides); }, [viewerState.colorOverrides]);
  useEffect(() => { viewerRef.current?.setOpacityOverrides(viewerState.opacityOverrides); }, [viewerState.opacityOverrides]);
  useEffect(() => { viewerRef.current?.setHover(hoverId ? [hoverId] : []); }, [hoverId]);
  useEffect(() => { viewerRef.current?.setViewMode(viewMode); }, [viewMode]);
  useEffect(() => { viewerRef.current?.setShowEdges(showEdges); }, [showEdges]);
  useEffect(() => { viewerRef.current?.setShowAxes(showAxes); }, [showAxes]);
  useEffect(() => { viewerRef.current?.setExplode(explode); }, [explode]);
  useEffect(() => {
    viewerRef.current?.setSectionBox(sectionEnabled, sectionBox, modelBounds);
  }, [sectionEnabled, sectionBox, modelBounds]);
  useEffect(() => { viewerRef.current?.setMeasureMode(measureMode); }, [measureMode]);
  useEffect(() => { viewerRef.current?.setAnnotationMode(annoMode); }, [annoMode]);

  // Recompute annotation screen positions on render
  useEffect(() => {
    if (!viewerRef.current) return;
    let raf;
    const update = () => {
      const v = viewerRef.current;
      if (v) {
        setAnnoPositions(viewerState.annotations.map(a => {
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

  return (
    <div className="viewer-wrap" ref={hostRef} onContextMenu={onContext}>
      <div className="viewer-overlay">
        {model && (
          <div className="viewer-hud">
            <div className="viewer-left-rail" aria-label="Viewer tools">
              <button className="btn btn-ghost btn-icon" title="Zoom to extents" onClick={() => viewerRef.current?.frameAll()}>
                <Icons.Globe size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Zoom to selection (F)" onClick={() => viewerRef.current?.frameElements([...viewerState.selectedIds])} disabled={viewerState.selectedIds.size === 0}>
                <Icons.Focus size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Zoom in" onClick={() => viewerRef.current?.zoomIn()}>
                <Icons.Plus size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Zoom out" onClick={() => viewerRef.current?.zoomOut()}>
                <Icons.Minus size={16} />
              </button>
              <div className="sep" />
              <button className="btn btn-ghost btn-icon" title="Show all (A)" onClick={() => dispatch({ type: 'show-all' })}>
                <Icons.Eye size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Hide selected (H)" disabled={viewerState.selectedIds.size === 0} onClick={() => dispatch({ type: 'toggle-hide', ids: [...viewerState.selectedIds] })}>
                <Icons.EyeOff size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Isolate selected (I)" disabled={viewerState.selectedIds.size === 0} onClick={() => dispatch({ type: 'isolate', ids: [...viewerState.selectedIds] })}>
                <Icons.Isolate size={16} />
              </button>
              <div className="sep" />
              <button className="btn btn-ghost btn-icon" data-active={sectionEnabled} title="Section box (S)" onClick={() => window.__toggleSection()}>
                <Icons.Section size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" data-active={measureMode} title="Measure" onClick={() => window.__toggleMeasure()}>
                <Icons.Ruler size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" data-active={annoMode} title="Annotate" onClick={() => window.__toggleAnno()}>
                <Icons.Pin size={16} />
              </button>
              <div className="sep" />
              <button className="btn btn-ghost btn-icon" data-active={showEdges} title="Toggle edges" onClick={() => window.__toggleEdges()}>
                <Icons.Edge size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" data-active={showAxes} title={showAxes ? 'Hide axis' : 'Show axis'} onClick={() => window.__toggleAxes()}>
                <Icons.Move size={16} />
              </button>
              <button className="btn btn-ghost btn-icon" title="Screenshot" onClick={() => {
                const d = viewerRef.current.screenshot();
                const a = document.createElement('a'); a.href = d; a.download = 'ifc-screenshot.png'; a.click();
                toast({ kind: 'ok', msg: 'Screenshot saved', sub: 'ifc-screenshot.png' });
              }}>
                <Icons.Camera size={16} />
              </button>
            </div>

            <div className="old-viewer-tools" aria-label="Old viewer navigation and visibility tools">
              <select
                value={selectedStoreyId}
                onChange={e => onStoreyChange(e.target.value)}
                title="Storey navigation"
              >
                <option value="all">All levels</option>
                {model.storeys.map(storey => (
                  <option key={storey.expressId} value={storey.expressId}>{storey.name || `Storey ${storey.expressId}`}</option>
                ))}
              </select>
              <button className="btn btn-ghost" data-active={slabsTransparent} title="Make slabs and coverings transparent" onClick={onToggleSlabsTransparent}>
                <Icons.Layer size={14} /> Slabs
              </button>
              <button className="btn btn-ghost" title="Isolate distribution and MEP elements" onClick={onFocusMEP}>
                <Icons.Relationship size={14} /> MEP
              </button>
              <button className="btn btn-ghost" title="Isolate beams and structural members" onClick={onFocusBeams}>
                <Icons.Box size={14} /> Beams
              </button>
              <button className="btn btn-ghost btn-icon" title="Reset old viewer filters" onClick={onResetOldViewerTools}>
                <Icons.Reset size={14} />
              </button>
            </div>

            <div className="viewer-nav-corner">
              <ViewCube viewerRef={viewerRef} />
            </div>

            <div className="viewer-mode-pill">
              <span className="dot" />
              <span>{viewMode === 'shaded' ? 'Shaded' : viewMode === 'xray' ? 'X-Ray' : 'Wireframe'}</span>
              {sectionEnabled && <span style={{ color: 'var(--accent)' }}>· section box</span>}
              {measureMode && <span style={{ color: 'var(--accent)' }}>· measure</span>}
              {annoMode && <span style={{ color: 'var(--accent)' }}>· annotate</span>}
            </div>

            {secondaryLoading && (
              <div className="viewer-secondary-pill">
                <div className="spin viewer-secondary-spin" />
                <span>Indexing properties…</span>
              </div>
            )}

            {sectionEnabled && modelBounds && sectionBox && (
              <div className="viewer-section-overlay">
                <SectionBoxControls
                  enabled={sectionEnabled}
                  box={sectionBox}
                  bounds={modelBounds}
                  onChange={onSectionBoxChange}
                  onReset={() => onSectionBoxChange({ ...modelBounds })}
                />
              </div>
            )}

            <div className="viewer-bottom-tools">
              <div className="viewer-exploded">
                <label>
                  <span>Exploded view</span>
                  <span className="v">{(explode * 100).toFixed(0)}%</span>
                </label>
                <input type="range" min="0" max="1" step="0.01" value={explode} onChange={e => window.__setExplode(parseFloat(e.target.value))} />
              </div>
            </div>

            {/* Annotation pins */}
            {annoPositions.map(a => a.screen.behind ? null : (
              <div key={a.id} className="anno-pin" data-status={a.status === 'resolved' ? 'resolved' : (a.status === 'progress' ? 'progress' : 'open')}
                style={{ left: a.screen.x, top: a.screen.y }}
                title={a.title}
                onClick={() => window.__editAnno && window.__editAnno(a.id)}
              >
                <span>{viewerState.annotations.findIndex(x => x.id === a.id) + 1}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard (start screen)
// ---------------------------------------------------------------------------
function StartDashboard({ onLoadDemo, onUpload, onLoadFile }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-hero">
          <h1>Inspect any IFC model in your browser.</h1>
          <p>Open an Industry Foundation Classes file to explore its geometry, hierarchy, property sets, and schema relationships. Everything runs locally — your model never leaves the browser.</p>
        </div>
        <div
          className="dropzone"
          data-over={dragOver}
          onClick={onUpload}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer?.files?.[0];
            if (file) onLoadFile(file, 'Dropped file');
            else onUpload();
          }}
        >
          <div className="icon"><Icons.Upload size={20} /></div>
          <h3>Drop an IFC file or click to browse</h3>
          <p>The file is parsed locally with web-ifc WASM. Geometry stays out of React state for predictable performance on large models.</p>
          <div className="formats">
            <span>.ifc</span><span>.ifcXML</span><span>.ifcZIP</span>
            <span style={{ borderColor: 'var(--accent-line)', color: 'var(--accent)' }}>IFC2x3 · IFC4 · IFC4.3</span>
          </div>
        </div>
        <div className="dash-tip">
          <span><kbd>O</kbd> open</span>
          <span><kbd>?</kbd> shortcuts</span>
          <span><kbd>Esc</kbd> clear selection</span>
        </div>
        <div className="dash-recent">
          <h4>Try the old viewer sample</h4>
          <div className="dash-recent-list">
            <div className="dash-recent-row" onClick={onLoadDemo}>
              <Icons.Cube size={14} style={{ color: 'var(--accent)' }} />
              <div>
                <div className="name">Building-Structural.ifc</div>
                <div className="meta">Loaded from the old IFC_Web_Viewer sample assets</div>
              </div>
              <div className="meta">289 KB</div>
              <Icons.ChevronRight size={12} style={{ color: 'var(--fg-3)' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
const LOAD_STEPS = [
  'Validate file extension and size',
  'Initialize web-ifc WASM runtime',
  'Parse STEP header and schema',
  'Decode geometric representations',
  'Build Three.js scene graph',
  'Extract spatial hierarchy',
  'Index entity types',
  'Extract property sets and quantities',
  'Resolve materials and classifications',
  'Map relationships and types',
  'Build searchable indexes',
  'Hand off to renderer',
];

function LoadingOverlay({ visible, fileName, progress }) {
  if (!visible) return null;
  const currentStep = Math.floor(progress * LOAD_STEPS.length);
  return (
    <div className="load-overlay">
      <div className="load-card">
        <h3>Loading IFC model</h3>
        <div className="file">{fileName}</div>
        <div className="load-bar"><div style={{ width: `${progress * 100}%` }} /></div>
        <div className="load-steps">
          {LOAD_STEPS.map((s, i) => {
            const state = i < currentStep ? 'done' : i === currentStep ? 'doing' : 'todo';
            return (
              <div key={i} className="load-step" data-state={state}>
                <span className="ic">{state === 'done' ? <Icons.Check size={9} /> : state === 'doing' ? <div className="spin" style={{ width: 8, height: 8, border: '1.5px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} /> : <span style={{ width: 4, height: 4, background: 'currentColor', borderRadius: '50%' }} />}</span>
                <span>{s}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary dashboard
// ---------------------------------------------------------------------------
function SummaryCard({ model, onClose }) {
  if (!model) return null;
  const classCounts = useMemo(() => {
    const m = new Map();
    model.elements.forEach(e => { if (!e.isType) m.set(e.ifcClass, (m.get(e.ifcClass) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [model]);
  const missingNames = model.elements.filter(e => !e.isType && (!e.name || e.name.trim() === '')).length;
  const spaces = model.elements.filter(e => e.ifcClass === 'IfcSpace').length;
  return (
    <div className="modal-backdrop summary-backdrop" onClick={onClose}>
      <div className="summary-card" onClick={e => e.stopPropagation()}>
      <div className="summary-card-head">
        <div>
          <h3>{model.fileName}</h3>
          <div className="sub">{model.schemaVersion} · {formatSize(model.fileSize)} · loaded {new Date().toLocaleTimeString()}</div>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose}><Icons.X size={12} /></button>
      </div>
      <div className="summary-stats">
        <div className="summary-stat"><div className="k">Entities</div><div className="v">{model.totalEntities.toLocaleString()}</div></div>
        <div className="summary-stat"><div className="k">Geometry items</div><div className="v">{model.totalGeometryItems}</div></div>
        <div className="summary-stat"><div className="k">Storeys</div><div className="v">{model.storeys.length}</div></div>
        <div className="summary-stat"><div className="k">Spaces</div><div className="v">{spaces}</div></div>
        <div className="summary-stat"><div className="k">Classes</div><div className="v">{classCounts.length}</div></div>
        <div className="summary-stat"><div className="k">Property sets</div><div className="v">{model.elements.reduce((a, e) => a + e.propertySets.length, 0)}</div></div>
        <div className="summary-stat"><div className="k">Relationships</div><div className="v">{model.relationships.length}</div></div>
        <div className="summary-stat" style={{ background: missingNames ? 'oklch(0.82 0.13 80 / 0.1)' : 'var(--bg-2)' }}><div className="k">Missing names</div><div className="v" style={{ color: missingNames ? 'var(--warn)' : 'var(--fg-0)' }}>{missingNames}</div></div>
      </div>
      <div className="summary-classes">
        <h4>Top 10 IFC classes by count</h4>
        <ul>
          {classCounts.map(([cls, n]) => (
            <li key={cls}>
              <span className="swatch" style={{ background: CLASS_COLOR(cls) }} />
              <span className="lbl">{cls}</span>
              <span className="cnt">{n}</span>
            </li>
          ))}
        </ul>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Help / shortcuts panel
// ---------------------------------------------------------------------------
function HelpPanel({ onClose }) {
  const shortcuts = [
    ['F', 'Fit selected'],
    ['A', 'Show all'],
    ['H', 'Hide selected'],
    ['I', 'Isolate selected'],
    ['Esc', 'Clear selection'],
    ['Ctrl + F', 'Focus search'],
    ['M', 'Measurement mode'],
    ['S', 'Section box (6 sides)'],
    ['E', 'Toggle edges'],
    ['X', 'Toggle x-ray'],
    ['W', 'Toggle wireframe'],
    ['1–6', 'Camera presets'],
    ['?', 'This help panel'],
    ['Right-click', 'Context menu'],
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="kbd-panel" onClick={e => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <div className="kbd-grid">
          {shortcuts.map(([k, l]) => (
            <div key={k} className="row"><span className="l">{l}</span><span className="k">{k}</span></div>
          ))}
        </div>
        <div style={{ marginTop: 18, fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--fg-0)' }}>Mouse:</strong> Left-click picks. Ctrl/Shift+click multi-selects. Middle-drag or Shift+drag pans. Right-drag orbits. Wheel zooms. Right-click for context menu.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast container
// ---------------------------------------------------------------------------
function ToastContainer({ toasts }) {
  return (
    <div className="toasts">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind || 'info'}`}>
          <div className="ic">{t.kind === 'ok' ? <Icons.Check size={11} /> : t.kind === 'warn' ? <Icons.Alert size={11} /> : t.kind === 'error' ? <Icons.X size={11} /> : <Icons.Info size={11} />}</div>
          <div className="msg">
            <div>{t.msg}</div>
            {t.sub && <div className="sub">{t.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function ContextMenu({ menu, onClose, dispatch, onZoomTo, model, toast }) {
  if (!menu) return null;
  const ids = menu.ids;
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={onClose}>
      <div className="item" onClick={() => { dispatch({ type: 'select', ids }); onClose(); }}>
        <Icons.Check size={11} /> Select {ids.length > 1 ? `${ids.length} items` : ''} <span className="sc">Click</span>
      </div>
      <div className="item" onClick={() => { onZoomTo(ids); onClose(); }}>
        <Icons.Focus size={11} /> Zoom to <span className="sc">F</span>
      </div>
      <div className="sep" />
      <div className="item" onClick={() => { dispatch({ type: 'isolate', ids }); onClose(); }}>
        <Icons.Isolate size={11} /> Isolate <span className="sc">I</span>
      </div>
      <div className="item" onClick={() => { dispatch({ type: 'toggle-hide', ids }); onClose(); }}>
        <Icons.EyeOff size={11} /> Hide <span className="sc">H</span>
      </div>
      <div className="item" onClick={() => { dispatch({ type: 'show-all' }); onClose(); }}>
        <Icons.Eye size={11} /> Show all <span className="sc">A</span>
      </div>
      <div className="sep" />
      <div className="item" onClick={() => {
        const el = model.byId.get(ids[0]);
        if (el) {
          navigator.clipboard?.writeText(el.globalId);
          toast({ kind: 'ok', msg: 'GlobalId copied' });
        }
        onClose();
      }}>
        <Icons.Copy size={11} /> Copy GlobalId
      </div>
      <div className="item" onClick={() => {
        const rows = ids.map(id => model.byId.get(id)).filter(Boolean);
        exportJSON(rows, toast);
        onClose();
      }}>
        <Icons.Export size={11} /> Export as JSON
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
function App() {
  const [theme, setTheme] = useState('light');
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(null); // { fileName, progress } or null
  const [showSummary, setShowSummary] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [viewMode, setViewMode] = useState('shaded');
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
  const [viewerState, dispatch] = useReducer(viewerStateReducer, undefined, initialViewerState);
  const [panelLayout, setPanelLayout] = useState(getInitialPanelLayout);
  const [selectedStoreyId, setSelectedStoreyId] = useState('all');
  const [slabsTransparent, setSlabsTransparent] = useState(false);
  const fileInputRef = useRef(null);
  const viewerRef = useRef(null);
  const appBodyRef = useRef(null);
  const panelLayoutDragRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(panelLayout));
    } catch { /* ignore unavailable storage */ }
  }, [panelLayout]);

  const startPanelResize = useCallback((edge, e) => {
    if (!model) return;
    e.preventDefault();
    const body = appBodyRef.current;
    const rect = body?.getBoundingClientRect();
    const start = { ...panelLayout };
    const startX = e.clientX;
    const startY = e.clientY;
    document.body.classList.add('is-resizing-layout');

    const layoutFromPointer = (ev) => {
      const width = rect?.width || window.innerWidth;
      const height = rect?.height || window.innerHeight;
      const next = { ...start };
      if (edge === 'left') {
        const maxLeft = Math.max(220, width - start.right - 420);
        next.left = clamp(start.left + ev.clientX - startX, 220, maxLeft);
      } else if (edge === 'right') {
        const maxRight = Math.max(260, width - start.left - 420);
        next.right = clamp(start.right - (ev.clientX - startX), 260, maxRight);
      } else if (edge === 'bottom') {
        const maxBottom = Math.max(120, height - 260);
        next.bottom = clamp(start.bottom - (ev.clientY - startY), 120, Math.min(460, maxBottom));
      }
      return next;
    };

    const onMove = (ev) => {
      const next = layoutFromPointer(ev);
      panelLayoutDragRef.current = next;
      applyPanelLayoutStyles(body, next);
      viewerRef.current?.scheduleResize?.();
    };

    const onUp = () => {
      document.body.classList.remove('is-resizing-layout');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const finalLayout = panelLayoutDragRef.current || start;
      panelLayoutDragRef.current = null;
      setPanelLayout(finalLayout);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [model, panelLayout]);

  const resetPanelLayout = useCallback(() => {
    setPanelLayout(DEFAULT_PANEL_LAYOUT);
  }, []);

  // Warm up web-ifc WASM as soon as the app is idle so the first upload is snappy.
  // Uses requestIdleCallback when available; falls back to a short setTimeout.
  useEffect(() => {
    const warmup = () => { window.ensureWebIfc?.(() => {})?.catch(() => {}); };
    let handle;
    if (typeof requestIdleCallback !== 'undefined') {
      handle = requestIdleCallback(warmup, { timeout: 2000 });
      return () => cancelIdleCallback(handle);
    } else {
      handle = setTimeout(warmup, 50);
      return () => clearTimeout(handle);
    }
  }, []);

  // toast helper
  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts(ts => [...ts, { ...t, id }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 3000);
  }, []);

  const addLog = useCallback((level, msg) => {
    setLog(l => [...l, { time: new Date().toLocaleTimeString(), level, msg }]);
  }, []);

  const loadIfcFile = useCallback(async (file, sourceLabel = 'User selected') => {
    if (!file) return;
    if (!/\.(ifc|ifcxml|ifczip)$/i.test(file.name)) {
      toast({ kind: 'error', msg: 'Unsupported file', sub: 'Please choose a .ifc / .ifcxml / .ifczip file' });
      return;
    }

    model?.close?.();
    window.__currentModel = null;
    setModel(null);
    setShowSummary(false);
    setShowSchema(false);
    setLog([]);
    dispatch({ type: 'reset' });
    setSelectedStoreyId('all');
    setSlabsTransparent(false);
    setExplode(0);
    setSectionEnabled(false);
    setSectionBox(null);
    setMeasureMode(false);
    setAnnoMode(false);
    setLoading({ fileName: file.name, progress: 0.01 });
    addLog('info', `${sourceLabel} <span class="hl">${file.name}</span> (${formatSize(file.size)})`);

    try {
      addLog('info', 'Checking IFC schema from STEP header');
      const schema = await window.readIfcSchema?.(file);
      if (schema) {
        addLog('ok', `Schema header: <span class="hl">${schema}</span>`);
        if (!window.isSupportedIfcSchema?.(schema)) {
          throw new Error(`Unsupported schema: ${schema}. Supported: IFC2X3, IFC4 and IFC4X3.`);
        }
      } else {
        addLog('warn', 'Schema header not found before parse; web-ifc will detect it during load');
      }

      addLog('info', 'Initializing web-ifc and streaming geometry');
      const m = await window.loadRealIfc(file, {
        onProgress: (p) => setLoading({ fileName: file.name, progress: p }),
        onLog: addLog,
      });
      addLog('ok', `Indexed <span class="hl">${m.elements.length}</span> elements · <span class="hl">${m.totalGeometryItems}</span> with geometry · <span class="hl">${m.relationships.length}</span> relationships`);
      setModel(m);
      setLoading(null);
      if (m._ensureSecondaryData) {
        setSecondaryLoading(true);
        m._ensureSecondaryData().finally(() => setSecondaryLoading(false));
      }
      toast({ kind: 'ok', msg: 'Model loaded', sub: `${m.elements.length} elements · ${m.schemaVersion}` });
    } catch (err) {
      console.error(err);
      addLog('error', `Failed to load IFC: ${err.message || err}`);
      setLoading(null);
      toast({ kind: 'error', msg: 'IFC load failed', sub: String(err.message || err).slice(0, 80) });
    }
  }, [addLog, toast, model]);

  const loadDemoModel = useCallback(async () => {
    try {
      const response = await fetch(SAMPLE_IFC_URL);
      if (!response.ok) throw new Error(`Sample file returned HTTP ${response.status}`);
      const blob = await response.blob();
      const file = new File([blob], 'Building-Structural.ifc', { type: 'application/octet-stream' });
      await loadIfcFile(file, 'Opened old viewer sample');
    } catch (err) {
      console.error(err);
      addLog('error', `Failed to open sample IFC: ${err.message || err}`);
      toast({ kind: 'error', msg: 'Sample load failed', sub: String(err.message || err).slice(0, 80) });
    }
  }, [addLog, loadIfcFile, toast]);

  // Upload handler — picks a real IFC file and parses it through web-ifc.
  const onUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const onFileSelected = async (e) => {
    const file = e.target.files?.[0];
    await loadIfcFile(file);
    e.target.value = '';
  };

  // Apply theme to body + viewer
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    if (window.__viewer) window.__viewer.setTheme(theme);
  }, [theme]);

  // Reset
  const onReset = useCallback(() => {
    model?.close?.();
    window.__currentModel = null;
    setModel(null);
    setLog([]);
    setSecondaryLoading(false);
    dispatch({ type: 'reset' });
    setSelectedStoreyId('all');
    setSlabsTransparent(false);
    setExplode(0);
    setSectionEnabled(false);
    setSectionBox(null);
    setMeasureMode(false);
    setAnnoMode(false);
    setShowSummary(false);
    toast({ kind: 'info', msg: 'Model closed' });
  }, [model, toast]);

  // Pick handler
  const onPick = useCallback((id, e) => {
    const multi = e && (e.ctrlKey || e.metaKey || e.shiftKey);
    dispatch({ type: 'select', ids: [id], multi });
  }, []);

  // Zoom-to
  const onZoomTo = useCallback((ids) => {
    window.__viewer?.frameElements(ids);
  }, []);

  const focusIdsFromOldViewerTool = useCallback((ids, label) => {
    if (!ids.length) {
      toast({ kind: 'warn', msg: 'No matching elements', sub: label });
      return;
    }
    dispatch({ type: 'isolate', ids });
    window.__viewer?.frameElements(ids);
    toast({ kind: 'info', msg: label, sub: `${ids.length} element${ids.length === 1 ? '' : 's'}` });
  }, [toast]);

  const onStoreyChange = useCallback((storeyId) => {
    setSelectedStoreyId(storeyId);
    if (!model) return;
    if (storeyId === 'all') {
      dispatch({ type: 'isolate', ids: [] });
      window.__viewer?.frameAll();
      return;
    }
    const numericId = Number(storeyId);
    const ids = model.elements
      .filter(el => !el.isType && el.geometry && el.storey?.expressId === numericId)
      .map(el => el.expressId);
    const storey = model.storeys.find(s => s.expressId === numericId);
    focusIdsFromOldViewerTool(ids, storey?.name || 'Storey');
  }, [focusIdsFromOldViewerTool, model]);

  const onToggleSlabsTransparent = useCallback(() => {
    if (!model) return;
    const ids = model.elements
      .filter(el => ['IfcSlab', 'IfcSlabStandardCase', 'IfcSlabElementedCase', 'IfcCovering', 'IfcRoof'].includes(el.ifcClass))
      .map(el => el.expressId);
    setSlabsTransparent(value => {
      const next = !value;
      dispatch({ type: 'set-opacity-many', ids, opacity: next ? 0.18 : null });
      toast({ kind: 'info', msg: next ? 'Slabs transparent' : 'Slabs restored', sub: `${ids.length} element${ids.length === 1 ? '' : 's'}` });
      return next;
    });
  }, [model, toast]);

  const onFocusMEP = useCallback(() => {
    if (!model) return;
    const ids = model.elements
      .filter(el => !el.isType && el.geometry && (
        el.ifcClass === 'IfcDistributionElement' ||
        el.ifcClass.startsWith('IfcFlow') ||
        ['IfcDuctSegment', 'IfcDuctFitting', 'IfcPipeSegment', 'IfcPipeFitting', 'IfcCableSegment', 'IfcCableCarrierSegment', 'IfcAirTerminal', 'IfcOutlet', 'IfcSwitchingDevice', 'IfcLightFixture'].includes(el.ifcClass)
      ))
      .map(el => el.expressId);
    focusIdsFromOldViewerTool(ids, 'MEP systems');
  }, [focusIdsFromOldViewerTool, model]);

  const onFocusBeams = useCallback(() => {
    if (!model) return;
    const ids = model.elements
      .filter(el => !el.isType && el.geometry && ['IfcBeam', 'IfcBeamStandardCase', 'IfcMember', 'IfcColumn', 'IfcColumnStandardCase'].includes(el.ifcClass))
      .map(el => el.expressId);
    focusIdsFromOldViewerTool(ids, 'Beams and structure');
  }, [focusIdsFromOldViewerTool, model]);

  const onResetOldViewerTools = useCallback(() => {
    if (!model) return;
    const slabIds = model.elements
      .filter(el => ['IfcSlab', 'IfcSlabStandardCase', 'IfcSlabElementedCase', 'IfcCovering', 'IfcRoof'].includes(el.ifcClass))
      .map(el => el.expressId);
    setSelectedStoreyId('all');
    setSlabsTransparent(false);
    dispatch({ type: 'set-opacity-many', ids: slabIds, opacity: null });
    dispatch({ type: 'isolate', ids: [] });
    window.__viewer?.frameAll();
  }, [model]);

  // Search
  const onSearch = useCallback((q) => {
    if (!model) return;
    if (!q || !q.trim()) {
      dispatch({ type: 'clear-query' });
      return;
    }
    const { ids, match } = runQuery(model, q);
    dispatch({ type: 'set-query', ids, match });
    addLog('info', `Query <span class="hl">${q}</span> matched <span class="hl">${ids.length}</span> element${ids.length === 1 ? '' : 's'}`);
    toast({ kind: ids.length ? 'info' : 'warn', msg: `${ids.length} match${ids.length === 1 ? '' : 'es'}`, sub: q });
  }, [model, addLog, toast]);

  // Context menu
  const onContext = useCallback((e, id) => {
    if (e.preventDefault) e.preventDefault();
    if (!model) return;
    const ids = id ? [id] : [...viewerState.selectedIds];
    if (ids.length === 0) return;
    setContextMenu({ x: e.clientX, y: e.clientY, ids });
  }, [model, viewerState.selectedIds]);

  // Bridge functions for viewer toolbar to set state
  useEffect(() => {
    window.__toggleSection = () => {
      setSectionEnabled(v => {
        const next = !v;
        if (next) {
          // Initialize box from current model bounds
          const b = viewerRef.current?.getModelBounds();
          if (b) setSectionBox({ ...b });
        }
        return next;
      });
    };
    window.__toggleMeasure = () => setMeasureMode(v => { if (!v) setAnnoMode(false); return !v; });
    window.__toggleAnno = () => setAnnoMode(v => { if (!v) setMeasureMode(false); return !v; });
    window.__toggleEdges = () => setShowEdges(v => !v);
    window.__toggleAxes = () => setShowAxes(v => !v);
    window.__setExplode = (e) => setExplode(e);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      const sel = [...viewerState.selectedIds];
      switch (e.key.toLowerCase()) {
        case 'f': if (sel.length) onZoomTo(sel); break;
        case 'h': if (sel.length) dispatch({ type: 'toggle-hide', ids: sel }); break;
        case 'i': if (sel.length) dispatch({ type: 'isolate', ids: sel }); break;
        case 'a': dispatch({ type: 'show-all' }); break;
        case 'escape': dispatch({ type: 'clear-selection' }); setContextMenu(null); break;
        case 'm': setMeasureMode(v => !v); break;
        case 's': window.__toggleSection && window.__toggleSection(); break;
        case 'e': setShowEdges(v => !v); break;
        case 'x': setViewMode(m => m === 'xray' ? 'shaded' : 'xray'); break;
        case 'w': setViewMode(m => m === 'wireframe' ? 'shaded' : 'wireframe'); break;
        case '?': setShowHelp(true); break;
        case 'o': onUpload(); break;
        case '1': window.__viewer?.setCameraPreset('iso'); break;
        case '2': window.__viewer?.setCameraPreset('top'); break;
        case '3': window.__viewer?.setCameraPreset('front'); break;
        case '4': window.__viewer?.setCameraPreset('back'); break;
        case '5': window.__viewer?.setCameraPreset('left'); break;
        case '6': window.__viewer?.setCameraPreset('right'); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewerState.selectedIds, onZoomTo, onUpload]);

  // Click-away for context menu
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    setTimeout(() => window.addEventListener('click', handler), 0);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const lastMeasure = viewerState.measurements[viewerState.measurements.length - 1];

  return (
    <div className="app">
      <TopToolbar
        model={model}
        loadProgress={loading ? loading.progress : 1}
        viewerState={viewerState}
        dispatch={dispatch}
        onUpload={onUpload}
        onLoadSample={loadDemoModel}
        onReset={onReset}
        onSearch={onSearch}
        onOpenSummary={() => setShowSummary(true)}
        onOpenSchema={() => setShowSchema(true)}
        onOpenHelp={() => setShowHelp(true)}
        viewMode={viewMode}
        onSetViewMode={setViewMode}
        onTheme={{ value: theme, set: setTheme }}
      />
      <input ref={fileInputRef} type="file" accept=".ifc,.ifcxml,.ifczip" style={{ display: 'none' }} onChange={onFileSelected} />

      <div
        ref={appBodyRef}
        className="app-body"
        style={{
          gridTemplateColumns: `${panelLayout.left}px minmax(360px, 1fr) ${panelLayout.right}px`,
          gridTemplateRows: `minmax(240px, 1fr) ${panelLayout.bottom}px`,
          '--left-panel-width': `${panelLayout.left}px`,
          '--right-panel-width': `${panelLayout.right}px`,
          '--bottom-panel-height': `${panelLayout.bottom}px`,
        }}
      >
        {model && (
          <>
            <button className="resize-handle resize-handle-left" aria-label="Resize left panel" title="Resize left panel" onPointerDown={(e) => startPanelResize('left', e)} />
            <button className="resize-handle resize-handle-right" aria-label="Resize right panel" title="Resize right panel" onPointerDown={(e) => startPanelResize('right', e)} />
            <button className="resize-handle resize-handle-bottom" aria-label="Resize bottom panel" title="Resize bottom panel" onPointerDown={(e) => startPanelResize('bottom', e)} onDoubleClick={resetPanelLayout} />
          </>
        )}
        <LeftSidebar
          model={model}
          viewerState={viewerState}
          dispatch={dispatch}
          onPick={onPick}
          onZoomTo={onZoomTo}
          onContext={onContext}
        />
        <ViewerCanvas
          model={model}
          viewerState={viewerState}
          dispatch={dispatch}
          viewMode={viewMode}
          showEdges={showEdges}
          showAxes={showAxes}
          explode={explode}
          sectionEnabled={sectionEnabled}
          sectionBox={sectionBox}
          onSectionBoxChange={setSectionBox}
          measureMode={measureMode}
          annoMode={annoMode}
          hoverId={hoverId}
          onSetHoverId={setHoverId}
          lastMeasure={lastMeasure}
          onContext={(e) => onContext(e, null)}
          toast={toast}
          viewerRef={viewerRef}
          selectedStoreyId={selectedStoreyId}
          slabsTransparent={slabsTransparent}
          onStoreyChange={onStoreyChange}
          onToggleSlabsTransparent={onToggleSlabsTransparent}
          onFocusMEP={onFocusMEP}
          onFocusBeams={onFocusBeams}
          onResetOldViewerTools={onResetOldViewerTools}
          secondaryLoading={secondaryLoading}
        />
        <Inspector model={model} viewerState={viewerState} dispatch={dispatch} onZoomTo={onZoomTo} toast={toast} />
        <BottomPanel model={model} viewerState={viewerState} dispatch={dispatch} log={log} onPick={onPick} toast={toast} />
      </div>

      {!model && !loading && <StartDashboard onLoadDemo={loadDemoModel} onUpload={onUpload} onLoadFile={loadIfcFile} />}
      {loading && <LoadingOverlay visible={true} fileName={loading.fileName} progress={loading.progress} />}
      {model && showSummary && <SummaryCard model={model} onClose={() => setShowSummary(false)} />}
      {showSchema && <SchemaExplorer model={model} onClose={() => setShowSchema(false)} onSelectClass={(ids) => dispatch({ type: 'select', ids })} dispatch={dispatch} />}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} dispatch={dispatch} onZoomTo={onZoomTo} model={model} toast={toast} />
      <ToastContainer toasts={toasts} />
    </div>
  );
}

// Mount -------------------------------------------------------------------
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
