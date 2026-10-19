[English](judges.md) | [Español](es/judges.md)

# Testing instructions (moved)

The judges' instructions now live in **[docs/judges/review-guide.md](judges/review-guide.md)**. This page stays so that
older links keep working. Where each topic of the old page went:

| Old topic | New place |
|---|---|
| The three environments (Explore demo, Test Store, your merchant space) | [Review guide: access and recommended environment](judges/review-guide.md#access-and-recommended-environment) |
| What is real and what is synthetic | [Review guide: what is real, synthetic, simulated or stored](judges/review-guide.md#what-is-real-synthetic-simulated-or-stored) |
| 1. Inbox | [Demo walkthrough, track A](judges/demo-walkthrough.md#a-explore-demo-no-account) |
| 2. A standard case · 3. The contradiction | [Review guide: main path](judges/review-guide.md#main-path-answer-a-dispute) |
| 4. Add your own evidence | [Review guide: upload and sanitise a document](judges/review-guide.md#upload-and-sanitise-a-document) · [walkthrough, track C](judges/demo-walkthrough.md#c-add-and-sanitise-your-own-evidence) |
| 5. Approve and send to real PayPal | [Demo walkthrough, track B](judges/demo-walkthrough.md#b-sandbox-evaluation-answer-a-real-sandbox-dispute) |
| 6. The buying agent | [Review guide: optional buying agent](judges/review-guide.md#optional-the-buying-agent) · [walkthrough, track D](judges/demo-walkthrough.md#d-the-buying-agent) |
| 7. The agent-purchase case | [Demo walkthrough, track E](judges/demo-walkthrough.md#e-the-agent-purchase-case) |
| More cases | [Demo walkthrough, track A, step 10](judges/demo-walkthrough.md#a-explore-demo-no-account) |
| 8. Optional: re-run the AI | [Review guide: main path](judges/review-guide.md#main-path-answer-a-dispute) |
| 9. Optional: MeterMCP from your own MCP client | [Demo walkthrough, track F](judges/demo-walkthrough.md#f-optional-metermcp-from-your-own-mcp-client) · [MCP tools](technical/mcp-tools.md) |
| Limits · a used dispute or reserve | [Review guide: if a dispute was used, the reserve is empty or a cap is reached](judges/review-guide.md#if-a-dispute-was-used-the-reserve-is-empty-or-a-cap-is-reached) |
| Run it yourself | [Local development](technical/local-development.md) |

Two statements of the old page are corrected in the new one: «PayPal accepts evidence once per dispute» is an
observation of our sandbox tests, not a documented PayPal rule; and a case moves to its next sandbox dispute only
while its reserve has one left. Every claim and its evidence: [verification matrix](judges/verification-matrix.md).
