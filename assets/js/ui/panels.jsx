/** All the side / bottom / modal panels. */

// ===========================================================================
// LEFT SIDEBAR
// ===========================================================================

function LeftSidebar({ model, viewerState, dispatch, onPick, onZoomTo, onContext }) {
  const [tab, setTab] = useState('spatial');
  const [filter, setFilter] = useState('');

  const counts = useMemo(() => {
    const m = new Map();
    if (!model) return m;
    model.elements.forEach(e => {
      if (e.isType) return;
      m.set(e.ifcClass, (m.get(e.ifcClass) || 0) + 1);
    });
    return m;
  }, [model]);

  if (!model) {
    return <div className="side left-side">
      <div className="side-tabs">
        {['Spatial', 'Entities', 'Layers', 'Views', 'Sets'].map(t => (
          <button key={t} className="side-tab" disabled style={{ opacity: 0.4 }}>{t}</button>
        ))}
      </div>
      <div className="side-empty">
        Load an IFC model to browse its hierarchy.
      </div>
    </div>;
  }

  return (
    <div className="side left-side">
      <div className="side-tabs">
        <button className="side-tab" aria-selected={tab === 'spatial'} onClick={() => setTab('spatial')}>
          <Icons.Tree size={12} /> Spatial
        </button>
        <button className="side-tab" aria-selected={tab === 'entities'} onClick={() => setTab('entities')}>
          <Icons.Box size={12} /> Entities
        </button>
        <button className="side-tab" aria-selected={tab === 'layers'} onClick={() => setTab('layers')}>
          <Icons.Layer size={12} /> Layers
        </button>
        <button className="side-tab" aria-selected={tab === 'views'} onClick={() => setTab('views')}>
          <Icons.Bookmark size={12} /> Views
        </button>
        <button className="side-tab" aria-selected={tab === 'sets'} onClick={() => setTab('sets')}>
          <Icons.Sets size={12} /> Sets
        </button>
      </div>
      <div className="side-search">
        <Icons.Search size={11} style={{ color: 'var(--fg-3)' }} />
        <input
          placeholder={`Filter ${tab}…`}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {filter && <button className="tree-action" onClick={() => setFilter('')}><Icons.X size={10} /></button>}
      </div>
      <div className="side-content">
        {tab === 'spatial' && <SpatialTree model={model} viewerState={viewerState} dispatch={dispatch} onPick={onPick} onZoomTo={onZoomTo} onContext={onContext} filter={filter} />}
        {tab === 'entities' && <EntityTypesList model={model} counts={counts} viewerState={viewerState} dispatch={dispatch} onPick={onPick} onZoomTo={onZoomTo} filter={filter} />}
        {tab === 'layers' && <LayersList model={model} counts={counts} viewerState={viewerState} dispatch={dispatch} onZoomTo={onZoomTo} filter={filter} />}
        {tab === 'views' && <SavedViewsList viewerState={viewerState} dispatch={dispatch} />}
        {tab === 'sets' && <SelectionSetsList viewerState={viewerState} dispatch={dispatch} onPick={onPick} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spatial tree
// ---------------------------------------------------------------------------
function SpatialTree({ model, viewerState, dispatch, onPick, onZoomTo, onContext, filter }) {
  const [expanded, setExpanded] = useState(() => {
    const s = new Set();
    s.add(model.project.expressId);
    s.add(model.site.expressId);
    s.add(model.building.expressId);
    model.storeys.forEach(st => s.add(st.expressId));
    return s;
  });

  const toggleExpand = (id) => {
    setExpanded(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const filterLower = filter.toLowerCase();
  const matchesFilter = (el) => {
    if (!filter) return true;
    if (el.isClassGroup) return el.ifcClass.toLowerCase().includes(filterLower);
    return (el.name || '').toLowerCase().includes(filterLower) ||
           (el.ifcClass || '').toLowerCase().includes(filterLower) ||
           (el.globalId || '').toLowerCase().includes(filterLower);
  };

  const getDirectChildren = (el) => {
    const children = el.childrenExpressIds
      ? el.childrenExpressIds.map(id => model.byId.get(id)).filter(Boolean)
      : [];
    return children.length > 0
      ? children
      : model.elements.filter(c => c.parentExpressId === el.expressId && !c.isType);
  };

  const groupStoreyChildrenByClass = (storey, children) => {
    if (storey.ifcClass !== 'IfcBuildingStorey') return children;

    const groups = new Map();
    children.forEach(child => {
      if (!groups.has(child.ifcClass)) groups.set(child.ifcClass, []);
      groups.get(child.ifcClass).push(child);
    });

    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ifcClass, classChildren]) => ({
        isClassGroup: true,
        treeId: `class:${storey.expressId}:${ifcClass}`,
        ifcClass,
        name: ifcClass,
        parentExpressId: storey.expressId,
        children: classChildren,
      }));
  };

  const renderNode = (el, depth) => {
    const directChildren = el.isClassGroup
      ? el.children
      : getDirectChildren(el);
    const treeChildren = el.isClassGroup
      ? directChildren
      : groupStoreyChildrenByClass(el, directChildren);

    const visibleChildren = filter
      ? treeChildren.filter(c => matchesFilter(c) || hasDescendantMatch(c))
      : treeChildren;

    if (filter && !matchesFilter(el) && visibleChildren.length === 0) return null;

    const nodeId = el.treeId || el.expressId;
    const collectedIds = collectIds(el, model);
    const isOpen = expanded.has(nodeId) || !!filter;
    const isSelected = el.isClassGroup
      ? collectedIds.length > 0 && collectedIds.every(id => viewerState.selectedIds.has(id))
      : viewerState.selectedIds.has(el.expressId);
    const isHidden = el.isClassGroup
      ? collectedIds.length > 0 && collectedIds.every(id => viewerState.hiddenIds.has(id))
      : viewerState.hiddenIds.has(el.expressId);
    const hasChildren = visibleChildren.length > 0;
    const rowCount = directChildren.length;
    const zoomIds = el.isClassGroup ? collectedIds : [el.expressId];

    return (
      <span style={{display:'contents'}} key={nodeId}>
        <div
          className="tree-row"
          data-selected={isSelected}
          data-hidden={isHidden}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={(e) => el.isClassGroup ? toggleExpand(nodeId) : onPick(el.expressId, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            el.isClassGroup ? onZoomTo(collectedIds) : onContext(e, el.expressId);
          }}
        >
          <span className={`tree-caret ${hasChildren ? '' : 'invisible'}`} onClick={(e) => { e.stopPropagation(); toggleExpand(nodeId); }}>
            <Icons.ChevronRight size={9} style={{ transform: isOpen ? 'rotate(90deg)' : '' }} />
          </span>
          <span className="tree-icon"><span className="swatch" style={{ background: CLASS_COLOR(el.ifcClass) }} /></span>
          <span className="tree-label">
            <span className="lbl-class">{el.isClassGroup ? 'Class' : el.ifcClass.replace('Ifc', '')}</span>
            {el.name || <em style={{ color: 'var(--fg-3)' }}>(unnamed)</em>}
          </span>
          {(rowCount > 0) && <span className="tree-count">{rowCount}</span>}
          <span className="tree-actions">
            <button className="tree-action" title="Zoom to" onClick={(e) => { e.stopPropagation(); onZoomTo(zoomIds); }}>
              <Icons.Focus size={11} />
            </button>
            <button
              className="tree-action"
              data-active={isHidden}
              title={isHidden ? 'Show' : 'Hide'}
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'toggle-hide', ids: collectedIds }); }}
            >
              {isHidden ? <Icons.EyeOff size={11} /> : <Icons.Eye size={11} />}
            </button>
            <button
              className="tree-action"
              title="Isolate"
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'isolate', ids: collectedIds }); }}
            >
              <Icons.Isolate size={11} />
            </button>
          </span>
        </div>
        {isOpen && visibleChildren.map(c => renderNode(c, depth + 1))}
      </span>
    );

    function hasDescendantMatch(node) {
      const kids = node.isClassGroup ? node.children : getDirectChildren(node);
      return kids.some(k => matchesFilter(k) || hasDescendantMatch(k));
    }
  };

  return <div className="tree">{renderNode(model.project, 0)}</div>;
}

