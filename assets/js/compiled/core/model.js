(() => {
  const IFC_CLASS_COLORS = {
    IfcWall: "#c9a66b",
    IfcWallStandardCase: "#c9a66b",
    IfcWallElementedCase: "#c9a66b",
    IfcSlab: "#9aa8b8",
    IfcSlabStandardCase: "#9aa8b8",
    IfcColumn: "#d4845c",
    IfcColumnStandardCase: "#d4845c",
    IfcBeam: "#e8a45a",
    IfcBeamStandardCase: "#e8a45a",
    IfcMember: "#e8a45a",
    IfcPlate: "#d9b06a",
    IfcDoor: "#e87850",
    IfcWindow: "#4eb8e8",
    IfcWindowStandardCase: "#4eb8e8",
    IfcStair: "#b87fd4",
    IfcStairFlight: "#b87fd4",
    IfcRailing: "#e6c76a",
    IfcCovering: "#8fb88a",
    IfcRoof: "#b88862",
    IfcSpace: "#3db8b0",
    IfcFurnishingElement: "#8ec45a",
    IfcFurniture: "#8ec45a",
    IfcDistributionElement: "#6ec4e8",
    IfcFlowSegment: "#5ab0dc",
    IfcFlowFitting: "#68b8e0",
    IfcFlowTerminal: "#7ac6ec",
    IfcPipeSegment: "#58a8d4",
    IfcDuctSegment: "#62b0d8",
    IfcBuildingElementProxy: "#94a0b0",
    IfcFooting: "#a89078",
    IfcPile: "#a89078",
    IfcProject: "#b8c0cc",
    IfcSite: "#b8c0cc",
    IfcBuilding: "#b8c0cc",
    IfcBuildingStorey: "#b8c0cc"
  };
  const CLASS_COLOR = (c) => IFC_CLASS_COLORS[c] || "#8e9aa8";
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = s * 1664525 + 1013904223 >>> 0;
      return s / 4294967295;
    };
  }
  const rng = makeRng(2980430046);
  const r = () => rng();
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$";
  function makeGuid() {
    let s = "";
    for (let i = 0; i < 22; i++) s += B64[Math.floor(r() * 64)];
    return s;
  }
  let _exId = 100;
  const nextId = () => ++_exId;
  const MATERIALS = {
    concrete: { name: "Concrete C30/37", density: 2400, thermalConductivity: 2.3, layers: null },
    steel: { name: "Structural Steel S355", density: 7850, thermalConductivity: 50, layers: null },
    glass: { name: "Glazing - Double Low-E", density: 2500, thermalConductivity: 1, layers: [
      { name: "Glass outer", thickness: 6 },
      { name: "Argon cavity", thickness: 16 },
      { name: "Glass inner", thickness: 6 }
    ] },
    brick: { name: "Clay Brick Veneer", density: 1800, thermalConductivity: 0.6, layers: null },
    gypsum: { name: "Gypsum Plasterboard", density: 800, thermalConductivity: 0.21, layers: null },
    wood: { name: "Oak Hardwood", density: 720, thermalConductivity: 0.17, layers: null },
    aluminium: { name: "Anodised Aluminium", density: 2700, thermalConductivity: 237, layers: null },
    insulation: { name: "Mineral Wool Insulation", density: 35, thermalConductivity: 0.035, layers: null },
    wallAssembly: {
      name: "External Wall - 250mm",
      density: null,
      thermalConductivity: null,
      layers: [
        { name: "Clay Brick Veneer", thickness: 90 },
        { name: "Air Cavity", thickness: 40 },
        { name: "Mineral Wool Insulation", thickness: 80 },
        { name: "Concrete Block", thickness: 100 },
        { name: "Gypsum Plasterboard", thickness: 12 }
      ]
    },
    intWallAssembly: {
      name: "Internal Partition - 100mm",
      layers: [
        { name: "Gypsum Plasterboard", thickness: 12 },
        { name: "Steel Stud Cavity", thickness: 76 },
        { name: "Gypsum Plasterboard", thickness: 12 }
      ]
    },
    slabAssembly: {
      name: "Composite Floor Slab - 200mm",
      layers: [
        { name: "Carpet", thickness: 10 },
        { name: "Screed", thickness: 50 },
        { name: "Concrete C30/37", thickness: 140 }
      ]
    }
  };
  const UNICLASS = {
    IfcWall: { code: "Ss_25_10_30", name: "External wall systems" },
    IfcWallStandardCase: { code: "Ss_25_30_20", name: "Internal partition systems" },
    IfcSlab: { code: "Ss_30_25_30", name: "Floor slab systems" },
    IfcColumn: { code: "Ss_20_05_30", name: "Column systems" },
    IfcBeam: { code: "Ss_20_05_15", name: "Beam systems" },
    IfcDoor: { code: "Pr_30_59_19", name: "Door assemblies" },
    IfcWindow: { code: "Pr_30_59_98", name: "Window assemblies" },
    IfcStair: { code: "Ss_30_12_85", name: "Stair systems" },
    IfcSpace: { code: "SL_25_10", name: "Space - General" }
  };
  function buildModel() {
    const elements = [];
    const byId = /* @__PURE__ */ new Map();
    const relationships = [];
    function add(el) {
      elements.push(el);
      byId.set(el.expressId, el);
      return el;
    }
    function rel(type, source, targets, description) {
      const r2 = {
        expressId: nextId(),
        relationshipType: type,
        sourceExpressId: source,
        targetExpressIds: Array.isArray(targets) ? targets : [targets],
        description
      };
      relationships.push(r2);
      return r2;
    }
    const project = add({
      expressId: nextId(),
      globalId: makeGuid(),
      ifcClass: "IfcProject",
      name: "Riverside Office Block \u2014 Concept Design",
      description: "Sample IFC4 model bundled with the static viewer for demonstration purposes.",
      objectType: null,
      predefinedType: null,
      longName: "Project Riverside \u2014 Stage C Design Development",
      phase: "Stage C \u2014 Design Development",
      storey: null,
      parentExpressId: null,
      childrenExpressIds: [],
      propertySets: [],
      quantitySets: [],
      materials: [],
      classifications: [],
      rawAttributes: null,
      // set later
      visibility: true,
      geometry: null
    });
    const site = add({
      expressId: nextId(),
      globalId: makeGuid(),
      ifcClass: "IfcSite",
      name: "Riverside Plot",
      description: "Riverside development plot, 0.42 ha.",
      objectType: null,
      predefinedType: null,
      storey: null,
      parentExpressId: project.expressId,
      childrenExpressIds: [],
      propertySets: [
        {
          name: "Pset_SiteCommon",
          properties: [
            { name: "Reference", value: "PLOT-R12", type: "IfcIdentifier" },
            { name: "BuildableArea", value: 4200, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "TotalArea", value: 5840, unit: "m\xB2", type: "IfcAreaMeasure" }
          ]
        }
      ],
      quantitySets: [],
      materials: [],
      classifications: [],
      rawAttributes: null,
      visibility: true,
      geometry: null
    });
    const building = add({
      expressId: nextId(),
      globalId: makeGuid(),
      ifcClass: "IfcBuilding",
      name: "Block A",
      description: "3-storey office block, GFA approx 1,840 m\xB2.",
      objectType: null,
      predefinedType: null,
      elevationOfRefHeight: 0,
      storey: null,
      parentExpressId: site.expressId,
      childrenExpressIds: [],
      propertySets: [
        {
          name: "Pset_BuildingCommon",
          properties: [
            { name: "BuildingID", value: "A", type: "IfcIdentifier" },
            { name: "GrossFloorArea", value: 1840, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NumberOfStoreys", value: 3, type: "IfcInteger" },
            { name: "OccupancyType", value: "Office", type: "IfcLabel" },
            { name: "IsLandmarked", value: false, type: "IfcBoolean" }
          ]
        }
      ],
      quantitySets: [],
      materials: [],
      classifications: [],
      rawAttributes: null,
      visibility: true,
      geometry: null
    });
    project.childrenExpressIds.push(site.expressId);
    site.childrenExpressIds.push(building.expressId);
    rel("IfcRelAggregates", project.expressId, [site.expressId], "Project decomposes into site");
    rel("IfcRelAggregates", site.expressId, [building.expressId], "Site contains building");
    function typeObject(cls, name, predefined, properties = []) {
      return add({
        expressId: nextId(),
        globalId: makeGuid(),
        ifcClass: cls,
        name,
        description: `Type definition for ${name}`,
        objectType: name,
        predefinedType: predefined,
        isType: true,
        storey: null,
        parentExpressId: project.expressId,
        childrenExpressIds: [],
        propertySets: properties,
        quantitySets: [],
        materials: [],
        classifications: [],
        rawAttributes: null,
        visibility: true,
        geometry: null
      });
    }
    const types = {
      wallExt: typeObject("IfcWallType", "WT-EXT-250", "STANDARD", [
        { name: "Pset_WallCommon", properties: [
          { name: "Reference", value: "WT-EXT-250", type: "IfcIdentifier" },
          { name: "IsExternal", value: true, type: "IfcBoolean" },
          { name: "LoadBearing", value: true, type: "IfcBoolean" },
          { name: "FireRating", value: "REI 90", type: "IfcLabel" },
          { name: "AcousticRating", value: "Rw 52 dB", type: "IfcLabel" },
          { name: "ThermalTransmittance", value: 0.22, unit: "W/m\xB2K", type: "IfcThermalTransmittanceMeasure" }
        ] }
      ]),
      wallInt: typeObject("IfcWallType", "WT-INT-100", "STANDARD", [
        { name: "Pset_WallCommon", properties: [
          { name: "Reference", value: "WT-INT-100", type: "IfcIdentifier" },
          { name: "IsExternal", value: false, type: "IfcBoolean" },
          { name: "LoadBearing", value: false, type: "IfcBoolean" },
          { name: "FireRating", value: "EI 60", type: "IfcLabel" },
          { name: "AcousticRating", value: "Rw 45 dB", type: "IfcLabel" }
        ] }
      ]),
      slab: typeObject("IfcSlabType", "ST-SLAB-200", "FLOOR", [
        { name: "Pset_SlabCommon", properties: [
          { name: "Reference", value: "ST-SLAB-200", type: "IfcIdentifier" },
          { name: "LoadBearing", value: true, type: "IfcBoolean" },
          { name: "FireRating", value: "REI 120", type: "IfcLabel" },
          { name: "IsExternal", value: false, type: "IfcBoolean" }
        ] }
      ]),
      column: typeObject("IfcColumnType", "CT-RC-400", "COLUMN", [
        { name: "Pset_ColumnCommon", properties: [
          { name: "Reference", value: "CT-RC-400", type: "IfcIdentifier" },
          { name: "LoadBearing", value: true, type: "IfcBoolean" },
          { name: "FireRating", value: "R 120", type: "IfcLabel" }
        ] }
      ]),
      beam: typeObject("IfcBeamType", "BT-RC-400x600", "BEAM", [
        { name: "Pset_BeamCommon", properties: [
          { name: "Reference", value: "BT-RC-400x600", type: "IfcIdentifier" },
          { name: "LoadBearing", value: true, type: "IfcBoolean" },
          { name: "FireRating", value: "R 120", type: "IfcLabel" }
        ] }
      ]),
      door: typeObject("IfcDoorType", "DT-INT-D01", "DOOR", [
        { name: "Pset_DoorCommon", properties: [
          { name: "Reference", value: "DT-INT-D01", type: "IfcIdentifier" },
          { name: "IsExternal", value: false, type: "IfcBoolean" },
          { name: "FireRating", value: "EI 30", type: "IfcLabel" },
          { name: "SecurityRating", value: "RC2", type: "IfcLabel" }
        ] }
      ]),
      window: typeObject("IfcWindowType", "WT-EXT-W01", "WINDOW", [
        { name: "Pset_WindowCommon", properties: [
          { name: "Reference", value: "WT-EXT-W01", type: "IfcIdentifier" },
          { name: "IsExternal", value: true, type: "IfcBoolean" },
          { name: "ThermalTransmittance", value: 1.1, unit: "W/m\xB2K", type: "IfcThermalTransmittanceMeasure" },
          { name: "GlazingAreaFraction", value: 0.78, type: "IfcPositiveRatioMeasure" }
        ] }
      ])
    };
    const storeyHeight = 3.6;
    const storeys = [];
    for (let i = 0; i < 3; i++) {
      const s = add({
        expressId: nextId(),
        globalId: makeGuid(),
        ifcClass: "IfcBuildingStorey",
        name: `Level ${String(i).padStart(2, "0")}${i === 0 ? " \u2014 Ground" : ""}`,
        description: null,
        elevation: i * storeyHeight,
        storey: null,
        parentExpressId: building.expressId,
        childrenExpressIds: [],
        propertySets: [
          { name: "Pset_BuildingStoreyCommon", properties: [
            { name: "EntranceLevel", value: i === 0, type: "IfcBoolean" },
            { name: "AboveGround", value: true, type: "IfcBoolean" },
            { name: "GrossFloorArea", value: 612, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetFloorArea", value: 540, unit: "m\xB2", type: "IfcAreaMeasure" }
          ] }
        ],
        quantitySets: [
          { name: "Qto_BuildingStoreyBaseQuantities", properties: [
            { name: "GrossFloorArea", value: 612, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetFloorArea", value: 540, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "GrossHeight", value: 3.6, unit: "m", type: "IfcLengthMeasure" },
            { name: "NetVolume", value: 1944, unit: "m\xB3", type: "IfcVolumeMeasure" }
          ] }
        ],
        materials: [],
        classifications: [],
        rawAttributes: null,
        visibility: true,
        geometry: null
      });
      building.childrenExpressIds.push(s.expressId);
      storeys.push(s);
    }
    rel("IfcRelAggregates", building.expressId, storeys.map((s) => s.expressId), "Building decomposes into storeys");
    const W = 24, D = 14;
    const halfW = W / 2, halfD = D / 2;
    storeys.forEach((storey, sIdx) => {
      const z0 = storey.elevation;
      const z1 = z0 + storeyHeight;
      const slab = add(makeElement({
        cls: "IfcSlab",
        typeObj: types.slab,
        predefined: "FLOOR",
        name: `Slab L${sIdx} \u2014 Floor`,
        storey,
        parent: storey,
        mat: "slabAssembly",
        geometry: { kind: "box", x: 0, y: 0, z: z0, w: W + 0.5, d: D + 0.5, h: 0.2, offsetZ: -0.2 },
        psets: [
          { name: "Pset_SlabCommon", properties: [
            { name: "Reference", value: "ST-SLAB-200", type: "IfcIdentifier" },
            { name: "LoadBearing", value: true, type: "IfcBoolean" },
            { name: "IsExternal", value: false, type: "IfcBoolean" },
            { name: "FireRating", value: "REI 120", type: "IfcLabel" },
            { name: "AcousticRating", value: "Rw 58 dB", type: "IfcLabel" },
            { name: "PitchAngle", value: 0, unit: "\xB0", type: "IfcPlaneAngleMeasure" }
          ] }
        ],
        qtos: [
          { name: "Qto_SlabBaseQuantities", properties: [
            { name: "GrossArea", value: (W + 0.5) * (D + 0.5), unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetArea", value: (W + 0.5) * (D + 0.5) - 8.5, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "GrossVolume", value: (W + 0.5) * (D + 0.5) * 0.2, unit: "m\xB3", type: "IfcVolumeMeasure" },
            { name: "Perimeter", value: 2 * (W + 0.5 + (D + 0.5)), unit: "m", type: "IfcLengthMeasure" },
            { name: "Width", value: 0.2, unit: "m", type: "IfcLengthMeasure" }
          ] }
        ]
      }));
      const wallH = storeyHeight;
      const wallT = 0.25;
      const extWalls = [
        { name: "South", x: 0, y: -halfD, w: W, d: wallT },
        { name: "North", x: 0, y: halfD, w: W, d: wallT },
        { name: "West", x: -halfW, y: 0, w: wallT, d: D },
        { name: "East", x: halfW, y: 0, w: wallT, d: D }
      ];
      const extWallEls = extWalls.map((w) => add(makeElement({
        cls: "IfcWallStandardCase",
        typeObj: types.wallExt,
        predefined: "STANDARD",
        name: `Wall L${sIdx} ${w.name} \u2014 WT-EXT-250`,
        storey,
        parent: storey,
        mat: "wallAssembly",
        external: true,
        geometry: { kind: "box", x: w.x, y: w.y, z: z0, w: w.w, d: w.d, h: wallH },
        psets: types.wallExt.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
        qtos: [
          { name: "Qto_WallBaseQuantities", properties: [
            { name: "Length", value: w.w >= w.d ? w.w : w.d, unit: "m", type: "IfcLengthMeasure" },
            { name: "Height", value: wallH, unit: "m", type: "IfcLengthMeasure" },
            { name: "Width", value: wallT, unit: "m", type: "IfcLengthMeasure" },
            { name: "GrossSideArea", value: (w.w >= w.d ? w.w : w.d) * wallH, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetVolume", value: (w.w >= w.d ? w.w : w.d) * wallH * wallT, unit: "m\xB3", type: "IfcVolumeMeasure" }
          ] }
        ]
      })));
      const intT = 0.1;
      const intWallA = add(makeElement({
        cls: "IfcWallStandardCase",
        typeObj: types.wallInt,
        predefined: "STANDARD",
        name: `Wall L${sIdx} Partition A \u2014 WT-INT-100`,
        storey,
        parent: storey,
        mat: "intWallAssembly",
        external: false,
        geometry: { kind: "box", x: -4, y: 0, z: z0, w: intT, d: D - 0.5, h: wallH },
        psets: types.wallInt.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
        qtos: [{ name: "Qto_WallBaseQuantities", properties: [
          { name: "Length", value: D - 0.5, unit: "m", type: "IfcLengthMeasure" },
          { name: "Height", value: wallH, unit: "m", type: "IfcLengthMeasure" },
          { name: "Width", value: intT, unit: "m", type: "IfcLengthMeasure" }
        ] }]
      }));
      const intWallB = add(makeElement({
        cls: "IfcWallStandardCase",
        typeObj: types.wallInt,
        predefined: "STANDARD",
        name: `Wall L${sIdx} Partition B \u2014 WT-INT-100`,
        storey,
        parent: storey,
        mat: "intWallAssembly",
        external: false,
        geometry: { kind: "box", x: 5, y: 0, z: z0, w: intT, d: D - 0.5, h: wallH },
        psets: types.wallInt.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
        qtos: [{ name: "Qto_WallBaseQuantities", properties: [
          { name: "Length", value: D - 0.5, unit: "m", type: "IfcLengthMeasure" },
          { name: "Height", value: wallH, unit: "m", type: "IfcLengthMeasure" },
          { name: "Width", value: intT, unit: "m", type: "IfcLengthMeasure" }
        ] }]
      }));
      const colSize = 0.4;
      const cols = [];
      const colXs = [-9, -3, 3, 9];
      const colYs = [-4.5, 4.5];
      colXs.forEach((cx) => colYs.forEach((cy) => {
        const c = add(makeElement({
          cls: "IfcColumn",
          typeObj: types.column,
          predefined: "COLUMN",
          name: `Column L${sIdx} (${cx},${cy}) \u2014 CT-RC-400`,
          storey,
          parent: storey,
          mat: "concrete",
          geometry: { kind: "box", x: cx, y: cy, z: z0, w: colSize, d: colSize, h: wallH },
          psets: types.column.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
          qtos: [
            { name: "Qto_ColumnBaseQuantities", properties: [
              { name: "Length", value: wallH, unit: "m", type: "IfcLengthMeasure" },
              { name: "CrossSectionArea", value: colSize * colSize, unit: "m\xB2", type: "IfcAreaMeasure" },
              { name: "OuterSurfaceArea", value: 4 * colSize * wallH, unit: "m\xB2", type: "IfcAreaMeasure" },
              { name: "GrossVolume", value: colSize * colSize * wallH, unit: "m\xB3", type: "IfcVolumeMeasure" }
            ] }
          ]
        }));
        cols.push(c);
      }));
      const beamH = 0.6;
      [-4.5, 4.5].forEach((by) => {
        const b = add(makeElement({
          cls: "IfcBeam",
          typeObj: types.beam,
          predefined: "BEAM",
          name: `Beam L${sIdx} Edge y=${by} \u2014 BT-RC-400x600`,
          storey,
          parent: storey,
          mat: "concrete",
          geometry: { kind: "box", x: 0, y: by, z: z1 - beamH, w: W - 1.5, d: 0.4, h: beamH },
          psets: types.beam.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
          qtos: [
            { name: "Qto_BeamBaseQuantities", properties: [
              { name: "Length", value: W - 1.5, unit: "m", type: "IfcLengthMeasure" },
              { name: "CrossSectionArea", value: 0.4 * beamH, unit: "m\xB2", type: "IfcAreaMeasure" },
              { name: "GrossVolume", value: (W - 1.5) * 0.4 * beamH, unit: "m\xB3", type: "IfcVolumeMeasure" }
            ] }
          ]
        }));
      });
      const winCfg = [
        { y: -halfD, side: "South" },
        { y: halfD, side: "North" }
      ];
      winCfg.forEach((cfg) => {
        [-8, -2, 4, 10].forEach((wx, wi) => {
          const w = add(makeElement({
            cls: "IfcWindow",
            typeObj: types.window,
            predefined: "WINDOW",
            name: `Window L${sIdx} ${cfg.side} ${wi + 1} \u2014 WT-EXT-W01`,
            storey,
            parent: storey,
            mat: "glass",
            external: true,
            geometry: { kind: "box", x: wx, y: cfg.y, z: z0 + 1, w: 1.4, d: 0.06, h: 1.6 },
            psets: types.window.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
            qtos: [
              { name: "Qto_WindowBaseQuantities", properties: [
                { name: "Width", value: 1.4, unit: "m", type: "IfcLengthMeasure" },
                { name: "Height", value: 1.6, unit: "m", type: "IfcLengthMeasure" },
                { name: "Area", value: 2.24, unit: "m\xB2", type: "IfcAreaMeasure" },
                { name: "Perimeter", value: 6, unit: "m", type: "IfcLengthMeasure" }
              ] }
            ]
          }));
        });
      });
      if (sIdx === 0) {
        add(makeElement({
          cls: "IfcDoor",
          typeObj: types.door,
          predefined: "DOOR",
          name: `Main Entrance Door \u2014 DT-INT-D01`,
          storey,
          parent: storey,
          mat: "aluminium",
          external: true,
          geometry: { kind: "box", x: 0, y: -halfD, z: z0, w: 1.8, d: 0.08, h: 2.2 },
          psets: types.door.propertySets.map((p) => ({ ...p, properties: p.properties.map((x) => x.name === "IsExternal" ? { ...x, value: true } : x) })),
          qtos: [{ name: "Qto_DoorBaseQuantities", properties: [
            { name: "Width", value: 1.8, unit: "m", type: "IfcLengthMeasure" },
            { name: "Height", value: 2.2, unit: "m", type: "IfcLengthMeasure" },
            { name: "Area", value: 3.96, unit: "m\xB2", type: "IfcAreaMeasure" }
          ] }]
        }));
      }
      [-4, 5].forEach((dx) => {
        add(makeElement({
          cls: "IfcDoor",
          typeObj: types.door,
          predefined: "DOOR",
          name: `Door L${sIdx} x=${dx} \u2014 DT-INT-D01`,
          storey,
          parent: storey,
          mat: "wood",
          external: false,
          geometry: { kind: "box", x: dx, y: 3, z: z0, w: 0.9, d: 0.05, h: 2.1 },
          psets: types.door.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
          qtos: [{ name: "Qto_DoorBaseQuantities", properties: [
            { name: "Width", value: 0.9, unit: "m", type: "IfcLengthMeasure" },
            { name: "Height", value: 2.1, unit: "m", type: "IfcLengthMeasure" },
            { name: "Area", value: 1.89, unit: "m\xB2", type: "IfcAreaMeasure" }
          ] }]
        }));
      });
      const zones = [
        { name: "Open Office", x: 0, y: 0, w: 7, d: D - 1, color: "#4ea1a6" },
        { name: "Meeting Room", x: -7.5, y: 0, w: 4, d: D - 1, color: "#5fb0a2" },
        { name: "Service Core", x: 7.5, y: 0, w: 4, d: D - 1, color: "#3f8c91" }
      ];
      zones.forEach((z) => {
        const s = add(makeElement({
          cls: "IfcSpace",
          typeObj: null,
          predefined: "INTERNAL",
          name: `${z.name} L${sIdx}`,
          storey,
          parent: storey,
          mat: null,
          geometry: { kind: "space", x: z.x, y: z.y, z: z0 + 0.02, w: z.w, d: z.d, h: storeyHeight - 0.7 },
          psets: [{ name: "Pset_SpaceCommon", properties: [
            { name: "IsExternal", value: false, type: "IfcBoolean" },
            { name: "GrossPlannedArea", value: z.w * z.d, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetPlannedArea", value: z.w * z.d * 0.92, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "OccupancyType", value: z.name === "Meeting Room" ? "Meeting" : "Office", type: "IfcLabel" },
            { name: "OccupancyNumberPeak", value: z.name === "Meeting Room" ? 12 : 24, type: "IfcCountMeasure" }
          ] }],
          qtos: [{ name: "Qto_SpaceBaseQuantities", properties: [
            { name: "Height", value: storeyHeight, unit: "m", type: "IfcLengthMeasure" },
            { name: "NetFloorArea", value: z.w * z.d, unit: "m\xB2", type: "IfcAreaMeasure" },
            { name: "NetVolume", value: z.w * z.d * storeyHeight, unit: "m\xB3", type: "IfcVolumeMeasure" },
            { name: "NetCeilingArea", value: z.w * z.d, unit: "m\xB2", type: "IfcAreaMeasure" }
          ] }]
        }));
      });
    });
    const roofZ = storeys.length * storeyHeight;
    add(makeElement({
      cls: "IfcRoof",
      typeObj: null,
      predefined: "FLAT_ROOF",
      name: "Roof \u2014 Flat Roof Assembly",
      storey: storeys[storeys.length - 1],
      parent: storeys[storeys.length - 1],
      mat: "slabAssembly",
      geometry: { kind: "box", x: 0, y: 0, z: roofZ, w: W + 0.7, d: D + 0.7, h: 0.3 },
      psets: [{ name: "Pset_RoofCommon", properties: [
        { name: "IsExternal", value: true, type: "IfcBoolean" },
        { name: "FireRating", value: "REI 90", type: "IfcLabel" },
        { name: "ThermalTransmittance", value: 0.18, unit: "W/m\xB2K", type: "IfcThermalTransmittanceMeasure" }
      ] }],
      qtos: [{ name: "Qto_RoofBaseQuantities", properties: [
        { name: "GrossArea", value: (W + 0.7) * (D + 0.7), unit: "m\xB2", type: "IfcAreaMeasure" },
        { name: "NetArea", value: (W + 0.7) * (D + 0.7), unit: "m\xB2", type: "IfcAreaMeasure" }
      ] }]
    }));
    for (let i = 0; i < storeys.length; i++) {
      add(makeElement({
        cls: "IfcStairFlight",
        typeObj: null,
        predefined: "STRAIGHT",
        name: `Stair Flight L${i} \u2192 L${i + 1}`,
        storey: storeys[i],
        parent: storeys[i],
        mat: "concrete",
        geometry: { kind: "stair", x: 9.5, y: -3, z: i * storeyHeight, w: 1.4, d: 4, h: storeyHeight },
        psets: [{ name: "Pset_StairFlightCommon", properties: [
          { name: "NumberOfRiser", value: 18, type: "IfcInteger" },
          { name: "NumberOfTreads", value: 17, type: "IfcInteger" },
          { name: "RiserHeight", value: 0.2, unit: "m", type: "IfcLengthMeasure" },
          { name: "TreadLength", value: 0.27, unit: "m", type: "IfcLengthMeasure" }
        ] }],
        qtos: []
      }));
    }
    const orphanWall = add(makeElement({
      cls: "IfcWallStandardCase",
      typeObj: types.wallInt,
      predefined: "STANDARD",
      name: "",
      // missing
      storey: storeys[1],
      parent: storeys[1],
      mat: "intWallAssembly",
      external: false,
      geometry: { kind: "box", x: 1, y: -1, z: storeyHeight + 0.01, w: 0.1, d: 4, h: storeyHeight - 0.1 },
      psets: types.wallInt.propertySets.map((p) => ({ ...p, properties: p.properties.slice() })),
      qtos: []
    }));
    elements.forEach((el) => {
      const ucls = UNICLASS[el.ifcClass];
      if (ucls && !el.isType && el.ifcClass !== "IfcProject" && el.ifcClass !== "IfcSite" && el.ifcClass !== "IfcBuilding" && el.ifcClass !== "IfcBuildingStorey") {
        el.classifications.push({ system: "Uniclass 2015", code: ucls.code, name: ucls.name });
      }
    });
    storeys.forEach((st) => {
      const contained = elements.filter((e) => e.parentExpressId === st.expressId && !e.isType);
      rel("IfcRelContainedInSpatialStructure", st.expressId, contained.map((e) => e.expressId), "Storey contains elements");
    });
    elements.forEach((el) => {
      if (el.typeExpressId) {
        rel("IfcRelDefinesByType", el.typeExpressId, [el.expressId], "Type defines instance");
      }
    });
    elements.forEach((el) => {
      el.rawAttributes = computeRawAttrs(el);
    });
    return {
      elements,
      byId,
      relationships,
      project,
      site,
      building,
      storeys,
      materials: MATERIALS,
      schemaVersion: "IFC4",
      fileName: "Riverside_OfficeBlockA_StageC.ifc",
      fileSize: 18420113,
      totalEntities: elements.length + relationships.length + 24,
      // ~ entity count
      totalGeometryItems: elements.filter((e) => e.geometry).length
    };
    function makeElement(opts) {
      const id = nextId();
      const matInfo = opts.mat ? MATERIALS[opts.mat] : null;
      const materials = matInfo ? [{
        name: matInfo.name,
        density: matInfo.density,
        thermalConductivity: matInfo.thermalConductivity,
        layers: matInfo.layers
      }] : [];
      return {
        expressId: id,
        globalId: makeGuid(),
        ifcClass: opts.cls,
        name: opts.name,
        description: null,
        objectType: opts.typeObj ? opts.typeObj.objectType : null,
        typeExpressId: opts.typeObj ? opts.typeObj.expressId : null,
        typeGlobalId: opts.typeObj ? opts.typeObj.globalId : null,
        predefinedType: opts.predefined || null,
        tag: `${opts.cls.replace("Ifc", "").substring(0, 3).toUpperCase()}-${id}`,
        storey: opts.storey,
        parentExpressId: opts.parent ? opts.parent.expressId : null,
        childrenExpressIds: [],
        propertySets: opts.psets || [],
        quantitySets: opts.qtos || [],
        materials,
        classifications: [],
        isExternal: opts.external,
        visibility: true,
        geometry: opts.geometry,
        colorOverride: null,
        opacityOverride: null
      };
    }
  }
  function computeRawAttrs(el) {
    const attrs = [
      { idx: 1, name: "GlobalId", value: el.globalId, ref: false },
      { idx: 2, name: "OwnerHistory", value: "#42", ref: true },
      { idx: 3, name: "Name", value: el.name || null, ref: false },
      { idx: 4, name: "Description", value: el.description || null, ref: false },
      { idx: 5, name: "ObjectType", value: el.objectType || null, ref: false },
      { idx: 6, name: "ObjectPlacement", value: `#${el.expressId + 1}`, ref: true },
      { idx: 7, name: "Representation", value: el.geometry ? `#${el.expressId + 2}` : null, ref: true }
    ];
    if ("tag" in el) attrs.push({ idx: 8, name: "Tag", value: el.tag || null, ref: false });
    if (el.predefinedType) attrs.push({ idx: 9, name: "PredefinedType", value: `.${el.predefinedType}.`, ref: false });
    if (el.ifcClass === "IfcBuildingStorey") attrs.push({ idx: 10, name: "Elevation", value: el.elevation, ref: false });
    return attrs;
  }
  const SCHEMA_INFO = {
    IfcWall: {
      parent: "IfcBuildingElement",
      children: ["IfcWallStandardCase", "IfcWallElementedCase"],
      description: "The wall represents a vertical construction that may bound or subdivide spaces. Walls are usually vertical, planar elements.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "Name", type: "IfcLabel", required: false },
        { name: "Description", type: "IfcText", required: false },
        { name: "ObjectType", type: "IfcLabel", required: false },
        { name: "PredefinedType", type: "IfcWallTypeEnum", required: false },
        { name: "Tag", type: "IfcIdentifier", required: false }
      ],
      propertySets: ["Pset_WallCommon", "Pset_ConcreteElementGeneral", "Pset_ManufacturerTypeInformation"],
      quantitySets: ["Qto_WallBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType", "IfcRelVoidsElement", "IfcRelConnectsPathElements"]
    },
    IfcWallStandardCase: {
      parent: "IfcWall",
      children: [],
      description: "IfcWallStandardCase is a specialization where the geometry is fully described by a thickness profile swept along an axis.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "Name", type: "IfcLabel", required: false },
        { name: "PredefinedType", type: "IfcWallTypeEnum", required: false },
        { name: "Tag", type: "IfcIdentifier", required: false }
      ],
      propertySets: ["Pset_WallCommon"],
      quantitySets: ["Qto_WallBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType"]
    },
    IfcSlab: {
      parent: "IfcBuildingElement",
      children: ["IfcSlabStandardCase", "IfcSlabElementedCase"],
      description: "A slab is a component of the construction that may enclose a space vertically. The slab may provide the lower support (floor) or upper construction (roof slab) in any space.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "PredefinedType", type: "IfcSlabTypeEnum", required: false }
      ],
      propertySets: ["Pset_SlabCommon", "Pset_ConcreteElementGeneral"],
      quantitySets: ["Qto_SlabBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType"]
    },
    IfcColumn: {
      parent: "IfcBuildingElement",
      children: ["IfcColumnStandardCase"],
      description: "A column is a vertical structural member which often is aligned with a building grid intersection. It represents a slender vertical structural member supporting axial compression loads.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "PredefinedType", type: "IfcColumnTypeEnum", required: false }
      ],
      propertySets: ["Pset_ColumnCommon", "Pset_ConcreteElementGeneral"],
      quantitySets: ["Qto_ColumnBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType", "IfcRelConnectsStructuralMember"]
    },
    IfcBeam: {
      parent: "IfcBuildingElement",
      children: ["IfcBeamStandardCase"],
      description: "A beam is a horizontal, or near-horizontal, structural member that is capable of withstanding load primarily by resisting bending.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "PredefinedType", type: "IfcBeamTypeEnum", required: false }
      ],
      propertySets: ["Pset_BeamCommon", "Pset_ConcreteElementGeneral"],
      quantitySets: ["Qto_BeamBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType"]
    },
    IfcDoor: {
      parent: "IfcBuildingElement",
      children: ["IfcDoorStandardCase"],
      description: "A door is a built element typically used to control physical access. Doors are typically located in walls, partitions, or other vertical openings.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "OverallHeight", type: "IfcPositiveLengthMeasure", required: false },
        { name: "OverallWidth", type: "IfcPositiveLengthMeasure", required: false },
        { name: "PredefinedType", type: "IfcDoorTypeEnum", required: false }
      ],
      propertySets: ["Pset_DoorCommon", "Pset_DoorWindowGlazingType"],
      quantitySets: ["Qto_DoorBaseQuantities"],
      relationships: ["IfcRelFillsElement", "IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType"]
    },
    IfcWindow: {
      parent: "IfcBuildingElement",
      children: ["IfcWindowStandardCase"],
      description: "The window is a built element that is predominantly used to provide natural light and fresh air. It includes vertical openings but also horizontal openings such as skylights.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "OverallHeight", type: "IfcPositiveLengthMeasure", required: false },
        { name: "OverallWidth", type: "IfcPositiveLengthMeasure", required: false },
        { name: "PredefinedType", type: "IfcWindowTypeEnum", required: false }
      ],
      propertySets: ["Pset_WindowCommon", "Pset_DoorWindowGlazingType"],
      quantitySets: ["Qto_WindowBaseQuantities"],
      relationships: ["IfcRelFillsElement", "IfcRelContainedInSpatialStructure", "IfcRelAssociatesMaterial", "IfcRelDefinesByType"]
    },
    IfcStair: {
      parent: "IfcBuildingElement",
      children: [],
      description: "A stair is a vertical passageway allowing occupants to walk (step) from one floor level to another floor level at a different elevation.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "PredefinedType", type: "IfcStairTypeEnum", required: false }
      ],
      propertySets: ["Pset_StairCommon"],
      quantitySets: ["Qto_StairFlightBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAggregates"]
    },
    IfcStairFlight: {
      parent: "IfcBuildingElementComponent",
      children: [],
      description: "A stair flight is an assembly of building components, in a single straight or winding run, enabling passage from one floor level to another.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "NumberOfRisers", type: "IfcInteger", required: false },
        { name: "NumberOfTreads", type: "IfcInteger", required: false }
      ],
      propertySets: ["Pset_StairFlightCommon"],
      quantitySets: ["Qto_StairFlightBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAggregates"]
    },
    IfcSpace: {
      parent: "IfcSpatialStructureElement",
      children: [],
      description: "A space represents an area or volume bounded actually or theoretically. Spaces are areas or volumes that provide certain functions within a building.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "LongName", type: "IfcLabel", required: false },
        { name: "PredefinedType", type: "IfcSpaceTypeEnum", required: false }
      ],
      propertySets: ["Pset_SpaceCommon", "Pset_SpaceOccupancyRequirements"],
      quantitySets: ["Qto_SpaceBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAggregates", "IfcRelSpaceBoundary"]
    },
    IfcRoof: {
      parent: "IfcBuildingElement",
      children: [],
      description: "A roof is the covering of the top part of a building, it protects the building against the effects of weather.",
      commonAttributes: [
        { name: "GlobalId", type: "IfcGloballyUniqueId", required: true },
        { name: "PredefinedType", type: "IfcRoofTypeEnum", required: false }
      ],
      propertySets: ["Pset_RoofCommon"],
      quantitySets: ["Qto_RoofBaseQuantities"],
      relationships: ["IfcRelContainedInSpatialStructure", "IfcRelAggregates"]
    },
    IfcCovering: {
      parent: "IfcBuildingElement",
      children: [],
      description: "A covering is an element which covers some part of another element.",
      commonAttributes: [],
      propertySets: ["Pset_CoveringCommon"],
      quantitySets: ["Qto_CoveringBaseQuantities"],
      relationships: ["IfcRelCoversBldgElements"]
    },
    IfcProject: { parent: "IfcContext", children: [], description: "The undertaking of some design, engineering, construction, or maintenance activities leading towards a product.", commonAttributes: [], propertySets: [], quantitySets: [], relationships: ["IfcRelAggregates", "IfcRelDeclares"] },
    IfcSite: { parent: "IfcSpatialStructureElement", children: [], description: "A site is a defined area of land, possibly covered with water, on which the project construction is to be completed.", commonAttributes: [], propertySets: ["Pset_SiteCommon"], quantitySets: [], relationships: ["IfcRelAggregates"] },
    IfcBuilding: { parent: "IfcSpatialStructureElement", children: [], description: "A building represents a structure that provides shelter for its occupants or contents and stands in one place.", commonAttributes: [], propertySets: ["Pset_BuildingCommon"], quantitySets: [], relationships: ["IfcRelAggregates"] },
    IfcBuildingStorey: { parent: "IfcSpatialStructureElement", children: [], description: "The building storey has an elevation and typically represents a (nearly) horizontal aggregation of spaces that are vertically bound.", commonAttributes: [], propertySets: ["Pset_BuildingStoreyCommon"], quantitySets: ["Qto_BuildingStoreyBaseQuantities"], relationships: ["IfcRelAggregates", "IfcRelContainedInSpatialStructure"] }
  };
  Object.assign(window, {
    buildModel,
    IFC_CLASS_COLORS,
    CLASS_COLOR,
    SCHEMA_INFO,
    MATERIALS
  });
})();
