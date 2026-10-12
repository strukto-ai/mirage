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

export const PROMPT = `{prefix}
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
  Without time bounds, bare channel listings show the latest 90 days
  ending at the newest message. Date globs can discover earlier days.
  With start_time/end_time, listings cover that scope; messages and their
  attachments outside it are absent, including through direct paths.
  Users and channel metadata remain available as context.
  On a time-scoped mount grep and rg see only the in-scope files.
  Messages are JSONL; use jq to extract fields like .text, .user, .ts, .files.
  .user is a user ID (U…), not a username; resolve it through
  users/<username>__<user-id>.json and filter messages by the ID.
  With content_search on, grep -rw and rg -w read only the channel and
  DM days Slack search names; attachments under files/ are always read.`

export const WRITE_PROMPT = `  Writes go through the slack CLI if installed:
    slack send-message --channel <channel-id> --text "message"
    slack send-message --channel <channel-id> --thread-ts <ts> --text "reply"
  See slack --help for every verb (react, pins, member-info, search).`
