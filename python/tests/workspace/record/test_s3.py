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

from mirage.vfs.s3.config import S3Config
from mirage.workspace.record.s3 import S3RecordClient
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session


@pytest.mark.asyncio
async def test_the_record_client_opens_through_the_s3_test_seam():
    # The record stores used to build their own session, so a test that
    # patched the S3 seam still let them reach the network.
    session = MultiBucketSession({"b": {}})
    with patch_s3_session(session):
        records = S3RecordClient(S3Config(bucket="b"), "sessions/")
        await records.put("one", {"generation": 1})
        fields, etag = await records.get("one")
    assert fields == {"generation": 1}
    assert etag
    assert await records.client() is session._client
    assert "sessions/one.json" in session._client.buckets["b"]
