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

from mirage.core.hf_buckets.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_file_returns_size_and_etag(make_acc):
    acc = make_acc({"data/file.txt": b"abcde"})
    s = await stat(acc, PathSpec.from_str_path("/data/file.txt"))
    assert s.name == "file.txt"
    assert s.size == 5
    assert s.fingerprint == "etag-data/file.txt"
    assert s.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_directory_via_dir_probe(make_acc):
    acc = make_acc({"data/file.txt": b"x"})
    s = await stat(acc, PathSpec.from_str_path("/data"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "data"


@pytest.mark.asyncio
async def test_stat_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await stat(acc, PathSpec.from_str_path("/missing.txt"))


@pytest.mark.asyncio
async def test_stat_root_is_directory(make_acc):
    acc = make_acc({})
    s = await stat(acc, PathSpec.from_str_path("/"))
    assert s.type == FileType.DIRECTORY
