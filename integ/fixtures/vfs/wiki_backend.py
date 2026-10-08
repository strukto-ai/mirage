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

# A backend a deployment ships as a file and names from yaml
# (`vfs: ./wiki_backend.py:WikiVFS`). Two classes over one
# page store, one per half of the versioning design: WikiVFS owns
# its pages and carries them in its state, so a snapshot rebuilds the
# mount through the recorded reference with the pages as they were;
# FeedVFS keeps the default state, so a load has to be handed the
# live VFS and refuses otherwise. The TypeScript twins beside this
# file must behave identically, because the point of the ref form is
# that one deployment runs on both hosts.

import hashlib
from copy import deepcopy

from mirage import (NULL_INDEX, Accessor, BaseVFS, ContentType, FileStat,
                    FileType, IndexCacheStore, PathSpec)

PAGES = {"notes.md": "agents just speak bash\n"}
FEED = {"status.md": "All systems go.\n"}


class PageAccessor(Accessor):

    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages


def _key(path: PathSpec) -> str:
    return path.vfs_path.strip("/")


class PagesVFS(BaseVFS):
    """One flat page store: readdir, read and stat, and write."""

    accessor: PageAccessor

    async def readdir(self,
                      path: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> list[str]:
        if _key(path):
            raise NotADirectoryError(path.virtual)
        parent = path.virtual.rstrip("/")
        return [f"{parent}/{name}" for name in sorted(self.accessor.pages)]

    async def read(self,
                   path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX,
                   offset: int = 0,
                   size: int | None = None) -> bytes:
        key = _key(path)
        if not key:
            raise IsADirectoryError(path.virtual)
        if key not in self.accessor.pages:
            raise FileNotFoundError(path.virtual)
        return self.accessor.pages[key].encode()

    async def stat(self,
                   path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> FileStat:
        key = _key(path)
        name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
        if not key:
            return FileStat(name=name, size=None, type=FileType.DIRECTORY)
        if key not in self.accessor.pages:
            raise FileNotFoundError(path.virtual)
        data = self.accessor.pages[key].encode()
        return FileStat(name=name,
                        size=len(data),
                        type=FileType.FILE,
                        content=ContentType.TEXT,
                        fingerprint=hashlib.sha256(data).hexdigest()[:16])

    async def write(self, path: PathSpec, data: bytes) -> None:
        key = _key(path)
        if not key or "/" in key:
            raise NotADirectoryError(path.virtual)
        self.accessor.pages[key] = data.decode()


class WikiVFS(PagesVFS):
    """Owned content: the pages ride the state and rebuild without help."""

    def __init__(self, pages: dict[str, str] | None = None) -> None:
        self.store = PageAccessor(deepcopy(PAGES if pages is None else pages))
        super().__init__(name="wiki",
                         accessor=self.store,
                         supports_snapshot=True)

    def get_state(self) -> dict:
        return {"type": self.name, "pages": deepcopy(self.store.pages)}

    def load_state(self, state: dict) -> None:
        self.store.pages = deepcopy(state.get("pages", {}))


class FeedVFS(PagesVFS):
    """Observed content: the default state asks to be handed back live."""

    def __init__(self) -> None:
        super().__init__(name="feed",
                         accessor=PageAccessor(FEED),
                         supports_snapshot=True)
