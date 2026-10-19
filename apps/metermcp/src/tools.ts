/**
 * The upstream tools MeterMCP sells. They are served by the gateway itself and are synthetic: deterministic
 * outputs derived from the arguments (no market data, no real reports). What is real is the metering and the
 * PayPal money flow around them.
 */
import { z } from 'zod';
import { sha256 } from './hash.ts';

export interface PaidTool {
  name: string;
  title: string;
  /** Price per successful call, decimal string in {@link CURRENCY}. */
  price: string;
  summary: string;
  input: z.ZodRawShape;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export const CURRENCY = 'USD';

/** A deterministic number in [0, 1) from a seed. */
const unit = (seed: string) => parseInt(sha256(seed).slice(0, 8), 16) / 0x1_0000_0000;

/** Qualitative, clearly synthetic findings. Three consecutive entries are picked deterministically from the topic. */
const FINDING_POOL = [
  'Synthetic finding: demand looks steady in this made-up scenario.',
  'Synthetic finding: supply appears concentrated among a few invented vendors.',
  'Synthetic finding: pricing pressure is described as moderate.',
  'Synthetic finding: the outlook is presented as broadly neutral.',
  'Synthetic finding: no regulatory change is assumed in this example.',
  'Synthetic finding: operational risk is described as manageable.',
];

export const PAID_TOOLS: readonly PaidTool[] = [
  {
    name: 'quote_lookup',
    title: 'Quote lookup',
    price: '0.05',
    summary: 'Look up a (synthetic) price quote for a product or ticker symbol. Limits: current quote only, no price history, no risk or supplier information.',
    input: { symbol: z.string().min(1).max(32).describe('Product code or ticker symbol, e.g. "ACME-42"') },
    run: async (a) => {
      const symbol = String(a.symbol).toUpperCase();
      return {
        symbol,
        quote: (10 + unit(`q:${symbol}`) * 990).toFixed(2),
        currency: CURRENCY,
        synthetic: true,
        limits: ['Current quote only: no price history.', 'No risk or supplier information.'],
      };
    },
  },
  {
    name: 'deep_report',
    title: 'Deep report',
    price: '0.40',
    summary: 'Write a (synthetic) structured research report on a topic. Limits: qualitative findings only, no row-level figures; use bulk_export for the data.',
    input: { topic: z.string().min(1).max(200).describe('What the report is about') },
    run: async (a) => {
      const topic = String(a.topic);
      const start = Math.floor(unit(`r:${topic}`) * FINDING_POOL.length);
      const findings = [0, 1, 2].map((i) => FINDING_POOL[(start + i) % FINDING_POOL.length]!);
      return {
        topic,
        sections: ['Summary', 'Market', 'Risks', 'Recommendation'],
        findings,
        summary: `Synthetic report on "${topic}": qualitative findings only.`,
        synthetic: true,
        limits: ['Qualitative findings only: no row-level figures.', 'For the underlying data, use bulk_export.'],
      };
    },
  },
  {
    name: 'bulk_export',
    title: 'Bulk export',
    price: '0.92',
    summary: 'Export a (synthetic) dataset as rows with a checksum. Limits: raw rows only, no interpretation; the preview shows at most 3 rows and the checksum covers all rows.',
    input: {
      dataset: z.string().min(1).max(64).describe('Dataset name, e.g. "quotes-2026-10"'),
      rows: z.number().int().min(1).max(1000).optional().describe('How many rows (default 100)'),
    },
    run: async (a) => {
      const dataset = String(a.dataset);
      const rows = typeof a.rows === 'number' ? a.rows : 100;
      const preview = [0, 1, 2].slice(0, rows).map((i) => ({ row: i + 1, value: (unit(`b:${dataset}:${i}`) * 100).toFixed(2) }));
      return {
        dataset,
        rows,
        checksum: sha256(`${dataset}:${rows}`).slice(0, 16),
        preview,
        synthetic: true,
        limits: ['Raw rows only: no interpretation or recommendation.', 'Preview shows at most 3 rows; the checksum covers all rows.'],
      };
    },
  },
];

export const toolByName = (name: string) => PAID_TOOLS.find((t) => t.name === name);

export function priceList() {
  return {
    currency: CURRENCY,
    unit: 'per successful call; failed calls are never charged',
    tools: PAID_TOOLS.map((t) => ({ name: t.name, title: t.title, price: t.price })),
    free: ['price_list', 'get_balance', 'close_session', 'get_receipt'],
  };
}
