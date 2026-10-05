(() => {
  function LeftSidebar({ model, viewerState, dispatch, onPick, onZoomTo, onContext }) {
    const [tab, setTab] = useState("spatial");
    const [filter, setFilter] = useState("");
    const counts = useMemo(() => {
      const m = /* @__PURE__ */ new Map();
      if (!model) return m;
      model.elements.forEach((e) => {
        if (e.isType) return;
        m.set(e.ifcClass, (m.get(e.ifcClass) || 0) + 1);
      });
      return m;
    }, [model]);
    if (!model) {
      return /* @__PURE__ */ React.createElement("div", { className: "side left-side" }, /* @__PURE__ */ React.createElement("div", { className: "side-tabs" }, ["Spatial", "Entities", "Layers", "Views", "Sets"].map((t) => /* @__PURE__ */ React.createElement("button", { key: t, className: "side-tab", disabled: true, style: { opacity: 0.4 } }, t))), /* @__PURE__ */ React.createElement("div", { className: "side-empty" }, "Load an IFC model to browse its hierarchy."));
    }
    return /* @__PURE__ */ React.createElement("div", { className: "side left-side" }, /* @__PURE__ */ React.createElement("div", { className: "side-tabs" }, /* @__PURE__ */ React.createElement("button", { className: "side-tab", "aria-selected": tab === "spatial", onClick: () => setTab("spatial") }, /* @__PURE__ */ React.createElement(Icons.Tree, { size: 12 }), " Spatial"), /* @__PURE__ */ React.createElement("button", { className: "side-tab", "aria-selected": tab === "entities", onClick: () => setTab("entities") }, /* @__PURE__ */ React.createElement(Icons.Box, { size: 12 }), " Entities"), /* @__PURE__ */ React.createElement("button", { className: "side-tab", "aria-selected": tab === "layers", onClick: () => setTab("layers") }, /* @__PURE__ */ React.createElement(Icons.Layer, { size: 12 }), " Layers"), /* @__PURE__ */ React.createElement("button", { className: "side-tab", "aria-selected": tab === "views", onClick: () => setTab("views") }, /* @__PURE__ */ React.createElement(Icons.Bookmark, { size: 12 }), " Views"), /* @__PURE__ */ React.createElement("button", { className: "side-tab", "aria-selected": tab === "sets", onClick: () => setTab("sets") }, /* @__PURE__ */ React.createElement(Icons.Sets, { size: 12 }), " Sets")), /* @__PURE__ */ React.createElement("div", { className: "side-search" }, /* @__PURE__ */ React.createElement(Icons.Search, { size: 11, style: { color: "var(--fg-3)" } }), /* @__PURE__ */ React.createElement(
      "input",
      {
        placeholder: `Filter ${tab}\u2026`,
        value: filter,
        onChange: (e) => setFilter(e.target.value)
      }
    ), filter && /* @__PURE__ */ React.createElement("button", { className: "tree-action", onClick: () => setFilter("") }, /* @__PURE__ */ React.createElement(Icons.X, { size: 10 }))), /* @__PURE__ */ React.createElement("div", { className: "side-content" }, tab === "spatial" && /* @__PURE__ */ React.createElement(SpatialTree, { model, viewerState, dispatch, onPick, onZoomTo, onContext, filter }), tab === "entities" && /* @__PURE__ */ React.createElement(EntityTypesList, { model, counts, viewerState, dispatch, onPick, onZoomTo, filter }), tab === "layers" && /* @__PURE__ */ React.createElement(LayersList, { model, counts, viewerState, dispatch, onZoomTo, filter }), tab === "views" && /* @__PURE__ */ React.createElement(SavedViewsList, { viewerState, dispatch }), tab === "sets" && /* @__PURE__ */ React.createElement(SelectionSetsList, { viewerState, dispatch, onPick })));
  }
  function SpatialTree({ model, viewerState, dispatch, onPick, onZoomTo, onContext, filter }) {
    const [expanded, setExpanded] = useState(() => {
      const s = /* @__PURE__ */ new Set();
      s.add(model.project.expressId);
      s.add(model.site.expressId);
      s.add(model.building.expressId);
      model.storeys.forEach((st) => s.add(st.expressId));
      return s;
    });
    const toggleExpand = (id) => {
      setExpanded((s) => {
        const n = new Set(s);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
    };
    const filterLower = filter.toLowerCase();
    const matchesFilter = (el) => {
      if (!filter) return true;
      if (el.isClassGroup) return el.ifcClass.toLowerCase().includes(filterLower);
      return (el.name || "").toLowerCase().includes(filterLower) || (el.ifcClass || "").toLowerCase().includes(filterLower) || (el.globalId || "").toLowerCase().includes(filterLower);
    };
    const getDirectChildren = (el) => {
      const children = el.childrenExpressIds ? el.childrenExpressIds.map((id) => model.byId.get(id)).filter(Boolean) : [];
      return children.length > 0 ? children : model.elements.filter((c) => c.parentExpressId === el.expressId && !c.isType);
    };
    const groupStoreyChildrenByClass = (storey, children) => {
      if (storey.ifcClass !== "IfcBuildingStorey") return children;
      const groups = /* @__PURE__ */ new Map();
      children.forEach((child) => {
        if (!groups.has(child.ifcClass)) groups.set(child.ifcClass, []);
        groups.get(child.ifcClass).push(child);
      });
      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ifcClass, classChildren]) => ({
        isClassGroup: true,
        treeId: `class:${storey.expressId}:${ifcClass}`,
        ifcClass,
        name: ifcClass,
        parentExpressId: storey.expressId,
        children: classChildren
      }));
    };
    const renderNode = (el, depth) => {
      const directChildren = el.isClassGroup ? el.children : getDirectChildren(el);
      const treeChildren = el.isClassGroup ? directChildren : groupStoreyChildrenByClass(el, directChildren);
      const visibleChildren = filter ? treeChildren.filter((c) => matchesFilter(c) || hasDescendantMatch(c)) : treeChildren;
      if (filter && !matchesFilter(el) && visibleChildren.length === 0) return null;
      const nodeId = el.treeId || el.expressId;
      const collectedIds = collectIds(el, model);
      const isOpen = expanded.has(nodeId) || !!filter;
      const isSelected = el.isClassGroup ? collectedIds.length > 0 && collectedIds.every((id) => viewerState.selectedIds.has(id)) : viewerState.selectedIds.has(el.expressId);
      const isHidden = el.isClassGroup ? collectedIds.length > 0 && collectedIds.every((id) => viewerState.hiddenIds.has(id)) : viewerState.hiddenIds.has(el.expressId);
      const hasChildren = visibleChildren.length > 0;
      const rowCount = directChildren.length;
      const zoomIds = el.isClassGroup ? collectedIds : [el.expressId];
      return /* @__PURE__ */ React.createElement("span", { style: { display: "contents" }, key: nodeId }, /* @__PURE__ */ React.createElement(
        "div",
        {
          className: "tree-row",
          "data-selected": isSelected,
          "data-hidden": isHidden,
          style: { paddingLeft: 8 + depth * 14 },
          onClick: (e) => el.isClassGroup ? toggleExpand(nodeId) : onPick(el.expressId, e),
          onContextMenu: (e) => {
            e.preventDefault();
            el.isClassGroup ? onZoomTo(collectedIds) : onContext(e, el.expressId);
          }
        },
        /* @__PURE__ */ React.createElement("span", { className: `tree-caret ${hasChildren ? "" : "invisible"}`, onClick: (e) => {
          e.stopPropagation();
          toggleExpand(nodeId);
        } }, /* @__PURE__ */ React.createElement(Icons.ChevronRight, { size: 9, style: { transform: isOpen ? "rotate(90deg)" : "" } })),
        /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(el.ifcClass) } })),
        /* @__PURE__ */ React.createElement("span", { className: "tree-label" }, /* @__PURE__ */ React.createElement("span", { className: "lbl-class" }, el.isClassGroup ? "Class" : el.ifcClass.replace("Ifc", "")), el.name || /* @__PURE__ */ React.createElement("em", { style: { color: "var(--fg-3)" } }, "(unnamed)")),
        rowCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "tree-count" }, rowCount),
        /* @__PURE__ */ React.createElement("span", { className: "tree-actions" }, /* @__PURE__ */ React.createElement("button", { className: "tree-action", title: "Zoom to", onClick: (e) => {
          e.stopPropagation();
          onZoomTo(zoomIds);
        } }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 })), /* @__PURE__ */ React.createElement(
          "button",
          {
            className: "tree-action",
            "data-active": isHidden,
            title: isHidden ? "Show" : "Hide",
            onClick: (e) => {
              e.stopPropagation();
              dispatch({ type: "toggle-hide", ids: collectedIds });
            }
          },
          isHidden ? /* @__PURE__ */ React.createElement(Icons.EyeOff, { size: 11 }) : /* @__PURE__ */ React.createElement(Icons.Eye, { size: 11 })
        ), /* @__PURE__ */ React.createElement(
          "button",
          {
            className: "tree-action",
            title: "Isolate",
            onClick: (e) => {
              e.stopPropagation();
              dispatch({ type: "isolate", ids: collectedIds });
            }
          },
          /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 11 })
        ))
      ), isOpen && visibleChildren.map((c) => renderNode(c, depth + 1)));
      function hasDescendantMatch(node) {
        const kids = node.isClassGroup ? node.children : getDirectChildren(node);
        return kids.some((k) => matchesFilter(k) || hasDescendantMatch(k));
      }
    };
    return /* @__PURE__ */ React.createElement("div", { className: "tree" }, renderNode(model.project, 0));
  }
  function collectIds(el, model) {
    if (el.isClassGroup) {
      const out2 = [];
      el.children.forEach((child) => collectIds(child, model).forEach((id) => out2.push(id)));
      return [...new Set(out2)];
    }
    const out = [el.expressId];
    const walk = (e) => {
      const children = e.childrenExpressIds ? e.childrenExpressIds.map((id) => model.byId.get(id)).filter(Boolean) : [];
      const kids = children.length > 0 ? children : model.elements.filter((c) => c.parentExpressId === e.expressId && !c.isType);
      kids.forEach((k) => {
        out.push(k.expressId);
        walk(k);
      });
    };
    walk(el);
    return out;
  }
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
    return /* @__PURE__ */ React.createElement("div", { className: "tree", style: { padding: "4px 0" } }, filtered.map(([cls, n]) => {
      const isOpen = openClass === cls;
      const instances = model.elements.filter((e) => e.ifcClass === cls && !e.isType);
      const isolated = instances.length > 0 && instances.every((e) => viewerState.isolatedIds.has(e.expressId));
      return /* @__PURE__ */ React.createElement("span", { style: { display: "contents" }, key: cls }, /* @__PURE__ */ React.createElement(
        "div",
        {
          className: "tree-row",
          onClick: () => setOpenClass(isOpen ? null : cls),
          onContextMenu: (e) => {
            e.preventDefault();
            onZoomTo(instances.map((i) => i.expressId));
          }
        },
        /* @__PURE__ */ React.createElement("span", { className: "tree-caret" }, /* @__PURE__ */ React.createElement(Icons.ChevronRight, { size: 9, style: { transform: isOpen ? "rotate(90deg)" : "" } })),
        /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(cls) } })),
        /* @__PURE__ */ React.createElement("span", { className: "tree-label" }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11.5 } }, cls)),
        /* @__PURE__ */ React.createElement("span", { className: "tree-count" }, n),
        /* @__PURE__ */ React.createElement("span", { className: "tree-actions" }, /* @__PURE__ */ React.createElement("button", { className: "tree-action", title: "Zoom", onClick: (e) => {
          e.stopPropagation();
          onZoomTo(instances.map((i) => i.expressId));
        } }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 })), /* @__PURE__ */ React.createElement("button", { className: "tree-action", "data-active": isolated, title: "Isolate", onClick: (e) => {
          e.stopPropagation();
          dispatch({ type: "isolate", ids: instances.map((i) => i.expressId) });
        } }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 11 })), /* @__PURE__ */ React.createElement("button", { className: "tree-action", title: "Select all", onClick: (e) => {
          e.stopPropagation();
          dispatch({ type: "select", ids: instances.map((i) => i.expressId) });
        } }, /* @__PURE__ */ React.createElement(Icons.Check, { size: 11 })))
      ), isOpen && instances.map((el) => /* @__PURE__ */ React.createElement(
        "div",
        {
          key: el.expressId,
          className: "tree-row",
          "data-selected": viewerState.selectedIds.has(el.expressId),
          "data-hidden": viewerState.hiddenIds.has(el.expressId),
          style: { paddingLeft: 36 },
          onClick: (e) => onPick(el.expressId, e)
        },
        /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(el.ifcClass), opacity: 0.6 } })),
        /* @__PURE__ */ React.createElement("span", { className: "tree-label", style: { fontSize: 11.5 } }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)", fontFamily: "JetBrains Mono, monospace", fontSize: 10, marginRight: 6 } }, "#", el.expressId), el.name || /* @__PURE__ */ React.createElement("em", { style: { color: "var(--fg-3)" } }, "(unnamed)")),
        /* @__PURE__ */ React.createElement("span", { className: "tree-actions" }, /* @__PURE__ */ React.createElement("button", { className: "tree-action", title: "Zoom", onClick: (e) => {
          e.stopPropagation();
          onZoomTo([el.expressId]);
        } }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 })))
      )));
    }));
  }
  function LayersList({ model, counts, viewerState, dispatch, onZoomTo, filter }) {
    const groups = useMemo(() => [
      { name: "Architectural", cats: ["IfcWall", "IfcWallStandardCase", "IfcDoor", "IfcWindow", "IfcCovering", "IfcRailing", "IfcStair", "IfcStairFlight", "IfcRoof"] },
      { name: "Structural", cats: ["IfcColumn", "IfcBeam", "IfcSlab"] },
      { name: "Spatial", cats: ["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace"] },
      { name: "MEP", cats: ["IfcDistributionElement", "IfcFlowSegment"] },
      { name: "Furnishing", cats: ["IfcFurnishingElement"] }
    ], []);
    return /* @__PURE__ */ React.createElement("div", { className: "tree", style: { padding: "4px 0" } }, groups.map((g) => {
      const total = g.cats.reduce((a, c) => a + (counts.get(c) || 0), 0);
      if (filter && !g.name.toLowerCase().includes(filter.toLowerCase()) && total === 0) return null;
      return /* @__PURE__ */ React.createElement("span", { style: { display: "contents" }, key: g.name }, /* @__PURE__ */ React.createElement("div", { className: "side-section-head" }, /* @__PURE__ */ React.createElement("span", null, g.name), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)", fontFamily: "JetBrains Mono, monospace" } }, total)), g.cats.map((c) => {
        const n = counts.get(c);
        if (!n) return null;
        const instances = model.elements.filter((e) => e.ifcClass === c && !e.isType);
        const isHidden = instances.every((i) => viewerState.hiddenIds.has(i.expressId));
        return /* @__PURE__ */ React.createElement("div", { key: c, className: "tree-row", style: { paddingLeft: 18 }, "data-hidden": isHidden }, /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(c) } })), /* @__PURE__ */ React.createElement("span", { className: "tree-label" }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11.5 } }, c.replace("Ifc", ""))), /* @__PURE__ */ React.createElement("span", { className: "tree-count" }, n), /* @__PURE__ */ React.createElement("span", { className: "tree-actions" }, /* @__PURE__ */ React.createElement(
          "button",
          {
            className: "tree-action",
            "data-active": isHidden,
            title: isHidden ? "Show" : "Hide",
            onClick: () => dispatch({ type: "toggle-hide", ids: instances.map((i) => i.expressId) })
          },
          isHidden ? /* @__PURE__ */ React.createElement(Icons.EyeOff, { size: 11 }) : /* @__PURE__ */ React.createElement(Icons.Eye, { size: 11 })
        ), /* @__PURE__ */ React.createElement("button", { className: "tree-action", title: "Zoom", onClick: () => onZoomTo(instances.map((i) => i.expressId)) }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 }))));
      }));
    }));
  }
  function SavedViewsList({ viewerState, dispatch }) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 12px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 } }, "Saved Views"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, padding: "0 6px", fontSize: 11 }, onClick: () => dispatch({ type: "save-view" }) }, /* @__PURE__ */ React.createElement(Icons.Plus, { size: 10 }), " Save current")), viewerState.savedViews.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { color: "var(--fg-3)", fontSize: 11, padding: "14px 0", textAlign: "center" } }, "No saved views yet.", /* @__PURE__ */ React.createElement("br", null), "Frame the model, then click ", /* @__PURE__ */ React.createElement("em", null, "Save current"), ".") : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, viewerState.savedViews.map((v) => /* @__PURE__ */ React.createElement("div", { key: v.id, className: "tree-row", style: { height: 32 }, onClick: () => dispatch({ type: "restore-view", id: v.id }) }, /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement(Icons.Camera, { size: 11 })), /* @__PURE__ */ React.createElement("span", { className: "tree-label" }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: "var(--fg-0)" } }, v.name), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10, color: "var(--fg-3)", fontFamily: "JetBrains Mono, monospace" } }, v.timestamp)), /* @__PURE__ */ React.createElement("button", { className: "tree-action", onClick: (e) => {
      e.stopPropagation();
      dispatch({ type: "delete-view", id: v.id });
    } }, /* @__PURE__ */ React.createElement(Icons.X, { size: 11 }))))));
  }
  function SelectionSetsList({ viewerState, dispatch, onPick }) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 12px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 } }, "Selection Sets"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, padding: "0 6px", fontSize: 11 }, disabled: viewerState.selectedIds.size === 0, onClick: () => dispatch({ type: "save-set" }) }, /* @__PURE__ */ React.createElement(Icons.Plus, { size: 10 }), " From selection")), viewerState.selectionSets.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { color: "var(--fg-3)", fontSize: 11, padding: "14px 0", textAlign: "center" } }, "Select objects in the viewer", /* @__PURE__ */ React.createElement("br", null), "and save them as a reusable set.") : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, viewerState.selectionSets.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.id, className: "tree-row", style: { height: 28 }, onClick: () => dispatch({ type: "restore-set", id: s.id }) }, /* @__PURE__ */ React.createElement("span", { className: "tree-icon" }, /* @__PURE__ */ React.createElement(Icons.Sets, { size: 11 })), /* @__PURE__ */ React.createElement("span", { className: "tree-label" }, s.name), /* @__PURE__ */ React.createElement("span", { className: "tree-count" }, s.ids.length), /* @__PURE__ */ React.createElement("button", { className: "tree-action", onClick: (e) => {
      e.stopPropagation();
      dispatch({ type: "delete-set", id: s.id });
    } }, /* @__PURE__ */ React.createElement(Icons.X, { size: 11 }))))));
  }
  function Inspector({ model, viewerState, dispatch, onZoomTo, toast }) {
    const [openSections, setOpenSections] = useState(() => /* @__PURE__ */ new Set(["identity", "spatial", "psets", "qtos", "materials", "type", "classifications", "rels", "raw"]));
    const [colorOpen, setColorOpen] = useState(false);
    const [detailRev, setDetailRev] = useState(0);
    const id = viewerState.selectedIds.size > 0 ? [...viewerState.selectedIds][viewerState.selectedIds.size - 1] : null;
    useEffect(() => {
      if (!(model == null ? void 0 : model.expandElement) || id == null) return;
      let cancelled = false;
      Promise.resolve(model.expandElement(id)).then(() => {
        if (!cancelled) setDetailRev((v) => v + 1);
      });
      return () => {
        cancelled = true;
      };
    }, [id, model]);
    if (!model) return null;
    void detailRev;
    if (!id) {
      return /* @__PURE__ */ React.createElement("div", { className: "side right-side" }, /* @__PURE__ */ React.createElement("div", { className: "side-content" }, /* @__PURE__ */ React.createElement("div", { className: "insp-empty" }, /* @__PURE__ */ React.createElement("div", { className: "insp-empty-icon" }, /* @__PURE__ */ React.createElement(Icons.Box, { size: 20 })), /* @__PURE__ */ React.createElement("h3", null, "No selection"), /* @__PURE__ */ React.createElement("p", null, "Click an element in the viewer or the tree to inspect its IFC metadata, property sets, materials, and relationships."), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16, padding: "10px 12px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 5, fontSize: 11, textAlign: "left", color: "var(--fg-2)" } }, /* @__PURE__ */ React.createElement("div", { style: { color: "var(--fg-1)", fontWeight: 600, marginBottom: 4 } }, "Tip"), "Hold ", /* @__PURE__ */ React.createElement("kbd", { style: { background: "var(--bg-3)", padding: "1px 5px", borderRadius: 3, fontFamily: "JetBrains Mono, monospace", fontSize: 10 } }, "Ctrl"), " while clicking to multi-select."))));
    }
    const el = model.byId.get(id);
    if (!el) return null;
    const toggle = (k) => setOpenSections((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
    const copy = (text, label) => {
      var _a;
      (_a = navigator.clipboard) == null ? void 0 : _a.writeText(text);
      toast({ kind: "ok", msg: "Copied", sub: label });
    };
    const incomingRels = model.relationships.filter((r) => r.targetExpressIds.includes(id));
    const outgoingRels = model.relationships.filter((r) => r.sourceExpressId === id);
    const typeObj = el.typeExpressId ? model.byId.get(el.typeExpressId) : null;
    const breadcrumb = [];
    let cur = el;
    while (cur && cur.parentExpressId) {
      const parent = model.byId.get(cur.parentExpressId);
      if (!parent) break;
      breadcrumb.unshift(parent);
      cur = parent;
    }
    return /* @__PURE__ */ React.createElement("div", { className: "side right-side" }, /* @__PURE__ */ React.createElement("div", { className: "insp-header" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, fontFamily: "JetBrains Mono, monospace", fontSize: 10, color: "var(--fg-3)", marginBottom: 6 } }, breadcrumb.map((b, i) => /* @__PURE__ */ React.createElement("span", { style: { display: "contents" }, key: b.expressId }, /* @__PURE__ */ React.createElement("span", { style: { cursor: "pointer" }, onClick: () => dispatch({ type: "select", ids: [b.expressId] }) }, b.name || b.ifcClass), i < breadcrumb.length - 1 || true ? /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.5 } }, "\u203A") : null))), /* @__PURE__ */ React.createElement("div", { className: "insp-class-pill" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(el.ifcClass) } }), el.ifcClass), /* @__PURE__ */ React.createElement("div", { className: "insp-name" }, el.name || /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)", fontStyle: "italic" } }, "(unnamed)")), /* @__PURE__ */ React.createElement("div", { className: "insp-globalid" }, /* @__PURE__ */ React.createElement("span", null, el.globalId), /* @__PURE__ */ React.createElement("button", { title: "Copy GlobalId", onClick: () => copy(el.globalId, "GlobalId") }, /* @__PURE__ */ React.createElement(Icons.Copy, { size: 11 }))), /* @__PURE__ */ React.createElement("div", { className: "insp-quickbar" }, /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => onZoomTo([id]) }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 }), " Zoom"), /* @__PURE__ */ React.createElement("button", { className: "btn", "data-active": viewerState.isolatedIds.size > 0 && viewerState.isolatedIds.has(id), onClick: () => dispatch({ type: "isolate", ids: [id] }) }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 11 }), " Isolate"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => dispatch({ type: "toggle-hide", ids: [id] }) }, viewerState.hiddenIds.has(id) ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Icons.EyeOff, { size: 11 }), " Show") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Icons.Eye, { size: 11 }), " Hide")), /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => setColorOpen((v) => !v) }, /* @__PURE__ */ React.createElement(Icons.PaintBucket, { size: 11 }), " Color"), colorOpen && /* @__PURE__ */ React.createElement("div", { className: "color-popover", style: { top: 28, right: 0 } }, ["#6fb7d6", "#d18a6a", "#b08fbe", "#d4c084", "#91a673", "#a87b5a", "#4ea1a6", "#cfd3da", "#b4a07c", "#c2956a", "#8a93a0", null].map((c) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: c || "reset",
        className: "sw",
        style: { background: c || "transparent", borderColor: !c ? "var(--line-strong)" : void 0 },
        title: c || "Reset",
        onClick: () => {
          dispatch({ type: "set-color", id, color: c });
          setColorOpen(false);
        }
      },
      !c && /* @__PURE__ */ React.createElement(Icons.X, { size: 10 })
    )))))), /* @__PURE__ */ React.createElement("div", { className: "side-content" }, /* @__PURE__ */ React.createElement(Section, { title: "Basic Identity", open: openSections.has("identity"), onToggle: () => toggle("identity") }, /* @__PURE__ */ React.createElement(KV, { k: "Express ID" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, "#", el.expressId), /* @__PURE__ */ React.createElement("button", { className: "tree-action", style: { marginLeft: 4 }, onClick: () => copy("#" + el.expressId, "Express ID") }, /* @__PURE__ */ React.createElement(Icons.Copy, { size: 10 }))), /* @__PURE__ */ React.createElement(KV, { k: "GlobalId" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, el.globalId)), /* @__PURE__ */ React.createElement(KV, { k: "IFC Class" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, el.ifcClass)), /* @__PURE__ */ React.createElement(KV, { k: "Object Type" }, el.objectType || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement(KV, { k: "Tag" }, el.tag ? /* @__PURE__ */ React.createElement("span", { className: "mono" }, el.tag) : /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement(KV, { k: "Predefined Type" }, el.predefinedType ? /* @__PURE__ */ React.createElement("span", { className: "mono" }, ".", el.predefinedType, ".") : /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement(KV, { k: "Description" }, el.description || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014"))), /* @__PURE__ */ React.createElement(Section, { title: "Spatial Location", open: openSections.has("spatial"), onToggle: () => toggle("spatial") }, /* @__PURE__ */ React.createElement(KV, { k: "Project" }, /* @__PURE__ */ React.createElement("span", { style: { cursor: "pointer", color: "var(--accent)" }, onClick: () => dispatch({ type: "select", ids: [model.project.expressId] }) }, model.project.name)), /* @__PURE__ */ React.createElement(KV, { k: "Site" }, /* @__PURE__ */ React.createElement("span", { style: { cursor: "pointer", color: "var(--accent)" }, onClick: () => dispatch({ type: "select", ids: [model.site.expressId] }) }, model.site.name)), /* @__PURE__ */ React.createElement(KV, { k: "Building" }, /* @__PURE__ */ React.createElement("span", { style: { cursor: "pointer", color: "var(--accent)" }, onClick: () => dispatch({ type: "select", ids: [model.building.expressId] }) }, model.building.name)), /* @__PURE__ */ React.createElement(KV, { k: "Storey" }, el.storey ? /* @__PURE__ */ React.createElement("span", { style: { cursor: "pointer", color: "var(--accent)" }, onClick: () => dispatch({ type: "select", ids: [el.storey.expressId] }) }, el.storey.name) : /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement(KV, { k: "Containment" }, /* @__PURE__ */ React.createElement("span", { className: "mono", style: { fontSize: 10.5 } }, "IfcRelContainedInSpatialStructure"))), el.propertySets.length > 0 && /* @__PURE__ */ React.createElement(
      Section,
      {
        title: "Property Sets",
        count: el.propertySets.length,
        open: openSections.has("psets"),
        onToggle: () => toggle("psets")
      },
      el.propertySets.map((ps) => /* @__PURE__ */ React.createElement("div", { className: "pset-table", key: ps.name }, /* @__PURE__ */ React.createElement("div", { className: "pset-head" }, /* @__PURE__ */ React.createElement("span", { className: "dot" }), " ", ps.name), ps.properties.map((p) => /* @__PURE__ */ React.createElement("div", { className: "pset-row", key: p.name }, /* @__PURE__ */ React.createElement("span", { className: "k" }, p.name), /* @__PURE__ */ React.createElement("span", { className: "v" }, formatValue(p.value), p.unit && /* @__PURE__ */ React.createElement("span", { className: "unit" }, p.unit))))))
    ), el.quantitySets.length > 0 && /* @__PURE__ */ React.createElement(
      Section,
      {
        title: "Quantity Sets",
        count: el.quantitySets.length,
        open: openSections.has("qtos"),
        onToggle: () => toggle("qtos")
      },
      el.quantitySets.map((qs) => /* @__PURE__ */ React.createElement("div", { className: "pset-table", key: qs.name }, /* @__PURE__ */ React.createElement("div", { className: "pset-head", style: { color: "oklch(0.82 0.12 145)" } }, /* @__PURE__ */ React.createElement("span", { className: "dot", style: { background: "oklch(0.82 0.12 145)" } }), " ", qs.name), qs.properties.map((p) => /* @__PURE__ */ React.createElement("div", { className: "pset-row", key: p.name }, /* @__PURE__ */ React.createElement("span", { className: "k" }, p.name), /* @__PURE__ */ React.createElement("span", { className: "v" }, formatValue(p.value), p.unit && /* @__PURE__ */ React.createElement("span", { className: "unit" }, p.unit))))))
    ), el.materials.length > 0 && /* @__PURE__ */ React.createElement(
      Section,
      {
        title: "Materials",
        count: el.materials.length,
        open: openSections.has("materials"),
        onToggle: () => toggle("materials")
      },
      el.materials.map((m, mi) => /* @__PURE__ */ React.createElement("div", { key: mi, style: { paddingTop: 6 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-0)" } }, /* @__PURE__ */ React.createElement(Icons.Material, { size: 11, style: { color: "var(--fg-2)" } }), m.name), m.density && /* @__PURE__ */ React.createElement(KV, { k: "Density" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, m.density, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)" } }, "kg/m\xB3"))), m.thermalConductivity && /* @__PURE__ */ React.createElement(KV, { k: "\u03BB (Conductivity)" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, m.thermalConductivity, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)" } }, "W/mK"))), m.layers && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 6 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.06, color: "var(--fg-3)", marginBottom: 4, fontWeight: 600 } }, "Layer Set"), m.layers.map((l, li) => /* @__PURE__ */ React.createElement("div", { key: li, className: "pset-row" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, l.name), /* @__PURE__ */ React.createElement("span", { className: "v" }, l.thickness, " ", /* @__PURE__ */ React.createElement("span", { className: "unit" }, "mm")))))))
    ), typeObj && /* @__PURE__ */ React.createElement(
      Section,
      {
        title: "Type Information",
        open: openSections.has("type"),
        onToggle: () => toggle("type")
      },
      /* @__PURE__ */ React.createElement(KV, { k: "Type" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, typeObj.objectType)),
      /* @__PURE__ */ React.createElement(KV, { k: "IFC Class" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, typeObj.ifcClass)),
      /* @__PURE__ */ React.createElement(KV, { k: "Type Express" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, "#", typeObj.expressId)),
      /* @__PURE__ */ React.createElement(KV, { k: "Type GlobalId" }, /* @__PURE__ */ React.createElement("span", { className: "mono", style: { fontSize: 10.5 } }, typeObj.globalId)),
      typeObj.propertySets.map((ps) => /* @__PURE__ */ React.createElement("div", { className: "pset-table", key: ps.name }, /* @__PURE__ */ React.createElement("div", { className: "pset-head" }, /* @__PURE__ */ React.createElement("span", { className: "dot" }), " ", ps.name, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)", marginLeft: 4 } }, "(inherited)")), ps.properties.map((p) => /* @__PURE__ */ React.createElement("div", { className: "pset-row", key: p.name }, /* @__PURE__ */ React.createElement("span", { className: "k" }, p.name), /* @__PURE__ */ React.createElement("span", { className: "v" }, formatValue(p.value), p.unit && /* @__PURE__ */ React.createElement("span", { className: "unit" }, p.unit))))))
    ), el.classifications.length > 0 && /* @__PURE__ */ React.createElement(Section, { title: "Classification", open: openSections.has("classifications"), onToggle: () => toggle("classifications") }, el.classifications.map((c, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { paddingTop: 4 } }, /* @__PURE__ */ React.createElement(KV, { k: "System" }, c.system), /* @__PURE__ */ React.createElement(KV, { k: "Code" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, c.code)), /* @__PURE__ */ React.createElement(KV, { k: "Name" }, c.name)))), /* @__PURE__ */ React.createElement(
      Section,
      {
        title: "Relationships",
        count: incomingRels.length + outgoingRels.length,
        open: openSections.has("rels"),
        onToggle: () => toggle("rels")
      },
      [...incomingRels, ...outgoingRels].slice(0, 12).map((r) => /* @__PURE__ */ React.createElement("div", { key: r.expressId, className: "rel-chip", onClick: () => {
        const other = r.sourceExpressId === id ? r.targetExpressIds[0] : r.sourceExpressId;
        dispatch({ type: "select", ids: [other] });
      } }, /* @__PURE__ */ React.createElement("span", { className: "rt" }, r.relationshipType), /* @__PURE__ */ React.createElement("span", { className: "rl" }, r.description))),
      incomingRels.length + outgoingRels.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { color: "var(--fg-3)", fontSize: 11, padding: 6 } }, "No relationships indexed.")
    ), /* @__PURE__ */ React.createElement(Section, { title: "Raw IFC Attributes", open: openSections.has("raw"), onToggle: () => toggle("raw") }, /* @__PURE__ */ React.createElement("div", { className: "raw-attrs" }, /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "#"), /* @__PURE__ */ React.createElement("th", null, "Name"), /* @__PURE__ */ React.createElement("th", null, "Value"))), /* @__PURE__ */ React.createElement("tbody", null, (el.rawAttributes || []).map((a) => /* @__PURE__ */ React.createElement("tr", { key: a.idx }, /* @__PURE__ */ React.createElement("td", { className: "idx" }, a.idx), /* @__PURE__ */ React.createElement("td", { className: "name" }, a.name), /* @__PURE__ */ React.createElement("td", { className: `val ${a.ref ? "ref" : ""} ${a.value == null ? "null" : ""}` }, a.value == null ? "$" : typeof a.value === "string" && !a.ref ? `'${a.value}'` : String(a.value))))))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("button", { className: "btn", style: { height: 24, fontSize: 11 }, onClick: () => copy(JSON.stringify(el, (k, v) => k === "storey" ? v ? v.name : null : v, 2), "Full metadata JSON") }, /* @__PURE__ */ React.createElement(Icons.Copy, { size: 11 }), " Copy full JSON")))));
  }
  function Section({ title, count, open, onToggle, children }) {
    return /* @__PURE__ */ React.createElement("div", { className: "insp-section", "data-open": open }, /* @__PURE__ */ React.createElement("div", { className: "insp-section-head", onClick: onToggle }, /* @__PURE__ */ React.createElement("div", { className: "insp-section-title" }, title, count != null && /* @__PURE__ */ React.createElement("span", { className: "insp-count" }, count)), /* @__PURE__ */ React.createElement("span", { className: "insp-caret" }, /* @__PURE__ */ React.createElement(Icons.ChevronDown, { size: 11 }))), /* @__PURE__ */ React.createElement("div", { className: "insp-section-body" }, children));
  }
  function KV({ k, children }) {
    return /* @__PURE__ */ React.createElement("div", { className: "insp-kv" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, k), /* @__PURE__ */ React.createElement("span", { className: "v" }, children));
  }
  function formatValue(v) {
    if (v == null) return /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)" } }, "\u2014");
    if (typeof v === "boolean") return /* @__PURE__ */ React.createElement("span", { style: { color: v ? "var(--ok)" : "var(--danger)" } }, v ? "TRUE" : "FALSE");
    if (typeof v === "number") return v.toLocaleString(void 0, { maximumFractionDigits: 3 });
    return String(v);
  }
  function BottomPanel({ model, viewerState, dispatch, log, onPick, toast }) {
    const [tab, setTab] = useState("selected");
    const [collapsed, setCollapsed] = useState(false);
    const selectedRows = useMemo(() => {
      if (!model) return [];
      return [...viewerState.selectedIds].map((id) => model.byId.get(id)).filter(Boolean);
    }, [viewerState.selectedIds, model]);
    const validationIssues = useMemo(() => {
      if (!model) return [];
      const issues = [];
      const missingNames = model.elements.filter((e) => !e.isType && (!e.name || e.name.trim() === ""));
      if (missingNames.length) issues.push({ severity: "warn", message: "Elements with missing Name attribute", count: missingNames.length, ids: missingNames.map((e) => e.expressId) });
      const missingClass = model.elements.filter((e) => !e.isType && !e.classifications.length && !["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"].includes(e.ifcClass));
      if (missingClass.length) issues.push({ severity: "info", message: "Elements without Uniclass classification", count: missingClass.length, ids: missingClass.map((e) => e.expressId) });
      issues.push({ severity: "info", message: "Schema validation passed for IFC4 (Reference View MVD)", count: null });
      return issues;
    }, [model]);
    if (!model) return /* @__PURE__ */ React.createElement("div", { className: "bottom-panel" }, /* @__PURE__ */ React.createElement("div", { className: "bp-head" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tabs" }, ["Selected", "Query", "Validation", "Loading Log", "Performance"].map((t) => /* @__PURE__ */ React.createElement("button", { key: t, className: "bp-tab", disabled: true, style: { opacity: 0.4 } }, t)))), /* @__PURE__ */ React.createElement("div", { className: "bp-body", style: { height: 80, display: "grid", placeItems: "center", color: "var(--fg-3)", fontSize: 12 } }, "Load a model to see selection details, query results, and performance metrics."));
    return /* @__PURE__ */ React.createElement("div", { className: "bottom-panel" }, /* @__PURE__ */ React.createElement("div", { className: "bp-head" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tabs" }, /* @__PURE__ */ React.createElement("button", { className: "bp-tab", "aria-selected": tab === "selected", onClick: () => {
      setTab("selected");
      setCollapsed(false);
    } }, /* @__PURE__ */ React.createElement(Icons.Table, { size: 11 }), " Selected ", /* @__PURE__ */ React.createElement("span", { className: "count" }, viewerState.selectedIds.size)), /* @__PURE__ */ React.createElement("button", { className: "bp-tab", "aria-selected": tab === "query", onClick: () => {
      setTab("query");
      setCollapsed(false);
    } }, /* @__PURE__ */ React.createElement(Icons.Filter, { size: 11 }), " Query Results ", /* @__PURE__ */ React.createElement("span", { className: "count" }, viewerState.queryResults.length)), /* @__PURE__ */ React.createElement("button", { className: "bp-tab", "aria-selected": tab === "validation", onClick: () => {
      setTab("validation");
      setCollapsed(false);
    } }, /* @__PURE__ */ React.createElement(Icons.Alert, { size: 11 }), " Validation ", /* @__PURE__ */ React.createElement("span", { className: "count" }, validationIssues.length)), /* @__PURE__ */ React.createElement("button", { className: "bp-tab", "aria-selected": tab === "log", onClick: () => {
      setTab("log");
      setCollapsed(false);
    } }, /* @__PURE__ */ React.createElement(Icons.Log, { size: 11 }), " Loading Log ", /* @__PURE__ */ React.createElement("span", { className: "count" }, log.length)), /* @__PURE__ */ React.createElement("button", { className: "bp-tab", "aria-selected": tab === "perf", onClick: () => {
      setTab("perf");
      setCollapsed(false);
    } }, /* @__PURE__ */ React.createElement(Icons.Speed, { size: 11 }), " Performance")), /* @__PURE__ */ React.createElement("div", { className: "bp-actions" }, tab === "selected" && selectedRows.length > 0 && /* @__PURE__ */ React.createElement("span", { style: { display: "contents" } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: () => exportCSV(selectedRows, model, toast) }, /* @__PURE__ */ React.createElement(Icons.Export, { size: 11 }), " CSV"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: () => exportJSON(selectedRows, toast) }, /* @__PURE__ */ React.createElement(Icons.Export, { size: 11 }), " JSON")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", onClick: () => setCollapsed((c) => !c), title: collapsed ? "Expand" : "Collapse" }, /* @__PURE__ */ React.createElement(Icons.ChevronDown, { size: 11, style: { transform: collapsed ? "rotate(180deg)" : "" } })))), /* @__PURE__ */ React.createElement("div", { className: `bp-body ${collapsed ? "collapsed" : ""}` }, tab === "selected" && /* @__PURE__ */ React.createElement(SelectedTable, { rows: selectedRows, model, viewerState, onPick, dispatch }), tab === "query" && /* @__PURE__ */ React.createElement(QueryResultsTable, { rows: viewerState.queryResults.map((id) => model.byId.get(id)).filter(Boolean), model, viewerState, onPick, dispatch }), tab === "validation" && /* @__PURE__ */ React.createElement(ValidationList, { issues: validationIssues, dispatch }), tab === "log" && /* @__PURE__ */ React.createElement(LoadingLog, { log }), tab === "perf" && /* @__PURE__ */ React.createElement(PerfPanel, { model, viewerState })));
  }
  function SelectedTable({ rows, model, viewerState, onPick, dispatch }) {
    if (rows.length === 0) return /* @__PURE__ */ React.createElement("div", { style: { padding: 24, textAlign: "center", color: "var(--fg-3)", fontSize: 12 } }, "No elements selected. Click an element in the viewer or pick from the tree.");
    return /* @__PURE__ */ React.createElement("table", { className: "dtbl" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Express"), /* @__PURE__ */ React.createElement("th", null, "GlobalId"), /* @__PURE__ */ React.createElement("th", null, "IFC Class"), /* @__PURE__ */ React.createElement("th", null, "Name"), /* @__PURE__ */ React.createElement("th", null, "Storey"), /* @__PURE__ */ React.createElement("th", null, "Material"), /* @__PURE__ */ React.createElement("th", null, "Visibility"))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((el) => {
      var _a, _b;
      const vis = viewerState.hiddenIds.has(el.expressId) ? "hidden" : viewerState.isolatedIds.has(el.expressId) ? "isolated" : "visible";
      return /* @__PURE__ */ React.createElement("tr", { key: el.expressId, "data-selected": true, onClick: (e) => onPick(el.expressId, e) }, /* @__PURE__ */ React.createElement("td", { className: "mono" }, "#", el.expressId), /* @__PURE__ */ React.createElement("td", { className: "mono" }, el.globalId.slice(0, 8), "\u2026"), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "class-pill" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(el.ifcClass) } }), el.ifcClass)), /* @__PURE__ */ React.createElement("td", null, el.name || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "(unnamed)")), /* @__PURE__ */ React.createElement("td", null, ((_a = el.storey) == null ? void 0 : _a.name) || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement("td", null, ((_b = el.materials[0]) == null ? void 0 : _b.name) || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "vis-dot", "data-state": vis }), " ", vis));
    })));
  }
  function QueryResultsTable({ rows, model, viewerState, onPick, dispatch }) {
    if (rows.length === 0) return /* @__PURE__ */ React.createElement("div", { style: { padding: 24, textAlign: "center", color: "var(--fg-3)", fontSize: 12 } }, "No query results. Run a search from the toolbar.", /* @__PURE__ */ React.createElement("br", null), "Try: ", /* @__PURE__ */ React.createElement("span", { className: "mono", style: { color: "var(--accent)" } }, "FireRating:REI 90"), ", ", /* @__PURE__ */ React.createElement("span", { className: "mono", style: { color: "var(--accent)" } }, "IsExternal:true"), ", or ", /* @__PURE__ */ React.createElement("span", { className: "mono", style: { color: "var(--accent)" } }, "IfcDoor"));
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 12px", fontSize: 11, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ React.createElement("span", null, rows.length, " match", rows.length === 1 ? "" : "es"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, fontSize: 11 }, onClick: () => dispatch({ type: "select", ids: rows.map((r) => r.expressId) }) }, /* @__PURE__ */ React.createElement(Icons.Check, { size: 11 }), " Select all"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, fontSize: 11 }, onClick: () => dispatch({ type: "isolate", ids: rows.map((r) => r.expressId) }) }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 11 }), " Isolate"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, fontSize: 11 }, onClick: () => dispatch({ type: "clear-query" }) }, /* @__PURE__ */ React.createElement(Icons.X, { size: 11 }), " Clear")), /* @__PURE__ */ React.createElement("table", { className: "dtbl" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Express"), /* @__PURE__ */ React.createElement("th", null, "IFC Class"), /* @__PURE__ */ React.createElement("th", null, "Name"), /* @__PURE__ */ React.createElement("th", null, "Storey"), /* @__PURE__ */ React.createElement("th", null, "Match"))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((el) => {
      var _a;
      return /* @__PURE__ */ React.createElement("tr", { key: el.expressId, "data-selected": viewerState.selectedIds.has(el.expressId), onClick: (e) => onPick(el.expressId, e) }, /* @__PURE__ */ React.createElement("td", { className: "mono" }, "#", el.expressId), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "class-pill" }, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(el.ifcClass) } }), el.ifcClass)), /* @__PURE__ */ React.createElement("td", null, el.name || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "(unnamed)")), /* @__PURE__ */ React.createElement("td", null, ((_a = el.storey) == null ? void 0 : _a.name) || /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u2014")), /* @__PURE__ */ React.createElement("td", { className: "muted" }, viewerState.queryMatchText[el.expressId] || "\u2014"));
    }))));
  }
  function ValidationList({ issues, dispatch }) {
    return /* @__PURE__ */ React.createElement("div", { className: "val-list" }, issues.map((i, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: `val-row ${i.severity}` }, /* @__PURE__ */ React.createElement("div", { className: "vsev" }, i.severity === "warn" ? "!" : i.severity === "error" ? "\xD7" : "i"), /* @__PURE__ */ React.createElement("div", { className: "vmsg" }, i.message), i.count != null && /* @__PURE__ */ React.createElement("div", { className: "vcount" }, i.count), i.ids && i.ids.length > 0 && /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { height: 22, fontSize: 11 }, onClick: () => dispatch({ type: "select", ids: i.ids }) }, /* @__PURE__ */ React.createElement(Icons.Focus, { size: 11 }), " Show"))));
  }
  function LoadingLog({ log }) {
    return /* @__PURE__ */ React.createElement("div", { className: "log-list" }, log.map((l, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: `log-row ${l.level}` }, /* @__PURE__ */ React.createElement("span", { className: "t" }, l.time), /* @__PURE__ */ React.createElement("span", { className: "l" }, l.level), /* @__PURE__ */ React.createElement("span", { className: "msg", dangerouslySetInnerHTML: { __html: l.msg } }))));
  }
  function PerfPanel({ model, viewerState }) {
    const [fps, setFps] = useState(60);
    useEffect(() => {
      const t = setInterval(() => {
        if (window.__viewer) setFps(window.__viewer.getFps());
      }, 500);
      return () => clearInterval(t);
    }, []);
    const visible = model.elements.filter((e) => e.geometry && !viewerState.hiddenIds.has(e.expressId)).length;
    return /* @__PURE__ */ React.createElement("div", { className: "perf-grid" }, /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "FPS"), /* @__PURE__ */ React.createElement("div", { className: "v" }, fps, /* @__PURE__ */ React.createElement("span", { className: "unit" }, "/ 60")), /* @__PURE__ */ React.createElement("div", { className: "bar" }, /* @__PURE__ */ React.createElement("div", { style: { width: `${Math.min(100, fps / 60 * 100)}%` } }))), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Visible Geometry"), /* @__PURE__ */ React.createElement("div", { className: "v" }, visible, /* @__PURE__ */ React.createElement("span", { className: "unit" }, "/ ", model.totalGeometryItems)), /* @__PURE__ */ React.createElement("div", { className: "bar" }, /* @__PURE__ */ React.createElement("div", { style: { width: `${visible / model.totalGeometryItems * 100}%` } }))), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Selected"), /* @__PURE__ */ React.createElement("div", { className: "v" }, viewerState.selectedIds.size)), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Indexed Entities"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.totalEntities.toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "GPU Memory"), /* @__PURE__ */ React.createElement("div", { className: "v" }, (model.totalGeometryItems * 0.014).toFixed(1), /* @__PURE__ */ React.createElement("span", { className: "unit" }, "MB"))), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Property Sets"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.elements.reduce((a, e) => a + e.propertySets.length, 0))), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Quantities"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.elements.reduce((a, e) => a + e.quantitySets.length, 0))), /* @__PURE__ */ React.createElement("div", { className: "perf-card" }, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Relationships"), /* @__PURE__ */ React.createElement("div", { className: "v" }, model.relationships.length)));
  }
  function SchemaExplorer({ model, onClose, onSelectClass, dispatch }) {
    var _a;
    const [selected, setSelected] = useState("IfcWall");
    const [filter, setFilter] = useState("");
    const classes = useMemo(() => {
      const list = Object.keys(SCHEMA_INFO);
      const counts = /* @__PURE__ */ new Map();
      if (model) {
        model.elements.forEach((e) => {
          if (!e.isType) counts.set(e.ifcClass, (counts.get(e.ifcClass) || 0) + 1);
        });
      }
      return list.map((c) => ({ name: c, count: counts.get(c) || 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }, [model]);
    const filtered = classes.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
    const info = SCHEMA_INFO[selected];
    const instances = model ? model.elements.filter((e) => e.ifcClass === selected && !e.isType) : [];
    const psetUsage = useMemo(() => {
      const m = /* @__PURE__ */ new Map();
      instances.forEach((i) => i.propertySets.forEach((ps) => {
        if (!m.has(ps.name)) m.set(ps.name, { occurrences: 0, props: /* @__PURE__ */ new Map() });
        const e = m.get(ps.name);
        e.occurrences++;
        ps.properties.forEach((p) => {
          if (!e.props.has(p.name)) e.props.set(p.name, p.type || "IfcValue");
        });
      }));
      return [...m.entries()];
    }, [instances]);
    const qtoUsage = useMemo(() => {
      const m = /* @__PURE__ */ new Map();
      instances.forEach((i) => i.quantitySets.forEach((qs) => {
        if (!m.has(qs.name)) m.set(qs.name, { occurrences: 0, props: /* @__PURE__ */ new Map() });
        const e = m.get(qs.name);
        e.occurrences++;
        qs.properties.forEach((p) => {
          if (!e.props.has(p.name)) e.props.set(p.name, p.type || "IfcQuantity");
        });
      }));
      return [...m.entries()];
    }, [instances]);
    return /* @__PURE__ */ React.createElement("div", { className: "modal-backdrop", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "modal-head" }, /* @__PURE__ */ React.createElement(Icons.Schema, { size: 14, style: { color: "var(--accent)" } }), /* @__PURE__ */ React.createElement("h2", null, "IFC Schema Explorer"), /* @__PURE__ */ React.createElement("span", { className: "sub" }, model ? `IFC4 \u2014 ${model.elements.length} entities indexed` : "No model loaded"), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-icon", onClick: onClose }, /* @__PURE__ */ React.createElement(Icons.X, { size: 12 }))), /* @__PURE__ */ React.createElement("div", { className: "modal-body" }, /* @__PURE__ */ React.createElement("div", { className: "schema-list" }, /* @__PURE__ */ React.createElement("div", { className: "side-search", style: { margin: "8px" } }, /* @__PURE__ */ React.createElement(Icons.Search, { size: 11, style: { color: "var(--fg-3)" } }), /* @__PURE__ */ React.createElement("input", { placeholder: "Filter classes\u2026", value: filter, onChange: (e) => setFilter(e.target.value) })), filtered.map((c) => /* @__PURE__ */ React.createElement(
      "div",
      {
        key: c.name,
        className: "row",
        "data-selected": selected === c.name,
        "data-empty": c.count === 0,
        onClick: () => setSelected(c.name)
      },
      /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(c.name) } }),
      /* @__PURE__ */ React.createElement("span", { className: "nm" }, c.name),
      /* @__PURE__ */ React.createElement("span", { className: "ct" }, c.count || "\u2014")
    ))), /* @__PURE__ */ React.createElement("div", { className: "schema-detail" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement("span", { className: "swatch", style: { background: CLASS_COLOR(selected) } }), selected), /* @__PURE__ */ React.createElement("div", { className: "breadcrumb" }, /* @__PURE__ */ React.createElement("span", { className: "clickable", onClick: () => (info == null ? void 0 : info.parent) && SCHEMA_INFO[info.parent] && setSelected(info.parent) }, (info == null ? void 0 : info.parent) || "IfcRoot"), /* @__PURE__ */ React.createElement("span", { className: "sep" }, "\u203A"), /* @__PURE__ */ React.createElement("span", null, selected), ((_a = info == null ? void 0 : info.children) == null ? void 0 : _a.length) > 0 && /* @__PURE__ */ React.createElement("span", { style: { display: "contents" } }, /* @__PURE__ */ React.createElement("span", { className: "sep" }, "\u203A"), info.children.slice(0, 2).map((c, i) => /* @__PURE__ */ React.createElement("span", { style: { display: "contents" }, key: c }, i > 0 && /* @__PURE__ */ React.createElement("span", { className: "sep", style: { opacity: 0.3 } }, "\xB7"), /* @__PURE__ */ React.createElement("span", { className: SCHEMA_INFO[c] ? "clickable" : "", onClick: () => SCHEMA_INFO[c] && setSelected(c) }, c))), info.children.length > 2 && /* @__PURE__ */ React.createElement("span", null, "+", info.children.length - 2))), /* @__PURE__ */ React.createElement("p", { style: { fontSize: 12, color: "var(--fg-1)", lineHeight: 1.55, marginTop: 14 } }, (info == null ? void 0 : info.description) || "No description available."), /* @__PURE__ */ React.createElement("div", { className: "schema-grid" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Instances"), /* @__PURE__ */ React.createElement("div", { className: "v" }, instances.length)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Property Sets"), /* @__PURE__ */ React.createElement("div", { className: "v" }, psetUsage.length)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Quantity Sets"), /* @__PURE__ */ React.createElement("div", { className: "v" }, qtoUsage.length)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "k" }, "Relationships"), /* @__PURE__ */ React.createElement("div", { className: "v" }, ((info == null ? void 0 : info.relationships) || []).length))), /* @__PURE__ */ React.createElement("h4", null, "Common Attributes"), /* @__PURE__ */ React.createElement("div", { className: "schema-list-2" }, ((info == null ? void 0 : info.commonAttributes) || []).map((a) => /* @__PURE__ */ React.createElement("div", { key: a.name, className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "nm" }, a.name, a.required && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--warn)", marginLeft: 4 } }, "*")), /* @__PURE__ */ React.createElement("div", { className: "meta" }, a.type))), ((info == null ? void 0 : info.commonAttributes) || []).length === 0 && /* @__PURE__ */ React.createElement("div", { className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "nm", style: { color: "var(--fg-3)" } }, "No attributes documented."), /* @__PURE__ */ React.createElement("div", null))), /* @__PURE__ */ React.createElement("h4", null, "Property Sets ", psetUsage.length > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--fg-3)", textTransform: "none", letterSpacing: 0, marginLeft: 4 } }, "(from ", instances.length, " instance", instances.length === 1 ? "" : "s", ")")), psetUsage.length > 0 ? psetUsage.map(([name, data]) => /* @__PURE__ */ React.createElement("div", { key: name, className: "schema-pset" }, /* @__PURE__ */ React.createElement("div", { className: "schema-pset-head" }, /* @__PURE__ */ React.createElement("span", null, name), /* @__PURE__ */ React.createElement("span", { className: "occ" }, data.occurrences, " occurrence", data.occurrences === 1 ? "" : "s")), /* @__PURE__ */ React.createElement("div", { className: "schema-pset-props" }, [...data.props.entries()].map(([pn, pt]) => /* @__PURE__ */ React.createElement("div", { key: pn, className: "row" }, /* @__PURE__ */ React.createElement("span", { className: "nm" }, pn), /* @__PURE__ */ React.createElement("span", { className: "ty" }, pt)))))) : /* @__PURE__ */ React.createElement("div", { className: "schema-list-2" }, /* @__PURE__ */ React.createElement("div", { className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "nm", style: { color: "var(--fg-3)" } }, "No property sets observed on instances. Schema-suggested:"), /* @__PURE__ */ React.createElement("div", null)), ((info == null ? void 0 : info.propertySets) || []).map((p) => /* @__PURE__ */ React.createElement("div", { key: p, className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "nm", style: { color: "var(--fg-2)" } }, p), /* @__PURE__ */ React.createElement("div", { className: "meta" }, "suggested")))), qtoUsage.length > 0 && /* @__PURE__ */ React.createElement("span", { style: { display: "contents" } }, /* @__PURE__ */ React.createElement("h4", null, "Quantity Sets"), qtoUsage.map(([name, data]) => /* @__PURE__ */ React.createElement("div", { key: name, className: "schema-pset" }, /* @__PURE__ */ React.createElement("div", { className: "schema-pset-head", style: { color: "oklch(0.82 0.12 145)" } }, /* @__PURE__ */ React.createElement("span", null, name), /* @__PURE__ */ React.createElement("span", { className: "occ" }, data.occurrences, " occurrence", data.occurrences === 1 ? "" : "s")), /* @__PURE__ */ React.createElement("div", { className: "schema-pset-props" }, [...data.props.entries()].map(([pn, pt]) => /* @__PURE__ */ React.createElement("div", { key: pn, className: "row" }, /* @__PURE__ */ React.createElement("span", { className: "nm" }, pn), /* @__PURE__ */ React.createElement("span", { className: "ty" }, pt))))))), /* @__PURE__ */ React.createElement("h4", null, "Relationships"), /* @__PURE__ */ React.createElement("div", { className: "schema-list-2" }, ((info == null ? void 0 : info.relationships) || []).map((r) => /* @__PURE__ */ React.createElement("div", { key: r, className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "nm" }, r), /* @__PURE__ */ React.createElement("div", { className: "meta" }, "IFC4")))), instances.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 22, display: "flex", gap: 6 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", onClick: () => {
      onSelectClass(instances.map((i) => i.expressId));
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Check, { size: 12 }), " Select all ", instances.length, " instance", instances.length === 1 ? "" : "s"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      dispatch({ type: "isolate", ids: instances.map((i) => i.expressId) });
      onClose();
    } }, /* @__PURE__ */ React.createElement(Icons.Isolate, { size: 12 }), " Isolate in viewer"))))));
  }
  function exportCSV(rows, model, toast) {
    const headers = ["ExpressId", "GlobalId", "IfcClass", "Name", "Storey", "Material", "ObjectType", "PredefinedType"];
    const lines = [headers.join(",")];
    rows.forEach((el) => {
      var _a, _b;
      const cells = [
        el.expressId,
        el.globalId,
        el.ifcClass,
        `"${(el.name || "").replace(/"/g, '""')}"`,
        `"${((_a = el.storey) == null ? void 0 : _a.name) || ""}"`,
        `"${((_b = el.materials[0]) == null ? void 0 : _b.name) || ""}"`,
        el.objectType || "",
        el.predefinedType || ""
      ];
      lines.push(cells.join(","));
    });
    download(lines.join("\n"), "ifc-selection.csv", "text/csv");
    toast({ kind: "ok", msg: "CSV exported", sub: `${rows.length} row${rows.length === 1 ? "" : "s"}` });
  }
  function exportJSON(rows, toast) {
    download(JSON.stringify(rows, (k, v) => k === "storey" ? v ? v.name : null : v, 2), "ifc-selection.json", "application/json");
    toast({ kind: "ok", msg: "JSON exported", sub: `${rows.length} object${rows.length === 1 ? "" : "s"}` });
  }
  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  Object.assign(window, {
    LeftSidebar,
    Inspector,
    BottomPanel,
    SchemaExplorer,
    exportCSV,
    exportJSON,
    download
  });
})();
