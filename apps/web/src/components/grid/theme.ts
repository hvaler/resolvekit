import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  HighlightChangesModule,
  ModuleRegistry,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RenderApiModule,
  RowApiModule,
  RowStyleModule,
  ScrollApiModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
} from 'ag-grid-community';

// AG Grid Community only (no Enterprise modules, no licence key), and only the features the two grids use instead of
// AllCommunityModule (~1.09 MB). AG Grid logs an error naming the module whenever a feature needs a missing one.
ModuleRegistry.registerModules([
  ClientSideRowModelModule, // rows held in the browser
  ClientSideRowModelApiModule, // applyTransaction, forEachNodeAfterFilter
  RowApiModule, // getRowNode, getDisplayedRowAtIndex, getPinnedBottomRow
  ColumnApiModule, // get/apply/resetColumnState (column layout saved on the device)
  TextFilterModule, // inbox chips: status, case type, next step
  NumberFilterModule, // inbox chip: due soon
  QuickFilterModule, // inbox search
  PinnedRowModule, // "Totals at risk" and the receipt total
  RenderApiModule, // refreshCells, redrawRows
  HighlightChangesModule, // flashCells when PayPal changes a dispute
  ScrollApiModule, // ensureIndexVisible
  RowStyleModule, // getRowStyle
  CellStyleModule, // cellClass
  TooltipModule, // receipt "Hash" header tooltip
]);
// Development only: explains misconfigured grid options in the console (left out of production builds).
if (import.meta.env.DEV) ModuleRegistry.registerModules([ValidationModule]);

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
