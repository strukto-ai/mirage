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
from mirage.core.s3.stat import stat
from mirage.resource.s3 import S3Config
from mirage.types import FileType, PathSpec
from tests.integration.s3_mock import patch_s3_multi


def _accessor() -> S3Accessor:
    return S3Accessor(
        S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        ))


def test_trailing_slash_prefers_directory_over_coexisting_object():
    store = {"csv": b"i am a file", "csv/1.txt": b"child"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        accessor = _accessor()
        file_stat = asyncio.run(
            stat(accessor,
                 PathSpec(resource_path="csv", virtual="/csv", directory="/"),
                 index=None))
        assert file_stat.type != FileType.DIRECTORY
        dir_stat = asyncio.run(
            stat(accessor,
                 PathSpec(resource_path="csv",
                          virtual="/csv/",
                          directory="/csv/"),
                 index=None))
        assert dir_stat.type == FileType.DIRECTORY
    finally:
        stack.close()
