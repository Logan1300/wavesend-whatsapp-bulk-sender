# WaveSend 🌊

**Safety-first bulk messaging for WhatsApp Web, as a Chrome extension.**

WaveSend sends personalised WhatsApp messages (with attachments) to a list of contacts through your own logged-in WhatsApp Web session. You don't need to save the numbers first. It paces itself like a person would, watches for warning signs, and stops on its own before your number gets into trouble.

> **Current version:** 2.1.1 (November 2026) · Manifest V3 · Chrome
> **Status:** Private project. Not published on the Chrome Web Store.

---

## ✨ Features

### Sending
- **Import contacts** from Excel/CSV, a Google Sheets link, or by pasting a list. Numbers don't need to be saved in your phone.
- **Personalisation variables** like `{{name}}`, with fallbacks for empty cells, an automatic `{{greeting}}` (Good morning / afternoon / evening), and **spintax** (`{Hi|Hello|Hey}`) so no two messages are identical.
- **Attachments:** up to 10 files per message, a caption for each file, plus contact cards.
- **Up to 5 message variations** for each campaign, with formatting, emoji and a live phone preview.
- **Test send**, plus pause, resume and stop at any time.
- **Templates** and ⚡ **quick replies** inside WhatsApp Web.
- **Scheduling:** send later, or repeat daily, weekly or monthly.
- **Recipients' local time:** messages go out at a sensible hour where each recipient lives.

### Safety
- **Presets:** Ultra-safe, Balanced and Fast, plus hourly and daily limits and set sending hours.
- **Human-like behaviour:** bell-curve random delays, random batch sizes and breaks, a shuffled send order, and real typing so the recipient sees "typing…".
- **Warm-up mode** for new numbers: 20 messages a day, rising to 150 a day over 30 days.
- **Safety health score** with one-click fixes, plus a **spam-risk checker** for your message text.
- **Auto-pause** on a ban warning, a streak of failures, or a high rate of invalid numbers.
- **Number filter:** "Only check numbers" mode tests which numbers are on WhatsApp, and invalid ones are remembered.
- **Unsubscribe handling:** adds an opt-out line and auto-detects STOP replies (English and Hindi).
- **Wrong-chat protection:** if WhatsApp shows a popup instead of the chat, nothing is sent. The previously open chat is never used.
- **Privacy blur** for working in public.

### After sending
- **Reports:** CSV export, and **auto-resume** after a browser restart.
- **Reply analysis:** read/delivered status, reply rate, and replies sorted into interested / not interested / unsubscribed.
- **Follow-ups** to any reply segment.
- **A/B results** for each message variation.
- **Auto-reply bot** with keyword rules (no AI).
- **Contact export** from group members and unsaved numbers in the chat list.

### Tools
- **Preview-all dry run** shows every personalised message before anything is sent.
- **Backup / restore** of all settings, templates and lists.
- **Diagnose** checks the live WhatsApp Web page and runs a safe attachment rehearsal.

---

## 🚀 Installation (developer mode)

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `wavesend` folder (the one that contains `manifest.json`).
5. Pin WaveSend from the puzzle-piece menu.
6. Open [web.whatsapp.com](https://web.whatsapp.com) and scan the QR code once.

**While sending,** keep the WhatsApp Web tab open (its own window is fine) and the computer awake. Everything runs in your browser: no servers, no accounts, no fees.

### Updating
1. Replace the files (or run `git pull`).
2. On `chrome://extensions`, click the ↻ reload icon on the WaveSend card.
3. Reload the WhatsApp Web tab.

---

## 🛠️ How it works

```
wavesend/
├── manifest.json        Extension settings, version number, permissions
├── background.js        Service worker: runs the send queue, scheduling, limits
├── content.js           Runs inside WhatsApp Web: opens chats, types, sends, reads replies
├── main.js              Runs in the page's MAIN world: handles the file picker for attachments
├── popup.html / .js     The small window from the toolbar icon
├── dashboard.html/.js/.css   The full WaveSend dashboard (campaigns, settings, reports)
├── lib/core.js          Shared logic: variables, spintax, delays, safety checks
├── lib/xlsx.js          Reads Excel files
├── sample_contacts.csv  Example contact list (made-up numbers)
└── icons/               Extension icons
```

| Part | What it does |
|---|---|
| **`background.js`** (service worker) | Runs the send queue. State is kept in `chrome.storage`, with `chrome.alarms` as a backup so the queue survives restarts. |
| **`content.js`** | Runs inside WhatsApp Web. It opens chats, types messages, clicks buttons and reads replies. **All DOM selectors are in the `SEL` object at the top of the file.** |
| **`main.js`** | Runs in the page's MAIN world. It intercepts WhatsApp's file picker so attachments can be added. |

**Opening a chat:** WaveSend clicks a `whatsapp://send?phone=…` link inside the already-loaded WhatsApp Web, so the page doesn't reload. After 3 failures it falls back to `web.whatsapp.com/send?phone=…`, which does reload. You can change this under *Settings › How to open each chat*.

**Attachments:** the content script arms `main.js` and waits for an "armed" reply. It then opens **Attach**, clicks **Photos & videos** or **Document**, and clicks the preview's **Send N selected** button. If that fails it tries the file input, then paste. A preview that fails is cancelled, never sent.

**Reading messages:** WaveSend uses the `data-id` prefix (`true_` = sent, `false_` = received) and the aria-label receipts ("Read", "Delivered", "Sent", "Pending"). The old `.message-in` / `.message-out` classes are only a fallback.

### When WhatsApp changes its layout
WhatsApp Web updates often. If something stops working:
1. Run **Diagnose** in WaveSend and save the report.
2. Compare it with the selectors in `SEL` at the top of `content.js`.
3. Update the selectors, bump the version in `manifest.json`, and add a line to `CHANGELOG.md`.

Last checked against **WhatsApp Web 2.3000.1053942533**, Chrome 156, English UI.

---

## ⚠️ Responsible use

Use WaveSend only for contacts who expect to hear from you, such as existing customers, members or people who opted in. Sending unsolicited bulk messages breaks WhatsApp's Terms of Service and can get your number **banned**. The safety features lower that risk but cannot remove it. Most bans come from people blocking or reporting you, so message people who know you and keep the health score green. For large marketing volumes, use the official WhatsApp Business Platform. WaveSend is not affiliated with WhatsApp or Meta.

**Never commit contact lists, reports or backups to this repository.** They contain other people's phone numbers. The `.gitignore` blocks the common file types, but check `git status` before each commit.

---

## 📁 Repository notes

- `CHANGELOG.md`: version history and bug fixes.
- `docs/GIT-WORKFLOW.md`: everyday Git commands for this project.

## 📄 License

© 2026. All rights reserved. This is a private project. Please don't copy or redistribute it without permission.
