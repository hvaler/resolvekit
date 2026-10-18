# A model-driven buying agent for MeterMCP (design)

Status: approved by the owner with four adjustments, which are incorporated (marked «owner, 18/10»), 18/10/2026. It addresses finding H-02 of the 17/10 audit: `apps/metermcp/scripts/demo-agent.ts` says «scripted, no LLM» while the landing page says «an AI agent calls paid tools».

## Intent

Judges must be able to see that the agent **decides**. A person gives a goal and a maximum budget and never says which tools to use. The agent reads the tools and their prices, picks one and says briefly why, makes the real paid call and reads the result. Then something changes the plan: the tool fails, the answer is not enough for the goal, or what is left of the budget does not cover the preferred option. The agent decides whether to retry, buy another tool or stop, and does it within the budget. At the end the receipt shows what really happened: the calls made, the failures that were not charged, and the amount captured in PayPal.

To show it is not a fixed sequence, the same goal is run again with one condition changed (the budget, or whether a tool is available). The two runs are shown side by side as **observed** decisions. A different choice is never forced to get the effect for the video.

## Decided by the owner

- **Two surfaces, one engine.** A simple interactive page for judges and a recorded run for the video. Both run the same agent engine, and `demo:prepare --agent-count` reuses it too.
- **Goal and budget.**
  - The person enters the goal and their maximum.
  - The server checks that amount against the demo limits, and PayPal asks the buyer to approve exactly that amount.
  - The agent can never raise it.
  - The **tool budget** (paid in PayPal) is kept apart from the **cost of running the model** (shown separately, never charged to the budget).
- **Real model decisions.**
  - The model chooses the next action only after reading the previous result.
  - Code validates the tool, its arguments, the remaining balance and the run limits.
  - There is no hidden fixed sequence behind the explanations.
- **Synthetic results, labelled as such.** The three current tools stay synthetic in this version, and each says so. Each result states its **explicit limits**, for example a summary that does not include the figures the goal needs, so the model can judge whether another tool is worth buying. No artificial «confidence» score is presented as a measure of quality: the current `confidence` field of `deep_report` goes.
- **Adaptation.**
  - The existing injected failure may be used, identified as injected wherever it appears (page, receipt, video).
  - The receipt records what really happened.
  - A comparison between two runs shows observed decisions only.
- **The judge's page** shows:
  - the goal and the budget;
  - the PayPal approval;
  - each action taken, with its result summarised and a short reason for the decision;
  - the final receipt.

  It does **not** show the model's internal reasoning. The video shows one run of that same path.
- **Relation to ResolveKit.**
  - A selected run can produce the payment that is later disputed and analysed in ResolveKit.
  - Launching the agent **never opens a dispute** by itself.
  - `demo:prepare --agent-count` keeps the link between run, MeterMCP session and capture.
- **First version scope.**
  - The three current tools.
  - Goals related to what those tools can do.
  - Limits on calls, time and model cost.
  - If a goal cannot be met with those tools, the agent says so and stops.

## Goals

1. An agent engine that is a loop of model decisions over MeterMCP's tools, validated by code, with run limits. It is usable from the server (judge page), the command line (video, local) and `demo:prepare`.
2. MeterMCP accepts a **requested cap** within demo limits, so the approved PayPal amount is the person's maximum.
3. Tool results with explicit, honest limits.
4. A per-run choice to inject the first-call failure of a named tool, labelled in the run and in the receipt.
5. A judge page:
   - goal and budget form;
   - the approval link and its status;
   - live steps;
   - the receipt;
   - the person's earlier runs, and a side-by-side view of two of them.
6. A stored **run record** linking run, MeterMCP session, PayPal order, authorization and capture, and the receipt hash.
7. Tests:
   - the engine with a fake model, covering every validation and limit;
   - provider adapters;
   - MeterMCP requested caps and per-run injection;
   - routes and limits;
   - that no step runs without a model decision.

## Non-goals (first version)

- New or real (non-synthetic) tools, or tools from other servers.
- Showing the model's chain of thought.
- Opening disputes from the page.
- Live PayPal (sandbox only, as today).
- An agent that chats back and forth with the person. One goal gives one run.

