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

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.events import app_delta_hook
from mirage.core.google.search import files_containing as _files_containing
from mirage.core.gsheets.constants import MIME
from mirage.core.gsheets.read import read as _read
from mirage.core.gsheets.readdir import readdir as _readdir
from mirage.core.gsheets.rename import rename as _rename
from mirage.core.gsheets.stat import stat as _stat
from mirage.core.gsheets.unlink import unlink as _unlink
from mirage.events.base import DeltaHook
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.generated.google_vocabulary import SHEETS_WORDS
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gsheets.config import GSheetsConfig
from mirage.vfs.gsheets.sheet_entry import make_filename

VFS_MD = """\
```text
{prefix}
  owned/     # sheets you created
    <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
  shared/    # sheets others shared with you
    <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
```

- `<YYYY-MM-DD>` is the file's `modifiedTime`, so a date glob such as
  `2026-05-*` narrows by it.
- `<title>` is sanitized: spaces and any character outside
  `[A-Za-z0-9_.-]` become `_`, at most 100 characters.
- `<spreadsheet-id>` is the Google Sheets spreadsheet id.
- `shared/` holds sheets shared with you by others; ones you own
  and shared with others are still in `owned/`.

A `.gsheet.json` matches the Google Sheets API `spreadsheets.get`
response:

```jsonc
{
  "spreadsheetId": "...",
  "spreadsheetUrl": "...",
  "properties": { "title": "...", "locale": "...", "timeZone": "..." },
  "sheets": [
    {                                      // one element per tab
      "properties": {
        "sheetId": 0, "title": "...", "index": 0,
        "gridProperties": { "rowCount": 1000, "columnCount": 26 }
      },
      "data": [
        {
          "rowData": [
            { "values": [
                { "formattedValue": "...",
                  "userEnteredValue": {...},
                  "effectiveValue": {...} }
            ]}    // an empty cell is {}, a trailing one absent
          ]
        }
      ]
    }
  ],
  "namedRanges": [...]
}
```

Useful `jq` paths:

```jq
.properties.title
.sheets[].properties.title                              # tab names
.sheets[0].data[0].rowData[].values[].formattedValue    # cell strings
.namedRanges[]
```

Delete, on a `write` path:

```sh
rm {prefix}/owned/<file>.gsheet.json   # deletes it from Drive for good
rm -f <path>                       # ignores a missing file
```

Only `.gsheet.json` files can be removed; `owned/` and `shared/` cannot.

Rename to a new title, on a `write` path:

```sh
mv {prefix}/owned/<date>_<old>__<id>.gsheet.json \\
   {prefix}/owned/<date>_<new>__<id>.gsheet.json
```

Keep the folder, the date and the id, and spell the title the way the
listing does (spaces become `_`); any other name is refused."""


class GSheetsVFS(BaseVFS):
    accessor: GSheetsAccessor
    name: str = VFSName.GSHEETS
    caches_reads: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    # Reads stamp listing metadata; a fresh stat checks Drive by file ID.
    read_revalidatable: bool = True
    vfs_md: str = VFS_MD
    whole_word_search: bool = True

    # Every file here is a rendering; there are no stored bytes to read.
    renderers: Mapping[str, str] = MappingProxyType(
        {".gsheet.json": "read_sheet"}
    )

    def __init__(self, config: GSheetsConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GSheetsAccessor(self.config, TokenManager(config))

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read_sheet(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        """Render a spreadsheet as the JSON its ``.gsheet.json`` file holds.

        Args:
            path (PathSpec): the file.
            offset (int): the window's first byte.
            size (int | None): the window's length, None through the end.
        """
        data = await _read(self.accessor, path)
        return slice_window(data, offset, size)

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
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(
            self.accessor, _readdir, MIME, SHEETS_WORDS, text, [path]
        )

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        await _unlink(self.accessor, path, entry)

    async def rename(
        self,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
    ) -> None:
        await _rename(self.accessor, src, dst, entry)

    def delta_hook(self) -> DeltaHook:
        return app_delta_hook(self.accessor, MIME, make_filename)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
