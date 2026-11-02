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

from typing import Any

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.events import build_delta_hook
from mirage.core.gmail.read import read as _read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.search import files_containing as _files_containing
from mirage.core.gmail.stat import stat as _stat
from mirage.core.google.client import TokenManager
from mirage.events.base import DeltaHook
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.gmail.config import GmailConfig

VFS_MD = """\
```text
{prefix}
  <label>/
    <yyyy-mm-dd>/
      <subject>__<message-id>.gmail.json   # the email, body included
      <subject>__<message-id>/             # its attachments, if any
        <attachment-filename>
```

- `<label>` is a Gmail label: `INBOX`, `SENT`, `DRAFT`, `IMPORTANT`,
  `STARRED`, `TRASH`, `SPAM` or any user label.
- `<yyyy-mm-dd>` is the date the message was received. Listing one
  (`ls {prefix}/INBOX/2026-05-03/`) pushes `after:`/`before:` into the
  Gmail query, much cheaper than scanning the whole label.
- `<subject>` is sanitized: `ls` the date directory rather than
  construct it. `<message-id>` is the Gmail message id.
- The email body is in the `.gmail.json` file; read it with `cat`,
  `head` or `jq`, keeping the suffix. The sibling directory, the same
  name without the extension, holds attachments only: `cat` one to
  download its bytes. `grep -r` over a date directory skips these binary
  files.
- A `grep` or `rg` hit names the `.gmail.json` file, not the attachments
  directory. To list a message's attachments, `ls` its path with
  `.gmail.json` stripped; `ENOENT` means it has none:
  `ls {prefix}/INBOX/2026-05-03/<subject>__<message-id>/`

A `.gmail.json` is processed by Mirage, not the raw Gmail API response:

```jsonc
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
```

Useful `jq` paths:

```jq
.subject
.from.email
.body_text
.labels[]
.attachments[] | .filename
```

To act on messages (read by id, triage, raw API calls), use the `gws`
CLI if installed (`gws gmail --help`)."""


class GmailVFS(BaseVFS):
    accessor: GmailAccessor
    name: str = VFSName.GMAIL
    caches_reads: bool = True
    # Every listed file carries an exact size: .gmail.json is rendered at
    # readdir from the full message the listing already fetched, and
    # attachments carry the decoded byte count.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    vfs_md: str = VFS_MD
    # The listing keeps each message's text; an attachment is read as usual.
    searchable = ("*/*/*.gmail.json",)

    def __init__(self, config: GmailConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GmailAccessor(
            self.config, TokenManager(config), lambda: self.walk_limit >= 0
        )

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> bytes:
        return await _read(self.accessor, path, entry)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        return await _stat(self.accessor, path, entry, parent)

    def supports(self, name: str) -> bool:
        """Whether this VFS answers ``name``; with no walk limit it reads
        every file rather than ask the service's search.

        Args:
            name (str): the function name.
        """
        if name == "files_containing" and self.walk_limit < 0:
            return False
        return super().supports(name)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
