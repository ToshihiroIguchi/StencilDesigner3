/** Format a µm value as millimetres with the given decimal places. */
export function fmtMm(um: number, decimals = 3): string {
  return (um / 1000).toFixed(decimals) + ' mm';
}

/** Format a µm value as a bare number string in mm (no unit suffix). */
export function fmtMmBare(um: number, decimals = 3): string {
  return (um / 1000).toFixed(decimals);
}
