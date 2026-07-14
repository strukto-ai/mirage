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
from mirage.cache.index import NULL_INDEX
from mirage.core.s3.stat import stat
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec
from tests.integration.s3_mock import patch_s3_multi


def test_s3_stat_returns_fingerprint_from_etag():
    store = {"foo.txt": b"hello"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        config = S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
        accessor = S3Accessor(config)
        scope = PathSpec(resource_path="foo.txt",
                         virtual="/foo.txt",
                         directory="/")
        result = asyncio.run(stat(accessor, scope, index=NULL_INDEX))
        assert result.fingerprint is not None
        assert result.fingerprint == result.extra.get("etag")
    finally:
        stack.close()
