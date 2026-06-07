// Shared AutoCAD Color Index (ACI) palette utilities.
// Used by the DXF importer (ACI → hex) and exporter (hex → nearest ACI) so the
// two stay symmetric and a round-trip preserves layer colors as closely as the
// 255-color palette allows.

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** ACI index → hex color. Standard 255-color palette (1–9 exact + 10–249 interpolated). */
export function aciToHex(aci: number): string {
  const exact: Record<number, string> = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#414141', 9: '#808080',
  };
  if (exact[aci]) return exact[aci];
  // ACI 10–249: arranged in 24 hue groups of 10 shades each
  if (aci >= 10 && aci <= 249) {
    const hueIdx = Math.floor((aci - 10) / 10); // 0..23
    const shadeIdx = (aci - 10) % 10;           // 0..9
    const hue = (hueIdx / 24) * 360;
    // Shades 0,2,4,6,8 → full sat; 1,3,5,7,9 → half sat; lightness varies
    const lightness = 20 + shadeIdx * 6;
    const saturation = shadeIdx % 2 === 0 ? 100 : 50;
    return hslToHex(hue, saturation, lightness);
  }
  return '#ffffff';
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// Precompute the RGB palette once (ACI 1..249) for nearest-color matching.
const PALETTE: { aci: number; r: number; g: number; b: number }[] = [];
for (let aci = 1; aci <= 249; aci++) {
  PALETTE.push({ aci, ...hexToRgb(aciToHex(aci)) });
}

/**
 * CSS hex color (#rrggbb) → nearest standard ACI index.
 * White and black both map to the default foreground color (ACI 7); all other
 * colors map to the squared-Euclidean nearest entry in the 255-color palette.
 */
export function nearestAci(css: string): number {
  if (!css || css.charAt(0) !== '#' || css.length !== 7) return 7;
  const { r, g, b } = hexToRgb(css);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 7;
  // White and black are the conventional default foreground color (ACI 7).
  if (r === 255 && g === 255 && b === 255) return 7;
  if (r === 0 && g === 0 && b === 0) return 7;

  let bestAci = 7;
  let minDist = Infinity;
  for (const c of PALETTE) {
    const dr = r - c.r, dg = g - c.g, db = b - c.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < minDist) {
      minDist = dist;
      bestAci = c.aci;
    }
  }
  return bestAci;
}
