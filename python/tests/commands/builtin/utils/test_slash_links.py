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

from mirage.commands.builtin.utils.slash_links import (is_slashed_link,
                                                       mkdir_link_refusal,
                                                       rm_link_refusal)
from mirage.ops.types import LinkView
from mirage.types import FileStat, FileType, PathSpec


def _spec(virtual: str, raw_path: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual.lstrip("/"),
                    raw_path=raw_path)


def _links(link_at: str | None, target: FileStat | None) -> LinkView:
    """A LinkView answering for exactly one link path.

    Args:
        link_at (str | None): the one path that is a link, or None for a
            namespace holding no links at all.
        target (FileStat | None): what that link resolves to; None is a
            dangling link.
    """

    async def target_stat(path: str) -> FileStat | None:
        return target if path == link_at else None

    async def exists(path: str) -> bool:
        return target is not None

    return LinkView(
        stat_at=lambda path: (FileStat(name="l", type=FileType.SYMLINK)
                              if path == link_at else None),
        children=lambda directory: [],
        subtree=lambda directory: [],
        resolve=lambda path: path,
        exists=exists,
        target_stat=target_stat,
    )


DIR = FileStat(name="sub", type=FileType.DIRECTORY)
FILE = FileStat(name="reg", type=FileType.TEXT)


def test_is_slashed_link_needs_both_the_slash_and_the_link():
    links = _links("/data/dlink", DIR)
    assert is_slashed_link(_spec("/data/dlink", "/data/dlink/"), links)
    # The same link without the slash is an ordinary lstat operand.
    assert not is_slashed_link(_spec("/data/dlink", "/data/dlink"), links)
    # A slash on something that is not a link is the guard's business.
    assert not is_slashed_link(_spec("/data/sub", "/data/sub/"), links)
    assert not is_slashed_link(_spec("/data/dlink", "/data/dlink/"), None)


@pytest.mark.asyncio
async def test_rm_refuses_a_directory_link_with_eisdir_even_under_f():
    """GNU: `rm dlink/` and `rm -f dlink/` are both "Is a directory"."""
    links = _links("/data/dlink", DIR)
    spec = _spec("/data/dlink", "/data/dlink/")
    for force in (False, True):
        assert await rm_link_refusal(
            spec, links, recursive=False,
            force=force) == ("rm: cannot remove "
                             "'/data/dlink/': Is a directory")


@pytest.mark.asyncio
async def test_rm_reports_enotdir_for_everything_else_and_f_silences_it():
    dangling = _links("/data/dangle", None)
    spec = _spec("/data/dangle", "/data/dangle/")
    assert await rm_link_refusal(
        spec, dangling, recursive=False,
        force=False) == ("rm: cannot remove '/data/dangle/': "
                         "Not a directory")
    assert await rm_link_refusal(spec, dangling, recursive=False,
                                 force=True) is None
    # -r turns even a directory link into ENOTDIR (GNU `rm -r dlink/`).
    dir_link = _links("/data/dlink", DIR)
    assert await rm_link_refusal(
        _spec("/data/dlink", "/data/dlink/"),
        dir_link,
        recursive=True,
        force=False) == ("rm: cannot remove '/data/dlink/': "
                         "Not a directory")


@pytest.mark.asyncio
async def test_rm_passes_through_an_operand_that_is_not_a_slashed_link():
    links = _links("/data/dlink", DIR)
    assert await rm_link_refusal(_spec("/data/dlink", "/data/dlink"),
                                 links,
                                 recursive=False,
                                 force=False) is None


@pytest.mark.asyncio
async def test_mkdir_collides_with_a_link_however_it_is_spelled():
    links = _links("/data/dlink", DIR)
    for raw in ("/data/dlink", "/data/dlink/"):
        taken, message = await mkdir_link_refusal(_spec("/data/dlink", raw),
                                                  links,
                                                  parents=False)
        assert taken
        assert message == (f"mkdir: cannot create directory '{raw}': "
                           "File exists")


@pytest.mark.asyncio
async def test_mkdir_p_is_satisfied_only_by_a_link_to_a_directory():
    spec = _spec("/data/dlink", "/data/dlink")
    taken, message = await mkdir_link_refusal(spec,
                                              _links("/data/dlink", DIR),
                                              parents=True)
    assert taken and message is None
    # A link to a file, or a dangling one, still collides under -p.
    for target in (FILE, None):
        taken, message = await mkdir_link_refusal(spec,
                                                  _links(
                                                      "/data/dlink", target),
                                                  parents=True)
        assert taken
        assert message is not None and "File exists" in message


@pytest.mark.asyncio
async def test_mkdir_leaves_a_free_name_alone():
    taken, message = await mkdir_link_refusal(_spec("/data/new", "/data/new"),
                                              _links("/data/dlink", DIR),
                                              parents=False)
    assert not taken and message is None
