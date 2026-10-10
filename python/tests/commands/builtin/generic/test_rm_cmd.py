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

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.generic.rm_cmd import make_rm, remove_tree
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.errors import UsageError
from mirage.types import FileStat, FileType, HiddenPaths, PathSpec, Visibility
from mirage.view.types import LinkView, MountView, NamespaceView


class FakeAccessor:
    pass


# The mount's table, for its glob: no operand here is a pattern.
_IO = CommandIO(
    readdir=AsyncMock(return_value=[]),
    read_bytes=AsyncMock(),
    read_stream=AsyncMock(),
    stat=AsyncMock(),
    is_mounted=lambda _: True,
)


def _make_rm(files: set[str], calls: list[tuple]):
    """The rm and the mount table whose unlink it calls."""

    async def unlink(accessor, path, index=NULL_INDEX):
        calls.append((accessor, path, index))
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        files.remove(path.virtual)

    return make_rm(vfs="gdocs"), replace(_IO, unlink=unlink)


@pytest.mark.asyncio
async def test_rm_hands_each_operand_to_the_mounts_unlink():
    calls: list[tuple] = []
    accessor = FakeAccessor()
    rm, io = _make_rm({"/owned/a.gdoc.json"}, calls)
    path = PathSpec.from_str_path("/owned/a.gdoc.json")
    _, result = await rm(
        accessor, [path], [], CommandOpts(io=io, index=NULL_INDEX)
    )
    assert result.exit_code == 0
    assert calls == [(accessor, path, NULL_INDEX)]


@pytest.mark.asyncio
async def test_rm_missing_operand():
    rm, io = _make_rm(set(), [])
    with pytest.raises(UsageError) as info:
        await rm(FakeAccessor(), [], [], CommandOpts(io=io))
    assert str(info.value) == (
        "rm: missing operand\nTry 'rm --help' for more information."
    )
    assert info.value.exit_code == 1


@pytest.mark.asyncio
async def test_rm_force_without_operands_does_nothing():
    calls: list[tuple] = []
    rm, io = _make_rm(set(), calls)
    out, result = await rm(
        FakeAccessor(), [], [], CommandOpts(io=io, flags={"f": True})
    )
    assert (out, result.exit_code, result.stderr) == (None, 0, None)
    assert calls == []


@pytest.mark.asyncio
async def test_rm_enoent_reports_and_continues_without_force():
    files = {"/owned/b.json"}
    calls: list[tuple] = []
    rm, io = _make_rm(files, calls)
    paths = [
        PathSpec.from_str_path("/owned/x.json"),
        PathSpec.from_str_path("/owned/b.json"),
    ]
    _, result = await rm(FakeAccessor(), paths, [], CommandOpts(io=io))
    assert result.exit_code == 1
    assert result.stderr == (
        b"rm: cannot remove '/owned/x.json': No such file or directory\n"
    )
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_rm_force_swallows_enoent():
    calls: list[tuple] = []
    rm, io = _make_rm(set(), calls)
    _, result = await rm(
        FakeAccessor(),
        [PathSpec.from_str_path("/owned/x.json")],
        [],
        CommandOpts(io=io, flags={"f": True}),
    )
    assert result.exit_code == 0
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_rm_verbose_reports_each_removal():
    files = {"/owned/a.gdoc.json", "/owned/b.gdoc.json"}
    rm, io = _make_rm(files, [])
    paths = [
        PathSpec.from_str_path("/owned/a.gdoc.json"),
        PathSpec.from_str_path("/owned/b.gdoc.json"),
    ]
    output, result = await rm(
        FakeAccessor(), paths, [], CommandOpts(io=io, flags={"v": True})
    )
    assert isinstance(output, bytes)
    text = output.decode()
    assert "removed '/owned/a.gdoc.json'" in text
    assert "removed '/owned/b.gdoc.json'" in text
    assert result.exit_code == 0
    assert not files


@pytest.mark.asyncio
async def test_rm_empty_operand_keeps_its_spelling():
    calls: list[tuple] = []
    rm, io = _make_rm(set(), calls)
    path = replace(
        PathSpec.from_str_path("/owned"), raw_path="", walk_error="ENOENT"
    )
    _, result = await rm(FakeAccessor(), [path], [], CommandOpts(io=io))
    assert result.stderr == (
        b"rm: cannot remove '': No such file or directory\n"
    )


TREE = {"/t": ["/t/a.txt", "/t/inner"], "/t/inner": ["/t/inner/b.txt"]}


def _spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def _tree_ops(calls: list[tuple[str, str]], gone: str | None = None):
    async def readdir(path):
        return TREE.get(path.virtual, [])

    async def stat(path):
        kind = FileType.DIRECTORY if path.virtual in TREE else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    async def unlink(path):
        if path.virtual == gone:
            raise FileNotFoundError(path.virtual)
        calls.append(("unlink", path.virtual))

    async def rmdir(path):
        calls.append(("rmdir", path.virtual))

    return {"readdir": readdir, "stat": stat, "unlink": unlink, "rmdir": rmdir}


def _ns(
    mounts: list[str] = (),
    links: list[str] = (),
    hidden: tuple[str, ...] = (),
) -> NamespaceView:
    link_rows = {
        name.rsplit("/", 1)[0]: [
            FileStat(name=name.rsplit("/", 1)[1], type=FileType.SYMLINK)
        ]
        for name in links
    }
    return NamespaceView(
        links=LinkView(
            stat_at=lambda _v: None,
            children=lambda base: link_rows.get(base, []),
            subtree=lambda _v: [],
            resolve=lambda v: v,
            exists=AsyncMock(return_value=True),
            target_stat=AsyncMock(),
        ),
        mounts=MountView(
            descendants=lambda _v: list(mounts),
            visible_descendants=lambda _v: list(mounts),
            is_root=lambda v: v in mounts,
            root_of=lambda _v: "/",
        ),
        visibility=Visibility(paths=HiddenPaths(paths=hidden)),
    )


@pytest.mark.asyncio
async def test_remove_tree_never_enters_a_mount_below():
    calls: list[tuple[str, str]] = []
    removed, failures = await remove_tree(
        _spec("/t"),
        **_tree_ops(calls),
        ns=_ns(mounts=["/t/inner"]),
        force=False,
    )
    assert calls == [("unlink", "/t/a.txt")]
    assert failures == []


@pytest.mark.asyncio
async def test_remove_tree_leaves_a_hidden_link_to_the_directory():
    calls: list[tuple[str, str]] = []
    _, failures = await remove_tree(
        _spec("/t/inner"),
        **_tree_ops(calls),
        ns=_ns(links=["/t/inner/secret"], hidden=("/t/inner/secret",)),
        force=False,
    )
    assert calls == [("unlink", "/t/inner/b.txt"), ("rmdir", "/t/inner")]
    assert failures == []


@pytest.mark.parametrize("force", [True, False])
@pytest.mark.asyncio
async def test_remove_tree_force_takes_an_entry_gone_as_removed(force):
    calls: list[tuple[str, str]] = []
    _, failures = await remove_tree(
        _spec("/t/inner"),
        **_tree_ops(calls, gone="/t/inner/b.txt"),
        ns=None,
        force=force,
    )
    assert [p.virtual for p, _ in failures] == (
        [] if force else ["/t/inner/b.txt"]
    )
    assert (("rmdir", "/t/inner") in calls) is force
