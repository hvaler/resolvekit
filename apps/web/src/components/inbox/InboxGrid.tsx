import type {
  CellKeyDownEvent,
  ColDef,
  ColumnState,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ModelUpdatedEvent,
  RowClassParams,
  RowDoubleClickedEvent,
  RowHeightParams,
  RowStyle,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chipFilterModel,
  compareDue,
  computeTotals,
  quickFilterText,
  sameRow,
  type ChipKey,
  type GridRow,
  type InboxGridRow,
} from '../../domain/inbox';
import { rkGridTheme } from '../grid/theme';
import { AmountCell, CaseTypeCell, DisputeCell, DueCell, ItemCell, NextStepCell, ReadinessCell, StageCell, StatusCell } from './cells';

const STORAGE_KEY = 'resolvekit.inbox.columns';
const ROW_H = 58;
const PINNED_H = 76;
const HEADER_H = 38;

const asDispute = (d: GridRow | undefined): InboxGridRow | null => (d && d.kind === 'dispute' ? d : null);
const qf = (f: (r: InboxGridRow) => string) => (p: { data: GridRow }) => {
  const r = asDispute(p.data);
  return r ? f(r) : '';
};

/** Columns as specified in the design's rk-grid.js (3d build spec). */
const COLUMNS: ColDef<GridRow>[] = [
  {
    colId: 'due',
    field: 'dueH',
    headerName: 'Due',
    width: 132,
    sort: 'asc',
    comparator: (a: number | null, b: number | null, _na, _nb, desc) => compareDue(a, b, desc),
    filter: 'agNumberColumnFilter',
    cellRenderer: DueCell,
    getQuickFilterText: quickFilterText.due,
  },
  { colId: 'dispute', field: 'id', headerName: 'Dispute', flex: 1.6, minWidth: 236, cellRenderer: DisputeCell, getQuickFilterText: qf(quickFilterText.dispute) },
  { colId: 'item', field: 'item', headerName: 'Buyer declared', width: 132, cellRenderer: ItemCell },
  { colId: 'amount', field: 'amount', headerName: 'Amount', width: 108, type: 'rightAligned', cellRenderer: AmountCell, getQuickFilterText: qf(quickFilterText.amount) },
  { colId: 'stage', field: 'stageLabel', headerName: 'Stage', width: 84, cellRenderer: StageCell },
  {
    colId: 'status',
    field: 'statusLabel',
    headerName: 'PayPal status',
    width: 206,
    filter: 'agTextColumnFilter',
    cellRenderer: StatusCell,
    getQuickFilterText: qf(quickFilterText.status),
  },
  { colId: 'caseType', field: 'caseType', headerName: 'Case type', width: 130, filter: 'agTextColumnFilter', cellRenderer: CaseTypeCell },
  { colId: 'ready', field: 'ready', headerName: 'Readiness', width: 120, cellRenderer: ReadinessCell, getQuickFilterText: quickFilterText.ready },
  {
    colId: 'next',
    field: 'next',
    headerName: 'Next step',
    flex: 1.4,
    minWidth: 220,
    filter: 'agTextColumnFilter',
    cellRenderer: NextStepCell,
    getQuickFilterText: qf(quickFilterText.next),
  },
];

const DEFAULT_COL: ColDef<GridRow> = { sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true };

const LOADING_OVERLAY = `<div role="status" class="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-3 text-body text-ink-2 shadow-float">
  <span aria-hidden="true" class="box-border h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-acc"></span>Loading disputes from PayPal…</div>`;

const getRowId = (p: GetRowIdParams<GridRow>) => p.data.id;
const getRowHeight = (p: RowHeightParams<GridRow>) => (p.node.rowPinned ? PINNED_H : ROW_H);
function getRowStyle(p: RowClassParams<GridRow>): RowStyle | undefined {
  if (p.node.rowPinned) return { background: 'var(--surface2)' };
  const r = asDispute(p.data);
  if (!r) return undefined;
  if (r.nextKind === 'processing') return { background: 'var(--surface2)', color: 'var(--ink2)' };
  if (r.status === 'RESOLVED') return { opacity: '0.6' };
  return undefined;
}

