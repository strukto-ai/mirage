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

from mirage.resource.ram import RAMResource
from mirage.types import PathSpec


def _make_backend():
    b = RAMResource()
    b._store.dirs.add("/data")
    b._store.files["/data/file.txt"] = b"hello world"
    return b


def test_cat_updates_stats():
    b = _make_backend()
    data = asyncio.run(b.read_bytes(PathSpec.from_str_path("/data/file.txt")))
    assert data == b"hello world"


def test_tee_updates_stats():
    b = _make_backend()
    asyncio.run(
        b.write(PathSpec.from_str_path("/data/out.txt"), data=b"test data"))
    assert b._store.files["/data/out.txt"] == b"test data"


def test_callback_receives_events():
    b = _make_backend()
    data = asyncio.run(b.read_bytes(PathSpec.from_str_path("/data/file.txt")))
    assert data == b"hello world"


def test_write_callback_receives_events():
    b = _make_backend()
    asyncio.run(b.write(PathSpec.from_str_path("/data/out.txt"),
                        data=b"hello"))
    assert b._store.files["/data/out.txt"] == b"hello"


def test_stats_accumulate():
    b = _make_backend()
    asyncio.run(b.read_bytes(PathSpec.from_str_path("/data/file.txt")))
    asyncio.run(b.read_bytes(PathSpec.from_str_path("/data/file.txt")))
    assert b._store.files["/data/file.txt"] == b"hello world"
