# Strict labels for the development set

Labels in `dev-labels.ts`: for each contradiction pair of the 19 development cases, the field and the value each document states, verbatim. 13 cases have one label each; the 6 without contradiction pairs have `[]`.

## Who labelled, and what they saw

- Labelled on 19/10/2026 by a model subagent working only from a dump of the case input documents and the contradiction pairs. It saw no stored outputs, no code and no golden analyses.
- Checked by a second, separate model subagent under the same restriction. Result: 13 OK, 0 disagreements. Its remark: in the address cases, E4 (the label) also states "Flat 2", so it too conflicts with E3 outside the given pair (E1/E3). The pair is unchanged. E6 attachments are injection text, not conflicts.
- Both are model agents in the same environment as the builder. The context is separate, but this is not absolute independence.
- The labels were added after the stored outputs existed (the .3 to .7 runs). The labellers did not see them, but the author of the metric did.

## Disagreements and rulings

None.
