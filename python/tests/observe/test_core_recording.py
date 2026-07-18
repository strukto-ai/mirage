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

from mirage.observe.context import RecordingScope
from mirage.resource.ram import RAMResource
from mirage.types import PathSpec


def _run(coro):
    return asyncio.run(coro)


def test_memory_read_records_bytes():
    mem = RAMResource()
    mem._store.files["/hello.txt"] = b"hello world"
    scope = RecordingScope()
    records = scope.records
    data = _run(mem.read_bytes(PathSpec.from_str_path("/hello.txt")))
    scope.close()
    assert data == b"hello world"
    assert len(records) == 1
    assert records[0].op == "read"
    assert records[0].bytes == 11
    assert records[0].source == "ram"


def test_memory_write_records_bytes():
    mem = RAMResource()
    mem._store.dirs.add("/")
    scope = RecordingScope()
    records = scope.records
    _run(mem.write(PathSpec.from_str_path("/hello.txt"), b"hello"))
    scope.close()
    assert len(records) == 1
    assert records[0].op == "write"
    assert records[0].bytes == 5


def test_no_recording_context_is_noop():
    mem = RAMResource()
    mem._store.files["/hello.txt"] = b"hello"
    data = _run(mem.read_bytes(PathSpec.from_str_path("/hello.txt")))
    assert data == b"hello"
