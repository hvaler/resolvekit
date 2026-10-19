import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo, ThemeControls } from '../components/AppBar';
import { cx } from '../components/ui';

const REPO = 'https://github.com/hvaler/resolvekit';

/** A screenshot of the real app, framed. Light-theme captures from docs/media (synthetic case data). */
function Shot({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <figure className={cx('m-0 overflow-hidden rounded-xl border border-line bg-surface shadow-float', className)}>
      <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
    </figure>
  );
}

function Section({ id, eyebrow, title, children, className }: { id?: string; eyebrow?: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cx('mx-auto flex w-full max-w-[1120px] scroll-mt-16 flex-col gap-6 px-6 py-16 max-md:px-4 max-md:py-12', className)}>
      <div className="flex max-w-[720px] flex-col gap-2">
        {eyebrow && <span className="text-[12px] font-semibold uppercase tracking-[.06em] text-acc">{eyebrow}</span>}
        <h2 className="m-0 text-title-lg">{title}</h2>
      </div>
      {children}
    </section>
  );
}

const PROMISES = [
  {
    title: 'Every claim cited',
    body: 'The AI analyst drafts the response from your own records. A verifier checks each sentence against the exact words it cites; a sentence without a source is struck through and never sent.',
    src: '/landing/02-case-file.png',
    alt: 'A case file: hovering a citation lights up the exact words in the source document; an unsupported sentence is struck through.',
  },
  {
    title: 'Nothing sent without you',
    body: 'You review exactly what PayPal will receive, every claim beside its proof, and approve that exact content. The server sends it only if nothing changed since you approved.',
    src: '/landing/04-approve-ledger.png',
    alt: 'The approval screen: each claim next to its proof, the evidence type PayPal asks for, and the irreversible confirmation.',
  },
  {
    title: 'What PayPal recorded, not what we hope',
    body: 'After sending, ResolveKit reads the dispute back from PayPal and says “Recorded by PayPal” only when PayPal lists new seller evidence that matches what was sent.',
    src: '/landing/05-recorded-by-paypal.png',
    alt: 'A sandbox dispute read back after sending: the evidence PayPal recorded, next to what was sent.',
  },
];

const STEPS = [
  ['A PayPal dispute arrives', 'Read from PayPal’s Customer Disputes API, with what PayPal asks you for and the actions it allows now.'],
  ['The case file builds itself', 'Order, shipping, carrier records and messages become one timeline; contradictions are shown side by side, neutrally.'],
  ['AI drafts, a verifier checks', 'Supported sentences cite their evidence; unsupported ones are removed; instructions hidden in documents are treated as content.'],
  ['You approve; ResolveKit sends', 'Your approval covers that exact content. ResolveKit sends it to PayPal and reads the dispute back.'],
];

