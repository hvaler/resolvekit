# Three environments: what was left for later

This shipped on `main` at `250ce33` on 18/10/2026. The whole branch and its fixes were reviewed, and no isolation leak was found.

## Parked: decide later

- **Health is "unconfigured" before the server first reaches PayPal.** If the server starts while PayPal cannot be reached, health reads as «nothing bound». Judges then see the empty note, and a bound-case link goes to its demo copy. It fixes itself on the next good read.
- **PayPal sign-in loses `next`.** Signing in with PayPal always returns to `/?signed-in=paypal`. Only the owner signs in this way; passkey sign-in and `/join?next` keep it.

## Small, deferred on purpose

- **Seller refresh across a rebind.** Overlapping refreshes during a rebind can let a stale seller set win until the next refresh. Also, `confirm` does not prune entries after an empty complete read; this is harmless.
- **Test coverage.**
  - The new screens have no render tests (web tests are domain-only): the waiting, checking and retrying screens, the sign-out failure line, the indicator and the sandbox warning.
  - The `clientsFor` use inside `ServicesProvider` is not tested; the function itself is.
- **Health and account polling.**
  - The health retry timer restarts at full delay whenever the account is re-read; it should depend on `!!demo`.
  - The checking screen re-reads the account every 5 s, about 120 requests per 5 minutes per browser. Several judges behind one address could reach the 300-per-5-minutes limit. The state is rare.
- **Small UI issues.**
  - `DevOutcomeControl` does nothing on `/demo`.
  - The long environment label may crowd the bar at phone width.
  - `Frame` duplicates the AppBar header markup.
- **Code tidy-ups.**
  - `joinUrl` is only used by its test.
  - Some JSX indentation is off.
  - There is a Prettier warning in `InboxPage.tsx`.
  - A doc comment is misplaced in `sellers.ts`.
- **Local mode.** `GET /api/disputes/<non-fixture id>` now answers `UNKNOWN_CASE` instead of `NOT_BOUND`. No code depends on the old answer.

## Decisions taken during the build (rulings)

1. Sellers are remembered per binding and reused only while that binding stands, after the automated security review.
2. A pure `clientsFor(area, server)` is tested, and the demo switches uploads off explicitly.
3. An invite join lands on the evaluation inbox, not on a case opened before joining.
4. The owner's wording (18/10): the merchant connection is «in validation and not yet available».
5. With nothing bound, the last confirmed seller stays in `evaluation`. This is a label, not access.
6. Unknown health is not «nothing bound»: the app retries with backoff and never redirects to the demo.
7. The form's testing instructions (PayPalAI) were updated by hand.

## Third-party connection (separate from this delivery)

A sandbox Platform app works for Partner Referrals. Consent, an authorised listing and rejection of cross access are verified. The evidence and what is still pending are in `PayPalAI/docs/01-REGLAS.md` («Permisos de terceros en sandbox»). The integration is **not complete**: reading a known dispute, sending an approved response and the `merchant-integrations` check are still pending.
