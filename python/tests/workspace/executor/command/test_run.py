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

from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.resource.disk import DiskResource
from mirage.types import MountMode, ResourceName
from mirage.utils.params import accepts_kwarg
from mirage.workspace import Workspace
from mirage.workspace.executor.command.run import (drop_service_caches,
                                                   link_view, listed_names)

_LONG_ROW = "-rw-r--r-- 1 user user 6 Aug  2 18:54 real.txt"
_DEGRADED_ROW = "d\t-\t-\tsub"


def test_short_form_reads_plain_names():
    assert listed_names("a.txt\nb.txt\n", False) == {"a.txt", "b.txt"}


def test_short_form_strips_classify_suffixes():
    assert listed_names("dir/\nlink@\nexe*\n", False) == {"dir", "link", "exe"}


def test_long_form_reads_the_name_out_of_a_full_gnu_row():
    """The name is the ninth whitespace field; splitting on tabs alone
    read the whole row as one field, so dedup silently never matched."""
    assert listed_names(_LONG_ROW, True) == {"real.txt"}


def test_long_form_still_reads_the_degraded_tab_row():
    assert listed_names(_DEGRADED_ROW, True) == {"sub"}


def test_long_form_handles_both_row_shapes_at_once():
    listing = f"{_LONG_ROW}\n{_DEGRADED_ROW}\n"
    assert listed_names(listing, True) == {"real.txt", "sub"}


def test_a_name_containing_spaces_survives():
    row = "-rw-r--r-- 1 user user 6 Aug  2 18:54 two words.txt"
    assert listed_names(row, True) == {"two words.txt"}


def test_blank_lines_contribute_nothing():
    assert listed_names("\n\n", True) == set()
    assert listed_names("\n\n", False) == set()


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
def test_the_symlink_aware_commands_name_the_links_parameter(cmd):
    """Naming the parameter is the whole opt-in: no registry, no spec
    field, nothing that can fall out of step with the signature."""
    builder = next(b for b in _BUILDERS if b.name == cmd)
    assert accepts_kwarg(builder.fn, "links") is True


@pytest.mark.parametrize("cmd", ["cat", "grep", "wc", "head"])
def test_other_commands_are_not_handed_a_kwarg_they_cannot_take(cmd):
    """A bare **kwargs must not read as consent: wrappers forward it
    wholesale to a generic that would reject the keyword."""
    builder = next(b for b in _BUILDERS if b.name == cmd)
    assert accepts_kwarg(builder.fn, "links") is False


def test_stat_overlay_is_gated_by_the_same_rule():
    """The overlay used to carry its own list of command names."""
    named = {b.name for b in _BUILDERS if accepts_kwarg(b.fn, "stat_overlay")}
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
