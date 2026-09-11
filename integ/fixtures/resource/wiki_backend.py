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
# (`resource: ./wiki_backend.py:WikiResource`). Two classes over one
# page store, one per half of the versioning design: WikiResource owns
# its pages and carries them in its state, so a snapshot rebuilds the
# mount through the recorded reference with the pages as they were;
# FeedResource keeps the default state, so a load has to be handed the
# live resource and refuses otherwise. The TypeScript twins beside this
# file must behave identically, because the point of the ref form is
# that one deployment runs on both hosts.

import hashlib
from copy import deepcopy
from functools import partial

from mirage import (NULL_INDEX, Accessor, CommandIO, ContentType, FileStat,
                    FileType, GenericResource, IndexCacheStore, PathSpec,
                    stream_from_bytes)

PAGES = {"notes.md": "agents just speak bash\n"}
FEED = {"status.md": "All systems go.\n"}


class PageAccessor(Accessor):

    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages


def _key(path: PathSpec) -> str:
    return path.resource_path.strip("/")


async def readdir(accessor: PageAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    if _key(path):
        raise NotADirectoryError(path.virtual)
    parent = path.virtual.rstrip("/")
    return [f"{parent}/{name}" for name in sorted(accessor.pages)]


async def read_bytes(accessor: PageAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> bytes:
    key = _key(path)
    if not key:
        raise IsADirectoryError(path.virtual)
    if key not in accessor.pages:
        raise FileNotFoundError(path.virtual)
    return accessor.pages[key].encode()


async def stat(accessor: PageAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    key = _key(path)
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if not key:
        return FileStat(name=name, size=None, type=FileType.DIRECTORY)
    if key not in accessor.pages:
        raise FileNotFoundError(path.virtual)
    data = accessor.pages[key].encode()
    return FileStat(name=name,
                    size=len(data),
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    fingerprint=hashlib.sha256(data).hexdigest()[:16])


async def write(accessor: PageAccessor, path: PathSpec, data: bytes) -> None:
    key = _key(path)
    if not key or "/" in key:
        raise NotADirectoryError(path.virtual)
    accessor.pages[key] = data.decode()


def make_io() -> CommandIO:
    return CommandIO(readdir=readdir,
                     read_bytes=read_bytes,
                     read_stream=partial(stream_from_bytes, read_bytes),
                     stat=stat,
                     write=write,
                     is_mounted=lambda a: True,
                     local=False)


class WikiResource(GenericResource):
    """Owned content: the pages ride the state and rebuild without help."""

    def __init__(self, pages: dict[str, str] | None = None) -> None:
        self.store = PageAccessor(deepcopy(PAGES if pages is None else pages))
        super().__init__(name="wiki",
                         accessor=self.store,
                         io=make_io(),
                         supports_snapshot=True)

    def get_state(self) -> dict:
        return {"type": self.name, "pages": deepcopy(self.store.pages)}

    def load_state(self, state: dict) -> None:
        self.store.pages = deepcopy(state.get("pages", {}))


class FeedResource(GenericResource):
    """Observed content: the default state asks to be handed back live."""

    def __init__(self) -> None:
        super().__init__(name="feed",
                         accessor=PageAccessor(FEED),
                         io=make_io(),
                         supports_snapshot=True)
