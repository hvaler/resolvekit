[English](merchant-onboarding.md) | [Español](../es/technical/merchant-onboarding.md)

# Merchant onboarding through PayPal Platform

**Status: in validation, not available to users.** A merchant who signs in with PayPal today sees a waiting screen:
«Connecting disputes for new merchants is being validated and isn't available yet…», with a link to the demo.
ResolveKit cannot read that merchant's disputes or send responses on their behalf. Signing in grants no access to
them.

This page separates three things that must not be confused:

1. **External sandbox test achieved**: a step tried by hand in the PayPal sandbox on 18/10/2026, **outside the app**,
   with a separate sandbox Platform app. Private evidence, summarised here without ids, accounts or links; not
   reproducible by readers.
2. **Implemented in the app**: code in this repository. At commit `f1b7236` there is **none**: no
   `partner-referrals`, `merchant-integrations` or `PayPal-Auth-Assertion` anywhere in `apps/` or `packages/`.
3. **Deployed**: running on the hosted service. Only the waiting screen is deployed.

## The ten steps

| # | Step | External sandbox test (18/10/2026, outside the app) | Implemented in the app | Deployed |
|---|---|---|---|---|
| 1 | Platform app configuration (Disputes API features `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE`) | Achieved with a sandbox app of type Platform; an earlier attempt from a non-platform app was refused (403) | No | No |
| 2 | Partner Referrals (v2, `integration_type` `THIRD_PARTY`, both dispute features, `action_url`) | Achieved (201) | No | No |
| 3 | Consent | Achieved by an independent sandbox seller (a business account other than the platform and the evaluation seller) | No | No |
| 4 | Effective permissions in `merchant-integrations` | Achieved: `payments_receivable` and `primary_email_confirmed` true; `disputes/read-seller` and `disputes/update-seller` listed among the granted scopes | No | No |
| 5 | Dispute listing (`PayPal-Auth-Assertion`) | Achieved (200). Only the dispute on a payment the platform had processed appeared (first 0, then 1); the seller's disputes on its own direct invoices did not | No | No |
| 6 | Reading a known dispute | 200 for a dispute on an Orders v2 payment the platform created with the seller as payee; 403 `ACTION_NOT_ALLOWED` for two disputes on invoices the seller issued directly, one created after enabling Invoicing and Transaction search on the platform app | No | No |
| 7 | Authorised response (explicitly approved `provide-evidence`) | Achieved once (200) on the platform-processed dispute | No | No |
| 8 | Read-back | Achieved: the read-back showed `SUBMITTED_BY_SELLER` | No | No |
| 9 | Isolation and revocation | Cross-seller attempts refused by PayPal (403 for another seller's dispute; 400 when listing for a seller that had not consented). Revocation and disconnect: not tested (Pending) | No | No |
| 10 | Integration and availability in ResolveKit (link to the signed-in workspace, per-merchant case source, ResolveKit-side isolation, partner dispute webhooks) | Not tried: needs app code | No (Pending) | No (only the waiting screen) |

Source: command outputs of the external sandbox test of 18/10/2026, recorded in the development session; not stored in
this repository (ids omitted).

## The payment-origin difference (observation only)

In these tests, disputes on payments the platform processed were readable and answerable, and disputes on the
seller's direct invoices were not. This is an **experimental observation**: one seller, few cases, sandbox only,
never tested in live. It is not documented by PayPal, not confirmed, and not stated here as a rule or as PayPal's
behaviour. Possible explanations include a by-design scope tied to the calling partner, an account or app setting we
did not find, sandbox-specific behaviour, or something else. ResolveKit does not promise access to all of a
merchant's disputes, and an empty list must not be read as "this merchant has no disputes".

## Question to PayPal

A question asking whether third-party dispute access is limited to transactions processed through the partner, and
whether a platform can manage all of a consented seller's disputes, was sent through the hackathon developer
channel on **18/10/2026**. **No answer recorded as of 19/10/2026.**

## What PayPal documents

- Partner Referrals v2 creates a referral and returns «an `action_url` to which you redirect the customer»;
  `THIRD_PARTY` and the features `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE`
  ([Partner Referrals v2](https://developer.paypal.com/docs/api/partner-referrals/v2/),
  [schema](https://developer.paypal.com/api/partner-referrals/v2/schema.yaml)). No scope of which disputes is
  described.
- The app setting for the Disputes API and the seller's grant of permission
  ([onboarding checklist](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist)).
- Seller status checks (`payments_receivable`, `primary_email_confirmed`, `oauth_third_party`)
  ([before payment](https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/)); the v1
  reference that documents `merchant-integrations` is marked deprecated.
- `PayPal-Auth-Assertion` is «An API client-provided JSON Web Token (JWT) assertion that identifies the merchant»;
  consent to act on behalf of the merchant is a prerequisite
  ([request headers](https://developer.paypal.com/api/rest/requests),
  [orders get](https://developer.paypal.com/api/orders/v2/orders-get)).
- Partner dispute webhooks use the same `CUSTOMER.DISPUTE.*` events; whether they cover all of a seller's disputes is
  not stated ([partner dispute webhooks](https://developer.paypal.com/docs/multiparty/disputes-chargebacks/webhooks/)).

## What building it would need (not designed in code)

The three-environments design reserves a `connected` workspace state (never produced today) and a third case source,
the merchant's own disputes from PayPal with no fixtures. Building it would need, at least: steps 1–10 in app code;
a per-merchant source of disputes instead of bindings; isolation tests across merchants for routes, uploads,
analyses, caches and audit; and a settled answer on which disputes a platform can reach. None of this is
implemented. See [limitations](../product/limitations.md).
