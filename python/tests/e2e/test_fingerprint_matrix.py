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

from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import ConsistencyPolicy, MountMode
from mirage.workspace import Workspace
from tests.e2e.s3_mock import patch_s3_multi


def _make_ws(consistency: ConsistencyPolicy) -> Workspace:
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    resource = S3Resource(config)
    return Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=consistency,
    )


def test_s3_always_refetches_after_external_mutation():
    store = {"file.txt": b"v1"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        ws = _make_ws(ConsistencyPolicy.ALWAYS)

        async def run() -> tuple[bytes, bytes]:
            io1 = await ws.execute("cat /data/file.txt")
            first = await io1.materialize_stdout()
            store["file.txt"] = b"v2"
            io2 = await ws.execute("cat /data/file.txt")
            second = await io2.materialize_stdout()
            return first, second

        first, second = asyncio.run(run())
        assert first == b"v1"
        assert second == b"v2", (
            "S3 ALWAYS must refetch after external write to the mocked store")
    finally:
        stack.close()


def test_s3_lazy_serves_cache():
    store = {"file.txt": b"v1"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        ws = _make_ws(ConsistencyPolicy.LAZY)

        async def run() -> tuple[bytes, bytes]:
            io1 = await ws.execute("cat /data/file.txt")
            first = await io1.materialize_stdout()
            store["file.txt"] = b"v2"
            io2 = await ws.execute("cat /data/file.txt")
            second = await io2.materialize_stdout()
            return first, second

        first, second = asyncio.run(run())
        assert first == b"v1"
        assert second == b"v1", (
            "S3 LAZY must serve cached bytes even after store mutation")
    finally:
        stack.close()
