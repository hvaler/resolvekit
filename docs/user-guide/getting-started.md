[English](getting-started.md) | [Español](../es/user-guide/getting-started.md)

# Getting started

Pick the path that matches you. Labels in **bold** are the exact names on screen.

| You are | Start here | You need |
|---|---|---|
| Anyone curious | [Explore demo](#explore-demo) | A browser |
| A judge or invited reviewer | [Sandbox evaluation](#sandbox-evaluation-reviewers) | The reviewer link from the submission form |
| A merchant | [Your merchant space](#your-merchant-space) | A PayPal account (today you will see a waiting screen) |
| A developer | [Local mode](#local-mode) | Node.js 24+, a PayPal sandbox app (optional), a model key (optional) |

## Explore demo

1. Open the ResolveKit address and choose **Try the demo** (or go to `/demo`). No sign-in.
2. The app bar says «Explore demo · fictional cases, nothing is sent». Every case runs on a PayPal simulator in your
   browser; no model is called and nothing reaches PayPal.
3. The **Disputes** inbox lists every fictional case. Use it like this:
   - **Saved filters**: **Needs my approval**, **Agent purchase**, **Processing by PayPal**, **Due in 48 h**;
     **Clear all** removes them.
   - Search box «Search ID, reason, status, next step».
   - Shift-click a column header to add a sort; **Reset columns** restores the layout. Column order, widths and sort
     are saved on this device.
   - Arrow keys move; **Enter** or a double click opens a case.
   - **Readiness** («3 of 5 present») shows how complete the evidence is. It does not predict PayPal's decision.
4. Open a case to see the case file: [Cases and evidence](cases-and-evidence.md).

What the demo cannot do: **+ Add evidence** is disabled («Adding your own evidence reads it on the ResolveKit server;
it's available in the sandbox evaluation, not in the demo.»), **Re-run with AI** needs the server, and an edited
sentence cannot be re-checked by the model (it stays **Needs review**, «this edit was not re-checked»). You can still
walk through review, approval and the simulated read-back.

## Sandbox evaluation (reviewers)

The sandbox evaluation is the workspace of a PayPal **sandbox** seller. Its cases are bound to real sandbox disputes;
sending is real (`provide-evidence`) but no real money moves.

1. Open the reviewer link from the submission form. The page says «Checking the invite…», then
   «<workspace> invited you as a reviewer», with what you can do and «Access until <date>».
2. Type **Your name, as the audit trail will show it** (1–60 characters). Your approvals carry this name.
3. Choose **Create a passkey and join** (sign in again later on this device) or **Join for this browser only** (ends
   with the session, 12 hours). If the browser cannot create passkeys, only the second appears.
4. You land on **Disputes**. The app bar reads «Sandbox evaluation · <workspace> · PayPal sandbox». Only the bound
   cases are listed; each shows **PayPal sandbox · live** with its dispute id when opened.
5. Two links sit above the grid: **Explore demo · N more fictional cases** and **Try the buying agent**.

Next: [Cases and evidence](cases-and-evidence.md) → [Review and submit](review-and-submit.md) →
[Buying agent](buying-agent.md). Judges also have the [Review guide](../judges/review-guide.md).

If the link says «This invite was already used», «This invite has expired» or «This invite was revoked», ask the
workspace Owner for a new link. If the inbox says «No sandbox disputes are bound right now.», there is nothing to
answer yet; use the Explore demo.

## Your merchant space

1. Choose **Sign in**, then **Continue with PayPal**. PayPal asks you to approve a no-charge request so ResolveKit
   can confirm which account is yours: «No money moves and no agreement is created.»
2. After approving you return signed in as the **Owner** of your workspace.
3. Unless your account is the sandbox seller of the evaluation, you see: «You're signed in with PayPal. Access to your
   disputes isn't available yet.» Connecting disputes for new merchants is being validated; ResolveKit cannot read your
   disputes or send responses for your business.
4. From there: **Explore demo**, **Members and invites** (inviting someone «doesn't connect your disputes to PayPal»),
   **Sign out**, **Use another PayPal account**.

Signing in does not give ResolveKit any access to your disputes. Status of the dispute connection: **Pending** (see
[Limitations](../product/limitations.md)).

## Local mode

For development and offline demos on one machine. There is no sign-in: you are the merchant («Alex Moreno» in the
app bar) and act as the Owner.

```bash
cp .env.example .env   # optional: PayPal sandbox app credentials and a model key; never commit it
npm install
npm run server         # http://127.0.0.1:8787
npm run dev            # http://localhost:5173
```

- Without the server, or without PayPal credentials, every case runs on the simulator.
- To use real sandbox disputes, bind cases in `apps/server/bindings.json` (from `bindings.example.json`).
- Without `GEMINI_API_KEY` or `GROQ_API_KEY` the server shows stored analyses only, and the buying agent cannot run.
- A **Dev · simulator** control (bottom left, development builds or `?dev`) chooses what the simulated PayPal does
  after a submission and can simulate PayPal being unreachable.

Full setup: [Local development](../technical/local-development.md) and [Configuration](../technical/configuration.md).

## Everywhere

- **Light / Dark** and **Teal / Indigo** switch the theme.
- The account menu (your workspace name and role chip) shows who you are, «signed in with …», the workspace's PayPal
  connection, **Explore demo**, **Sign out**, **Sign out of all devices**, **Use another PayPal account** and «The
  three environments». See [Accounts and permissions](accounts-and-permissions.md).
