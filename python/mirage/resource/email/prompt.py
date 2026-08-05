# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

PROMPT = """\
{prefix}
  <folder>/
    <yyyy-mm-dd>/
      <subject>__<uid>.email.json
      <subject>__<uid>/           # if attachments exist
        <attachment-filename>
  Folders include: INBOX, Sent, Drafts, etc. cat shows email as JSON.

  <subject> is sanitized (don't construct it; ls the date dir).

  To act on mail (list/search/read/compose/reply/forward), use the
  himalaya CLI if installed: himalaya --help"""

WRITE_PROMPT = """\
  Sending mail goes through the himalaya CLI if installed:
    himalaya message compose --to "to@email.com" --subject "Hi" \\
      --body "..." --send"""
