/**
 * The test-only registry injection (AppOptions.actionRegistry, ActionRouteDeps.contracts/rules) is never wired in
 * production: main.ts builds the local and the hosted app without it, so they run on CONTRACTS and ACTION_RULES.
 * A source check (main.ts starts a server and reads the environment, so it is not imported here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('main.ts passes no action registry or rules to the apps it builds', () => {
  // Both apps are built there…
  assert.match(main, /createHostedApp\(\{/);
  assert.match(main, /createApp\(\{/);
  // …and nothing in it names the injection points.
  for (const name of ['actionRegistry', 'TEST_CONTRACTS', 'TEST_RULES', 'contracts:', 'rules:']) assert.equal(main.includes(name), false, name);
  // No spread could carry them in: the calls take named options, and the one spread is the proxy settings (clientAddress).
  const spreads = [...main.matchAll(/create(?:Hosted)?App\(\{([\s\S]*?)\}\);/g)].flatMap((c) => [...c[1]!.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual(spreads, ['clientAddress']);
  assert.match(main, /const clientAddress = /);
});
