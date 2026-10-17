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

from mirage.commands.builtin.generic.rm_cmd import remove_tree
from mirage.types import FileStat, FileType, PathSpec
from mirage.view.types import MountView

TREE = {"/t": ["/t/a.txt", "/t/inner"], "/t/inner": ["/t/inner/b.txt"]}


def _spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def _tree_ops(
    calls: list[tuple[str, str]],
    gone: str | None = None,
    vanished: str | None = None,
):
    async def readdir(path):
        return TREE.get(path.virtual, [])

    async def stat(path):
        if path.virtual == vanished:
            raise FileNotFoundError(path.virtual)
        kind = FileType.DIRECTORY if path.virtual in TREE else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    async def unlink(path):
        if path.virtual == gone:
            raise FileNotFoundError(path.virtual)
        calls.append(("unlink", path.virtual))

    async def rmdir(path):
        calls.append(("rmdir", path.virtual))

    return {"readdir": readdir, "stat": stat, "unlink": unlink, "rmdir": rmdir}


def _mounts(mounts: list[str]) -> MountView:
    return MountView(
        descendants=lambda _v: list(mounts),
        visible_descendants=lambda _v: list(mounts),
        is_root=lambda v: v in mounts,
        root_of=lambda _v: "/",
    )


@pytest.mark.asyncio
async def test_remove_tree_never_enters_a_mount_below():
    calls: list[tuple[str, str]] = []
    removed, failures = await remove_tree(
        _spec("/t"),
        **_tree_ops(calls),
        mounts=_mounts(["/t/inner"]),
        force=False,
    )
    assert calls == [("unlink", "/t/a.txt")]
    assert failures == []


@pytest.mark.parametrize("force", [True, False])
@pytest.mark.asyncio
async def test_remove_tree_force_takes_an_entry_gone_as_removed(force):
    calls: list[tuple[str, str]] = []
    _, failures = await remove_tree(
        _spec("/t/inner"),
        **_tree_ops(calls, gone="/t/inner/b.txt"),
        mounts=None,
        force=force,
    )
    assert [p.virtual for p, _ in failures] == (
        [] if force else ["/t/inner/b.txt"]
    )
    assert (("rmdir", "/t/inner") in calls) is force


@pytest.mark.asyncio
async def test_remove_tree_skips_a_child_gone_before_its_stat():
    calls: list[tuple[str, str]] = []
    _, failures = await remove_tree(
        _spec("/t/inner"),
        **_tree_ops(calls, vanished="/t/inner/b.txt"),
        mounts=None,
        force=False,
    )
    assert failures == []
    assert calls == [("rmdir", "/t/inner")]
