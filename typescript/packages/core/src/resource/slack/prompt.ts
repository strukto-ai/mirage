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

export const SLACK_PROMPT = `{prefix}
  channels/
    <channel-name>__<channel-id>/
      <yyyy-mm-dd>/
        chat.jsonl                # messages for that date
        files/                    # attachments shared that day (may be empty)
          <name>__<F-id>.<ext>    # cat to download bytes
  dms/
    <user-name>__<dm-id>/
      <yyyy-mm-dd>/
        chat.jsonl
        files/
          <name>__<F-id>.<ext>
  users/
    <username>__<user-id>.json    # user profile
  Naming: channel/DM/user directory names are \`<display-name>__<id>\`.
  The display name keeps the original spelling from Slack; only \`/\` is
  replaced with \`∕\` (U+2215) so paths don't break. Quote names
  containing spaces in shell commands. Always ls the parent dir first
  to discover exact entry names (they include IDs).
  Messages are JSONL; use jq to extract fields like .text, .user, .ts, .files.
  rg over files/ uses Slack's server-side file content search; works on
  PDFs, Word docs, code snippets that Slack has indexed.`

export const SLACK_WRITE_PROMPT = `  Write commands:
    slack-post-message <channel-path> "message"
    slack-reply-to-thread <message-path> "reply"`
