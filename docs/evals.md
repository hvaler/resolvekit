[English](evals.md) | [Español](es/evals.md)

# Analyst evals (moved)

This page moved to **[Quality → Analyst evaluations](quality/evaluations.md)** on 19/10/2026. The content, every
figure and every caveat are unchanged there; only links were updated.

In one line: on specific synthetic cases, with prompt `rk-analyst-2026-10-09.7` and the models `gemini-3.8-flash` and
`openai/gpt-oss-120b`, these are the results we observed, and you can inspect and recompute them
(`npm run evals:recompute`, no keys, no model calls). They evaluate the AI analyst only, not the buying agent; the
agent's evidence is in [Testing](quality/testing.md#buying-agent-unit-tests-and-observed-sandbox-runs).

Sources of every figure: [`packages/analyst/evals/results/summary.md`](../packages/analyst/evals/results/summary.md)
and [`summary.json`](../packages/analyst/evals/results/summary.json).
