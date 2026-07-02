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
from contextlib import ExitStack

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import RAMIndexCacheStore, ResourceType
from mirage.core.s3.readdir import readdir
from mirage.core.s3.stat import stat
from mirage.resource.s3 import S3Config
from mirage.types import FileType, PathSpec
from tests.integration.s3_mock import patch_s3_multi

EXPECTED_MODIFIED = "2026-03-31T00:00:00Z"


def _accessor():
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    return S3Accessor(config)


def test_readdir_stores_remote_time_for_files():
    store = {"dir/a.txt": b"hello", "dir/sub/b.txt": b"x"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        accessor = _accessor()
        cache = RAMIndexCacheStore(ttl=60)
        scope = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
        asyncio.run(readdir(accessor, scope, cache))
        file_lookup = asyncio.run(cache.get("/dir/a.txt"))
        assert file_lookup.entry is not None
        assert file_lookup.entry.resource_type == ResourceType.FILE
        assert file_lookup.entry.remote_time == EXPECTED_MODIFIED
        # S3 "folders" are synthetic common-prefixes: no time recorded.
        dir_lookup = asyncio.run(cache.get("/dir/sub"))
        assert dir_lookup.entry is not None
        assert dir_lookup.entry.resource_type == ResourceType.FOLDER
        assert dir_lookup.entry.remote_time == ""
    finally:
        stack.close()


def test_stat_returns_modified_from_index():
    store = {"dir/a.txt": b"hello"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        accessor = _accessor()
        cache = RAMIndexCacheStore(ttl=60)
        scope = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
        asyncio.run(readdir(accessor, scope, cache))
        target = PathSpec(resource_path="dir/a.txt",
                          virtual="/dir/a.txt",
                          directory="/dir")
        result = asyncio.run(stat(accessor, target, index=cache))
        assert result.modified == EXPECTED_MODIFIED
        assert result.size == 5
        assert result.type != FileType.DIRECTORY
    finally:
        stack.close()
