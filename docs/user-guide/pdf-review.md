[English](pdf-review.md) | [Español](../es/user-guide/pdf-review.md)

# PDF review

A PDF is never used as a PDF. The server turns the pages you choose into images, you cover each page and have it
read again, and on confirm ResolveKit builds a new image-only PDF from your covered pages. The original file is then
deleted. Its text layer, fonts, attachments, annotations and metadata are never used.

Status: Implemented · Tested locally · Deployed. Sending a PDF upload to PayPal sandbox: **Pending** (not yet
observed).

## Limits

| Limit | Value |
|---|---|
| File | up to 10 MiB and 30 pages |
| Pages used | at most 5 |
| Covering passes | 5 per page |
| Text of the PDF (read + transcribed) | 20,000 characters |
| Rebuilt PDF | under 9,900,000 bytes (it must stay under PayPal's 10 MB per file) |
| Page reads | each page read counts against your address's **upload** limit (20 per 10 minutes) |
| Text hint | once per page per review; counts against your address's PayPal-reads limit (60 per 5 minutes) |

## Steps

1. **+ Add evidence** → choose the PDF. «Checking the PDF…».
2. **Up to 5 pages**: the server reads them at once («Reading page 2 of 3…»). Skip to step 4.
3. **More than 5 pages**: the server prepares thumbnails («Preparing thumbnails (4 of 12)…»), then the upload shows
   **Choose pages**:
   - «This document has 12 pages. Choose up to 5 to add as evidence.»
   - «Keep the context the dispute needs: don't leave out pages with relevant or contradicting information.»
   - Click thumbnails to pick them («Page 8 of the original document»), then **Add N pages**. The choice is made once;
     to choose differently, discard and upload again.
4. When the pages are read, choose **Review** on the pending upload. **Review new evidence** opens with «<name> · PDF ·
   N pages chosen · uploaded by <person>» and a tab per page: «Page 8 · not covered», «Page 8 ✓», «Page 8 · changed».
5. On each page:
   1. Read the warning: «Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the
      code too if it carries data you don't want to share.»
   2. With **Cover** selected, drag over what must not be shared.
   3. **Cover this page and read it again** (even if nothing needs covering). The page is re-rendered with the covers
      burned in and read again from scratch.
   4. Under «Text read from the covered page» correct any misread line («This is what the analyst will read. Correct a
      line where the reading is wrong; each correction is marked with who made it.»).
   5. A line the reading missed: choose **Add text**, drag over the line on the page (never over a cover), then type it
      in «Type the line as it is on the page». It is shown as «Transcribed manually by <you>». **Remove** drops it.
   6. Optional: under «Text found in the PDF (a hint for your review; never stored or sent)» choose **Show it for this
      page** to compare with the PDF's own text. It can contain text that is invisible on the page.
6. **Review the pages included**: «These pages become evidence», one line per page («Page 2 of the original document ·
   2 lines read, 1 corrected»), and «Only the covered pages and the text above are stored and used; the original PDF
   is deleted.»
7. **Confirm as evidence**, or **← Back to the pages**. The PDF becomes the next evidence number.

**← Back to case** closes the window: what you typed and drew stays in this page until you reload it; nothing is used
before you confirm. **Discard** removes the upload («What you typed and drew on its pages is lost.»).

## What you will see afterwards

- Citations name the page of the **original** document: lines are cited as «line 2 of page 8» and grouped under «Page
  8 of the original document» on the evidence card.
- A sentence that rests on a corrected or transcribed line needs your explicit confirmation before it can be sent
  (see [Review and submit](review-and-submit.md)).
- The analyst is told which lines were corrected or transcribed by a person; it does not take them as read from the
  file.
- PayPal receives only the rebuilt PDF, named `E<n>-upload.pdf`.

## Messages and blockers

| Message | Meaning / what to do |
|---|---|
| «Cover <page> first, even if nothing needs covering.» | Every page must be covered and read again before confirming |
| «You changed what is covered on <page>: cover it again before confirming.» | Covers changed after the last read |
| «No text was read on this page. Transcribe what matters, or the analyst can't use it.» | Use **Add text** |
| «A transcribed line cannot come from a covered area.» | Move the area off the cover |
| «Type the text of each transcribed line on <page>, or remove it.» | Fill or remove empty transcribed lines |
| «Page 8 of the original document changed; check it again.» | The page changed on the server; review it again |
| «Once rebuilt from its covered pages, this PDF is larger than … ; upload it again and choose fewer pages» | Discard, upload again, pick fewer pages (a noisy scan can take about 2 MB per page) |
| «A page can be covered 5 times; discard this PDF and upload it again» | Start again |
| «Reading is taking longer than expected. Reload the page to check again.» | Reload; a read of five pages can take minutes |
| «Failed: …» | Discard and upload again |
| Thumbnail «No preview» | The thumbnail could not be loaded after 3 tries; you can still pick the page |

## Privacy and retention

- Until confirmed, the original PDF, its uncovered page renders and the text hint are visible only to people who can
  edit the upload. The hint is shown during review only and is never stored, logged or sent.
- On confirm the original PDF and the uncovered renders are deleted; the covered pages and their text remain as the
  evidence. A pending PDF not confirmed within 24 hours is discarded.
- Deleting and what stays at PayPal or a model provider: see [Cases and evidence](cases-and-evidence.md#deleting-and-what-stays).
- How the rendering is isolated (a separate process with memory and time limits): see
  [Evidence processing](../technical/evidence-processing.md).
