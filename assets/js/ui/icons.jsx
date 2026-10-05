/** Colored icon set backed by local Flaticon PNG assets. */

const ICON_DIR = 'assets/icons/flaticon/';

const ICON_FILES = {
  Upload: 'upload',
  Cube: 'cube',
  Home: 'home',
  Search: 'search',
  Sun: 'sun',
  Moon: 'moon',
  Save: 'export',
  Export: 'export',
  ChevronDown: 'chevron-down',
  ChevronRight: 'chevron-right',
  Eye: 'eye',
  EyeOff: 'eye',
  Isolate: 'box',
  Focus: 'search',
  Copy: 'copy',
  Layer: 'layer',
  Tree: 'hierarchy',
  Box: 'box',
  Bookmark: 'pin',
  Sets: 'hierarchy',
  Schema: 'hierarchy',
  Section: 'layer',
  Ruler: 'ruler',
  Pin: 'pin',
  X: 'close',
  Refresh: 'refresh',
  Camera: 'camera',
  Wireframe: 'box',
  Xray: 'eye',
  Shaded: 'cube',
  Edge: 'hierarchy',
  Help: 'help',
  Plus: 'plus',
  Minus: 'minus',
  ArrowUp: 'arrow',
  ArrowDown: 'arrow',
  ArrowLeft: 'arrow',
  ArrowRight: 'arrow',
  Check: 'check',
  Alert: 'warning',
  Info: 'info',
  Filter: 'filter',
  Table: 'table',
  Log: 'info',
  Speed: 'refresh',
  Move: 'arrow',
  Rotate: 'reset',
  Scale: 'arrow',
  Globe: 'globe',
  Pset: 'table',
  Material: 'layer',
  Relationship: 'hierarchy',
  Code: 'code',
  Annotate: 'pin',
  Grid: 'table',
  PaintBucket: 'paint',
  Reset: 'reset',
};

const IconImage = (file) => ({ size = 14, className = '', style, ...rest } = {}) => (
  <img
    className={className ? `icon-img ${className}` : 'icon-img'}
    src={`${ICON_DIR}${file}.png`}
    alt=""
    aria-hidden="true"
    draggable="false"
    width={size}
    height={size}
    style={{
      width: size,
      height: size,
      display: 'inline-block',
      objectFit: 'contain',
      verticalAlign: '-0.15em',
      flex: '0 0 auto',
      pointerEvents: 'none',
      ...style,
    }}
    {...rest}
  />
);

const Icons = {};
Object.keys(ICON_FILES).forEach((name) => {
  Icons[name] = IconImage(ICON_FILES[name]);
});

window.Icons = Icons;
