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
import stat
import time

from dulwich.diff_tree import (CHANGE_ADD, CHANGE_DELETE, CHANGE_MODIFY,
                               tree_changes)
from dulwich.objects import Blob, Commit, ObjectID, Tree
from dulwich.refs import Ref
from dulwich.repo import Repo

from mirage.server.version.backend import VersionBackend
from mirage.server.version.errors import HeadMovedError

FILE_MODE = 0o100644
DIR_MODE = 0o40000
AUTHOR = b"mirage <mirage@local>"


def _add_blob(repo: Repo, data: bytes) -> bytes:
    blob = Blob.from_string(data)
    repo.object_store.add_object(blob)
    return blob.id


def _read_blob(repo: Repo, oid: bytes) -> bytes:
    return repo.object_store[ObjectID(oid)].as_raw_string()


def _build_tree(repo: Repo, entries: dict[str, bytes]) -> bytes:
    tree = Tree()
    subdirs: dict[str, dict[str, bytes]] = {}
    for path, oid in entries.items():
        if "/" in path:
            head, rest = path.split("/", 1)
            subdirs.setdefault(head, {})[rest] = oid
        else:
            tree.add(path.encode(), FILE_MODE, ObjectID(oid))
    for name, sub in subdirs.items():
        tree.add(name.encode(), DIR_MODE, ObjectID(_build_tree(repo, sub)))
    repo.object_store.add_object(tree)
    return tree.id


def _read_tree(repo: Repo, oid: bytes, prefix: str = "") -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    tree = repo.object_store[ObjectID(oid)]
    assert isinstance(tree, Tree)
    for name, mode, sha in tree.items():
        rel = name.decode()
        full = f"{prefix}/{rel}" if prefix else rel
        if stat.S_ISDIR(mode):
            out.update(_read_tree(repo, sha, full))
        else:
            out[full] = sha
    return out


def _commit(repo: Repo, tree_oid: bytes, parents: list[bytes], branch: str,
            message: str) -> bytes:
    commit = Commit()
    commit.tree = tree_oid
    commit.parents = [ObjectID(p) for p in parents]
    commit.author = commit.committer = AUTHOR
    now = int(time.time())
    commit.author_time = commit.commit_time = now
    commit.author_timezone = commit.commit_timezone = 0
    commit.encoding = b"UTF-8"
    commit.message = message.encode()
    repo.object_store.add_object(commit)
    ref = Ref(b"refs/heads/" + branch.encode())
    expected_old = parents[0] if parents else None
    if expected_old is None:
        ok = repo.refs.add_if_new(ref, ObjectID(commit.id))
    else:
        ok = repo.refs.set_if_equals(ref, ObjectID(expected_old),
                                     ObjectID(commit.id))
    if not ok:
        raise HeadMovedError(branch)
    repo.refs.set_symbolic_ref(Ref(b"HEAD"), ref)
    return commit.id


def _head(repo: Repo, branch: str) -> bytes:
    return repo.refs[Ref(b"refs/heads/" + branch.encode())]


def _set_branch(repo: Repo, name: str, oid: bytes) -> None:
    repo.refs[Ref(b"refs/heads/" + name.encode())] = ObjectID(oid)


def _read_commit(repo: Repo, oid: bytes) -> Commit:
    obj = repo.object_store[ObjectID(oid)]
    assert isinstance(obj, Commit)
    return obj


def _branches(repo: Repo) -> list[str]:
    prefix = b"refs/heads/"
    names = [
        name[len(prefix):].decode() for name in repo.get_refs()
        if name.startswith(prefix)
    ]
    return sorted(names)


def _log(repo: Repo, branch: str) -> list[bytes]:
    head = repo.refs[Ref(b"refs/heads/" + branch.encode())]
    return [entry.commit.id for entry in repo.get_walker(include=[head])]


def _diff(repo: Repo, tree_a: bytes, tree_b: bytes) -> dict[str, list[str]]:
    added: list[str] = []
    modified: list[str] = []
    deleted: list[str] = []
    for change in tree_changes(repo.object_store, ObjectID(tree_a),
                               ObjectID(tree_b)):
        if change.type == CHANGE_ADD and change.new is not None:
            added.append(change.new.path.decode())
        elif change.type == CHANGE_DELETE and change.old is not None:
            deleted.append(change.old.path.decode())
        elif change.type == CHANGE_MODIFY and change.new is not None:
            modified.append(change.new.path.decode())
    return {
        "added": sorted(added),
        "modified": sorted(modified),
        "deleted": sorted(deleted),
    }


class VersionStore:

    def __init__(self, repo: Repo) -> None:
        self._repo = repo

    @classmethod
    async def open(cls, backend: VersionBackend,
                   workspace_id: str) -> "VersionStore":
        repo = await asyncio.to_thread(backend.open_repo, workspace_id)
        return cls(repo)

    async def write_blob(self, data: bytes) -> bytes:
        return await asyncio.to_thread(_add_blob, self._repo, data)

    async def read_blob(self, oid: bytes) -> bytes:
        return await asyncio.to_thread(_read_blob, self._repo, oid)

    async def write_tree(self, entries: dict[str, bytes]) -> bytes:
        return await asyncio.to_thread(_build_tree, self._repo, entries)

    async def read_tree(self, oid: bytes) -> dict[str, bytes]:
        return await asyncio.to_thread(_read_tree, self._repo, oid)

    async def commit(self, tree_oid: bytes, parents: list[bytes], branch: str,
                     message: str) -> bytes:
        return await asyncio.to_thread(_commit, self._repo, tree_oid, parents,
                                       branch, message)

    async def head(self, branch: str) -> bytes:
        return await asyncio.to_thread(_head, self._repo, branch)

    async def set_branch(self, name: str, oid: bytes) -> None:
        await asyncio.to_thread(_set_branch, self._repo, name, oid)

    async def read_commit(self, oid: bytes) -> Commit:
        return await asyncio.to_thread(_read_commit, self._repo, oid)

    async def branches(self) -> list[str]:
        return await asyncio.to_thread(_branches, self._repo)

    async def log(self, branch: str) -> list[bytes]:
        return await asyncio.to_thread(_log, self._repo, branch)

    async def diff(self, tree_a: bytes, tree_b: bytes) -> dict[str, list[str]]:
        return await asyncio.to_thread(_diff, self._repo, tree_a, tree_b)
