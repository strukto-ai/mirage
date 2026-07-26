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
        bucket="shared-bucket",
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


def test_two_workspaces_always_sees_other_writers_update():
    store = {"file.txt": b"v1"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"shared-bucket": store}))
    try:
        ws_a = _make_ws(ConsistencyPolicy.ALWAYS)
        ws_b = _make_ws(ConsistencyPolicy.ALWAYS)

        async def run() -> tuple[bytes, bytes]:
            io_b1 = await ws_b.execute("cat /data/file.txt")
            b_first = await io_b1.materialize_stdout()

            await ws_a.execute('echo -n "v2" > /data/file.txt')

            io_b2 = await ws_b.execute("cat /data/file.txt")
            b_second = await io_b2.materialize_stdout()
            return b_first, b_second

        b_first, b_second = asyncio.run(run())
        assert b_first == b"v1"
        assert b_second == b"v2", (
            "Workspace B under ALWAYS must see Workspace A's write "
            "via fingerprint mismatch; got stale cached bytes")
    finally:
        stack.close()


def test_two_workspaces_lazy_may_serve_stale_after_other_writer():
    store = {"file.txt": b"v1"}
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"shared-bucket": store}))
    try:
        ws_a = _make_ws(ConsistencyPolicy.LAZY)
        ws_b = _make_ws(ConsistencyPolicy.LAZY)

        async def run() -> bytes:
            io_b1 = await ws_b.execute("cat /data/file.txt")
            await io_b1.materialize_stdout()

            await ws_a.execute('echo -n "v2" > /data/file.txt')

            io_b2 = await ws_b.execute("cat /data/file.txt")
            return await io_b2.materialize_stdout()

        b_second = asyncio.run(run())
        assert b_second in (b"v1", b"v2"), (
            "LAZY is allowed to serve cached bytes; this just documents "
            "the trade-off (cache was populated before A's write)")
    finally:
        stack.close()
