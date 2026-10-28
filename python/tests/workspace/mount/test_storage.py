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

from mirage.types import MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.mount.storage import make_storage_key


class SharedStoreVFS(RAMVFS):
    """Two instances naming one store, the way two redis mounts on one
    keyspace do."""

    def storage_location(self) -> str:
        return "ram:shared"


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual.strip("/"),
    )


def _key(mounts: dict):
    ws = Workspace({p: (r, MountMode.WRITE) for p, r in mounts.items()})
    return make_storage_key(ws.registry)


def test_distinct_mounts_are_distinct_storage():
    """Same basename on two real stores must stay a legitimate move."""
    key = _key({"/m1/": RAMVFS(), "/m2/": RAMVFS()})
    assert key(_spec("/m1/x.txt")) != key(_spec("/m2/x.txt"))


def test_disk_roots_that_differ_stay_separate(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    key = _key({"/d1/": DiskVFS(root=str(a)), "/d2/": DiskVFS(root=str(b))})
    assert key(_spec("/d1/x.txt")) != key(_spec("/d2/x.txt"))


def test_key_keeps_the_ancestor_prefix_boundary():
    """cp/mv test containment with startswith(key + "/")."""
    key = _key({"/m1/": SharedStoreVFS(), "/m2/": SharedStoreVFS()})
    assert key(_spec("/m2/dir/sub")).startswith(key(_spec("/m1/dir")) + "/")
    assert not key(_spec("/m2/dirty")).startswith(key(_spec("/m1/dir")) + "/")


def test_nested_disk_roots_resolve_to_one_key(tmp_path):
    """Overlapping roots make the same file reachable two ways.

    /a backed by root and /b backed by root/sub means /a/sub/x and /b/x
    are one file. Keeping the root and the relative path as separate
    key components kept them apart and let mv delete the file.
    """
    root = tmp_path / "data"
    sub = root / "sub"
    sub.mkdir(parents=True)
    key = _key(
        {
            "/a/": DiskVFS(root=str(root)),
            "/b/": DiskVFS(root=str(sub)),
        }
    )
    assert key(_spec("/a/sub/x.txt")) == key(_spec("/b/x.txt"))


def test_nested_roots_do_not_collide_on_a_sibling(tmp_path):
    """Concatenation must not fuse names that merely share a prefix."""
    root = tmp_path / "data"
    sibling = tmp_path / "dataX"
    root.mkdir()
    sibling.mkdir()
    key = _key(
        {
            "/a/": DiskVFS(root=str(root)),
            "/b/": DiskVFS(root=str(sibling)),
        }
    )
    assert key(_spec("/a/y.txt")) != key(_spec("/b/y.txt"))


def test_path_outside_every_mount_falls_back_to_itself():
    """The defensive branch, reached only without a root mount.

    A Workspace always carries one, so an unmatched path normally lands
    there instead; this pins the fallback for a bare registry.
    """

    class _NoMounts:
        def try_mount_for(self, path: str):
            return None

    key = make_storage_key(_NoMounts())
    assert key(_spec("/nowhere/x.txt")) == "/nowhere/x.txt"
