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
from typing import Any

import pytest

from mirage.errors.fs import walk_declined, walk_refusal
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.answers import Answers, run_generic

TREE = {
    "/m": ["/m/a.txt", "/m/d", "/m/locked"],
    "/m/d": ["/m/d/x.txt"],
    "/m/locked": ["/m/locked/f.txt"],
}
FILES = {"/m/a.txt", "/m/d/x.txt", "/m/locked/f.txt"}


async def _readdir(path: PathSpec) -> list[str]:
    return TREE.get(path.virtual, [])


async def _stat(path: PathSpec) -> FileStat:
    if path.virtual.startswith("/m/locked/"):
        raise PermissionError(path.virtual)
    if path.virtual in TREE:
        return FileStat(name=path.virtual, type=FileType.DIRECTORY)
    if path.virtual in FILES:
        return FileStat(name=path.virtual, type=FileType.FILE)
    raise FileNotFoundError(path.virtual)


def _mount(removed: list[str] | None = None) -> Answers:
    async def remove(path: PathSpec) -> None:
        assert removed is not None
        removed.append(path.virtual)

    writes: dict[str, Any] = (
        {} if removed is None else {"unlink": remove, "rm_r": remove}
    )
    return Answers("/m/", readdir=_readdir, stat=_stat, **writes)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.lstrip("/"),
        resolved=True,
    )


async def _rm(
    mount: Answers, *paths: str, **flags: bool
) -> tuple[int, str, str]:
    out, io = await run_generic(
        "rm", mount, [_spec(p) for p in paths], **flags
    )
    stderr = io.stderr.decode() if io.stderr else ""
    return io.exit_code, out.decode(), stderr


@pytest.mark.asyncio
async def test_rm_stats_its_operand_through_the_dispatcher():
    removed: list[str] = []
    mount = _mount(removed)
    assert await _rm(mount, "/m/a.txt") == (0, "", "")
    assert removed == ["/m/a.txt"]
    assert [name for name, _, _ in mount.calls] == ["stat", "unlink"]


@pytest.mark.asyncio
async def test_rm_v_walks_the_tree_through_the_dispatcher():
    removed: list[str] = []
    listing = "removed '/m/d/x.txt'\nremoved directory '/m/d'\n"
    result = await _rm(_mount(removed), "/m/d", r=True, v=True)
    assert result == (0, listing, "")
    assert removed == ["/m/d"]


@pytest.mark.asyncio
async def test_rm_f_reports_an_existing_file_it_cannot_remove():
    # GNU's `ignorable_missing` spares ENOENT and ENOTDIR alone: a file
    # that exists on a filesystem refusing the unlink fails under -f too.
    refusal = "rm: cannot remove '/m/a.txt': Operation not supported\n"
    result = await _rm(_mount(), "/m/a.txt", "/m/nope", f=True)
    assert result == (1, "", refusal)


@pytest.mark.asyncio
async def test_rm_reports_a_refused_stat_and_removes_the_rest():
    removed: list[str] = []
    refusal = "rm: cannot remove '/m/locked/f.txt': Permission denied\n"
    result = await _rm(_mount(removed), "/m/locked/f.txt", "/m/a.txt", f=True)
    assert result == (1, "", refusal)
    assert removed == ["/m/a.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "force,refusal,raw,code,stderr",
    [
        (
            False,
            "ELOOP",
            "loop/child",
            1,
            b"rm: cannot remove 'loop/child': "
            b"Too many levels of symbolic links\n",
        ),
        (True, "ENOENT", "", 0, None),
    ],
)
async def test_rm_refused_operand_keeps_spelling_and_continues(
    force, refusal, raw, code, stderr
):
    stats: list[str] = []
    unlinked: list[PathSpec] = []

    async def stat(path: PathSpec) -> FileStat:
        stats.append(path.virtual)
        if path.walk_error is not None:
            raise walk_refusal(path)
        return FileStat(name="ok", type=FileType.FILE)

    async def unlink(path: PathSpec) -> None:
        unlinked.append(path)

    mount = Answers("/data/", stat=stat, unlink=unlink)
    refused = replace(
        PathSpec.from_str_path("/data"), raw_path=raw, walk_error=refusal
    )
    valid = PathSpec.from_str_path("/data/ok")
    _, result = await run_generic("rm", mount, [refused, valid], f=force)
    assert (result.exit_code, result.stderr) == (code, stderr)
    assert len(stats) == 2
    assert unlinked == [valid]


async def _declined_rm_r(path: PathSpec) -> None:
    raise walk_declined("s3", "rm_r", path)


@pytest.mark.asyncio
async def test_rm_r_names_a_mount_below_and_fails():
    tree = {"/data": ["/data/a.txt", "/data/inner"]}
    unlinked: list[str] = []
    rmdirs: list[str] = []

    async def readdir(path: PathSpec) -> list[str]:
        return tree.get(path.virtual, [])

    async def stat(path: PathSpec) -> FileStat:
        kind = FileType.DIRECTORY if path.virtual in tree else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    async def unlink(path: PathSpec) -> None:
        unlinked.append(path.virtual)

    async def rmdir(path: PathSpec) -> None:
        rmdirs.append(path.virtual)

    mount = Answers(
        "/data/",
        below=("/data/inner/",),
        readdir=readdir,
        stat=stat,
        unlink=unlink,
        rmdir=rmdir,
        rm_r=_declined_rm_r,
    )
    _, result = await run_generic(
        "rm", mount, [PathSpec.from_str_path("/data")], r=True
    )
    assert result.exit_code == 1
    assert result.stderr == (
        b"rm: skipping '/data/inner', since it's on a different device\n"
    )
    assert unlinked == ["/data/a.txt"]
    assert rmdirs == []
