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

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.mount.storage import (make_storage_key,
                                            resource_storage_id)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual.strip("/"))


def _key(mounts: dict):
    ws = Workspace({p: (r, MountMode.WRITE) for p, r in mounts.items()})
    return make_storage_key(ws.registry)


def test_one_resource_at_two_prefixes_is_one_storage():
    """The alias that used to make mv delete the file it moved (#154)."""
    shared = RAMResource()
    key = _key({"/m1/": shared, "/m2/": shared})
    assert key(_spec("/m1/x.txt")) == key(_spec("/m2/x.txt"))


def test_distinct_resources_are_distinct_storage():
    """Same basename on two real stores must stay a legitimate move."""
    key = _key({"/m1/": RAMResource(), "/m2/": RAMResource()})
    assert key(_spec("/m1/x.txt")) != key(_spec("/m2/x.txt"))


def test_disk_identity_is_the_resolved_root(tmp_path):
    """Two DiskResources built on one directory are one store."""
    root = str(tmp_path)
    key = _key({
        "/d1/": DiskResource(root=root),
        "/d2/": DiskResource(root=root)
    })
    assert key(_spec("/d1/x.txt")) == key(_spec("/d2/x.txt"))


def test_disk_roots_that_differ_stay_separate(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    key = _key({
        "/d1/": DiskResource(root=str(a)),
        "/d2/": DiskResource(root=str(b))
    })
    assert key(_spec("/d1/x.txt")) != key(_spec("/d2/x.txt"))


def test_distinct_paths_in_one_storage_stay_distinct():
    """A real move within one store must not read as a self-move."""
    shared = RAMResource()
    key = _key({"/m1/": shared, "/m2/": shared})
    assert key(_spec("/m1/x.txt")) != key(_spec("/m2/other.txt"))


def test_key_keeps_the_ancestor_prefix_boundary():
    """cp/mv test containment with startswith(key + "/")."""
    shared = RAMResource()
    key = _key({"/m1/": shared, "/m2/": shared})
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
    key = _key({
        "/a/": DiskResource(root=str(root)),
        "/b/": DiskResource(root=str(sub)),
    })
    assert key(_spec("/a/sub/x.txt")) == key(_spec("/b/x.txt"))


def test_nested_roots_do_not_collide_on_a_sibling(tmp_path):
    """Concatenation must not fuse names that merely share a prefix."""
    root = tmp_path / "data"
    sibling = tmp_path / "dataX"
    root.mkdir()
    sibling.mkdir()
    key = _key({
        "/a/": DiskResource(root=str(root)),
        "/b/": DiskResource(root=str(sibling)),
    })
    assert key(_spec("/a/y.txt")) != key(_spec("/b/y.txt"))


def test_resource_without_storage_id_keeps_object_identity():
    """A custom resource may not inherit BaseResource.storage_id.

    Falling back to the mount prefix would give one object two
    identities and let a self-move through.
    """

    class _Custom:
        pass

    shared = _Custom()
    assert resource_storage_id(shared) == resource_storage_id(shared)
    assert resource_storage_id(shared) != resource_storage_id(_Custom())


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


def test_aliased_mounts_refuse_the_move_that_used_to_lose_the_file():
    """End to end: the #154 repro must keep the bytes."""
    shared = RAMResource()
    ws = Workspace({
        "/m1/": (shared, MountMode.WRITE),
        "/m2/": (shared, MountMode.WRITE)
    })

    async def _run():
        await ws.execute("sh -c 'echo precious > /m1/x.txt'")
        io = await ws.execute("mv /m1/x.txt /m2/x.txt")
        err = await io.stderr_str()
        kept = await (await ws.execute("cat /m2/x.txt")).stdout_str()
        return err, io.exit_code, kept

    err, code, kept = asyncio.run(_run())
    assert code == 1
    assert "are the same file" in err
    assert kept == "precious\n"
