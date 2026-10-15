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
from mirage.core.s3.readdir import readdir
from mirage.core.s3.stat import stat
from mirage.types import FileType, PathSpec
from mirage.vfs.s3 import S3Config
from tests.e2e.s3_mock import patch_s3_multi

EXPECTED_MODIFIED = "2026-03-31T00:00:00Z"


def _accessor():
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    return S3Accessor(config)


def test_readdir_answers_the_modified_time_of_files():
    store = {"dir/a.txt": b"hello", "dir/sub/b.txt": b"x"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        scope = PathSpec(vfs_path="dir", virtual="/dir", directory="/dir")
        rows = {
            row.name: row for row in asyncio.run(readdir(_accessor(), scope))
        }
        assert rows["a.txt"].type == FileType.FILE
        assert rows["a.txt"].modified == EXPECTED_MODIFIED
        assert rows["a.txt"].size == 5
        # S3 "folders" are synthetic common-prefixes: no time recorded.
        assert rows["sub"].type == FileType.DIRECTORY
        assert rows["sub"].modified is None
    finally:
        stack.close()


def test_stat_returns_the_modified_time():
    store = {"dir/a.txt": b"hello"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        target = PathSpec(
            vfs_path="dir/a.txt", virtual="/dir/a.txt", directory="/dir"
        )
        result = asyncio.run(stat(_accessor(), target))
        assert result.modified == EXPECTED_MODIFIED
        assert result.size == 5
        assert result.type != FileType.DIRECTORY
    finally:
        stack.close()
