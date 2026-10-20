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

import pytest

from mirage.accessor.base import Accessor
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace


async def _cli_write_case(
    tmp_path, by: Accessor | None = None
) -> tuple[str, str, str]:
    """A CLI write mutates the service out of band, exactly as gws does
    by file id, then the mounts its client may reach drop their caches."""
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    (tmp_path / "one" / "a.txt").write_bytes(b"v1\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v1\n")
    one = DiskVFS(root=str(tmp_path / "one"))
    two = DiskVFS(root=str(tmp_path / "two"))
    one.caches_reads = True
    two.caches_reads = True
    ws = Workspace({"/one/": one, "/two/": two}, mode=MountMode.WRITE)
    await (await ws.shell("cat /one/a.txt")).stdout_str()
    await (await ws.shell("cat /two/b.txt")).stdout_str()
    (tmp_path / "one" / "a.txt").write_bytes(b"v2\n")
    (tmp_path / "one" / "new.txt").write_bytes(b"fresh\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v2\n")
    if isinstance(by, _ReachesOne):
        by.target = one.accessor
    await ws._registry.drop_caches(by)
    body = await (await ws.shell("cat /one/a.txt")).stdout_str()
    listing = await (await ws.shell("ls /one")).stdout_str()
    other = await (await ws.shell("cat /two/b.txt")).stdout_str()
    return body, listing, other


@pytest.mark.asyncio
async def test_a_cli_write_drops_bodies_as_well_as_listings(tmp_path):
    """A stale listing hides a create; a stale body hides an edit. The
    cached body is the one that answers without reaching the service, so
    clearing the index alone leaves `cat` serving pre-write content."""
    body, listing, _other = await _cli_write_case(tmp_path)
    assert body == "v2\n"
    assert "new.txt" in listing


@pytest.mark.asyncio
async def test_a_write_by_no_named_client_drops_every_mount(tmp_path):
    # A client that does not say which mounts it reaches may reach any.
    _body, _listing, other = await _cli_write_case(tmp_path)
    assert other == "v2\n"


class _ReachesOne(Accessor):
    """A client whose writes reach only the accessor it targets."""

    target: Accessor | None = None

    def reaches(self, peer: Accessor) -> bool:
        return peer is self.target


@pytest.mark.asyncio
async def test_a_write_drops_only_the_mounts_its_client_reaches(tmp_path):
    body, listing, other = await _cli_write_case(tmp_path, _ReachesOne())
    assert (body, "new.txt" in listing) == ("v2\n", True)
    assert other == "v1\n"
