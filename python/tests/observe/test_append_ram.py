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

from mirage import MountMode, Workspace
from mirage.ops import Ops
from mirage.resource.ram import RAMResource


def _make_ops() -> tuple[Ops, RAMResource]:
    mem = RAMResource()
    ws = Workspace({"/data/": mem}, mode=MountMode.WRITE)
    return ws.fs, mem


def test_append_creates_file():
    ops, mem = _make_ops()
    asyncio.run(ops.append("/data/test.jsonl", b"line1\n"))
    assert mem._store.files["/test.jsonl"] == b"line1\n"


def test_append_concatenates():
    ops, mem = _make_ops()
    mem._store.files["/test.jsonl"] = b"line1\n"
    asyncio.run(ops.append("/data/test.jsonl", b"line2\n"))
    assert mem._store.files["/test.jsonl"] == b"line1\nline2\n"


def test_append_records_op():
    ops, mem = _make_ops()
    asyncio.run(ops.append("/data/test.jsonl", b"hello"))
    assert len(ops.records) == 1
    assert ops.records[0].op == "append"
    assert ops.records[0].bytes == 5
