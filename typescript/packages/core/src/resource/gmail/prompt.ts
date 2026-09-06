// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export const GMAIL_PROMPT = `{prefix}
  <label>/
    <yyyy-mm-dd>/
      <subject>__<message-id>.gmail.json    # email JSON file (the email itself)
      <subject>__<message-id>/              # attachments dir, only if any
        <attachment-filename>

  Email body is in the .gmail.json file. The sibling dir holds attachments
  only. Read with \`cat\`/\`head\`/\`jq\` on \`<path>.gmail.json\` (keep the suffix).

  Commands: cat, ls, head, tail, nl, wc, stat, find, tree, grep, rg, jq,
  basename, dirname, realpath. No others (no readFile, etc.).

  Path: <label>/<yyyy-mm-dd>/<subject>__<message-id>.gmail.json
    <label>       Gmail label (INBOX, SENT, DRAFT, IMPORTANT, STARRED,
                  TRASH, SPAM, or any user label)
    <yyyy-mm-dd>  date the message was received, used for date narrowing
                  (ls {prefix}/INBOX/2026-05-03/ pushes after:/before: into the
                  Gmail query - much cheaper than scanning the whole label)
    <subject>     sanitized subject (don't construct it; ls the date dir)
    <message-id>  Gmail message ID

  email JSON structure (mirage-processed, NOT the raw Gmail API response):
    {
      "id": "...",
      "thread_id": "...",
      "from":    { "name": "...", "email": "..." },
      "to":      [ { "name": "...", "email": "..." } ],
      "cc":      [ ... ],
      "subject": "...",
      "date":    "Mon, 3 May 2026 10:00:00 -0700",
      "body_text": "decoded plain-text body",
      "snippet":   "first ~200 chars from Gmail",
      "labels":  [ "INBOX", "IMPORTANT", ... ],
      "attachments": [
        { "id": "...", "filename": "invoice.pdf",
          "mime_type": "application/pdf", "size": 12345 }
      ]
    }

  Attachments: each message with attachments has a sibling directory at
  <subject>__<message-id>/ (same name as the .gmail.json file but without
  the extension). Cat a file inside to download bytes. grep -r over a
  date dir skips these binary files automatically.

  After a grep/rg hit, the result line points to .../<subject>__<id>.gmail.json
  — the sibling attachments dir is NOT in grep output. Once you have the
  message id (or the .gmail.json path), ls the same path with .gmail.json
  stripped to list attachments directly:
    ls {prefix}/INBOX/2026-05-03/<subject>__<message-id>/
  ENOENT means the message has no attachments.

  Useful jq paths:
    .subject
    .from.email
    .body_text
    .labels[]
    .attachments[] | .filename

  For message actions (read by id, triage, raw API calls), consult
  Installed CLIs when listed and choose the intended Google account.`

export const GMAIL_WRITE_PROMPT = `  Service writes require a CLI for the intended account. When listed, consult
  Installed CLIs for its name and guide; a mount does not select a CLI account.

  Body gotcha: bash double-quoted "...\\n..." is NOT a newline.
  Use $'line1\\nline2' (ANSI-C quoting) or "$(printf '...\\n...')"
  if you need real newlines in the body.

  Delete:
    rm {prefix}/<label>/<yyyy-mm-dd>/<subject>__<message-id>.gmail.json
                                            # moves the message to Trash
    rm -f <path>                            # ignore if missing
    Only operates on .gmail.json files; label/, date/, and the
    attachments folder cannot be removed (they are virtual).`
