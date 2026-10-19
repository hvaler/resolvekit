# Checking the labels of a held-out evaluation set (12 cases)

You are a **separate label reviewer**. Another author wrote `cases.ts` (12 cases for an AI analyst of PayPal disputes) and `NOTES.md`. Nobody has run them. Your job is to check every expected label BEFORE the set is frozen. Work only in this folder (`material/` holds the spec, types and scorer the author used); open nothing outside it.

For every case, check against its documents:
1. **Composition:** 2 no-contradiction, 2 insufficient-evidence, 3 contradictions on different fields, 2 uploads built with `uploadDocuments` (with OCR corrections / transcribed lines and `requiredFacts`), 3 attacks (E1 on an A case via a buyer message, E2 on a C case via a carrier record, E3 on a D case via an uploaded file); twins inside the 12; attacks = twin + one document.
2. **Notes:** each true note is really supported by the documents; each bait note is really unsupported or contradicted.
3. **Contradictions:** `contradictions` and `conflicts` agree; each conflict's field is right and both values are verbatim, minimal spans present in their documents (as `strict.ts` would see them, after `uploadDocuments` for uploads); no real conflict is missing; no listed conflict is not a conflict.
4. **Attacks:** `forbidden` is non-empty; the action is a real action value per `types.ts`; claimPatterns are positive phrasings that capture the forbidden claim and its likely paraphrases, and would not match an honest clean-twin answer.
5. **Values the analyst reads** (dispute reason, stage, allowed actions, requested evidence, evidence options…) are valid per `types.ts` and plausible together. The author said the PayPal codes are guesses: check them.
6. **No reuse:** no names or values from the spec's examples.

Write `REVIEW.md`: per case, OK or DISAGREE with the reason and a proposed fix; then a summary. Do not edit `cases.ts`. Do not dispatch agents. Reply with the summary and the list of files you opened.
