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

from mirage.core.hf_buckets.create import create
from mirage.core.hf_buckets.unlink import unlink
from mirage.core.hf_buckets.write import write_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_write_bytes_uploads(make_acc):
    acc = make_acc({})
    await write_bytes(acc, PathSpec.from_str_path("/hello.txt"), b"hi there")
    assert acc._fake.files == {"hello.txt": b"hi there"}


@pytest.mark.asyncio
async def test_unlink_deletes_file(make_acc):
    acc = make_acc({"delete-me.txt": b"x"})
    await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    assert "delete-me.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_unlink_refuses_directory(make_acc):
    acc = make_acc({"some-dir/child.txt": b"x"})
    with pytest.raises(IsADirectoryError):
        await unlink(acc, PathSpec.from_str_path("/some-dir"))
    assert "some-dir/child.txt" in acc._fake.files


@pytest.mark.asyncio
async def test_create_writes_empty_file(make_acc):
    acc = make_acc({})
    await create(acc, PathSpec.from_str_path("/touched.txt"))
    assert acc._fake.files.get("touched.txt") == b""
