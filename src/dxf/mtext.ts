/**
 * Decodes DXF MTEXT / TEXT content into plain newline-delimited text.
 * Handles paragraph breaks, escaped characters, \U+XXXX, font/colour/height codes,
 * stacked fractions and %% control codes. Formatting is dropped.
 */

// Codes that take a parameter string terminated by ';' (e.g. \fArial|b0|i0;, \H2.5;, \C1;)
const PARAM_CODES = new Set(['f', 'F', 'H', 'C', 'c', 'T', 'Q', 'W', 'A', 'p', 'S']);
// Codes that toggle a style and take no parameter
const TOGGLE_CODES = new Set(['L', 'l', 'O', 'o', 'K', 'k']);

export function decodeMtext(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{' || ch === '}') continue; // formatting group delimiters
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'P' || next === 'X') { out += '\n'; i++; }
    else if (next === '\\' || next === '{' || next === '}') { out += next; i++; }
    else if (next === '~') { out += ' '; i++; }
    else if ((next === 'U' || next === 'u') && raw[i + 2] === '+') {
      const hex = raw.slice(i + 3, i + 7);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        i += 1;
      }
    } else if (PARAM_CODES.has(next)) {
      const end = raw.indexOf(';', i + 2);
      const param = end < 0 ? raw.slice(i + 2) : raw.slice(i + 2, end);
      if (next === 'S') {
        // Stacked text "num/den", "num^den" or "num#den" -> "num/den" / "num den"
        out += param.replace(/[/#]/g, '/').replace(/\^/g, ' ');
      }
      i = end < 0 ? raw.length : end;
    } else if (TOGGLE_CODES.has(next)) {
      i++;
    } else {
      // Unknown escape: keep the escaped character literally
      out += next;
      i++;
    }
  }
  return decodePercentCodes(out);
}

/** Decodes AutoCAD %% control sequences (used by TEXT and sometimes MTEXT). */
export function decodePercentCodes(s: string): string {
  return s
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%%/g, '%')
    .replace(/%%[uUoO]/g, '')
    .replace(/%%(\d{3})/g, (_m, d: string) => String.fromCharCode(parseInt(d, 10)));
}

/**
 * Vertical metrics of the annotation renderer (canvas textBaseline = 'top', measured in the browser):
 * the baseline sits ~0.88 em below the annotation origin and the em box is 1.0 em tall.
 * Lines are spaced 1.2 em apart.
 */
export const TEXT_ASCENT_RATIO = 0.88;
export const TEXT_BOX_RATIO = 1.0;
export const TEXT_LINE_PITCH = 1.2;

/** Estimated text extent in µm: width ~0.6 em per narrow char (1.0 em for wide chars), line pitch 1.2 em. */
export function estimateTextExtentUm(text: string, heightUm: number): { w: number; h: number } {
  const lines = text.split('\n');
  let maxEm = 0;
  for (const line of lines) {
    let em = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0) ?? 0;
      em += cp >= 0x2e80 ? 1.0 : 0.6;
    }
    maxEm = Math.max(maxEm, em);
  }
  return {
    w: Math.round(maxEm * heightUm),
    h: Math.round(((lines.length - 1) * TEXT_LINE_PITCH + TEXT_BOX_RATIO) * heightUm),
  };
}

/**
 * Offset (dx, dy in Y-down world µm) from an anchor point to the text's top-left corner.
 * hAlign: 0 left, 1 center, 2 right. vAlign: 0 top, 1 middle, 2 bottom, 3 first-line baseline.
 * heightUm is the font size, needed for the baseline case.
 */
export function topLeftOffset(
  w: number, h: number, hAlign: 0 | 1 | 2, vAlign: 0 | 1 | 2 | 3, heightUm = 0,
): { dx: number; dy: number } {
  const dy = vAlign === 0 ? 0 : vAlign === 1 ? -h / 2 : vAlign === 2 ? -h : -TEXT_ASCENT_RATIO * heightUm;
  return {
    dx: Math.round(hAlign === 0 ? 0 : hAlign === 1 ? -w / 2 : -w),
    dy: Math.round(dy),
  };
}
