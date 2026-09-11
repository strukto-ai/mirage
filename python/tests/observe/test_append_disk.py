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

from mirage import MountMode, Workspace
from mirage.ops import Ops
from mirage.resource.disk import DiskResource


def _make_ops(tmp_path: Path) -> tuple[Ops, DiskResource]:
    disk = DiskResource(root=tmp_path)
    ws = Workspace({"/disk/": disk}, mode=MountMode.WRITE)
    return ws.fs, disk


def test_append_creates_file(tmp_path):
    ops, _ = _make_ops(tmp_path)
    asyncio.run(ops.append("/disk/test.jsonl", b"line1\n"))
    assert (tmp_path / "test.jsonl").read_bytes() == b"line1\n"


def test_append_concatenates(tmp_path):
    ops, _ = _make_ops(tmp_path)
    (tmp_path / "test.jsonl").write_bytes(b"line1\n")
    asyncio.run(ops.append("/disk/test.jsonl", b"line2\n"))
    assert (tmp_path / "test.jsonl").read_bytes() == b"line1\nline2\n"
