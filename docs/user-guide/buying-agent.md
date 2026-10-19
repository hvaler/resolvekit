[English](buying-agent.md) | [Español](../es/user-guide/buying-agent.md)

# Buying agent

On `/agent` an AI model works toward a goal you type by choosing MeterMCP's paid tools, one action at a time, within a
budget you approve in PayPal (sandbox). Code checks every action before it is made, only successful calls are
charged, and the settlement shown is what MeterMCP's receipt says. Each step shows the model's short stated reason;
the model's internal reasoning is not shown. The tool outputs are synthetic.

Status: Implemented · Tested locally · Deployed · Verified in sandbox (two runs on 19/10/2026, below; they are
examples, not a guarantee of behaviour). **Stop** on a running run, the Groq fallback and recovery after a restart
have not been shown in the sandbox: **Pending**.

How it works inside: [Buying agent (technical)](../technical/buying-agent.md), [MCP tools](../technical/mcp-tools.md).

## Who can use it

- Sandbox evaluation: anyone signed in to the seller workspace (Owner, Member, Reviewer). In the inbox, **Try the
  buying agent**.
- Local mode: the operator, with a model key and MeterMCP running.
- Signed out, `/agent` sends you to **Sign in**. Another workspace's start is refused: «On this public demo only the
  seller's workspace starts agent runs.»

## What the agent can buy

| Tool | Price per successful call (USD) | What it returns (synthetic) |
|---|---|---|
| `quote_lookup` | 0.05 | A quote |
| `deep_report` | 0.40 | A report |
| `bulk_export` | 0.92 | An export of rows |
| `price_list`, `get_balance` | free | Prices; the budget's balance |

The model is offered these plus `finish`. Opening the budget, closing it and reading the receipt are done by code,
never by the model.

## Start a run

1. Under **New run**, type a **Goal** (1–300 characters, plain text) or pick one of the examples («they fill the
   field; edit them as you like»): one the tools can meet, one that needs the costly export, one they cannot meet.
2. Set the **Budget cap (USD, 0.50 to 5.00)**, e.g. `2.00`. The cap cannot be raised during the run.
3. Optional: tick **Simulate an outage: the first call to Deep report fails (marked as injected)**.
4. **Start the run**. You can have one run going at a time («One run at a time: wait for yours to end, or stop it.»).

## Approve the budget in PayPal

Nothing is opened in PayPal until the model chooses its first paid call that fits the cap. Then MeterMCP creates a
PayPal order to **authorize exactly the cap**, and the run shows **Waiting for approval in PayPal** with: «The agent
wants to spend up to <cap> USD. Approve the budget in PayPal (sandbox); nothing is charged until calls succeed.»

