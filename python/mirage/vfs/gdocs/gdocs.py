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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.constants import MIME
from mirage.core.gdocs.read import read as _read
from mirage.core.gdocs.readdir import readdir as _readdir
from mirage.core.gdocs.rename import rename as _rename
from mirage.core.gdocs.stat import stat as _stat
from mirage.core.gdocs.unlink import unlink as _unlink
from mirage.core.google.client import TokenManager
from mirage.core.google.events import app_delta_hook
from mirage.core.google.search import files_containing as _files_containing
from mirage.events.base import DeltaHook
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.generated.google_vocabulary import DOCS_WORDS
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gdocs.config import GDocsConfig
from mirage.vfs.gdocs.doc_entry import make_filename

VFS_MD = """\
{prefix}
  owned/
    <date>_<title>__<doc-id>.gdoc.json
  shared/
    <date>_<title>__<doc-id>.gdoc.json

  Filename: <YYYY-MM-DD>_<title>__<doc-id>.gdoc.json
    <YYYY-MM-DD>  modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>       sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <doc-id>      Google Docs document ID

  Buckets:
    owned/   docs you created
    shared/  docs shared with you by others
             - does NOT include docs you own and shared with others;
               those are still in owned/.

  gdoc.json structure (the Google Docs API documents.get response, read
  with includeTabsContent=true so every tab is present):
    {
      "documentId": "...",
      "title": "...",
      "tabs": [                          # one entry per top-level tab
        {
          "tabProperties": {
            "tabId": "t.0",              # names a tab for gws docs write
            "title": "Tab 1",
            "index": 0
          },
          "documentTab": {
            "body": {
              "content": [
                {                          # one element per block
                  "paragraph": {
                    "elements": [
                      { "textRun": { "content": "the actual text\\n",
                                     "textStyle": {...} } }
                    ],
                    "paragraphStyle": {...}
                  }
                },
                { "table": {...} },
                { "sectionBreak": {...} }
              ]
            },
            "documentStyle": {...},
            "namedStyles": {...}
          },
          "childTabs": [ { ...same shape, nested to any depth... } ]
                                       # a NESTED tab additionally carries
                                       # parentTabId and nestingLevel; a
                                       # root tab carries neither
        }
      ],
      "revisionId": "..."
    }

  There is no top-level .body. A tab-aware response leaves the singleton
  fields (.body, .documentStyle, .namedStyles) empty and hangs every
  tab's content off .tabs[].documentTab instead. Tabs also nest, so text
  can sit at any depth under .childTabs; the recursive recipes below read
  a one-tab and a fifty-tab document alike.

  Useful jq paths:
    .title
    [.. | .tabProperties? // empty | .title]             # every tab name
    [.. | .textRun? // empty | .content] | add           # all text, any depth
    [.. | .tabProperties? // empty] | length             # tab count
    [.tabs[0].documentTab.body.content[]
      | .paragraph?.elements[]?.textRun.content] | add   # first tab only
    .revisionId

  The first block of a body is always a sectionBreak, which carries no
  .paragraph, so a path through .paragraph needs the `?` or it fails with
  "Cannot iterate over null".

  Delete, on a `write` path:
    rm {prefix}/owned/<file>.gdoc.json      # permanent delete from Drive
    rm -f <path>                            # ignore if missing
    Only operates on .gdoc.json files; owned/ and shared/ themselves
    cannot be removed.

  Rename to a new title, on a `write` path:
    mv {prefix}/owned/<date>_<old>__<id>.gdoc.json \\
       {prefix}/owned/<date>_<new>__<id>.gdoc.json
    Keep the folder, the date and the id, and spell the title the way
    the listing does (spaces->_); any other name is refused."""


class GDocsVFS(BaseVFS):
    accessor: GDocsAccessor
    name: str = VFSName.GDOCS
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
    renderers: Mapping[str, str] = MappingProxyType({".gdoc.json": "read_doc"})

    def __init__(self, config: GDocsConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = GDocsAccessor(self.config, TokenManager(config))

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read_doc(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        """Render a document as the JSON its ``.gdoc.json`` file holds.

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
            self.accessor, _readdir, MIME, DOCS_WORDS, text, [path]
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
