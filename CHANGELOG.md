# Changelog

All notable changes to WaveSend are listed here, newest first.
When you change something, bump `"version"` in `manifest.json` and add an entry below.

Format: **Added** (new features) · **Changed** · **Fixed** (bugs)

---

## [2.1.1] – November 2026

### Fixed
- The media preview send button now reads **"Send 1 selected"** (not "Send"). Detection updated so attachments send again.
- The `.message-in` / `.message-out` classes are gone from WhatsApp Web. Messages are now read from the **`data-id` prefix** (`true_` sent / `false_` received). This brings back **STOP detection, reply tracking and auto-reply**.
- Footer buttons are now found by **aria-label** ("Attach", "Emojis, GIFs, Stickers", "Voice message") because the `data-icon` attributes were removed.

### Added
- **Diagnose** now runs a safe **attachment rehearsal** that never sends anything.

### Testing
- 28/28 end-to-end checks pass against a simulation of WhatsApp Web 2.3000.1053942533, along with the old-layout regression suite and unit tests.
- Waiting for a live retest on real WhatsApp Web.

---

## [2.1] – November 2026

### Changed
- **No page reload for each message.** Chats open in place with a `whatsapp://send` link, falling back to a reload after 3 failures.
- Faster typing and shorter waits.
- Attachments now go through the real **Attach → Photos & videos / Document** menu.

### Fixed
- **Wrong-chat risk:** if a popup appeared after an in-place open, the previous chat could get the message. Now nothing is sent.
- A race condition in the attachment helper.

---

## [2.0 and earlier]
- Not recorded in Git. History starts at 2.1.1.
