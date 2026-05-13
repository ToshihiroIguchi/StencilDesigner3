/**
 * Unit conversion and formatting utility.
 * Internal data is always integer micrometers (µm).
 */
export const UnitConverter = {
  /**
   * Parse a user-provided string into a strictly rounded integer µm.
   * Handles both mm and µm input modes.
   */
  parseInput(value: string, unit: 'mm' | 'um'): number {
    const floatVal = parseFloat(value);
    if (isNaN(floatVal)) return 0;
    return unit === 'mm' ? Math.round(floatVal * 1000) : Math.round(floatVal);
  },

  /**
   * Format a µm value for display in the given unit.
   * mm: 3 decimal places (e.g. "1.500")
   * um: integer (e.g. "1500")
   */
  formatOutput(um: number, unit: 'mm' | 'um', withSymbol = false): string {
    if (unit === 'mm') {
      const val = (um / 1000).toFixed(3);
      return withSymbol ? `${val} mm` : val;
    } else {
      const val = Math.round(um).toString();
      return withSymbol ? `${val}µm` : val;
    }
  }
};

/** @deprecated Use UnitConverter.formatOutput(um, 'mm', true) */
export function fmtMm(um: number, decimals = 3): string {
  return (um / 1000).toFixed(decimals) + ' mm';
}

/** @deprecated Use UnitConverter.formatOutput(um, 'mm', false) */
export function fmtMmBare(um: number, decimals = 3): string {
  return (um / 1000).toFixed(decimals);
}
