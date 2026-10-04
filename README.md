# Furniture-CNC-All

Browser-native **Furniture CNC AI** for IFC-based furniture engineering and CNC production.

## Current implementation

- Vite browser application.
- Three.js + That Open Components.
- IFC upload directly in the browser.
- IFC-to-Fragments conversion with web-ifc/That Open.
- 3D camera, fit-to-model and basic exploded-view control.
- Technology panel for the current cabinet specification.

## Current cabinet technology baseline

- Body: ЛДСП EGGER; IFC geometry is authoritative.
- Body/facade thickness from IFC: **20 mm**.
- Cabinet back: **HDF/HDFR 3.2 mm**.
- Edge: **ABS 1 mm, по кругу**.
- Hinges: none.
- Legs P01–P04: excluded.
- Drawers: 2.
- Drawer fronts: **577 × 20 × 234.5 mm**.
- Internal cabinet width: **560 mm**.
- Cabinet depth: **380 mm**.
- Body height: **495 mm**.
- Slides: **BOYARD START PUSH+SOFT SB38GRPH.1/350**, full extension, soft-close + push, 30 kg/pair, 350 mm.
- No unverified hardware dimensions may be invented.

## Repository structure

```
Furniture-CNC-All/
├── index.html
├── package.json
├── README.md
└── src/
    ├── main.js
    └── style.css
```

## Run in StackBlitz

Open the repository in StackBlitz:

https://stackblitz.com/github/fiagra08051979-ui/Furniture-CNC-All

The application is intended to run entirely in the browser. No desktop installation is required.

## Development direction

The next modules will be added to the existing project rather than creating separate versions:

1. IFC geometry inspection and exact element decomposition.
2. Technology rules and hardware library.
3. Drawer construction based on verified BOYARD documentation.
4. Geometry/tolerance validation.
5. Exploded assembly with real individual parts.
6. BOM and production Excel.
7. Production PDF.
8. CNC output through a machine-specific postprocessor.

## Important rule

**IFC geometry is the source of truth when the user says to preserve the model exactly.**

Technology may add only components explicitly required by the technology assignment and supported by verified hardware/rule data.
