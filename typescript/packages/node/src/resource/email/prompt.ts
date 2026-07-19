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

export const EMAIL_PROMPT = `{prefix}
  <folder>/
    <yyyy-mm-dd>/
      <subject>__<uid>.email.json
      <subject>__<uid>/           # if attachments exist
        <attachment-filename>
  Folders include: INBOX, Sent, Drafts, etc. cat shows email as JSON.

  Read commands:
    himalaya envelope list --folder INBOX --unseen        # id/from/subject/date
    himalaya message read --folder INBOX --uid <uid>     # one message as JSON`

export const EMAIL_WRITE_PROMPT = `  Write commands:
    himalaya message send --to "to@email.com" --subject "Hi" --body "..."
    himalaya message reply --folder INBOX --uid <uid> --body "..." [--all]
    himalaya message forward --folder INBOX --uid <uid> --to "to@email.com"`
