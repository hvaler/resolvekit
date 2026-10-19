[English](accounts-and-permissions.md) | [Español](../es/user-guide/accounts-and-permissions.md)

# Accounts and permissions

Each merchant has its own workspace. Only the workspace whose PayPal account is the **seller** on a bound sandbox
dispute sees and answers that dispute. This page covers signing in, roles, invites, signing out and what is kept.
The full permission matrix is in the [Functional specification](../product/functional-specification.md#3-permissions).

Status: Implemented · Tested locally · Deployed. PayPal sign-in Verified in sandbox. Passkey creation on the deployed
sandbox service: **Pending** (no evidence yet). Local mode has no accounts.

## Ways to sign in

| Way | For | What happens |
|---|---|---|
| **Continue with PayPal** | Merchants (becomes the **Owner**) | You approve a no-charge request in PayPal so ResolveKit can confirm which account is yours. «No money moves and no agreement is created.» |
| **Sign in with a passkey** | Members who joined with a passkey | Your device's passkey (WebAuthn) signs you in again |
| An invite link | New members and reviewers | Opens **Join**: «<workspace> invited you as a member / reviewer» |

**Continue with PayPal** is an identity check, not Log in with PayPal: ResolveKit creates a no-charge Billing
Agreements agreement token with a separate «identity» app (a PayPal API family listed under a deprecated path) and,
once you approve it, reads which PayPal account approved it. No agreement is created and nothing is charged. Signing in
does **not** give ResolveKit access to your disputes.

After a PayPal sign-in you come back to the page you started from (the start page if you opened `/signin` directly).
If PayPal sign-in fails, `/signin` shows why:

| Message | Meaning |
|---|---|
| «You cancelled on PayPal. Nothing was shared.» | You cancelled |
| «PayPal did not confirm the approval. Try again.» | The token was not approved |
| «That sign-in was started in another browser or has expired. Start again here.» | The sign-in must finish in the browser that started it, within 15 minutes |
| «PayPal could not be reached. Try again in a moment.» | PayPal unavailable |
| «PayPal sign-in is not set up on this server.» | Not configured (e.g. local mode) |
| «Your account could not be saved. Try again later.» | Server storage problem |
| «This demo has reached its number of workspaces.» | The demo is full |

## Roles

| Role chip | Who | Can | Cannot |
|---|---|---|---|
| **Owner** | The PayPal account that signed in | Everything in the workspace; **Members and invites**; **Workspace runs** and **Keep** on `/agent` | Be revoked |
| **Member** | Joined with a member invite | Review cases, add evidence, review and delete any upload, approve and send responses, run the agent, within the daily limits | Connect PayPal; manage members |
| **Reviewer** | Joined with a reviewer invite (judges) | As a Member, until the access end date | Edit or discard anyone else's pending upload; delete uploads; manage members |

What each person approves carries their name and role in the audit trail, e.g. «Dana Ruiz (Member, reviewer ·
passkey) p_…» (name, role, how they joined, person id).

An approval belongs to the person who composed it: nobody else, not even the Owner, can approve or send someone
else's composed response.

## Invite people (Owner)

1. Open the account menu → **Members and invites** (or `/workspace`). Only the Owner sees it («Owners only» otherwise).
2. Fill the form: **Label**, **Uses** (1–300), **Link valid (days)** (1–120), **Reviewer** (tick for a time-limited
   reviewer link), **Access until** (reviewer only; at most 180 days ahead).
3. **Create invite link**. «Copy this link now: it is shown only once.» → **Copy link**.
4. Send the link privately. Anyone holding it can join until it runs out of uses, expires or is revoked.

The invite token travels in the link's `#` fragment and is removed from the address bar when the page opens.

Inviting someone does not connect your disputes to PayPal: a workspace that is not the sandbox seller still shows the
waiting screen to everyone in it.

## Join a workspace

1. Open the invite link. «Checking the invite…».
2. Type **Your name, as the audit trail will show it** (1–60 characters).
3. **Create a passkey and join**, or **Join for this browser only**. «A passkey lets you sign in again on this device.
   "This browser only" ends when the session does (12 hours).»

| Invite page | What to do |
|---|---|
| «This invite was already used» / «This invite has expired» / «This invite was revoked» | «Ask the workspace owner for a new link.» |
| «This page needs the full invite link.» | Open the whole link, including the part after `#` |
| «The passkey was not created (cancelled or timed out).» | Try again, or **Join for this browser only** |

Joining again with a link that still has uses creates a new member entry; it does not restore an old one.

## Manage members (Owner)

**Members** lists **Name**, **Role**, **Joined with** (PayPal, passkey, this browser only), **Last active (UTC)**.
**Revoke** ends that person's access at once (every session). **Invite links** lists each link with uses, expiry and
**Revoke**. Revoked people and links stay listed as «Revoked».

## Sessions and signing out

| Control | Effect |
|---|---|
| **Sign out** | Ends the session in this browser |
| **Sign out of all devices** | Ends every session of yours at once |
| **Use another PayPal account** | Signs out and opens a fresh PayPal sign-in |

A session lasts 12 hours. A reviewer's access ends at its **Access until** date («Reviewer access until <date>»).

## The account menu

Your name, «<role> of <workspace> · signed in with <PayPal | passkey | this browser only>», your email when PayPal
gave one, and the workspace's connection:

- «Sandbox evaluation: this workspace's PayPal account is the seller on the bound sandbox disputes. Test documents go
  to PayPal sandbox disputes; no real money moves.»
- «This workspace isn't connected to its PayPal disputes yet. Explore demo shows the full flow on fictional cases.»
- «Checking this workspace's PayPal connection…»

## What is stored about you, and what can be deleted

| Data | Where | Kept | You can |
|---|---|---|---|
| Your person record (name, role, how you joined, last active; email for PayPal sign-ins) | ResolveKit server | No expiry in code | Owner can **Revoke** (the record stays, marked revoked). No self-service deletion |
| Passkey public key | ResolveKit server | With your record | — |
| Session cookie | Your browser | 12 hours | **Sign out** |
| Drafts (edits, resolutions) | Your browser's storage, per person | Until cleared | Clear the site's data in your browser |
| Audit events naming you | ResolveKit server | Last 200 per person; the sends log is never evicted | — |
| Your PayPal account | PayPal | PayPal's policy | ResolveKit created no agreement to remove |

Deleting accounts or workspaces is not available (see [Limitations](../product/limitations.md)). For data
retention on the server see [Retention and deletion](../operations/retention-and-deletion.md).
