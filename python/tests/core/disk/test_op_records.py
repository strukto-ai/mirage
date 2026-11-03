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
import errno
import os
import shutil
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.policy import Action, CommandResultContext, Policy
from mirage.vfs.disk import DiskVFS

MUTATIONS = frozenset(
    {"copy", "rename", "rename_prefix", "unlink", "mkdir", "rmdir", "rm_r"}
)


def _seed(root: Path) -> None:
    (root / "a.txt").write_bytes(b"hello\n")
    (root / "e").mkdir()
    (root / "d").mkdir()
    (root / "d" / "f.txt").write_bytes(b"f\n")


async def _rows(
    root: Path, line: str, exit_code: int = 0
) -> list[tuple[str, str, int]]:
    ws = Workspace({"/m/": DiskVFS(root=root)}, mode=MountMode.WRITE)
    start = len(ws.vfs.records)
    io = await ws.shell(line)
    assert io.exit_code == exit_code, await io.stderr_str()
    rows = ws.vfs.records[start:]
    assert all(r.execution_id for r in rows)
    return [
        (r.op, r.path, r.bytes)
        for r in rows
        if r.op in MUTATIONS and r.source == "disk"
    ]


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("cp /m/a.txt /m/c.txt", [("copy", "/m/c.txt", 0)]),
        (
            "cp -r /m/d /m/d2",
            [("mkdir", "/m/d2", 0), ("copy", "/m/d2/f.txt", 0)],
        ),
        (
            "mv /m/a.txt /m/b.txt",
            [("rename", "/m/a.txt", 0), ("rename", "/m/b.txt", 0)],
        ),
        (
            "mv /m/d /m/d2",
            [("rename_prefix", "/m/d", 0), ("rename_prefix", "/m/d2", 0)],
        ),
        ("rm /m/a.txt", [("unlink", "/m/a.txt", 0)]),
        ("mkdir /m/x", [("mkdir", "/m/x", 0)]),
        ("mkdir -p /m/y/z", [("mkdir", "/m/y/z", 0)]),
        ("rmdir /m/e", [("rmdir", "/m/e", 0)]),
        ("rm -r /m/d", [("rm_r", "/m/d", 0)]),
    ],
)
def test_disk_mutation_records_object_store_rows(tmp_path, line, expected):
    _seed(tmp_path)
    assert asyncio.run(_rows(tmp_path, line)) == expected


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("rm /m/missing", []),
        ("mv /m/missing /m/x", []),
        ("mkdir /m/e", []),
        ("rmdir /m/d", []),
        ("mkdir -p /m/a.txt/z", [("mkdir", "/m/a.txt/z", 0)]),
    ],
)
def test_failed_disk_mutation_records_only_what_it_may_have_changed(
    tmp_path, line, expected
):
    _seed(tmp_path)
    assert asyncio.run(_rows(tmp_path, line, 1)) == expected


async def _partial_rows(root: Path, line: str) -> list[tuple[str, str, int]]:
    _seed(root)
    (root / "ro").mkdir()
    (root / "d" / "s").mkdir()
    (root / "d" / "s" / "g.txt").write_bytes(b"g\n")
    os.chmod(root / "ro", 0o500)
    os.chmod(root / "d" / "s", 0o500)
    try:
        return await _rows(root, line, 1)
    finally:
        os.chmod(root / "ro", 0o700)
        os.chmod(root / "d" / "s", 0o700)


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory modes")
@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("cp /m/a.txt /m/ro/c.txt", [("copy", "/m/ro/c.txt", 0)]),
        ("rm -r /m/d", [("rm_r", "/m/d", 0)]),
    ],
)
def test_partly_failed_disk_mutation_still_records(tmp_path, line, expected):
    assert asyncio.run(_partial_rows(tmp_path, line)) == expected
    if line.startswith("rm"):
        assert not (tmp_path / "d" / "f.txt").exists()


def _fills_then_fails(src, dst):
    Path(dst).write_bytes(b"half")
    raise OSError(errno.ENOSPC, "No space left on device")


def _failed_cp(root: Path, monkeypatch, outcome: str) -> str:
    """Set up a cp of /m/a.txt that fails, and return its destination.

    Args:
        root (Path): the disk mount's root.
        monkeypatch (pytest.MonkeyPatch): patches the copy for "partial".
        outcome (str): "failed" refuses the destination's directory;
            "partial" writes half the file and runs out of space.
    """
    _seed(root)
    if outcome == "failed":
        (root / "ro").mkdir()
        os.chmod(root / "ro", 0o500)
        return "/m/ro/c.txt"
    monkeypatch.setattr(shutil, "copyfile", _fills_then_fails)
    return "/m/c.txt"


_CP_OUTCOMES = [("failed", False, 13), ("partial", True, 28)]


class RecordsByCommand(Policy):
    def __init__(self) -> None:
        self.seen: dict[str, list[dict]] = {}

    async def post_command(self, ctx: CommandResultContext) -> Action | None:
        self.seen[ctx.command] = list(ctx.records)
        return None


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory modes")
@pytest.mark.parametrize(("outcome", "changed", "number"), _CP_OUTCOMES)
def test_a_failed_disk_cp_reaches_post_command(
    tmp_path, monkeypatch, outcome, changed, number
):
    dst = _failed_cp(tmp_path, monkeypatch, outcome)

    async def run() -> list[dict]:
        ws = Workspace({"/m/": DiskVFS(root=tmp_path)}, mode=MountMode.WRITE)
        policy = RecordsByCommand()
        ws.policies.add(policy)
        try:
            io = await ws.shell(f"cp /m/a.txt {dst}")
            assert io.exit_code == 1
            return policy.seen["cp"]
        finally:
            await ws.close()

    try:
        seen = asyncio.run(run())
    finally:
        if (tmp_path / "ro").exists():
            os.chmod(tmp_path / "ro", 0o700)
    (copy,) = [r for r in seen if r["op"] == "copy"]
    assert (copy["path"], copy["status"], copy["errno"], copy["changed"]) == (
        dst,
        outcome,
        number,
        changed,
    )
