/**
 * Viewport widths in CSS pixels, inclusive. Up to `phoneMaxWidth` the wall
 * shows one cell at a time; up to `tabletMaxWidth` it defaults to two columns.
 * Media queries cannot read custom properties, so stylesheets repeat these
 * two numbers (see theme.css).
 */
export const BREAKPOINTS = { phoneMaxWidth: 639, tabletMaxWidth: 1023 } as const;