function readSaved(): ColumnState[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ColumnState[]) : null;
  } catch {
    return null;
  }
}
function save(api: GridApi<GridRow>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(api.getColumnState()));
  } catch {
    // Not persisted; the layout still applies for this visit.
  }
}

export interface InboxGridProps {
  rows: readonly InboxGridRow[];
  /** First load only, when there is nothing to show yet. Later syncs never blank the grid. */
  loading: boolean;
  quickFilter: string;
  chips: readonly ChipKey[];
  /** Change to reset column order, widths and sort. */
  resetToken: number;
  onOpen: (row: InboxGridRow) => void;
  onDisplayed?: (n: number) => void;
  onClear: () => void;
  height?: number;
}

/**
 * The case inbox on AG Grid Community: multi-sort (shift-click), quick filter, chip filters written to the
 * filter model, a pinned "Totals at risk" row, column state saved on this device, and in-place updates
 * (applyTransaction) when PayPal changes a dispute.
 */
export function InboxGrid({ rows, loading, quickFilter, chips, resetToken, onOpen, onDisplayed, onClear, height = HEADER_H + ROW_H * 8 + PINNED_H + 8 }: InboxGridProps) {
  const [api, setApi] = useState<GridApi<GridRow> | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const loaded = useRef<Map<string, InboxGridRow> | null>(null);
  const lastTotals = useRef('');
  const cb = useRef({ onOpen, onDisplayed });
  cb.current = { onOpen, onDisplayed };

  const onGridReady = useCallback((e: GridReadyEvent<GridRow>) => {
    const saved = readSaved();
    if (saved) e.api.applyColumnState({ state: saved, applyOrder: true });
    setApi(e.api);
  }, []);

  /** Totals and the displayed count follow the rows that pass the filters. */
  const onModelUpdated = useCallback((e: ModelUpdatedEvent<GridRow>) => {
    const api = e.api;
    if (api.isDestroyed()) return;
    const n = api.getDisplayedRowCount();
    const visible: InboxGridRow[] = [];
    api.forEachNodeAfterFilter((node) => {
      const r = asDispute(node.data);
      if (r) visible.push(r);
    });
    const t = computeTotals(visible);
    const key = `${n}:${JSON.stringify(t)}`;
    if (key !== lastTotals.current) {
      lastTotals.current = key;
      api.setGridOption('pinnedBottomRowData', n ? [t] : []);
      // The totals row keeps its id, and its column values are not fields, so redraw its cells explicitly.
      const pinned = api.getPinnedBottomRow(0);
      if (pinned) api.refreshCells({ rowNodes: [pinned], force: true });
    }
    setShown(n);
    cb.current.onDisplayed?.(n);
  }, []);

  // Rows: set once after the first load, then only changed rows go to the grid, in place.
  useEffect(() => {
    if (!api || loading) return;
    if (!loaded.current) {
      loaded.current = new Map(rows.map((r) => [r.id, r]));
      api.setGridOption('rowData', [...rows]);
      return;
    }
    const prev = loaded.current;
    const update = rows.filter((r) => {
      const p = prev.get(r.id);
      return p && !sameRow(p, r);
    });
    const add = rows.filter((r) => !prev.has(r.id));
    if (!update.length && !add.length) return;
    loaded.current = new Map(rows.map((r) => [r.id, r]));

    // Keep keyboard focus on the same dispute even if the new values move it in the sort.
    const focused = api.getFocusedCell();
    const gridHasFocus = !!document.activeElement?.closest('.ag-root-wrapper');
    const focusedId = focused && !focused.rowPinned ? api.getDisplayedRowAtIndex(focused.rowIndex)?.id : undefined;
    api.applyTransaction({ update, add });
    const nodes = update.map((r) => api.getRowNode(r.id)).filter((n) => n != null);
    // A cell only redraws when its own field changes; renderers also read other fields (reason, due note…), so force it.
    api.refreshCells({ rowNodes: nodes, force: true });
    api.flashCells({ rowNodes: nodes, columns: ['status', 'next', 'due'], flashDuration: 1200 });
    if (focused && focusedId && gridHasFocus) {
      const node = api.getRowNode(focusedId);
      if (node?.rowIndex != null) {
        api.ensureIndexVisible(node.rowIndex);
        api.setFocusedCell(node.rowIndex, focused.column);
      }
    }
  }, [api, rows, loading]);

  useEffect(() => {
    api?.setFilterModel(chipFilterModel(chips));
  }, [api, chips]);

  useEffect(() => {
    if (!api || !resetToken) return;
    api.resetColumnState();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing saved to remove.
    }
  }, [api, resetToken]);

  const onCellKeyDown = useCallback((e: CellKeyDownEvent<GridRow>) => {
    const ev = e.event as KeyboardEvent | null | undefined;
    const r = asDispute(e.data);
    if (ev?.key === 'Enter' && r && !e.node.rowPinned) {
      ev.preventDefault();
      cb.current.onOpen(r);
    }
  }, []);
  const onRowDoubleClicked = useCallback((e: RowDoubleClickedEvent<GridRow>) => {
    const r = asDispute(e.data);
    if (r && !e.node.rowPinned) cb.current.onOpen(r);
  }, []);
  const persist = useCallback((e: { api: GridApi<GridRow>; finished?: boolean; source?: string }) => {
    if (e.finished === false || e.source === 'api' || e.source === 'gridOptionsChanged') return;
    save(e.api);
  }, []);

  const q = quickFilter.trim();
  const noMatch = !!api && !loading && shown === 0;
  const empty = rows.length === 0;

  return (
    <div className="relative w-full" style={{ height }}>
      <AgGridReact<GridRow>
        theme={rkGridTheme}
        columnDefs={COLUMNS}
        defaultColDef={DEFAULT_COL}
        getRowId={getRowId}
        getRowHeight={getRowHeight}
        getRowStyle={getRowStyle}
        quickFilterText={quickFilter}
        loading={loading}
        overlayLoadingTemplate={LOADING_OVERLAY}
        suppressNoRowsOverlay
        animateRows
        ensureDomOrder
        onGridReady={onGridReady}
        onModelUpdated={onModelUpdated}
        onCellKeyDown={onCellKeyDown}
        onRowDoubleClicked={onRowDoubleClicked}
        onSortChanged={persist}
        onColumnMoved={persist}
        onColumnResized={persist}
      />
      {noMatch && (
        <div
          role="status"
          className="absolute bottom-px left-px right-px z-[5] flex items-center justify-center rounded-b-2xl bg-surface"
          style={{ top: HEADER_H + 1 }}
        >
          <div className="flex max-w-[420px] flex-col items-center gap-1.5 text-center">
            <span aria-hidden="true" className="mb-1 box-border h-[34px] w-[34px] rounded-xl border-[1.5px] border-dashed border-line-2" />
            <strong className="text-heading-md text-ink">
              {empty ? 'No open disputes' : q ? `No disputes match “${q}”` : 'No disputes match these filters'}
            </strong>
            <span className="text-pretty text-body leading-[1.5] text-ink-2">
              {empty
                ? 'New PayPal disputes appear here within a few minutes. We check every 30 seconds.'
                : `Search covers dispute ID, reason, item type, status and next step.${chips.length ? ' Saved filters combine: a dispute must match all of them.' : ''}`}
            </span>
            {!empty && (
              <button type="button" onClick={onClear} className="mt-1 rounded-md border border-line-2 bg-surface px-2.5 py-[5px] text-[12px] text-ink-2">
                Clear search and filters
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
