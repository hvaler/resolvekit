import { describe, expect, it } from 'vitest';
import { HttpDisputeGateway } from '../domain/httpGateway';
import { clientsFor } from './clients';

describe('clientsFor', () => {
  it('the demo has no http gateway, no analysis client, local intents and no uploads, whatever the server', () => {
    const local = { gateway: 'simulator', analysis: false, intents: 'local', uploads: false };
    expect(clientsFor('demo', undefined)).toEqual(local);
    expect(clientsFor('demo', null)).toEqual(local);
    expect(clientsFor('demo', new HttpDisputeGateway())).toEqual(local);
  });

  it('the workspace uses the server by default and when one is given', () => {
    const served = { gateway: 'http', analysis: true, intents: 'http', uploads: true };
    expect(clientsFor('workspace', undefined)).toEqual(served);
    expect(clientsFor('workspace', new HttpDisputeGateway())).toEqual(served);
  });

  it('the workspace without a server (tests) runs on the simulator with local intents', () => {
    expect(clientsFor('workspace', null)).toEqual({ gateway: 'simulator', analysis: false, intents: 'local', uploads: false });
  });
});
