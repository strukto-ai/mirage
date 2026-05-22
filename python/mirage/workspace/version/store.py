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

import asyncio
from pathlib import Path

from dulwich.objects import Blob
from dulwich.repo import Repo


def _open_repo(path: Path) -> Repo:
    if (path / "objects").is_dir():
        return Repo(str(path))
    path.mkdir(parents=True, exist_ok=True)
    return Repo.init_bare(str(path))


def _add_blob(repo: Repo, data: bytes) -> bytes:
    blob = Blob.from_string(data)
    repo.object_store.add_object(blob)
    return blob.id


def _read_blob(repo: Repo, oid: bytes) -> bytes:
    return repo.object_store[oid].as_raw_string()


class VersionStore:

    def __init__(self, repo: Repo, path: Path) -> None:
        self._repo = repo
        self._path = path

    @classmethod
    async def open(cls, path: str | Path) -> "VersionStore":
        p = Path(path)
        repo = await asyncio.to_thread(_open_repo, p)
        return cls(repo, p)

    async def write_blob(self, data: bytes) -> bytes:
        return await asyncio.to_thread(_add_blob, self._repo, data)

    async def read_blob(self, oid: bytes) -> bytes:
        return await asyncio.to_thread(_read_blob, self._repo, oid)