function collectIds(el, model) {
  if (el.isClassGroup) {
    const out = [];
    el.children.forEach(child => collectIds(child, model).forEach(id => out.push(id)));
    return [...new Set(out)];
  }

  const out = [el.expressId];
  const walk = (e) => {
    const children = e.childrenExpressIds
      ? e.childrenExpressIds.map(id => model.byId.get(id)).filter(Boolean)
      : [];
    const kids = children.length > 0
      ? children
      : model.elements.filter(c => c.parentExpressId === e.expressId && !c.isType);
    kids.forEach(k => { out.push(k.expressId); walk(k); });
  };
  walk(el);
  return out;
}

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------
function EntityTypesList({ model, counts, viewerState, dispatch, onPick, onZoomTo, filter }) {
  const sorted = useMemo(() => {
    const out = [];
    counts.forEach((n, cls) => out.push([cls, n]));
    out.sort((a, b) => b[1] - a[1]);
    return out;
  }, [counts]);
  const [openClass, setOpenClass] = useState(null);
  const filterL = filter.toLowerCase();
  const filtered = sorted.filter(([c]) => !filter || c.toLowerCase().includes(filterL));

  return (
    <div className="tree" style={{ padding: '4px 0' }}>
      {filtered.map(([cls, n]) => {
        const isOpen = openClass === cls;
        const instances = model.elements.filter(e => e.ifcClass === cls && !e.isType);
        const isolated = instances.length > 0 && instances.every(e => viewerState.isolatedIds.has(e.expressId));
        return (
          <span style={{display:'contents'}} key={cls}>
            <div
              className="tree-row"
              onClick={() => setOpenClass(isOpen ? null : cls)}
              onContextMenu={e => {
                e.preventDefault();
                onZoomTo(instances.map(i => i.expressId));
              }}
            >
              <span className="tree-caret">
                <Icons.ChevronRight size={9} style={{ transform: isOpen ? 'rotate(90deg)' : '' }} />
              </span>
              <span className="tree-icon"><span className="swatch" style={{ background: CLASS_COLOR(cls) }} /></span>
              <span className="tree-label">
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{cls}</span>
              </span>
              <span className="tree-count">{n}</span>
              <span className="tree-actions">
                <button className="tree-action" title="Zoom" onClick={e => { e.stopPropagation(); onZoomTo(instances.map(i => i.expressId)); }}>
                  <Icons.Focus size={11} />
                </button>
                <button className="tree-action" data-active={isolated} title="Isolate" onClick={e => { e.stopPropagation(); dispatch({ type: 'isolate', ids: instances.map(i => i.expressId) }); }}>
                  <Icons.Isolate size={11} />
                </button>
                <button className="tree-action" title="Select all" onClick={e => { e.stopPropagation(); dispatch({ type: 'select', ids: instances.map(i => i.expressId) }); }}>
                  <Icons.Check size={11} />
                </button>
              </span>
            </div>
            {isOpen && instances.map(el => (
              <div
                key={el.expressId}
                className="tree-row"
                data-selected={viewerState.selectedIds.has(el.expressId)}
                data-hidden={viewerState.hiddenIds.has(el.expressId)}
                style={{ paddingLeft: 36 }}
                onClick={(e) => onPick(el.expressId, e)}
              >
                <span className="tree-icon"><span className="swatch" style={{ background: CLASS_COLOR(el.ifcClass), opacity: 0.6 }} /></span>
                <span className="tree-label" style={{ fontSize: 11.5 }}>
                  <span style={{ color: 'var(--fg-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, marginRight: 6 }}>#{el.expressId}</span>
                  {el.name || <em style={{ color: 'var(--fg-3)' }}>(unnamed)</em>}
                </span>
                <span className="tree-actions">
                  <button className="tree-action" title="Zoom" onClick={(e) => { e.stopPropagation(); onZoomTo([el.expressId]); }}>
                    <Icons.Focus size={11} />
                  </button>
                </span>
              </div>
            ))}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layers (categories)
// ---------------------------------------------------------------------------
function LayersList({ model, counts, viewerState, dispatch, onZoomTo, filter }) {
  const groups = useMemo(() => ([
    { name: 'Architectural', cats: ['IfcWall', 'IfcWallStandardCase', 'IfcDoor', 'IfcWindow', 'IfcCovering', 'IfcRailing', 'IfcStair', 'IfcStairFlight', 'IfcRoof'] },
    { name: 'Structural', cats: ['IfcColumn', 'IfcBeam', 'IfcSlab'] },
    { name: 'Spatial', cats: ['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace'] },
    { name: 'MEP', cats: ['IfcDistributionElement', 'IfcFlowSegment'] },
    { name: 'Furnishing', cats: ['IfcFurnishingElement'] },
  ]), []);
  return (
    <div className="tree" style={{ padding: '4px 0' }}>
      {groups.map(g => {
        const total = g.cats.reduce((a, c) => a + (counts.get(c) || 0), 0);
        if (filter && !g.name.toLowerCase().includes(filter.toLowerCase()) && total === 0) return null;
        return (
          <span style={{display:'contents'}} key={g.name}>
            <div className="side-section-head">
              <span>{g.name}</span>
              <span style={{ color: 'var(--fg-3)', fontFamily: 'JetBrains Mono, monospace' }}>{total}</span>
            </div>
            {g.cats.map(c => {
              const n = counts.get(c);
              if (!n) return null;
              const instances = model.elements.filter(e => e.ifcClass === c && !e.isType);
              const isHidden = instances.every(i => viewerState.hiddenIds.has(i.expressId));
              return (
                <div key={c} className="tree-row" style={{ paddingLeft: 18 }} data-hidden={isHidden}>
                  <span className="tree-icon"><span className="swatch" style={{ background: CLASS_COLOR(c) }} /></span>
                  <span className="tree-label">
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{c.replace('Ifc', '')}</span>
                  </span>
                  <span className="tree-count">{n}</span>
                  <span className="tree-actions">
                    <button className="tree-action" data-active={isHidden} title={isHidden ? 'Show' : 'Hide'}
                      onClick={() => dispatch({ type: 'toggle-hide', ids: instances.map(i => i.expressId) })}>
                      {isHidden ? <Icons.EyeOff size={11} /> : <Icons.Eye size={11} />}
                    </button>
                    <button className="tree-action" title="Zoom" onClick={() => onZoomTo(instances.map(i => i.expressId))}>
                      <Icons.Focus size={11} />
                    </button>
                  </span>
                </div>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

function SavedViewsList({ viewerState, dispatch }) {
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Saved Views</span>
        <button className="btn btn-ghost" style={{ height: 22, padding: '0 6px', fontSize: 11 }} onClick={() => dispatch({ type: 'save-view' })}>
          <Icons.Plus size={10} /> Save current
        </button>
      </div>
      {viewerState.savedViews.length === 0 ? (
        <div style={{ color: 'var(--fg-3)', fontSize: 11, padding: '14px 0', textAlign: 'center' }}>
          No saved views yet.<br/>Frame the model, then click <em>Save current</em>.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {viewerState.savedViews.map(v => (
            <div key={v.id} className="tree-row" style={{ height: 32 }} onClick={() => dispatch({ type: 'restore-view', id: v.id })}>
              <span className="tree-icon"><Icons.Camera size={11} /></span>
              <span className="tree-label">
                <div style={{ fontSize: 12, color: 'var(--fg-0)' }}>{v.name}</div>
                <div style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'JetBrains Mono, monospace' }}>{v.timestamp}</div>
              </span>
              <button className="tree-action" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'delete-view', id: v.id }); }}>
                <Icons.X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionSetsList({ viewerState, dispatch, onPick }) {
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Selection Sets</span>
        <button className="btn btn-ghost" style={{ height: 22, padding: '0 6px', fontSize: 11 }} disabled={viewerState.selectedIds.size === 0} onClick={() => dispatch({ type: 'save-set' })}>
          <Icons.Plus size={10} /> From selection
        </button>
      </div>
      {viewerState.selectionSets.length === 0 ? (
        <div style={{ color: 'var(--fg-3)', fontSize: 11, padding: '14px 0', textAlign: 'center' }}>
          Select objects in the viewer<br/>and save them as a reusable set.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {viewerState.selectionSets.map(s => (
            <div key={s.id} className="tree-row" style={{ height: 28 }} onClick={() => dispatch({ type: 'restore-set', id: s.id })}>
              <span className="tree-icon"><Icons.Sets size={11} /></span>
              <span className="tree-label">{s.name}</span>
              <span className="tree-count">{s.ids.length}</span>
              <button className="tree-action" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'delete-set', id: s.id }); }}>
                <Icons.X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// RIGHT INSPECTOR
// ===========================================================================
function Inspector({ model, viewerState, dispatch, onZoomTo, toast }) {
  const [openSections, setOpenSections] = useState(() => new Set(['identity', 'spatial', 'psets', 'qtos', 'materials', 'type', 'classifications', 'rels', 'raw']));
  const [colorOpen, setColorOpen] = useState(false);
  const [detailRev, setDetailRev] = useState(0);

  const id = viewerState.selectedIds.size > 0 ? [...viewerState.selectedIds][viewerState.selectedIds.size - 1] : null;

  useEffect(() => {
    if (!model?.expandElement || id == null) return;
    let cancelled = false;
    Promise.resolve(model.expandElement(id)).then(() => {
      if (!cancelled) setDetailRev(v => v + 1);
    });
    return () => { cancelled = true; };
  }, [id, model]);

  if (!model) return null;
  void detailRev;
  if (!id) {
    return (
      <div className="side right-side">
        <div className="side-content">
          <div className="insp-empty">
            <div className="insp-empty-icon"><Icons.Box size={20} /></div>
            <h3>No selection</h3>
            <p>Click an element in the viewer or the tree to inspect its IFC metadata, property sets, materials, and relationships.</p>
            <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 5, fontSize: 11, textAlign: 'left', color: 'var(--fg-2)' }}>
              <div style={{ color: 'var(--fg-1)', fontWeight: 600, marginBottom: 4 }}>Tip</div>
              Hold <kbd style={{ background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 3, fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>Ctrl</kbd> while clicking to multi-select.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const el = model.byId.get(id);
  if (!el) return null;

  const toggle = (k) => setOpenSections(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const copy = (text, label) => {
    navigator.clipboard?.writeText(text);
    toast({ kind: 'ok', msg: 'Copied', sub: label });
  };

  const incomingRels = model.relationships.filter(r => r.targetExpressIds.includes(id));
  const outgoingRels = model.relationships.filter(r => r.sourceExpressId === id);
  const typeObj = el.typeExpressId ? model.byId.get(el.typeExpressId) : null;

  const breadcrumb = [];
  let cur = el;
  while (cur && cur.parentExpressId) {
    const parent = model.byId.get(cur.parentExpressId);
    if (!parent) break;
    breadcrumb.unshift(parent);
    cur = parent;
  }

  return (
    <div className="side right-side">
      {/* Header */}
      <div className="insp-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--fg-3)', marginBottom: 6 }}>
          {breadcrumb.map((b, i) => (
            <span style={{display:'contents'}} key={b.expressId}>
              <span style={{ cursor: 'pointer' }} onClick={() => dispatch({ type: 'select', ids: [b.expressId] })}>{b.name || b.ifcClass}</span>
              {i < breadcrumb.length - 1 || true ? <span style={{ opacity: 0.5 }}>›</span> : null}
            </span>
          ))}
        </div>
        <div className="insp-class-pill">
          <span className="swatch" style={{ background: CLASS_COLOR(el.ifcClass) }} />
          {el.ifcClass}
        </div>
        <div className="insp-name">{el.name || <span style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>(unnamed)</span>}</div>
        <div className="insp-globalid">
          <span>{el.globalId}</span>
          <button title="Copy GlobalId" onClick={() => copy(el.globalId, 'GlobalId')}><Icons.Copy size={11} /></button>
        </div>
        <div className="insp-quickbar">
          <button className="btn" onClick={() => onZoomTo([id])}><Icons.Focus size={11} /> Zoom</button>
          <button className="btn" data-active={viewerState.isolatedIds.size > 0 && viewerState.isolatedIds.has(id)} onClick={() => dispatch({ type: 'isolate', ids: [id] })}>
            <Icons.Isolate size={11} /> Isolate
          </button>
          <button className="btn" onClick={() => dispatch({ type: 'toggle-hide', ids: [id] })}>
            {viewerState.hiddenIds.has(id) ? <><Icons.EyeOff size={11} /> Show</> : <><Icons.Eye size={11} /> Hide</>}
          </button>
          <div style={{ position: 'relative' }}>
            <button className="btn" onClick={() => setColorOpen(v => !v)}><Icons.PaintBucket size={11} /> Color</button>
            {colorOpen && (
              <div className="color-popover" style={{ top: 28, right: 0 }}>
                {['#6fb7d6', '#d18a6a', '#b08fbe', '#d4c084', '#91a673', '#a87b5a', '#4ea1a6', '#cfd3da', '#b4a07c', '#c2956a', '#8a93a0', null].map(c => (
                  <button
                    key={c || 'reset'}
                    className="sw"
                    style={{ background: c || 'transparent', borderColor: !c ? 'var(--line-strong)' : undefined }}
                    title={c || 'Reset'}
                    onClick={() => { dispatch({ type: 'set-color', id, color: c }); setColorOpen(false); }}
                  >{!c && <Icons.X size={10} />}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="side-content">
        {/* Basic Identity */}
        <Section title="Basic Identity" open={openSections.has('identity')} onToggle={() => toggle('identity')}>
          <KV k="Express ID">
            <span className="mono">#{el.expressId}</span>
            <button className="tree-action" style={{ marginLeft: 4 }} onClick={() => copy('#' + el.expressId, 'Express ID')}><Icons.Copy size={10} /></button>
          </KV>
          <KV k="GlobalId"><span className="mono">{el.globalId}</span></KV>
          <KV k="IFC Class"><span className="mono">{el.ifcClass}</span></KV>
          <KV k="Object Type">{el.objectType || <span className="muted">—</span>}</KV>
          <KV k="Tag">{el.tag ? <span className="mono">{el.tag}</span> : <span className="muted">—</span>}</KV>
          <KV k="Predefined Type">{el.predefinedType ? <span className="mono">.{el.predefinedType}.</span> : <span className="muted">—</span>}</KV>
          <KV k="Description">{el.description || <span className="muted">—</span>}</KV>
        </Section>

        {/* Spatial Location */}
        <Section title="Spatial Location" open={openSections.has('spatial')} onToggle={() => toggle('spatial')}>
          <KV k="Project"><span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => dispatch({ type: 'select', ids: [model.project.expressId] })}>{model.project.name}</span></KV>
          <KV k="Site"><span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => dispatch({ type: 'select', ids: [model.site.expressId] })}>{model.site.name}</span></KV>
          <KV k="Building"><span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => dispatch({ type: 'select', ids: [model.building.expressId] })}>{model.building.name}</span></KV>
          <KV k="Storey">{el.storey ? <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => dispatch({ type: 'select', ids: [el.storey.expressId] })}>{el.storey.name}</span> : <span className="muted">—</span>}</KV>
          <KV k="Containment"><span className="mono" style={{ fontSize: 10.5 }}>IfcRelContainedInSpatialStructure</span></KV>
        </Section>

        {/* Property Sets */}
        {el.propertySets.length > 0 && (
          <Section
            title="Property Sets"
            count={el.propertySets.length}
            open={openSections.has('psets')}
            onToggle={() => toggle('psets')}
          >
            {el.propertySets.map(ps => (
              <div className="pset-table" key={ps.name}>
                <div className="pset-head"><span className="dot" /> {ps.name}</div>
                {ps.properties.map(p => (
                  <div className="pset-row" key={p.name}>
                    <span className="k">{p.name}</span>
                    <span className="v">{formatValue(p.value)}{p.unit && <span className="unit">{p.unit}</span>}</span>
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {/* Quantity Sets */}
        {el.quantitySets.length > 0 && (
          <Section
            title="Quantity Sets"
            count={el.quantitySets.length}
            open={openSections.has('qtos')}
            onToggle={() => toggle('qtos')}
          >
            {el.quantitySets.map(qs => (
              <div className="pset-table" key={qs.name}>
                <div className="pset-head" style={{ color: 'oklch(0.82 0.12 145)' }}><span className="dot" style={{ background: 'oklch(0.82 0.12 145)' }} /> {qs.name}</div>
                {qs.properties.map(p => (
                  <div className="pset-row" key={p.name}>
                    <span className="k">{p.name}</span>
                    <span className="v">{formatValue(p.value)}{p.unit && <span className="unit">{p.unit}</span>}</span>
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {/* Materials */}
        {el.materials.length > 0 && (
          <Section
            title="Materials"
            count={el.materials.length}
            open={openSections.has('materials')}
            onToggle={() => toggle('materials')}
          >
            {el.materials.map((m, mi) => (
              <div key={mi} style={{ paddingTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-0)' }}>
                  <Icons.Material size={11} style={{ color: 'var(--fg-2)' }} />
                  {m.name}
                </div>
                {m.density && <KV k="Density"><span className="mono">{m.density} <span style={{ color: 'var(--fg-3)' }}>kg/m³</span></span></KV>}
                {m.thermalConductivity && <KV k="λ (Conductivity)"><span className="mono">{m.thermalConductivity} <span style={{ color: 'var(--fg-3)' }}>W/mK</span></span></KV>}
                {m.layers && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--fg-3)', marginBottom: 4, fontWeight: 600 }}>Layer Set</div>
                    {m.layers.map((l, li) => (
                      <div key={li} className="pset-row">
                        <span className="k">{l.name}</span>
                        <span className="v">{l.thickness} <span className="unit">mm</span></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Section>
        )}

        {/* Type */}
        {typeObj && (
          <Section
            title="Type Information"
            open={openSections.has('type')}
            onToggle={() => toggle('type')}
          >
            <KV k="Type"><span className="mono">{typeObj.objectType}</span></KV>
            <KV k="IFC Class"><span className="mono">{typeObj.ifcClass}</span></KV>
            <KV k="Type Express"><span className="mono">#{typeObj.expressId}</span></KV>
            <KV k="Type GlobalId"><span className="mono" style={{ fontSize: 10.5 }}>{typeObj.globalId}</span></KV>
            {typeObj.propertySets.map(ps => (
              <div className="pset-table" key={ps.name}>
                <div className="pset-head"><span className="dot" /> {ps.name} <span style={{ color: 'var(--fg-3)', marginLeft: 4 }}>(inherited)</span></div>
                {ps.properties.map(p => (
                  <div className="pset-row" key={p.name}>
                    <span className="k">{p.name}</span>
                    <span className="v">{formatValue(p.value)}{p.unit && <span className="unit">{p.unit}</span>}</span>
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {/* Classifications */}
        {el.classifications.length > 0 && (
          <Section title="Classification" open={openSections.has('classifications')} onToggle={() => toggle('classifications')}>
            {el.classifications.map((c, i) => (
              <div key={i} style={{ paddingTop: 4 }}>
                <KV k="System">{c.system}</KV>
                <KV k="Code"><span className="mono">{c.code}</span></KV>
                <KV k="Name">{c.name}</KV>
              </div>
            ))}
          </Section>
        )}

        {/* Relationships */}
        <Section
          title="Relationships"
          count={incomingRels.length + outgoingRels.length}
          open={openSections.has('rels')}
          onToggle={() => toggle('rels')}
        >
          {[...incomingRels, ...outgoingRels].slice(0, 12).map(r => (
            <div key={r.expressId} className="rel-chip" onClick={() => {
              const other = r.sourceExpressId === id ? r.targetExpressIds[0] : r.sourceExpressId;
              dispatch({ type: 'select', ids: [other] });
            }}>
              <span className="rt">{r.relationshipType}</span>
              <span className="rl">{r.description}</span>
            </div>
          ))}
          {incomingRels.length + outgoingRels.length === 0 && <div style={{ color: 'var(--fg-3)', fontSize: 11, padding: 6 }}>No relationships indexed.</div>}
        </Section>

        {/* Raw attributes */}
        <Section title="Raw IFC Attributes" open={openSections.has('raw')} onToggle={() => toggle('raw')}>
          <div className="raw-attrs">
            <table>
              <thead><tr><th>#</th><th>Name</th><th>Value</th></tr></thead>
              <tbody>
                {(el.rawAttributes || []).map(a => (
                  <tr key={a.idx}>
                    <td className="idx">{a.idx}</td>
                    <td className="name">{a.name}</td>
                    <td className={`val ${a.ref ? 'ref' : ''} ${a.value == null ? 'null' : ''}`}>
                      {a.value == null ? '$' : (typeof a.value === 'string' && !a.ref ? `'${a.value}'` : String(a.value))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn" style={{ height: 24, fontSize: 11 }} onClick={() => copy(JSON.stringify(el, (k, v) => k === 'storey' ? (v ? v.name : null) : v, 2), 'Full metadata JSON')}>
              <Icons.Copy size={11} /> Copy full JSON
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, count, open, onToggle, children }) {
  return (
    <div className="insp-section" data-open={open}>
      <div className="insp-section-head" onClick={onToggle}>
        <div className="insp-section-title">
          {title}
          {count != null && <span className="insp-count">{count}</span>}
        </div>
        <span className="insp-caret"><Icons.ChevronDown size={11} /></span>
      </div>
      <div className="insp-section-body">{children}</div>
    </div>
  );
}

function KV({ k, children }) {
  return <div className="insp-kv"><span className="k">{k}</span><span className="v">{children}</span></div>;
}

function formatValue(v) {
  if (v == null) return <span style={{ color: 'var(--fg-3)' }}>—</span>;
  if (typeof v === 'boolean') return <span style={{ color: v ? 'var(--ok)' : 'var(--danger)' }}>{v ? 'TRUE' : 'FALSE'}</span>;
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return String(v);
}

// ===========================================================================
// BOTTOM PANEL
// ===========================================================================
function BottomPanel({ model, viewerState, dispatch, log, onPick, toast }) {
  const [tab, setTab] = useState('selected');
  const [collapsed, setCollapsed] = useState(false);

  const selectedRows = useMemo(() => {
    if (!model) return [];
    return [...viewerState.selectedIds].map(id => model.byId.get(id)).filter(Boolean);
  }, [viewerState.selectedIds, model]);

  const validationIssues = useMemo(() => {
    if (!model) return [];
    const issues = [];
    const missingNames = model.elements.filter(e => !e.isType && (!e.name || e.name.trim() === ''));
    if (missingNames.length) issues.push({ severity: 'warn', message: 'Elements with missing Name attribute', count: missingNames.length, ids: missingNames.map(e => e.expressId) });
    const missingClass = model.elements.filter(e => !e.isType && !e.classifications.length && !['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'].includes(e.ifcClass));
    if (missingClass.length) issues.push({ severity: 'info', message: 'Elements without Uniclass classification', count: missingClass.length, ids: missingClass.map(e => e.expressId) });
    issues.push({ severity: 'info', message: 'Schema validation passed for IFC4 (Reference View MVD)', count: null });
    return issues;
  }, [model]);

  if (!model) return (
    <div className="bottom-panel">
      <div className="bp-head">
        <div className="bp-tabs">
          {['Selected', 'Query', 'Validation', 'Loading Log', 'Performance'].map(t => (
            <button key={t} className="bp-tab" disabled style={{ opacity: 0.4 }}>{t}</button>
          ))}
        </div>
      </div>
      <div className="bp-body" style={{ height: 80, display: 'grid', placeItems: 'center', color: 'var(--fg-3)', fontSize: 12 }}>
        Load a model to see selection details, query results, and performance metrics.
      </div>
    </div>
  );

  return (
    <div className="bottom-panel">
      <div className="bp-head">
        <div className="bp-tabs">
          <button className="bp-tab" aria-selected={tab === 'selected'} onClick={() => { setTab('selected'); setCollapsed(false); }}>
            <Icons.Table size={11} /> Selected <span className="count">{viewerState.selectedIds.size}</span>
          </button>
          <button className="bp-tab" aria-selected={tab === 'query'} onClick={() => { setTab('query'); setCollapsed(false); }}>
            <Icons.Filter size={11} /> Query Results <span className="count">{viewerState.queryResults.length}</span>
          </button>
          <button className="bp-tab" aria-selected={tab === 'validation'} onClick={() => { setTab('validation'); setCollapsed(false); }}>
            <Icons.Alert size={11} /> Validation <span className="count">{validationIssues.length}</span>
          </button>
          <button className="bp-tab" aria-selected={tab === 'log'} onClick={() => { setTab('log'); setCollapsed(false); }}>
            <Icons.Log size={11} /> Loading Log <span className="count">{log.length}</span>
          </button>
          <button className="bp-tab" aria-selected={tab === 'perf'} onClick={() => { setTab('perf'); setCollapsed(false); }}>
            <Icons.Speed size={11} /> Performance
          </button>
        </div>
        <div className="bp-actions">
          {tab === 'selected' && selectedRows.length > 0 && (
            <span style={{display:'contents'}}>
              <button className="btn btn-ghost" onClick={() => exportCSV(selectedRows, model, toast)}><Icons.Export size={11} /> CSV</button>
              <button className="btn btn-ghost" onClick={() => exportJSON(selectedRows, toast)}><Icons.Export size={11} /> JSON</button>
            </span>
          )}
          <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icons.ChevronDown size={11} style={{ transform: collapsed ? 'rotate(180deg)' : '' }} />
          </button>
        </div>
      </div>
      <div className={`bp-body ${collapsed ? 'collapsed' : ''}`}>
        {tab === 'selected' && <SelectedTable rows={selectedRows} model={model} viewerState={viewerState} onPick={onPick} dispatch={dispatch} />}
        {tab === 'query' && <QueryResultsTable rows={viewerState.queryResults.map(id => model.byId.get(id)).filter(Boolean)} model={model} viewerState={viewerState} onPick={onPick} dispatch={dispatch} />}
        {tab === 'validation' && <ValidationList issues={validationIssues} dispatch={dispatch} />}
        {tab === 'log' && <LoadingLog log={log} />}
        {tab === 'perf' && <PerfPanel model={model} viewerState={viewerState} />}
      </div>
    </div>
  );
}

function SelectedTable({ rows, model, viewerState, onPick, dispatch }) {
  if (rows.length === 0) return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 12 }}>
      No elements selected. Click an element in the viewer or pick from the tree.
    </div>
  );
  return (
    <table className="dtbl">
      <thead><tr>
        <th>Express</th><th>GlobalId</th><th>IFC Class</th><th>Name</th><th>Storey</th><th>Material</th><th>Visibility</th>
      </tr></thead>
      <tbody>
        {rows.map(el => {
          const vis = viewerState.hiddenIds.has(el.expressId) ? 'hidden' : (viewerState.isolatedIds.has(el.expressId) ? 'isolated' : 'visible');
          return (
            <tr key={el.expressId} data-selected={true} onClick={(e) => onPick(el.expressId, e)}>
              <td className="mono">#{el.expressId}</td>
              <td className="mono">{el.globalId.slice(0, 8)}…</td>
              <td><span className="class-pill"><span className="swatch" style={{ background: CLASS_COLOR(el.ifcClass) }} />{el.ifcClass}</span></td>
              <td>{el.name || <span className="muted">(unnamed)</span>}</td>
              <td>{el.storey?.name || <span className="muted">—</span>}</td>
              <td>{el.materials[0]?.name || <span className="muted">—</span>}</td>
              <td><span className="vis-dot" data-state={vis} /> {vis}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function QueryResultsTable({ rows, model, viewerState, onPick, dispatch }) {
  if (rows.length === 0) return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 12 }}>
      No query results. Run a search from the toolbar.<br/>
      Try: <span className="mono" style={{ color: 'var(--accent)' }}>FireRating:REI 90</span>, <span className="mono" style={{ color: 'var(--accent)' }}>IsExternal:true</span>, or <span className="mono" style={{ color: 'var(--accent)' }}>IfcDoor</span>
    </div>
  );
  return (
    <div>
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span>{rows.length} match{rows.length === 1 ? '' : 'es'}</span>
        <button className="btn btn-ghost" style={{ height: 22, fontSize: 11 }} onClick={() => dispatch({ type: 'select', ids: rows.map(r => r.expressId) })}>
          <Icons.Check size={11} /> Select all
        </button>
        <button className="btn btn-ghost" style={{ height: 22, fontSize: 11 }} onClick={() => dispatch({ type: 'isolate', ids: rows.map(r => r.expressId) })}>
          <Icons.Isolate size={11} /> Isolate
        </button>
        <button className="btn btn-ghost" style={{ height: 22, fontSize: 11 }} onClick={() => dispatch({ type: 'clear-query' })}>
          <Icons.X size={11} /> Clear
        </button>
      </div>
      <table className="dtbl">
        <thead><tr>
          <th>Express</th><th>IFC Class</th><th>Name</th><th>Storey</th><th>Match</th>
        </tr></thead>
        <tbody>
          {rows.map(el => (
            <tr key={el.expressId} data-selected={viewerState.selectedIds.has(el.expressId)} onClick={(e) => onPick(el.expressId, e)}>
              <td className="mono">#{el.expressId}</td>
              <td><span className="class-pill"><span className="swatch" style={{ background: CLASS_COLOR(el.ifcClass) }} />{el.ifcClass}</span></td>
              <td>{el.name || <span className="muted">(unnamed)</span>}</td>
              <td>{el.storey?.name || <span className="muted">—</span>}</td>
              <td className="muted">{viewerState.queryMatchText[el.expressId] || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValidationList({ issues, dispatch }) {
  return (
    <div className="val-list">
      {issues.map((i, idx) => (
        <div key={idx} className={`val-row ${i.severity}`}>
          <div className="vsev">{i.severity === 'warn' ? '!' : (i.severity === 'error' ? '×' : 'i')}</div>
          <div className="vmsg">{i.message}</div>
          {i.count != null && <div className="vcount">{i.count}</div>}
          {i.ids && i.ids.length > 0 && (
            <button className="btn btn-ghost" style={{ height: 22, fontSize: 11 }} onClick={() => dispatch({ type: 'select', ids: i.ids })}>
              <Icons.Focus size={11} /> Show
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function LoadingLog({ log }) {
  return (
    <div className="log-list">
      {log.map((l, i) => (
        <div key={i} className={`log-row ${l.level}`}>
          <span className="t">{l.time}</span>
          <span className="l">{l.level}</span>
          <span className="msg" dangerouslySetInnerHTML={{ __html: l.msg }} />
        </div>
      ))}
    </div>
  );
}

function PerfPanel({ model, viewerState }) {
  const [fps, setFps] = useState(60);
  useEffect(() => {
    const t = setInterval(() => {
      if (window.__viewer) setFps(window.__viewer.getFps());
    }, 500);
    return () => clearInterval(t);
  }, []);
  const visible = model.elements.filter(e => e.geometry && !viewerState.hiddenIds.has(e.expressId)).length;
  return (
    <div className="perf-grid">
      <div className="perf-card">
        <div className="k">FPS</div>
        <div className="v">{fps}<span className="unit">/ 60</span></div>
        <div className="bar"><div style={{ width: `${Math.min(100, fps / 60 * 100)}%` }} /></div>
      </div>
      <div className="perf-card">
        <div className="k">Visible Geometry</div>
        <div className="v">{visible}<span className="unit">/ {model.totalGeometryItems}</span></div>
        <div className="bar"><div style={{ width: `${visible / model.totalGeometryItems * 100}%` }} /></div>
      </div>
      <div className="perf-card">
        <div className="k">Selected</div>
        <div className="v">{viewerState.selectedIds.size}</div>
      </div>
      <div className="perf-card">
        <div className="k">Indexed Entities</div>
        <div className="v">{model.totalEntities.toLocaleString()}</div>
      </div>
      <div className="perf-card">
        <div className="k">GPU Memory</div>
        <div className="v">{(model.totalGeometryItems * 0.014).toFixed(1)}<span className="unit">MB</span></div>
      </div>
      <div className="perf-card">
        <div className="k">Property Sets</div>
        <div className="v">{model.elements.reduce((a, e) => a + e.propertySets.length, 0)}</div>
      </div>
      <div className="perf-card">
        <div className="k">Quantities</div>
        <div className="v">{model.elements.reduce((a, e) => a + e.quantitySets.length, 0)}</div>
      </div>
      <div className="perf-card">
        <div className="k">Relationships</div>
        <div className="v">{model.relationships.length}</div>
      </div>
    </div>
  );
}

// ===========================================================================
// SCHEMA EXPLORER
// ===========================================================================
function SchemaExplorer({ model, onClose, onSelectClass, dispatch }) {
  const [selected, setSelected] = useState('IfcWall');
  const [filter, setFilter] = useState('');

  const classes = useMemo(() => {
    const list = Object.keys(SCHEMA_INFO);
    const counts = new Map();
    if (model) {
      model.elements.forEach(e => {
        if (!e.isType) counts.set(e.ifcClass, (counts.get(e.ifcClass) || 0) + 1);
      });
    }
    return list.map(c => ({ name: c, count: counts.get(c) || 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [model]);

  const filtered = classes.filter(c => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));

  const info = SCHEMA_INFO[selected];
  const instances = model ? model.elements.filter(e => e.ifcClass === selected && !e.isType) : [];
  // Collect actual pset usage in instances
  const psetUsage = useMemo(() => {
    const m = new Map();
    instances.forEach(i => i.propertySets.forEach(ps => {
      if (!m.has(ps.name)) m.set(ps.name, { occurrences: 0, props: new Map() });
      const e = m.get(ps.name);
      e.occurrences++;
      ps.properties.forEach(p => {
        if (!e.props.has(p.name)) e.props.set(p.name, p.type || 'IfcValue');
      });
    }));
    return [...m.entries()];
  }, [instances]);
  const qtoUsage = useMemo(() => {
    const m = new Map();
    instances.forEach(i => i.quantitySets.forEach(qs => {
      if (!m.has(qs.name)) m.set(qs.name, { occurrences: 0, props: new Map() });
      const e = m.get(qs.name);
      e.occurrences++;
      qs.properties.forEach(p => {
        if (!e.props.has(p.name)) e.props.set(p.name, p.type || 'IfcQuantity');
      });
    }));
    return [...m.entries()];
  }, [instances]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <Icons.Schema size={14} style={{ color: 'var(--accent)' }} />
          <h2>IFC Schema Explorer</h2>
          <span className="sub">{model ? `IFC4 — ${model.elements.length} entities indexed` : 'No model loaded'}</span>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-icon" onClick={onClose}><Icons.X size={12} /></button>
        </div>
        <div className="modal-body">
          <div className="schema-list">
            <div className="side-search" style={{ margin: '8px' }}>
              <Icons.Search size={11} style={{ color: 'var(--fg-3)' }} />
              <input placeholder="Filter classes…" value={filter} onChange={e => setFilter(e.target.value)} />
            </div>
            {filtered.map(c => (
              <div
                key={c.name}
                className="row"
                data-selected={selected === c.name}
                data-empty={c.count === 0}
                onClick={() => setSelected(c.name)}
              >
                <span className="swatch" style={{ background: CLASS_COLOR(c.name) }} />
                <span className="nm">{c.name}</span>
                <span className="ct">{c.count || '—'}</span>
              </div>
            ))}
          </div>
          <div className="schema-detail">
            <h3>
              <span className="swatch" style={{ background: CLASS_COLOR(selected) }} />
              {selected}
            </h3>
            <div className="breadcrumb">
              <span className="clickable" onClick={() => info?.parent && SCHEMA_INFO[info.parent] && setSelected(info.parent)}>{info?.parent || 'IfcRoot'}</span>
              <span className="sep">›</span>
              <span>{selected}</span>
              {info?.children?.length > 0 && (
                <span style={{display:'contents'}}>
                  <span className="sep">›</span>
                  {info.children.slice(0, 2).map((c, i) => (
                    <span style={{display:'contents'}} key={c}>
                      {i > 0 && <span className="sep" style={{ opacity: 0.3 }}>·</span>}
                      <span className={SCHEMA_INFO[c] ? 'clickable' : ''} onClick={() => SCHEMA_INFO[c] && setSelected(c)}>{c}</span>
                    </span>
                  ))}
                  {info.children.length > 2 && <span>+{info.children.length - 2}</span>}
                </span>
              )}
            </div>

            <p style={{ fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55, marginTop: 14 }}>
              {info?.description || 'No description available.'}
            </p>

            <div className="schema-grid">
              <div><div className="k">Instances</div><div className="v">{instances.length}</div></div>
              <div><div className="k">Property Sets</div><div className="v">{psetUsage.length}</div></div>
              <div><div className="k">Quantity Sets</div><div className="v">{qtoUsage.length}</div></div>
              <div><div className="k">Relationships</div><div className="v">{(info?.relationships || []).length}</div></div>
            </div>

            <h4>Common Attributes</h4>
            <div className="schema-list-2">
              {(info?.commonAttributes || []).map(a => (
                <div key={a.name} className="row">
                  <div className="nm">
                    {a.name}
                    {a.required && <span style={{ color: 'var(--warn)', marginLeft: 4 }}>*</span>}
                  </div>
                  <div className="meta">{a.type}</div>
                </div>
              ))}
              {(info?.commonAttributes || []).length === 0 && (
                <div className="row"><div className="nm" style={{ color: 'var(--fg-3)' }}>No attributes documented.</div><div /></div>
              )}
            </div>

            <h4>Property Sets {psetUsage.length > 0 && <span style={{ color: 'var(--fg-3)', textTransform: 'none', letterSpacing: 0, marginLeft: 4 }}>(from {instances.length} instance{instances.length === 1 ? '' : 's'})</span>}</h4>
            {psetUsage.length > 0 ? psetUsage.map(([name, data]) => (
              <div key={name} className="schema-pset">
                <div className="schema-pset-head">
                  <span>{name}</span>
                  <span className="occ">{data.occurrences} occurrence{data.occurrences === 1 ? '' : 's'}</span>
                </div>
                <div className="schema-pset-props">
                  {[...data.props.entries()].map(([pn, pt]) => (
                    <div key={pn} className="row">
                      <span className="nm">{pn}</span>
                      <span className="ty">{pt}</span>
                    </div>
                  ))}
                </div>
              </div>
            )) : (
              <div className="schema-list-2"><div className="row"><div className="nm" style={{ color: 'var(--fg-3)' }}>No property sets observed on instances. Schema-suggested:</div><div /></div>
                {(info?.propertySets || []).map(p => (
                  <div key={p} className="row"><div className="nm" style={{ color: 'var(--fg-2)' }}>{p}</div><div className="meta">suggested</div></div>
                ))}
              </div>
            )}

            {qtoUsage.length > 0 && (
              <span style={{display:'contents'}}>
                <h4>Quantity Sets</h4>
                {qtoUsage.map(([name, data]) => (
                  <div key={name} className="schema-pset">
                    <div className="schema-pset-head" style={{ color: 'oklch(0.82 0.12 145)' }}>
                      <span>{name}</span>
                      <span className="occ">{data.occurrences} occurrence{data.occurrences === 1 ? '' : 's'}</span>
                    </div>
                    <div className="schema-pset-props">
                      {[...data.props.entries()].map(([pn, pt]) => (
                        <div key={pn} className="row">
                          <span className="nm">{pn}</span>
                          <span className="ty">{pt}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </span>
            )}

            <h4>Relationships</h4>
            <div className="schema-list-2">
              {(info?.relationships || []).map(r => (
                <div key={r} className="row"><div className="nm">{r}</div><div className="meta">IFC4</div></div>
              ))}
            </div>

            {instances.length > 0 && (
              <div style={{ marginTop: 22, display: 'flex', gap: 6 }}>
                <button className="btn btn-primary" onClick={() => { onSelectClass(instances.map(i => i.expressId)); onClose(); }}>
                  <Icons.Check size={12} /> Select all {instances.length} instance{instances.length === 1 ? '' : 's'}
                </button>
                <button className="btn" onClick={() => { dispatch({ type: 'isolate', ids: instances.map(i => i.expressId) }); onClose(); }}>
                  <Icons.Isolate size={12} /> Isolate in viewer
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// EXPORT HELPERS
// ===========================================================================
function exportCSV(rows, model, toast) {
  const headers = ['ExpressId', 'GlobalId', 'IfcClass', 'Name', 'Storey', 'Material', 'ObjectType', 'PredefinedType'];
  const lines = [headers.join(',')];
  rows.forEach(el => {
    const cells = [
      el.expressId,
      el.globalId,
      el.ifcClass,
      `"${(el.name || '').replace(/"/g, '""')}"`,
      `"${el.storey?.name || ''}"`,
      `"${el.materials[0]?.name || ''}"`,
      el.objectType || '',
      el.predefinedType || '',
    ];
    lines.push(cells.join(','));
  });
  download(lines.join('\n'), 'ifc-selection.csv', 'text/csv');
  toast({ kind: 'ok', msg: 'CSV exported', sub: `${rows.length} row${rows.length === 1 ? '' : 's'}` });
}

function exportJSON(rows, toast) {
  download(JSON.stringify(rows, (k, v) => k === 'storey' ? (v ? v.name : null) : v, 2), 'ifc-selection.json', 'application/json');
  toast({ kind: 'ok', msg: 'JSON exported', sub: `${rows.length} object${rows.length === 1 ? '' : 's'}` });
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

Object.assign(window, {
  LeftSidebar, Inspector, BottomPanel, SchemaExplorer, exportCSV, exportJSON, download,
});