export function LandingPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg text-ink">
      <header className="sticky top-0 z-40 flex h-12 flex-none items-center gap-5 border-b border-line bg-surface px-6 max-md:gap-3 max-md:px-4">
        <Logo />
        <nav aria-label="Sections" className="flex items-center gap-4 text-[12.5px] text-ink-2 max-md:hidden">
          <a href="#how" className="text-ink-2 no-underline hover:text-ink">
            How it works
          </a>
          <a href="#agents" className="text-ink-2 no-underline hover:text-ink">
            For agent purchases
          </a>
          <a href="#security" className="text-ink-2 no-underline hover:text-ink">
            Security
          </a>
        </nav>
        <span className="flex-1" />
        <span className="rounded-md border border-line-2 bg-surface-2 px-2 py-[3px] text-[11.5px] text-ink-2 max-md:hidden">PayPal sandbox · synthetic case data</span>
        <span className="max-md:hidden">
          <ThemeControls />
        </span>
        <Link to="/signin" className="whitespace-nowrap text-[12.5px] font-medium text-ink no-underline hover:text-acc">
          Sign in
        </Link>
        <Link to="/demo" data-testid="try-demo" className="flex h-8 items-center whitespace-nowrap rounded-lg bg-acc px-3 text-[12.5px] font-semibold text-acc-ink no-underline">
          Try the demo
        </Link>
      </header>

      <main className="flex flex-col">
        {/* Hero */}
        <section className="mx-auto grid w-full max-w-[1120px] grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-10 px-6 pb-12 pt-16 max-lg:grid-cols-1 max-md:px-4 max-md:pt-10">
          <div className="flex flex-col gap-5">
            <h1 className="m-0 text-[40px] font-semibold leading-[1.08] tracking-[-0.02em] max-md:text-[30px]">Answer PayPal disputes with evidence, not guesses.</h1>
            <p className="m-0 text-[16px] leading-[1.6] text-ink-2">
              ResolveKit turns your scattered records into a case file, drafts a response in which every claim cites its proof, and sends it to PayPal only
              after you approve exactly what goes out.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link to="/demo" className="flex h-11 items-center rounded-xl bg-acc px-5 text-[14px] font-semibold text-acc-ink no-underline">
                Try the demo
              </Link>
              <Link to="/signin" className="flex h-11 items-center rounded-xl border border-line-2 bg-surface px-5 text-[14px] font-medium text-ink no-underline">
                Sign in
              </Link>
            </div>
            <span className="text-[12.5px] text-ink-3">Free to try. No sign-up to explore; merchants sign in with PayPal.</span>
          </div>
          <Shot src="/landing/thumbnail.png" alt="The ResolveKit case file: timeline, cited evidence and the response draft." />
        </section>

        {/* Promises */}
        <Section eyebrow="The promise" title="Three things ResolveKit never compromises on">
          <div className="grid grid-cols-3 gap-6 max-lg:grid-cols-1">
            {PROMISES.map((p) => (
              <article key={p.title} className="flex flex-col gap-3">
                <Shot src={p.src} alt={p.alt} />
                <h3 className="m-0 text-heading-md">{p.title}</h3>
                <p className="m-0 text-body leading-normal text-ink-2">{p.body}</p>
              </article>
            ))}
          </div>
        </Section>

        {/* How it works */}
        <Section id="how" eyebrow="How it works" title="From a dispute to a recorded response, with you deciding">
          <ol className="m-0 grid list-none grid-cols-4 gap-4 p-0 max-lg:grid-cols-2 max-md:grid-cols-1">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-acc-soft font-mono text-[12px] font-semibold text-acc">{i + 1}</span>
                <strong className="text-heading-sm">{title}</strong>
                <span className="text-body leading-normal text-ink-2">{body}</span>
              </li>
            ))}
          </ol>
        </Section>

        {/* Agent purchases */}
        <Section id="agents" eyebrow="For agent purchases · MeterMCP" title="When an AI agent bought from you, the receipt is the evidence">
          <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-10 max-lg:grid-cols-1">
            <div className="flex flex-col gap-3 text-body-lg leading-[1.6] text-ink-2">
              <p className="m-0">
                MeterMCP is a metered MCP gateway: the buyer approves a budget in PayPal,{' '}
                <Link to="/agent" className="text-acc">
                  an AI agent calls paid tools
                </Link>
                , and only the successful calls are captured.
              </p>
              <p className="m-0">
                If the buyer disputes the charge, the per-call receipt becomes the case file: mandate 5.00 USD, each call with its request hash, the failed
                call not charged, 1.37 captured and the rest released. It goes to PayPal as digital delivery with the receipt PDF.
              </p>
            </div>
            <Shot src="/landing/06-agent-metermcp-receipt.png" alt="An agent purchase case: the MeterMCP mandate, the per-call receipt with a failed call not charged, and the settlement." />
          </div>
        </Section>

        {/* Security and honesty */}
        <Section id="security" eyebrow="Security and honesty" title="What is real, what is synthetic, and what protects your account">
          <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-5">
              <h3 className="m-0 text-heading-sm">Real</h3>
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body leading-normal text-ink-2">
                <li>PayPal sandbox disputes, orders, authorizations and captures.</li>
                <li>Evidence submissions to PayPal, read back after sending.</li>
                <li>The AI analysis (Gemini, with Groq as fallback) and its verifier.</li>
                <li>Merchant sign-in through PayPal, invites and passkeys.</li>
              </ul>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-5">
              <h3 className="m-0 text-heading-sm">Synthetic</h3>
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body leading-normal text-ink-2">
                <li>The merchant’s documents and case data (orders, labels, notes).</li>
                <li>MeterMCP’s tool outputs.</li>
                <li>Cases you open without signing in run on a simulated PayPal; the app always says which.</li>
              </ul>
            </div>
          </div>
          <ul className="m-0 grid list-none grid-cols-3 gap-4 p-0 text-body leading-normal text-ink-2 max-lg:grid-cols-1">
            <li className="rounded-xl border border-line bg-surface-2 p-4">PayPal credentials never reach the browser; the server holds them.</li>
            <li className="rounded-xl border border-line bg-surface-2 p-4">Only the seller’s workspace sees and answers its real disputes, checked against PayPal before every send.</li>
            <li className="rounded-xl border border-line bg-surface-2 p-4">Every approval and send is on an audit trail that names the person who approved.</li>
          </ul>
        </Section>
      </main>

      <footer className="mt-auto border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-[12.5px] text-ink-2 max-md:px-4">
          <span>Built for the PayPal AI Hackathon.</span>
          <a href={REPO} className="text-acc">
            Source on GitHub
          </a>
          <span className="flex-1" />
          <span>Not affiliated with PayPal. ResolveKit improves preparation; PayPal decides disputes.</span>
        </div>
      </footer>
    </div>
  );
}
