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

from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.resource.disk import DiskResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.command.run import (drop_mount_caches,
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


def test_empty_namespace_still_offers_a_live_view():
    """A captured view must remain usable when the first link appears."""
    view = link_view(_FakeNamespace(has_links=False), _dispatch)
    assert view is not None
    assert view.children("/") == []
    assert view.stat_at("/missing") is None


def test_no_view_without_a_namespace():
    assert link_view(None, _dispatch) is None


@pytest.mark.parametrize("cmd", ["ls", "stat", "find", "du", "file"])
def test_the_symlink_aware_commands_read_the_links_field(cmd):
    """`CommandOpts.ns` reaches every handler; the family generic is
    where the read lives (tests/commands/test_links_optin.py pins the
    full delegation rule), and the builder passes `opts` through."""
    module = importlib.import_module(f"mirage.commands.builtin.generic.{cmd}")
    assert "opts.ns.links" in inspect.getsource(module)


def test_stat_overlay_is_read_where_stats_render():
    """The overlay used to carry its own list of command names; now the
    builders that render stats read it off `opts`."""
    named = set()
    for builder in BUILDERS:
        module = inspect.getmodule(inspect.unwrap(builder.fn))
        if module is None:
            continue
        if "opts.ns.stat_overlay" in inspect.getsource(module):
            named.add(builder.name)
    assert named == {"ls", "stat", "cp", "mv", "find"}


async def _cli_write_case(tmp_path) -> tuple[str, str, str]:
    """A CLI write mutates the service out of band, exactly as gws does
    by file id, then every mount drops its caches."""
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    (tmp_path / "one" / "a.txt").write_bytes(b"v1\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v1\n")
    one = DiskResource(root=str(tmp_path / "one"))
    two = DiskResource(root=str(tmp_path / "two"))
    one.caches_reads = True
    two.caches_reads = True
    ws = Workspace({"/one/": one, "/two/": two}, mode=MountMode.WRITE)
    await (await ws.execute("cat /one/a.txt")).stdout_str()
    await (await ws.execute("cat /two/b.txt")).stdout_str()
    (tmp_path / "one" / "a.txt").write_bytes(b"v2\n")
    (tmp_path / "one" / "new.txt").write_bytes(b"fresh\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v2\n")
    await drop_mount_caches(ws._registry)
    body = await (await ws.execute("cat /one/a.txt")).stdout_str()
    listing = await (await ws.execute("ls /one")).stdout_str()
    other = await (await ws.execute("cat /two/b.txt")).stdout_str()
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
async def test_a_cli_write_drops_every_mount(tmp_path):
    # Which mounts the CLI's service backs is not the CLI's business, so
    # the executor says the one thing it knows: a write happened.
    _body, _listing, other = await _cli_write_case(tmp_path)
    assert other == "v2\n"
