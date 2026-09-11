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


def test_read_records_op_record():
    ops, mem = _make_ops()
    mem._store.files["/hello.txt"] = b"hello world"
    asyncio.run(ops.read("/data/hello.txt"))
    assert len(ops.records) == 1
    r = ops.records[0]
    assert r.op == "read"
    assert r.path == "/data/hello.txt"
    assert r.bytes == 11
    assert r.duration_ms >= 0


def test_write_records_op_record():
    ops, mem = _make_ops()
    asyncio.run(ops.write("/data/hello.txt", b"hello"))
    assert len(ops.records) == 1
    r = ops.records[0]
    assert r.op == "write"
    assert r.bytes == 5


def test_stat_records_op_record():
    ops, mem = _make_ops()
    mem._store.files["/hello.txt"] = b"hello"
    asyncio.run(ops.stat("/data/hello.txt"))
    assert len(ops.records) == 1
    assert ops.records[0].op == "stat"
    assert ops.records[0].bytes == 0


def test_cache_hit_records_source_memory():
    ops, mem = _make_ops()
    mem._store.files["/hello.txt"] = b"hello world"
    asyncio.run(ops.read("/data/hello.txt"))
    asyncio.run(ops.read("/data/hello.txt"))
    assert len(ops.records) == 2
    assert ops.records[0].source == "ram"
    assert ops.records[1].source == "ram"
