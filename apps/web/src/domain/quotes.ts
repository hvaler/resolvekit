import type { Citation, Evidence } from './types';

/** All fragments a document can be cited by, with the source text each one quotes. */
export function fragmentTexts(e: Evidence): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, text: string) => {
    out[key] = out[key] ? `${out[key]} ${text}` : text;
  };
  switch (e.body.kind) {
    case 'lines':
      for (const l of e.body.lines) if (l.fragment) add(l.fragment, l.text);
      break;
    case 'mandate':
    case 'settlement':
      for (const r of e.body.rows) add(r.fragment, `${r.label}: ${r.value}`);
      break;
    case 'receipt':
      for (const c of e.body.calls) add(c.fragment, `#${c.n} ${c.time} ${c.tool} ${c.price} ${c.ok ? 'OK' : 'FAILED · not charged'}`);
      break;
  }
  return out;
}

/** The quoted proof for a citation, as shown in the claim ↔ proof ledger. */
export function quoteFor(evidence: readonly Evidence[], c: Citation, wholeDocSuffix = '(attached)'): string {
  const e = evidence.find((x) => x.id === c.evidenceId);
  if (!e) return `${c.evidenceId} (missing from the case file)`;
  if (c.fragments.length === 0) return `${e.title} ${wholeDocSuffix}`;
  const t = fragmentTexts(e);
  return c.fragments.map((f) => t[f] ?? f).join('  ·  ');
}
