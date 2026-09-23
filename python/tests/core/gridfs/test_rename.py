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

import re
from typing import Any

import pytest

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.cache.context import push_cache_manager
from mirage.core.gridfs import driver as gridfs_driver
from mirage.core.gridfs.rename import rename
from mirage.types import PathSpec


class _FakeManager:

    async def invalidate_after_write(self, path: PathSpec) -> None:
        return None

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        return None

    async def invalidate_subtree(self, path: PathSpec) -> None:
        return None


class _FakeFiles:

    def __init__(self, docs: dict[str, str]) -> None:
        self.docs = docs

    def _match(self, query: dict[str, Any]) -> list[str]:
        spec = query.get("filename")
        if isinstance(spec, dict):
            pattern = re.compile(spec["$regex"])
            return [i for i, name in self.docs.items() if pattern.match(name)]
        if spec is None:
            return list(self.docs)
        return [i for i, name in self.docs.items() if name == spec]

    async def _iter(self, ids: list[str]) -> Any:
        for doc_id in ids:
            yield {"_id": doc_id, "filename": self.docs[doc_id]}

    def find(self, query: dict[str, Any], projection: Any = None) -> Any:
        return self._iter(self._match(query))

    async def update_one(self, query: dict[str, Any],
                         update: dict[str, Any]) -> None:
        self.docs[query["_id"]] = update["$set"]["filename"]

    async def update_many(self, query: dict[str, Any],
                          update: dict[str, Any]) -> None:
        for doc_id in self._match(query):
            self.docs[doc_id] = update["$set"]["filename"]


def _accessor() -> GridFSAccessor:
    return GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db"))


def _spec(key: str) -> PathSpec:
    return PathSpec(vfs_path=key, virtual=f"/mnt/{key}", directory="/mnt")


def _install(monkeypatch, files: _FakeFiles) -> None:
    globs = vars(gridfs_driver)
    monkeypatch.setitem(globs, "files_coll", lambda accessor: files)
    monkeypatch.setitem(globs, "latest_file", _latest_of(files))
    monkeypatch.setitem(globs, "delete_all", _delete_of(files))


def _latest_of(files: _FakeFiles):

    async def latest_file(accessor: GridFSAccessor,
                          key: str) -> dict[str, Any] | None:
        for doc_id, name in files.docs.items():
            if name == key:
                return {"_id": doc_id, "filename": name}
        return None

    return latest_file


def _delete_of(files: _FakeFiles):

    async def delete_all(accessor: GridFSAccessor, query: dict[str,
                                                               Any]) -> None:
        for doc_id in files._match(query):
            files.docs.pop(doc_id, None)

    return delete_all


@pytest.mark.asyncio
async def test_rename_moves_a_whole_directory_prefix(monkeypatch):
    """A directory owns no revision, so the prefix retag has to carry it.

    Before this, a directory operand fell straight through to ENOENT and
    ``mv`` reported "No such file or directory" for a directory that
    ``ls`` had just listed.
    """
    files = _FakeFiles({
        "1": "d/",
        "2": "d/f.txt",
        "3": "d/sub/g.txt",
        "4": "keep.txt",
    })
    _install(monkeypatch, files)
    prev = push_cache_manager(_FakeManager())
    try:
        await rename(_accessor(), _spec("d"), _spec("e"))
    finally:
        push_cache_manager(prev)
    assert files.docs == {
        "1": "e/",
        "2": "e/f.txt",
        "3": "e/sub/g.txt",
        "4": "keep.txt",
    }


@pytest.mark.asyncio
async def test_rename_directory_replaces_an_empty_destination(monkeypatch):
    files = _FakeFiles({"1": "src/", "2": "src/f.txt", "3": "dst/"})
    _install(monkeypatch, files)
    prev = push_cache_manager(_FakeManager())
    try:
        await rename(_accessor(), _spec("src"), _spec("dst"))
    finally:
        push_cache_manager(prev)
    assert sorted(files.docs.values()) == ["dst/", "dst/f.txt"]


@pytest.mark.asyncio
async def test_rename_keeps_moving_a_plain_file(monkeypatch):
    files = _FakeFiles({"1": "a.txt"})
    _install(monkeypatch, files)
    prev = push_cache_manager(_FakeManager())
    try:
        await rename(_accessor(), _spec("a.txt"), _spec("b.txt"))
    finally:
        push_cache_manager(prev)
    assert files.docs == {"1": "b.txt"}


@pytest.mark.asyncio
async def test_rename_missing_source_raises_enoent(monkeypatch):
    files = _FakeFiles({"1": "other.txt"})
    _install(monkeypatch, files)
    prev = push_cache_manager(_FakeManager())
    try:
        with pytest.raises(FileNotFoundError):
            await rename(_accessor(), _spec("ghost"), _spec("e"))
    finally:
        push_cache_manager(prev)
    assert files.docs == {"1": "other.txt"}