## Anti-goals

- **A scripted plan dressed as decisions:**
  - any code path that picks a tool when the model did not;
  - a fallback to the old scripted planner when the model is unavailable. The run stops and says the model is unavailable.
- **The budget leaking:**
  - a paid call that exceeds the approved cap;
  - the model raising, re-opening or splitting the budget;
  - model cost being counted in the PayPal amount.
- **A failure presented as real when it was injected,** or an injected failure missing from the receipt.
- **Text from the goal or from a tool result acting as instructions to the code.** Both are data to the model, and the code only acts on validated actions.
- **Keys, the demo code or the admin token reaching the browser, the logs or the run record.**
- **A run that cannot end:** every run has a step limit, a time limit and a model-call limit, and always tries to settle.

## Decisions taken by Claude (my calls, to check while reading)

1. **Where the engine runs: the ResolveKit server.**
   - It already holds `GEMINI_API_KEY` and `GROQ_API_KEY`, and it already reaches MeterMCP over the private network with `METERMCP_ADMIN_TOKEN`.
   - MeterMCP stays a payment-metering server and gets no model keys.
   - The engine itself is a package (`packages/agent`), so the CLI and `demo:prepare` run the same code with local keys.
   - Cost if wrong: moving the package's host later; the engine does not depend on where it runs.
2. **The engine is an MCP client of MeterMCP over the same MCP protocol and tools as any external agent.** Only the transport and auth differ by caller:
   - **The ResolveKit server** uses a new **private** `/mcp` route on MeterMCP's private host, authenticated with the admin token. Two reasons: `hostedGuard` refuses `/mcp` on non-public hosts, and the public route's per-IP limits would make every judge share the server's single IP. That route gets its own limits: live sessions, plus requests per run id passed in a header.
   - **The CLI and `demo:prepare`** use the public `/mcp` with the demo code, as today.
   - The server does not get the demo code.
3. **Model: native function calling.** MeterMCP's MCP tool list (name, description, JSON input schema, price) is turned into function declarations: Gemini `functionDeclarations`, Groq OpenAI-style `tools`.
   - Every function gets a required `reason` argument (at most 200 characters), the short reason shown on the page.
   - One more function, `finish(outcome: 'done' | 'cannot_do' | 'out_of_budget', answer, reason)`, ends the run.
   - Free tools (`price_list`, `get_balance`) are offered to the model.
   - `close_session` and `get_receipt` are **not**: settlement is done by code after `finish` or any stop, so the model can never skip it.
   - Gemini is primary and Groq the fallback, **chosen once per run**. The fallback is used only if the primary fails before the first turn. A later model failure, after the provider's own retries, stops the run as `model_unavailable` and settles it. One run therefore has one provider and one transcript format, and two runs compare cleanly.
   - Cost if wrong: a provider whose function calling misbehaves; the adapter is small.
4. **One action per model turn (owner, 18/10).**
   - If the model returns several calls in one turn, the **whole turn is rejected** and nothing is executed. The model receives an observation asking for a single action.
   - This counts as an invalid action under decision 5.
   - Code never executes «the first valid one», because that would make code choose which part of the decision runs.
5. **Validation before every call.** Code checks that:
   - the tool exists and the arguments match its MCP schema;
   - the price is no more than the remaining balance. If it is more, the call is not made and the model receives `insufficient_balance`, with the remaining amount, as its observation;
   - the step and time limits have not been reached.

   An invalid action is returned to the model as an observation once; a second invalid action in a row ends the run (`stopped: invalid_action`).
