[English](troubleshooting.md) | [Español](../es/user-guide/troubleshooting.md)

# Troubleshooting

Find the message you see (or the closest one) and follow the fix. Messages are quoted as the app shows them. For
operators, see the [Runbook](../operations/runbook.md).

## Signing in and access

| You see | Why | Fix |
|---|---|---|
| «You're signed in with PayPal. Access to your disputes isn't available yet.» | Your workspace is not the sandbox seller; merchant connection is not available | Use **Explore demo**. Reviewers: join with the reviewer link instead |
| «Checking your PayPal connection…» (repeats every 5 s) | The server has not yet read the bound disputes' seller | Wait; it resolves when PayPal answers |
| «Couldn't read the bound sandbox cases yet. Retrying…» | The server's health read failed | **Retry now**, or wait (retries back off up to 30 s) |
| «No sandbox disputes are bound right now.» | Nothing to answer in the evaluation | Use the Explore demo |
| «Owners only» | Only the Owner manages members | Ask the Owner |
| «This invite was already used / has expired / was revoked» | The link cannot be used | Ask the Owner for a new link |
| Signed out after some hours | Sessions last 12 hours; «this browser only» ends with the session | Sign in with your passkey, or a new invite |
| «Reviewer access until …» passed | Reviewer access ended | Ask the Owner |
| PayPal sign-in errors | See [Accounts and permissions](accounts-and-permissions.md#ways-to-sign-in) | — |

## Reading cases

| You see | Why | Fix |
|---|---|---|
| «Couldn't reach PayPal. Showing saved data.» / «Sync delayed» | PayPal or the server did not answer | **Sync now** / **Sync again**; PayPal fields show «—» until a read succeeds |
| «Reading this dispute from PayPal…» for long | Slow sandbox read | Wait; reload |
| **Demo binding mismatch** | The bound sandbox dispute does not match the demo order (e.g. a different amount) | Informational; the PayPal fields shown are PayPal's |
| A case link opens in the Explore demo | In the evaluation workspace, only bound cases are live; other ids open their fictional twin | Expected |
| «Case not found» | No such case in this area | **← All cases** |
| **Evidence recorded by PayPal**, draft read-only | Someone already sent evidence on this dispute | Read the recorded evidence; in the evaluation the case moves to its next reserve dispute only if one is left |
| «PayPal is processing this new dispute. Actions appear shortly.» | New dispute, `UNDER_REVIEW`, no seller actions yet | Wait a few minutes |

## Analysis

| You see | Fix |
|---|---|
| **Re-run with AI** disabled: «Sign in required» / «Seller workspace only» | Sign in to the seller workspace |
| «Live-run limit reached (6/hour); next in N min» | Wait |
| «Live runs need the ResolveKit server (npm run server) with a model key» / «No model key (GEMINI_API_KEY / GROQ_API_KEY) on the server» | Local mode: start the server with a key |
| «No analysis for these documents: …» | The server is not connected or has no stored analysis; start it, or **Re-run with AI** |
| A sentence «Why: this edit was not re-checked (…)» | The re-check failed or is not available; edit again later, or review it yourself (it cannot be sent while **Needs review**) |
| «Analysis pending: it does not include E7 yet…» | **Re-run with AI** to include your confirmed evidence |
| `DAILY_CAP` «This demo allows N live AI runs per day; the cap resets at …» | Wait for the reset (UTC) |

## Evidence uploads

| You see | Fix |
|---|---|
| **+ Add evidence** disabled with a reason | Explore demo, signed out, another workspace, or evidence already sent; see the reason |
| «Adding evidence needs the ResolveKit server (npm run server)» | Local mode: start the server |
| «The uploads of this case could not be read (…)» | **Retry**; the analysis waits so that it does not leave out confirmed evidence |
| «Reading is taking longer than expected. Reload the page to check again.» | Reload |
| «Failed: …» on a PDF | Discard and upload again |
| Size, character or count errors | See [Cases and evidence](cases-and-evidence.md#errors) and [PDF review](pdf-review.md#messages-and-blockers) |
| «A response that attaches or quotes this upload is being sent to PayPal right now; delete it once the outcome is known» | Wait for the send to finish |
| «The analyses that quote this upload could not be removed, so it was not deleted; try again» | Try again |

## Review and submit

| You see | Fix |
|---|---|
| **Review what will be sent →** disabled | Read the bar above it: resolve each listed item |
| «only "Provide evidence" can be sent from this screen for now» (seen on the earlier deployed commit `fbe9621`) | The deployed commit `c12faea` has the other actions ([Review and submit](review-and-submit.md#other-dispute-actions)); if you still see this message, reload to get the new web bundle, and choose **Provide evidence** meanwhile |
| «Outcome pending confirmation» after a message, accept, offer or escalation | Press **Check again** (it only reads the dispute back); nothing else can be sent on that dispute until PayPal shows the result |
| «Not available: <reason>» next to an action | That variant has no recorded PayPal contract, or is outside it; see [Limitations](../product/limitations.md) |
| «Nothing can be sent yet» with reasons | Fix the reasons, **← Back to edit**, **Try again** |
| «Only the seller's workspace can send this» | Sign in to the seller workspace |
| «What would be sent now differs from what you approved…» (`INTENT_STALE`) | Review again and approve |
| «The approval was not recorded, so nothing was sent: …» | Try again |
| «The send could not be recorded durably, so nothing was sent; try again later» (`AUDIT_UNAVAILABLE`) | Try later |
| «PayPal already has seller evidence for this dispute; nothing more can be sent» | Read the recorded evidence |
| **Submission not confirmed** | **Try again**: ResolveKit reads back first and re-sends only if PayPal shows nothing recorded |
| «New seller evidence that doesn't match what we sent» | Someone else sent evidence; nothing is retried. Inspect «Sent versus recorded» |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Close and reopen the case |

## Buying agent

| You see | Fix |
|---|---|
| **Start the run** disabled | Type a goal and a cap; wait for your running run to end |
| No **Approve in PayPal** link | Only the author sees it, and only while the run waits for approval |
| PayPal refuses the login or payment | Use a sandbox **personal (buyer)** account, not the business account (PayPal refused the seller's business account in the 19/10/2026 sandbox run; observed, not documented) |
| «Stopped: PayPal approval timed out» | Approve within 15 minutes; start a new run |
| «Not verified yet» | The server reconciles the receipt every 5 minutes; the page keeps checking for 30 minutes |
| «Interrupted (stopped or server restart)» | Stop was pressed or the server restarted; a call in progress shows **uncertain** and is never repeated |
| Other refusals | See [Buying agent](buying-agent.md#errors) |

## Limits and service

| You see | Fix |
|---|---|
| 429 `RATE_LIMITED` | Too many requests from your address; wait for the time given (`Retry-After`) |
| 429 `DAILY_CAP` / `PERSON_CAP` | A shared daily cap is used up; it resets at midnight UTC |
| 503 `CAPS_UNAVAILABLE` «The demo cannot record this action's use right now, so it is not done» | Try later |
| Errors (502) for 1–2 minutes | The service is redeploying; wait and reload |
| «The server could not be reached.» | Check your connection; the service may be restarting |

Still stuck? Report it as described in [CONTRIBUTING.md](../../CONTRIBUTING.md); never include invite links, tokens
or personal data.