1. Choose **Approve in PayPal** (opens in a new tab; only the run's author sees this link).
2. Log in with a PayPal **sandbox personal (buyer) account**: reviewers get one in the submission form's testing
   instructions. Do not use the sandbox **business** account: it is the account the budget is paid to. In our 19/10/2026 sandbox
   run PayPal refused the approval with the seller's business account («Estás entrando en la cuenta del vendedor…» (PayPal's page was in Spanish; roughly «you are signing in to the seller's account»; recorded truncated)). This was observed, not documented by PayPal.
3. Approve. MeterMCP re-reads the order from PayPal and sends you back to `/agent?run=<id>` (or shows «Budget approved
   … You can close this tab and return to your agent»).
4. The run continues. If you cancel in PayPal, the run ends **Not approved in PayPal** («Nothing was authorized or
   charged»). If nobody approves within 15 minutes, it ends «Stopped: PayPal approval timed out». The waiting time does
   not count against the agent's time limit.

## Read the run

| Card | What it shows |
|---|---|
| Header | The outcome or state pill, the goal, «<who> · <time>», «simulated outage: deep_report» if ticked, **Stop**, **Keep** |
| **Steps** | One line per action: `#2 deep_report · 0.40 USD · FAILED, not charged · <result>`, then «Reason: <the model's stated reason>». Badges: **in progress**, **injected**, **not charged**, **uncertain** (the server restarted during that call; it is never repeated). A free tool shows «free»; a call over the balance shows «not called: insufficient balance»; an unreadable or multiple answer shows «invalid action» |
| **Answer** | What the model says it found and what is missing |
| **Budget and receipt** | **Budget cap**; **Charged per call (MeterMCP metering)**; **Failed calls (not charged)**; **Settlement (MeterMCP receipt)**; PayPal capture, PayPal order and MeterMCP session ids (author only); **Receipt SHA-256** |
| Usage line | «Model: <provider> <model> · N calls · X in / Y out tokens (provider-reported or estimated) · not charged to the PayPal budget» |

**Model usage is apart from the budget.** The PayPal budget pays only for MeterMCP tool calls. The model's calls are
paid by the service under its own provider quota and are never charged to the buyer.

**Charged per call** is MeterMCP's metering during the run; **Settlement** is the only statement of what PayPal
captured, and amounts appear only as the receipt states them.

## Outcomes

How the run ended, as the page says it. A run that stopped or was interrupted is never called done.

| Pill | Meaning |
|---|---|
| **Done** | The model finished with `done`: it says the goal is met |
| **The tools cannot meet this goal** | The model finished with `cannot_do` |
| **Out of budget** | The model finished with `out_of_budget`: what is left cannot pay for what is needed |
| «Stopped: action limit (8)» | 8 actions used |
| «Stopped: time limit» | 180 s of agent time (approval wait excluded) |
| «Stopped: model call limit» / «Stopped: model token budget» | 12 model calls / 60,000 tokens per run |
| «Stopped: the model gave invalid actions» | Two invalid actions in a row (none, several, or not allowed) |
| «Stopped: PayPal approval timed out» | Not approved within 15 minutes |
| «Stopped: MeterMCP did not open a budget» / «Stopped: MeterMCP unreachable» | MeterMCP refused or could not be reached |
| «Stopped: the run could not be saved» / «Stopped: internal error» | Server-side failure |
| **Model unavailable** | No model answered (after retries and, when a second key is configured, the fallback provider) |
| **Not approved in PayPal** | The buyer cancelled or PayPal declined |
| **Interrupted (stopped or server restart)** | **Stop** was pressed, or the server shut down or restarted; the record does not say which |

## Settlement

| Text | Meaning |
|---|---|
| «Captured X USD · Y released» | MeterMCP captured the successful calls; the rest of the authorization is no longer held (observed in sandbox) |
| «Capture pending at PayPal (not final)» | PayPal answered `PENDING`; no charge is claimed until it completes |
| «Voided: nothing charged» | No successful call; the authorization was voided |
| «Capture declined by PayPal: nothing charged» | PayPal declined or failed the capture |
| «Not approved in PayPal: nothing charged» | The budget was never approved |
| «Settlement failed: nothing charged as far as MeterMCP knows; will be retried» | MeterMCP will retry |
| «Not verified yet» | The receipt could not be read yet; the server reconciles every 5 minutes |
| «Budget open in PayPal (not settled yet)» | Approved, not closed yet |
| «Waiting for approval in PayPal: nothing charged yet» / «Not settled yet: the run is still going» | While running |
| «Nothing opened in PayPal» | The run ended before any paid call |

The page keeps reading a finished run whose settlement may still change, for up to 30 minutes.

## Injected failure

With **Simulate an outage** ticked, MeterMCP fails the **first** `deep_report` call of that run on purpose. That step
shows **injected** and **not charged**; the receipt marks it the same way. The model receives «UPSTREAM_UNAVAILABLE (injected for
this run at the person's request)» and decides what to do next. It is a test of behaviour under failure, not a real outage.

## Stop, Keep, Compare, Workspace runs

| Control | Who | What it does |
|---|---|---|
| **Stop** | The run's author, while it runs | Aborts the run: it ends **Interrupted (stopped or server restart)** and MeterMCP settles what was used. In sandbox: **Pending** |
| **Keep** | The workspace Owner (and the local operator) | «A kept run is never deleted by the 30-day retention.» |
| **Compare** | Anyone, on two runs of the list | Tick two runs («Pick to compare»), then **Compare (2/2)**: «Two runs side by side», step by step, with each outcome, settlement and usage |
| **Workspace runs** | The workspace Owner (hosted) | Lists everyone's runs in the workspace, read-only, marked «Viewed as workspace owner», without the approval link, PayPal order or MeterMCP session id. Each such view is logged |

## Two observed runs (19/10/2026, PayPal sandbox)

Examples only; the same goal can lead to different choices.

| Run | Cap | Simulated outage | Outcome | Settlement |
|---|---|---|---|---|
| A | 2.00 USD | yes | **The tools cannot meet this goal** | «Captured 0.05 USD · 1.95 released» |
| B | 2.00 USD | no | **Done** | «Captured 0.92 USD · 1.08 released» |

Both used Gemini. **Compare**, **Keep** and returning to `/agent?run=` after approval were checked the same day.

These runs are not the agent-purchase case's «1.37 of 5.00 USD» example: that one is demo data (and matches a
sandbox session made on 09/10/2026 by a scripted client). Starting a run never opens a dispute.

## Limits

1 running run per person and 3 per server; 5 runs per person and 20 per server per UTC day (they reset at midnight
UTC); 20 MeterMCP budgets per day. Per run: 8 actions, 12 model calls, 180 s, 15 min to approve.

## What is shared and kept

| Recipient | What |
|---|---|
| Model provider (Gemini; Groq as fallback) | Your goal (as data), the cap, the tool list and prices, each tool result (synthetic) and the model's own earlier turns |
| PayPal (sandbox) | An order for the cap (digital goods, the MeterMCP session id as reference), its authorization, one capture or a void |
| ResolveKit server | One record per run (goal, steps, reasons, usage, settlement, ids), kept 30 days unless kept, unsettled, unsaved or bound as case evidence. There is no delete button |
| MeterMCP ledger | Session, calls with request and response hashes, settlement; no expiry in code |

The PayPal sandbox keeps its own order, authorization and capture records. Model providers keep what they received
under their own policies.

## Errors

| Message | What to do |
|---|---|
| «You already have a run going: wait for it to end, or stop it.» | Wait or **Stop** |
| «The server is running as many agent runs as it allows; try again in a few minutes.» | Try later |
| «No AI model is configured on this server, so the agent cannot run.» | Local mode: set `GEMINI_API_KEY` or `GROQ_API_KEY` |
| «The demo's daily agent runs are used up; they reset at …» / «You have used your agent runs for today; try again in N h.» | Wait for the reset |
| «The cap is an amount in USD from 0.50 to 5.00, e.g. 2.50.» | Fix the cap |
| «This run is not one you can see.» | The run belongs to someone else |
| MeterMCP page «Payment method declined» | Nothing was authorized or charged; on `/agent` the run ends **Not approved in PayPal**. Start a new run |