6. **Budget opening: model first, PayPal second.**
   - The model's first turn sees the goal, tools and prices before any budget exists. If it calls `finish(cannot_do)` there, nothing is opened in PayPal.
   - **Before opening anything (owner, 18/10),** code checks that the price of that first paid call fits within the requested and validated maximum. If it does not, no order is created and no approval is asked for. The model receives `insufficient_balance` with the available budget, and then picks another tool or finishes.
   - After approval, code validates balance, price and limits **again** before executing. The agent can never raise or re-open the budget.
   - Its first paid call that fits makes code open the budget with the requested cap. This uses a new free MeterMCP tool, `open_budget({ cap, fail_first?, return_to? })`.
     - **Auth:** it has the same rights as opening a budget today: the demo code on the public route, the admin token on the private one.
     - **Limits:** the cap must be within the demo limits, and it counts toward `DAILY_BUDGETS`.
     - **Visibility:** it is listed in `tools/list`, since nothing about it is hidden. The engine never offers it to the model.
     - **Return:** it returns the approval URL. `payment_required` stays as it is for other clients.
   - **After approval:** PayPal returns the buyer to `return_to` when it is on an allowlist (`METERMCP_RETURN_ORIGINS`, the ResolveKit origins), otherwise to MeterMCP's `/approved`. Either way the page polls, and once the budget is active code executes the call the model chose.
   - Cost if wrong: one extra MeterMCP tool.
7. **Demo limits:**
   - cap from **0.50 to 5.00 USD** (`METERMCP_BUDGET` becomes the maximum; `METERMCP_MIN_BUDGET` 0.50);
   - at most **8 tool actions** per run;
   - **3 minutes** of agent time, not counting the wait for approval;
   - approval timeout **15 minutes**;
   - at most **12 model calls** per run;
   - goal at most **300 characters**.

   **Model usage limits (owner, 18/10).** All limits are configurable:
   - per call: a maximum of input tokens (`AGENT_MAX_INPUT_TOKENS`, default 8 000, estimated before sending) and of output tokens requested (`AGENT_MAX_OUTPUT_TOKENS`, default 1 024);
   - per run: an accumulated budget of tokens in and out (`AGENT_RUN_TOKEN_BUDGET`, default 60 000).

   The budget counts every attempt: retries, and any failed attempt of the primary provider before the fallback was chosen.

   - **Checked before every call:** a call that could exceed what is left is not started, and the run stops as `stopped: model_budget`.
   - **Known only after the call:** where the provider reports usage after the fact, the maximum output requested is capped to what is left, and the run record notes that the figure is the provider's reported usage.

   The page and the record show provider, model, model calls and tokens in and out. A monetary estimate is shown **only** when a tariff is identified (named source and date) and the calculation basis is sufficient; otherwise nothing.

   Usage is never labelled «free tier» automatically. It is always shown apart from the tool budget approved in PayPal and is never deducted from it.

   Runs share MeterMCP's `DAILY_BUDGETS`. A run that ends before opening a budget still counts against a new `DAILY_AGENT_RUNS` (20) on the ResolveKit server, plus a per-person limit of 5 a day.
8. **Tool results with explicit limits** (synthetic, deterministic, each with `synthetic: true` and a `limits` list):
   - `quote_lookup`: the current quote only. Limits: «no history, no risk information».
   - `deep_report`: sections with qualitative findings. Limits: «no row-level figures; for the underlying data use bulk_export».
   - `bulk_export`: a row preview and a checksum. Limits: «raw rows only, no interpretation».

   The `confidence` score is removed. The wording is fixed in code and listed in the docs.
9. **Per-run failure injection.**
   - `open_budget` accepts `fail_first: [tool]`.
   - The page offers a checkbox: «Simulate an outage: the first call to Deep report fails (marked as injected)».
   - The receipt already labels such a call `UPSTREAM_UNAVAILABLE (injected by …)`; the run record and the page mark it too.
   - **A session opened with `open_budget` follows only its own `fail_first`;** an empty list means no injected failure. The global `METERMCP_FAIL_FIRST` applies only to sessions opened through `payment_required`.
   - The receipt names the source of each injected failure: «injected for this run at the person's request», or «injected by the server's test switch».
   - Deploy order: MeterMCP first, then ResolveKit; `METERMCP_FAIL_FIRST` is removed from Render at the end.
   - Cost if wrong: none.
