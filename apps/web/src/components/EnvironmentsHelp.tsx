import { ENVIRONMENTS_HELP } from '../domain/copy';

/** The three environments in one place: shown on the waiting screen and from the account menu. */
export function EnvironmentsHelp({ className }: { className?: string }) {
  return (
    <ul aria-label="The three environments" className={className ?? 'm-0 flex list-none flex-col gap-1.5 p-0 text-[12px] leading-normal text-ink-2'}>
      {ENVIRONMENTS_HELP.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
