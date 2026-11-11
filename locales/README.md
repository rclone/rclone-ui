# Translations

Rclone UI's text lives in this folder, one folder per language:

| File | What it holds | Format |
|---|---|---|
| `<language>/app.po` | The windows' text | PO, with [ICU messages](https://lingui.dev/guides/message-format) |
| `<language>/core.po` | Native dialogs, the tray, the launcher, notifications and errors | PO, with Go's `%s` and `%d` |
| `<language>/rclone.json` | rclone's own descriptions and option help | JSON, by backend and option name |
| `<language>/TERMS.md` | How the app's own words are translated, and the language's style | |
| `languages.json` | The languages that the app offers, each under its own name | |

The `en` folder is written from the code by `npm run i18n`: don't edit it. The `pseudo` folder is
a test language, also written by the tools.

Spanish (`es`) and Simplified Chinese (`zh-CN`) ship complete. Any other language may be partly
translated: the app shows English for what is missing.

## Fixing a translation

Find the English text in the language's `app.po` or `core.po`, change the `msgstr` under it, and
open a pull request. To see it in the app, run a dev build (`npm run dev` and `npm run dev:app`)
and choose the language in Settings.

## Adding a language

1. Copy the `en` folder to a folder named after the language's tag (`fr`, `pt-BR`, `ja`).
2. Add the language to `languages.json`, under the name its speakers use ("Français").
3. In both `.po` files, set `Language:` in the header. In `core.po`, also set `Plural-Forms:` to
   [the language's rule](https://www.gnu.org/software/gettext/manual/html_node/Plural-forms.html).
4. Copy a `TERMS.md` from another language and decide your terms before you translate. It keeps
   the whole app saying things the same way.
5. Fill in each `msgstr`. Run `npm run i18n` to bring the files in step with the code, and
   `go run ./build/i18n -check` to find mistakes.

## How a translation should read

Write it as if the app had been made in your language. It is not the English sentence with its
words swapped.

- Use the words that people use for apps today, in the tone of a good modern app: short,
  friendly and direct.
- Translate the meaning. Reorder, split or shorten a sentence when that is how your language
  would say it.
- Use the words that macOS and Windows themselves use in your language for common things
  (Settings, Cancel, Open, Delete).
- Check your translation in its window. An odd phrase or a clipped label shows there.

## What stays as it is

- Names: Rclone UI, rclone, WinFsp, and the names of storage services (Google Drive, S3).
- rclone's options and their values: `--dry-run`, `vfs_cache_mode`, `10M`, `1h30m`.
- Paths, remote names, URLs and anything in backticks.
- Placeholders. Keep every one of them, with the same name. You may move them.

## Placeholders

**In `app.po`:**

- `{name}` is a value. `Delete {name}?` may become `¿Eliminar {name}?`.
- `<0>…</0>` wraps text that is shown differently, such as bold or a link. Keep the tags around
  the words that they belong to.
- A count is written with its forms. English has two (`one` and `other`). Use the forms that your
  language has, and `#` for the number:

  ```
  msgid "{count, plural, one {# file} other {# files}}"
  msgstr "{count, plural, one {# archivo} other {# archivos}}"
  ```

  Chinese has one form: `{count, plural, other {# 个文件}}`.
- In the Guides, `**bold**` marks a label that the app shows. Use the same words as that label's
  own translation, so that the guide matches the window.

**In `core.po`:**

- `%s` and `%d` are values, in the order of the English message. To put them in another order,
  number them: `%[2]s … %[1]s`.
- `%%` is a percent sign.
- A count has `msgid_plural`, and one `msgstr[n]` for each form of your language.

## Notes for translators

A line that starts with `#.` above a message is a note from the code: it says where the text
appears, or what an unclear word means. A message with `msgctxt` is used with one particular
meaning, which the context names.
