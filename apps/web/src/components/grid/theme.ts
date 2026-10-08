import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

// AG Grid Community only: no Enterprise modules and no licence key.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * Quartz mapped onto the ResolveKit tokens. Every colour is a CSS variable, so the grid follows
 * data-theme (light/dark) and data-accent (teal/indigo) on <html> without being re-created.
 */
export const rkGridTheme = themeQuartz.withParams({
  accentColor: 'var(--acc)',
  backgroundColor: 'var(--surface)',
  foregroundColor: 'var(--ink)',
  borderColor: 'var(--line)',
  chromeBackgroundColor: 'var(--surface2)',
  headerBackgroundColor: 'var(--surface2)',
  headerTextColor: 'var(--ink3)',
  headerFontSize: 11.5,
  headerFontWeight: 500,
  headerHeight: 38,
  rowHeight: 58,
  rowHoverColor: 'var(--surface2)',
  selectedRowBackgroundColor: 'var(--acc-soft)',
  oddRowBackgroundColor: 'var(--surface)',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 13,
  spacing: 7,
  wrapperBorderRadius: 10,
  borderRadius: 5,
  rowBorder: true,
  columnBorder: false,
  browserColorScheme: 'inherit',
});

/** The compact per-call receipt in the agent-purchase case. */
export const rkReceiptTheme = rkGridTheme.withParams({ rowHeight: 34, headerHeight: 32, fontSize: 12.5, headerFontSize: 11, wrapperBorderRadius: 7 });
