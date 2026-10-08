import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams, RowClassParams, RowStyle } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFragmentLit, type Highlight } from '../app/highlight';
import { receiptTotal } from '../domain/receipt';
import type { ReceiptCall } from '../domain/types';
import { rkReceiptTheme } from './grid/theme';
import { cx } from './ui';

type CallRow = ReceiptCall & { kind: 'call' };
type TotalRow = { kind: 'total'; fragment: '__total'; label: string; total: string; ofCap: string };
type Row = CallRow | TotalRow;
type P = ICellRendererParams<Row>;

const MONO_CELL = 'font-mono text-[12px] text-ink-2';

/** "#" column; in the pinned total row it spans #, time and tool and carries the label. */
function NumberCell({ data }: P) {
  if (!data) return null;
  if (data.kind === 'total') return <span className="font-sans text-[12.5px] font-semibold text-ink">{data.label}</span>;
  return <>{data.n}</>;
}

function ToolCell({ data }: P) {
  if (!data || data.kind === 'total') return null;
  return <span className={cx('font-mono font-medium', !data.ok && 'text-ink-3 line-through')}>{data.tool}</span>;
}

function PriceCell({ data }: P) {
  if (!data) return null;
  if (data.kind === 'total') return <span className="font-mono font-semibold">{data.total}</span>;
  return (
    <span className={cx('font-mono', !data.ok && 'text-ink-3 line-through')}>
      {data.price}
      {!data.ok && <span className="sr-only"> (not charged)</span>}
    </span>
  );
}

function StatusCell({ data }: P) {
  if (!data) return null;
  if (data.kind === 'total') return <span className="text-[12px] text-ink-2">{data.ofCap}</span>;
  return data.ok ? (
    <span className="rounded-sm bg-ok-soft px-[7px] py-px text-[11.5px] font-semibold text-ok">OK</span>
  ) : (
    <span className="whitespace-nowrap rounded-sm bg-bad-soft px-[7px] py-px text-[11.5px] font-semibold text-bad">FAILED · not charged</span>
  );
}

const COLUMNS: ColDef<Row>[] = [
  { field: 'n', headerName: '#', width: 38, cellClass: MONO_CELL, cellRenderer: NumberCell, colSpan: (p) => (p.node?.rowPinned ? 3 : 1) },
  { field: 'time', headerName: 'Time (UTC)', width: 88, cellClass: MONO_CELL },
  { field: 'tool', headerName: 'Tool', flex: 1, minWidth: 84, cellRenderer: ToolCell },
  { field: 'price', headerName: 'Price', width: 70, type: 'rightAligned', cellRenderer: PriceCell, comparator: (a: string, b: string) => Number(a) - Number(b) },
  { colId: 'status', field: 'ok', headerName: 'Status', width: 156, cellRenderer: StatusCell },
  { field: 'hash', headerName: 'Request hash', width: 104, cellClass: MONO_CELL },
];
const DEFAULT_COL: ColDef<Row> = { sortable: true, resizable: true, suppressHeaderMenuButton: true };
const getRowId = (p: GetRowIdParams<Row>) => p.data.fragment;

/**
 * Per-call receipt (agent purchase) on AG Grid: failed calls are struck and marked "not charged", and the
 * pinned total adds up the OK calls only. Hovering a citation chip highlights the cited calls.
 */
export function ReceiptGrid({ id, calls, currency, cap, hl }: { id: string; calls: ReceiptCall[]; currency: string; cap?: string; hl: Highlight | null }) {
  const [api, setApi] = useState<GridApi<Row> | null>(null);
  const rowData = useMemo<CallRow[]>(() => calls.map((c) => ({ ...c, kind: 'call' })), [calls]);
  const pinned = useMemo<TotalRow[]>(() => [{ kind: 'total', fragment: '__total', ...receiptTotal(calls, currency, cap) }], [calls, currency, cap]);

  const lit = calls.filter((c) => isFragmentLit(hl, id, c.fragment)).map((c) => c.fragment);
  const litKey = lit.join(',');
  const litRef = useRef<readonly string[]>(lit);
  litRef.current = lit;

  const getRowStyle = useCallback((p: RowClassParams<Row>): RowStyle | undefined => {
    if (p.node.rowPinned) return { background: 'var(--surface2)' };
    const d = p.data;
    if (!d || d.kind !== 'call') return undefined;
    if (litRef.current.includes(d.fragment)) return { background: 'var(--hl)', boxShadow: 'inset 3px 0 0 var(--acc)' };
    return d.ok ? undefined : { color: 'var(--ink3)' };
  }, []);

  // getRowStyle reads the highlighted keys; redraw so it runs again when they change.
  useEffect(() => {
    if (api && !api.isDestroyed()) api.redrawRows();
  }, [api, litKey]);

  return (
    <div role="region" aria-label="Per-call receipt" className="w-full">
      <AgGridReact<Row>
        theme={rkReceiptTheme}
        columnDefs={COLUMNS}
        defaultColDef={DEFAULT_COL}
        rowData={rowData}
        pinnedBottomRowData={pinned}
        domLayout="autoHeight"
        getRowId={getRowId}
        getRowStyle={getRowStyle}
        onGridReady={(e: GridReadyEvent<Row>) => setApi(e.api)}
      />
    </div>
  );
}
