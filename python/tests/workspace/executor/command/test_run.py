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

import importlib
import inspect

import pytest

from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.resource.disk import DiskResource
from mirage.types import MountMode, ResourceName
from mirage.workspace import Workspace
from mirage.workspace.executor.command.run import (drop_service_caches,
                                                   link_view,
                                                   registry_child_mounts)


class _FakeMount:

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix


class _FakeRegistry:
    """Enough of MountRegistry for the child_mounts fact to bind against."""

    def __init__(self, prefixes: list[str]) -> None:
        self._prefixes = prefixes

    def mounts(self) -> list[_FakeMount]:
        return [_FakeMount(p) for p in self._prefixes]


class _FakeLinks:

    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def symlink_targets(self) -> dict[str, str]:
        return self._targets


def test_registry_child_mounts_derives_from_the_mount_table():
    reg = _FakeRegistry(["/base/", "/base/inner/", "/dev/"])
    assert registry_child_mounts(reg, None, "/base") == ["inner"]
    assert registry_child_mounts(reg, None, "/") == ["base", "dev"]
    assert registry_child_mounts(reg, None, "/dev") == []


def test_registry_child_mounts_includes_link_ancestors():
    # A link below a directory chain no backend serves synthesizes its
    # ancestors, exactly as a nested mount prefix does, so `ls /` shows
    # the way to it.
    reg = _FakeRegistry(["/base/"])
    links = _FakeLinks({"/ghost/deep/lnk": "/base"})
    assert registry_child_mounts(reg, links, "/") == ["base", "ghost"]
    assert registry_child_mounts(reg, links, "/ghost") == ["deep"]


class _FakeNamespace:
    """Enough of Namespace for _link_view to bind against."""

    def __init__(self, has_links: bool = True) -> None:
        self._has_links = has_links

    def has_links(self) -> bool:
        return self._has_links

    def link_stat_at(self, path: str) -> None:
        return None

    def link_stats_under(self, directory: str) -> list:
        return []

    def link_stats_below(self, directory: str) -> list:
        return []

    def follow(self, path: str) -> str:
        return path


async def _dispatch(*args, **kwargs):
    return None, None


def test_a_view_is_offered_whenever_the_workspace_holds_links():
    assert link_view(_FakeNamespace(), _dispatch) is not None


def test_no_view_when_the_workspace_holds_no_links():
    """The common case stays free: no links, nothing to offer."""
    assert link_view(_FakeNamespace(has_links=False), _dispatch) is None


def test_no_view_without_a_namespace():
    assert link_view(None, _dispatch) is None


@pytest.mark.parametrize("cmd", ["ls", "stat", "find", "du", "file"])
def test_the_symlink_aware_commands_read_the_links_field(cmd):
    """`CommandOpts.links` reaches every handler; the family generic is
    where the read lives (tests/commands/test_links_optin.py pins the
    full delegation rule), and the builder passes `opts` through."""
    module = importlib.import_module(f"mirage.commands.builtin.generic.{cmd}")
    assert "opts.links" in inspect.getsource(module)


def test_stat_overlay_is_read_where_stats_render():
    """The overlay used to carry its own list of command names; now the
    builders that render stats read it off `opts`."""
    named = set()
    for builder in _BUILDERS:
        module = inspect.getmodule(inspect.unwrap(builder.fn))
        if module is None:
            continue
        if "opts.stat_overlay" in inspect.getsource(module):
            named.add(builder.name)
    assert named == {"ls", "stat", "cp", "mv", "find"}


async def _cli_write_case(tmp_path) -> tuple[str, str]:
    """A CLI write mutates the service out of band, exactly as gws does
    by file id, then drops the caches for the mounts that service backs."""
    (tmp_path / "a.txt").write_bytes(b"v1\n")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/data/": disk}, mode=MountMode.WRITE)
    await (await ws.execute("cat /data/a.txt")).stdout_str()
    (tmp_path / "a.txt").write_bytes(b"v2\n")
    (tmp_path / "new.txt").write_bytes(b"fresh\n")
    await drop_service_caches(ws._registry, (ResourceName.DISK, ))
    second = await (await ws.execute("cat /data/a.txt")).stdout_str()
    listing = await (await ws.execute("ls /data")).stdout_str()
    return second, listing


@pytest.mark.asyncio
async def test_a_cli_write_drops_bodies_as_well_as_listings(tmp_path):
    """A stale listing hides a create; a stale body hides an edit. The
    cached body is the one that answers without reaching the service, so
    clearing the index alone leaves `cat` serving pre-write content."""
    body, listing = await _cli_write_case(tmp_path)
    assert body == "v2\n"
    assert "new.txt" in listing


@pytest.mark.asyncio
async def test_a_cli_that_serves_nothing_drops_nothing(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"v1\n")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/data/": disk}, mode=MountMode.WRITE)
    await ws.execute("cat /data/a.txt")
    (tmp_path / "a.txt").write_bytes(b"v2\n")
    await drop_service_caches(ws._registry, ())
    assert await (await ws.execute("cat /data/a.txt")).stdout_str() == "v1\n"


@pytest.mark.asyncio
async def test_an_unrelated_service_keeps_its_cache(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"v1\n")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/data/": disk}, mode=MountMode.WRITE)
    await ws.execute("cat /data/a.txt")
    (tmp_path / "a.txt").write_bytes(b"v2\n")
    await drop_service_caches(ws._registry, (ResourceName.GDRIVE, ))
    assert await (await ws.execute("cat /data/a.txt")).stdout_str() == "v1\n"
