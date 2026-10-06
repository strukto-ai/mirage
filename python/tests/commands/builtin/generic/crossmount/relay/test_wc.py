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

from mirage.commands.builtin.generic.crossmount.relay.wc import run_wc
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.errors.fs import enoent
from mirage.io.types import CountedRun, IOResult, materialize
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# What each operand's own mount counts for `wc -l`, and what stat says. The
# printed text is never read back, so every run prints the same noise.
ROWS = {
    "/a/dir": ((0,), b"wc: /a/dir: Is a directory\n"),
    "/b/name with spaces": ((1,), None),
    "/b/x": ((1,), None),
    "/pg/rows": ((5,), None),
    "/pg2/rows": ((3,), None),
    "/gone": ((4,), None),
}
SIZES = {"/b/name with spaces": 6, "/b/x": 120, "/pg/rows": None}


class Mounts:
    def __init__(self) -> None:
        self.runs: list[tuple[str, list[str], dict]] = []
        self.ops: list[str] = []

    async def run_single(self, name, paths, texts, flags, stdin=None):
        self.runs.append((name, [p.virtual for p in paths], flags))
        values, err = ROWS[paths[0].virtual]
        return b"9 9 9 rendered\n", IOResult(
            exit_code=1 if err else 0,
            stderr=err,
            counted_runs=[CountedRun(values, paths[0].raw_path)],
        )

    async def dispatch(self, op, path, **kwargs):
        self.ops.append(op)
        if path.virtual == "/gone":
            raise enoent(path)
        kind = (
            FileType.DIRECTORY if path.virtual == "/a/dir" else FileType.FILE
        )
        return FileStat(
            name=path.virtual, type=kind, size=SIZES.get(path.virtual)
        ), IOResult()


def specs(*paths: str) -> list[PathSpec]:
    return [PathSpec.from_str_path(p) for p in paths]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,expected",
    [
        (
            {"lines": True},
            b"      0 /a/dir\n      1 /b/name with spaces\n      1 total\n",
        ),
        ({"lines": True, "total": "only"}, b"1\n"),
        (
            {"lines": True, "total": "never"},
            b"      0 /a/dir\n      1 /b/name with spaces\n",
        ),
    ],
)
async def test_each_mount_counts_its_operand(flags, expected):
    mounts = Mounts()
    body, io = await run_wc(
        specs("/a/dir", "/b/name with spaces"),
        flags,
        mounts.dispatch,
        mounts.run_single,
    )
    assert await materialize(body) == expected
    assert mounts.runs == [
        ("wc", ["/a/dir"], {**flags, "total": "never"}),
        ("wc", ["/b/name with spaces"], {**flags, "total": "never"}),
    ]
    assert "read" not in mounts.ops
    assert io.exit_code == 1
    assert io.stderr == b"wc: /a/dir: Is a directory\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paths,expected",
    [
        (("/pg/rows", "/pg2/rows"), b"5 /pg/rows\n3 /pg2/rows\n8 total\n"),
        (("/pg/rows", "/b/x"), b"  5 /pg/rows\n  1 /b/x\n  6 total\n"),
    ],
)
async def test_an_unsized_file_pads_to_its_count(paths, expected):
    mounts = Mounts()
    body, io = await run_wc(
        specs(*paths), {"lines": True}, mounts.dispatch, mounts.run_single
    )
    assert await materialize(body) == expected
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_a_file_gone_before_sizing_keeps_every_count():
    mounts = Mounts()
    body, io = await run_wc(
        specs("/gone", "/b/x"),
        {"lines": True},
        mounts.dispatch,
        mounts.run_single,
    )
    assert await materialize(body) == b"  4 /gone\n  1 /b/x\n  5 total\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_invalid_total_fails_before_any_mount_runs():
    mounts = Mounts()
    _, io = await run_wc(
        specs("/a/x", "/b/x"),
        {"total": "bogus"},
        mounts.dispatch,
        mounts.run_single,
    )
    assert io.exit_code == 1
    assert b"invalid argument 'bogus'" in io.stderr
    assert mounts.runs == []
    assert mounts.ops == []


@command("wc", vfs="ram", spec=SPECS["wc"])
async def _uncounted(accessor, paths, texts, opts):
    return b"777 " + paths[0].raw_path.encode() + b"\n", IOResult()


@command("wc", vfs="ram", spec=SPECS["wc"])
async def _row_count(accessor, paths, texts, opts):
    return b"", IOResult(counted_runs=[CountedRun((42,), paths[0].raw_path)])


@pytest.mark.asyncio
async def test_a_wc_without_counts_is_recounted_alone():
    # /b's wc renders text only, so its operand is recounted through the
    # dispatcher; /a's own count (a row count it never read for) stays.
    first, second = RAMVFS(), RAMVFS()
    first.load_state({"files": {"/x": b"a\nb\n"}})
    second.load_state({"files": {"/y": b"c\n"}})
    ws = Workspace({"/a": first, "/b": second}, mode=MountMode.WRITE)
    ws.mount("/a").register_fns([_row_count])
    ws.mount("/b").register_fns([_uncounted])
    try:
        result = await ws.shell("wc -l /a/x /b/y")
        assert (await result.materialize_stdout()) == (
            b"42 /a/x\n1 /b/y\n43 total\n"
        )
        assert result.exit_code == 0
    finally:
        await ws.close()
