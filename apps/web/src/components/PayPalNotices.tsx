import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useServices } from '../app/services';
import { fetchNotices, noticeAge, noticeText, type PayPalNotice } from '../domain/paypalNotices';

const POLL_NOTICES_MS = 30_000;
const SHOWN = 3;

/**
 * "PayPal notified": the latest verified PayPal webhooks about the signed-in merchant's disputes (hosted mode), each
 * re-read from PayPal by the server. A dispute already linked to a case opens it; a new one says it is not linked yet.
 * Nothing renders without notices.
 */
export function PayPalNotices() {
  const { demo, health } = useServices();
  const on = !!demo?.signedIn && !!health && health.paypal !== 'unconfigured';
  const [notices, setNotices] = useState<PayPalNotice[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = () =>
      void fetchNotices()
        .then((n) => alive && (setNotices(n), setNow(Date.now())))
        .catch(() => {});
    load();
    const t = setInterval(load, POLL_NOTICES_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [on]);

  if (!on || notices.length === 0) return null;
  return (
    <section aria-label="PayPal notifications" className="flex flex-col gap-1.5 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-[12.5px] text-ink">
      <span className="flex items-center gap-2 font-medium text-info">
        <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-info" />
        PayPal notified · webhook, signature verified with PayPal
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {notices.slice(0, SHOWN).map((n) => (
          <li key={n.eventId} className="flex flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 break-words">{noticeText(n)}</span>
            <span className="font-mono text-[11.5px] text-ink-3">{noticeAge(n, now)}</span>
            {n.caseId ? (
              <Link to={`/cases/${n.caseId}`} className="text-acc">
                Open case
              </Link>
            ) : (
              <span className="text-ink-3">not linked to a case yet</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
