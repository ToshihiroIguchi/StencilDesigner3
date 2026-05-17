declare module 'opentype.js' {
  interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    x: number;
    y: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }

  interface Path {
    commands: PathCommand[];
  }

  interface Glyph {
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }

  interface OS2Table {
    sCapHeight: number;
  }

  interface Tables {
    os2?: OS2Table;
  }

  interface Font {
    unitsPerEm: number;
    tables: Tables;
    charToGlyph(char: string): Glyph;
    getKerningValue(leftGlyph: Glyph, rightGlyph: Glyph): number;
  }

  function parse(buffer: ArrayBuffer): Font;
}
