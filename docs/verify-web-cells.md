# Checking web cells on the real sites

[繁體中文](verify-web-cells.zh-TW.md)

Web cells are tested automatically against a stand-in site only. No rule for
a real site (claude.ai, chatgpt.com, gemini.google.com, grok.com, chat.z.ai)
has ever been run against that site: the rules were written from the
publicly visible structure of the pages. This checklist is how a person with
their own accounts checks them, one site at a time, and what to report when
something does not match.

The terms of these sites restrict automated access to their web apps. Steps
D and E below switch the two automation switches on for a few prompts.
Whether to do that, on which sites and with which account is your decision;
steps A to C need neither switch. Nothing here says that any step is
permitted by any site.

Budget: about 10 minutes per site. Use short prompts; three per site are
enough.

## Before you start

- A running AnswerWall server (a release, not the Windows app in local
  mode) and a device that is signed in to it.
- Chrome or Edge, signed in to the sites you want to check **in normal
  tabs**.
- `answerwall-extension-<version>.zip` from the same release as the server,
  checked against `SHA256SUMS`, unpacked.

Write down for the report: the version, the browser and its version, the
operating system, the date, and for each site the plan you are on (free or
paid), because the pages differ.

## A. Installing and pairing (once)

1. `chrome://extensions` (or `edge://extensions`) > **Developer mode** on >
   **Load unpacked** > the unpacked folder.
   - [ ] The extension appears as "AnswerWall web cells" with the ID
         `nffcmlcjkacklpololkpdmhcfokannom`.
   - [ ] **Details > Permissions / Site access** lists the five sites and
         nothing like "all sites".
2. Click the extension's toolbar icon.
   - [ ] A first-run page opens and shows the same ID.
3. On the server: **Settings > Web cells** > **Allow web cells** on, tick
   the sites to check, add the ID. Leave **Fill in the prompt** and **Read
   the answer** off for now.
4. On the first-run page enter the server's address and a pairing code,
   press **Connect**.
   - [ ] The browser asks whether the extension may reach the server's
         address, and names that address only.
   - [ ] The wall appears. **Settings > Devices** on the server lists
         "Browser extension".
   - [ ] With a wrong ID on the server (remove one letter), **Connect**
         says that the server refuses the extension.

Note for the report whether the server was on `http://127.0.0.1`, plain
HTTP on the LAN, or HTTPS (public certificate, or the server's own
certificate authority): only loopback HTTP is covered by the automated
tests.

## B. Framing, per site (both switches off)

Add a cell for the site on the extension's wall (**Add cell**, pick the
site as provider).

- [ ] The site's page appears in the cell, signed in, looking as it does in
      a tab. If you see the browser's refusal page, a blank frame or the
      site's sign-in although you are signed in in a tab: note what the cell
      shows and stop here for this site.
- [ ] The cell says **Connected to the page** within a few seconds, and
      **Unverified rule**.
- [ ] Typing and sending a prompt by hand in the cell works, including the
      site's own features you use (model picker, attachments, search).
- [ ] **Open in a tab** opens the site in a new tab; **Reload** brings the
      cell back to the site's start page.
- [ ] Sign out of the site in a normal tab, reload the cell: it shows the
      site's sign-in page. Signing in inside the cell works, or (Gemini)
      leads to another host that the cell cannot show; note which. Sign in
      again in a normal tab.

## C. What must stay untouched (once, with any one site)

- [ ] Open the same site in a normal tab while the wall is open. It behaves
      as always. In its developer tools (**Network**, the page's own
      document, **Response Headers**) `content-security-policy` or
      `x-frame-options` is still present if the site sends one.
- [ ] In that normal tab's developer tools **Console**, the context picker
      shows the extension's content script, but nothing in the page has
      changed: no prompt appears there when you press Send on the wall.
- [ ] Close the wall tab. On `chrome://extensions`, **Inspect views: service
      worker**, run
      `await chrome.declarativeNetRequest.getSessionRules()` in its console:
      the result is `[]`. With the wall open it holds exactly one rule,
      whose `tabIds` is the wall's tab.

## D. Fill in the prompt, per site

Switch **Fill in the prompt** on (and leave **Read the answer** off). Ask
`Reply with the single word: ready` from the wall's composer.

- [ ] The prompt appears in the site's message box and is sent once.
- [ ] The cell says **Sent in the page. Reading answers is off, so nothing
      is stored.** and the ask in **History** has no entry for the site.
- [ ] A prompt with two lines and a non-Latin script (for example
      `第一行` / `second line`) arrives in the site as typed.

If instead the cell reports that the rule did not find the message box or a
usable send control, go to "Reporting a rule that fails".

## E. Read the answer, per site

Switch **Read the answer** on as well. Ask three things:

1. `Reply with the single word: ready`
2. `Give me a numbered list of three fruits, then a table with two columns, then a Python hello world in a code block.`
3. A prompt whose answer takes more than 20 seconds on that site (a long
   essay, or a model that thinks first).

For each:

- [ ] The cell goes from **Typing the prompt into the page…** to **Waiting
      for the page to finish its answer…** to **Done. The answer is stored
      in history.**
- [ ] The stored answer (**History** > **Open**) is the complete answer of
      that prompt: not cut off early, not the previous answer, without
      button labels ("Copy", "Retry") or the site's own interface text.
- [ ] For prompt 2: the list, the table and the code block (with its
      language) come out as Markdown.
- [ ] For prompt 3: nothing was stored before the page had finished.
- [ ] Press the cell's **Cancel** during a long answer: the cell ends as
      cancelled, nothing is stored, the page keeps going by itself.

Then switch **Fill in the prompt** off and keep **Read the answer** on:

- [ ] Send from the wall: the cell asks you to type in the page. Type and
      send there by hand; the finished answer is stored.

## F. Marking a rule as verified

When A to E pass for a site, the rule file `apps/extension/rules/<site>.json`
gets `"verified": true` and `"verifiedOn": "<the date, YYYY-MM-DD>"` in a
pull request that names the browser, the version and the plan it was checked
with. The cell then no longer says "Unverified rule". A rule is verified for
the page as it was on that day; sites change without notice.

## Reporting a rule that fails

Open an issue with:

- the site, the date, the browser and its version, the operating system,
  the extension's version, and whether you use a free or a paid plan;
- which step failed and the exact message the cell showed;
- what the rule should have found. In the cell, right-click the element
  (the message box, the send button, one whole answer, the "stop" button
  that is visible while the site answers) > **Inspect**, and copy for each:
  the tag name and its `id`, `class`, `data-*`, `aria-label` and `role`
  attributes, and the same for two or three of its parents. Do this once
  while the site is answering and once after it has finished, because the
  rule needs the difference;
- for a wrong stored answer: what was stored and what the page showed.

**Leave out** everything personal: no cookies, no tokens, no conversation
content, no account name, no address of your server, no screenshots that
show any of these. Attribute names and values of the page's own structure
are enough.

A rule can often be fixed by editing its data file alone
(`apps/extension/rules/<site>.json`: the lists are tried in order, the first
selector that matches is used) and reloading the extension. If you tried a
selector that works, say so in the issue.

## What to send back

One line per site and step is enough:

```
claude    A ok  B ok  C ok  D ok  E fail (stored answer includes "Copy")
chatgpt   A ok  B fail (frame refused)
```

plus the versions, the kind of server address, and anything this checklist
did not expect.
