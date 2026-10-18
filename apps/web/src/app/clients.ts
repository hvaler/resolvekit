import type { HttpDisputeGateway } from '../domain/httpGateway';
import type { Area } from '../domain/environment';

/** Which clients an area talks to. The demo never reaches the ResolveKit server for disputes, analyses, intents or uploads. */
export interface ClientKinds {
  /** `http`: bound cases may go to the server (real PayPal); `simulator`: the simulated PayPal only. */
  gateway: 'http' | 'simulator';
  /** The AI analyst API on the server (also gates uploads). */
  analysis: boolean;
  /** `http`: composed and sent by the server; `local`: composed in the browser. */
  intents: 'http' | 'local';
  /** Merchant evidence uploads (server only). */
  uploads: boolean;
}

/** `server`: undefined = the default server, null = none (tests); the demo ignores it. */
export function clientsFor(area: Area, server: HttpDisputeGateway | null | undefined): ClientKinds {
  const serverless = area === 'demo' || server === null;
  return { gateway: area === 'demo' ? 'simulator' : server === null ? 'simulator' : 'http', analysis: !serverless, intents: serverless ? 'local' : 'http', uploads: !serverless };
}