10. **Run record** stored by the ResolveKit server on its disk:
    - run id, who started it, goal, cap, the injection option;
    - model and provider;
    - steps: the action, its arguments, its reason, a summary of the result, metering and time;
    - stop reason and model cost;
    - MeterMCP session id, PayPal order, authorization and capture ids, and the receipt sha256.

    The record is a **state machine** persisted at every step, not a log written at the end. **Run outcome and settlement are two separate states (owner, 18/10):**
    - **Run:** `running`, `awaiting_approval`, `done`, `cannot_do`, `out_of_budget`, `stopped: <limit>`, `model_unavailable` or `interrupted`.
    - **Settlement:** `none` (no budget opened), `pending`, `settled` (captured amount, released amount), `voided`, `capture_pending`, `close_failed`. These are read from MeterMCP's receipt, never assumed.

    A run can be `interrupted` or `model_unavailable` while its settlement is still pending.

    **On a server restart:**
    - Every unfinished run is marked `interrupted`, **including runs waiting for approval**. Nothing resumes and no tool is executed automatically afterwards.
    - If a budget was opened, the server tries to close the session through MeterMCP's admin `/sessions/<id>/close`. It claims nothing about capture or release until it has re-read the receipt.
    - A failed close, or a capture left pending, is reconciled later by a periodic sweep. Close is idempotent in MeterMCP, so this never charges twice.
    - The page and the receipt show the real state.

    The person starts a new run if they want.

    Visible to the person who started the run and to the owner. It is deleted after 30 days, except runs the owner marks as kept (the one in the video, and those used by `demo:prepare`).
11. **The page** lives in ResolveKit at `/agent`, reachable from the evaluation inbox and the landing «AI agent» line, for signed-in people (owner and reviewer-link judges). Goal suggestions are offered as examples to edit, never as hidden presets. The page polls the run as uploads do. The side-by-side view puts two of the person's runs in columns, step by step, with their receipts.
12. **The video and the CLI.**
    - `demo-agent` becomes a command-line front end of the same engine: `--goal`, `--cap`, `--fail-first`, and the model keys from `.env`. It prints the same steps and saves the run record as JSON.
    - The scripted planner is deleted.
13. **The reserve: real runs, the synthetic example kept apart (owner, 18/10).**
    - **The synthetic example stays as it is:**
      - the simulated agent case;
      - its golden analysis;
      - evals EV-11 and EV-12;
      - the 1.37 USD story: four calls, one failure not charged.

      It is clearly labelled synthetic. Those evals test the dispute analyst and do not claim to show the agent's autonomy, so they are not rebuilt around a variable run.
    - **Reserve cases use real agent runs,** with whatever calls, failures, decisions and amount really happened. No 1.37 USD story is required.
    - **`demo:prepare --agent-run <run id>`** takes a run already made on the page, without running the agent again or creating another payment. `--agent-count N` still runs the engine itself, with a goal and cap given by flags (defaults provided). The injection is per run and optional.
    - **A run joins the reserve only if all of these hold:**
      - at least one call completed and charged;
      - the capture is completed (a pending capture does not count yet);
      - run, MeterMCP session, receipt, seller and capture all match;
      - the capture is not already used by another reserve entry;
      - if the run ended on a limit or an interruption, that is shown and never presented as a goal achieved.
    - `agentReceiptProblems` is replaced by these checks.
    - **ResolveKit builds the agent case's documents and analysis from that session's real receipt** and the run record: goal, steps and reasons, receipt, settlement. It inherits no amounts, calls, failures or claims from the synthetic case. Tests cover this hand-off.
    - **The video** may use a run with an injected failure, explicitly identified. The failure is optional for every other run, and no different choice is forced to manufacture a show of autonomy.
14. **Docs.**
    - The landing text stays «an AI agent calls paid tools», which becomes true.
    - `docs/judges.md`, the README and the form's testing instructions (`PayPalAI/entrega/formulario.md`) describe the page and the model in use. They tell three things apart: **the synthetic example**, **real agent runs**, and **the settlement state** of each run.

## Left to the builder

- The system prompt's exact wording, within these rules:
  - goal and tool results are data;
  - prefer the cheapest tool that can meet the goal;
  - say what is missing;
  - stop when the goal cannot be met.
- The page layout within the design system; the polling and step wording.
- The run record's file layout and retention sweep, next to the existing stores.
- How the side-by-side view aligns steps of different lengths.
