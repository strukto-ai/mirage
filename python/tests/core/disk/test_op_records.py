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
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.vfs.disk import DiskVFS

MUTATIONS = frozenset(
    {"copy", "rename", "rename_prefix", "unlink", "mkdir", "rmdir", "rm_r"}
)


async def _rows(root: Path, line: str) -> list[tuple[str, str, int]]:
    (root / "a.txt").write_bytes(b"hello\n")
    (root / "e").mkdir()
    (root / "d").mkdir()
    (root / "d" / "f.txt").write_bytes(b"f\n")
    ws = Workspace({"/m/": DiskVFS(root=root)}, mode=MountMode.WRITE)
    start = len(ws.vfs.records)
    io = await ws.shell(line)
    assert io.exit_code == 0, await io.stderr_str()
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
    assert asyncio.run(_rows(tmp_path, line)) == expected
