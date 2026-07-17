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

import pytest

from mirage.accessor.s3 import S3Config
from mirage.workspace.store.ram import RAMWorkspaceStateStore
from mirage.workspace.store.s3 import S3WorkspaceStateStore
from tests.workspace.s3_fake import FakeConditionalS3Client, patch_record_s3

BUCKET = "state-bucket"


def _config() -> S3Config:
    return S3Config(bucket=BUCKET,
                    region="us-east-1",
                    aws_access_key_id="fake",
                    aws_secret_access_key="fake",
                    key_prefix="mirage/")


@pytest.mark.asyncio
async def test_meta_roundtrip_and_layout():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3WorkspaceStateStore(_config())
        assert await store.load_meta("ws1") is None
        await store.set_meta("ws1", {
            "workspace_id": "ws1",
            "default_session_id": "main"
        })
        meta = await store.load_meta("ws1")
        await store.close()
    assert meta == {"workspace_id": "ws1", "default_session_id": "main"}
    assert (BUCKET, "mirage/workspaces/ws1.json") in client.objects


@pytest.mark.asyncio
async def test_cas_meta_conditional_create_single_winner():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store_a = S3WorkspaceStateStore(_config())
        store_b = S3WorkspaceStateStore(_config())
        record = {"workspace_id": "ws1", "generation": 1}
        results = await asyncio.gather(
            store_a.cas_set_meta("ws1", record, 0),
            store_b.cas_set_meta("ws1", dict(record), 0))
        await store_a.close()
        await store_b.close()
    assert sorted(results) == [False, True]


@pytest.mark.asyncio
async def test_replace_meta_retries_over_competing_writer():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3WorkspaceStateStore(_config())
        await store.set_meta("ws1", {
            "workspace_id": "ws1",
            "created_at": 111.0,
            "generation": 4
        })
        written = await store.replace_meta("ws1", {
            "workspace_id": "ws1",
            "default_session_id": "restored"
        })
        await store.close()
    assert written["default_session_id"] == "restored"
    assert written["created_at"] == 111.0
    assert written["generation"] == 5


@pytest.mark.asyncio
async def test_sessions_group_scoped_per_workspace():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3WorkspaceStateStore(_config())
        sessions = store.sessions("ws1")
        assert store.sessions("ws1") is sessions
        await sessions.set("main", {"session_id": "main"})
        await store.close()
    assert (BUCKET, "mirage/ws1/sessions/main.json") in client.objects


@pytest.mark.asyncio
async def test_namespace_and_observer_planes_refused():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3WorkspaceStateStore(_config())
        with pytest.raises(RuntimeError, match="sessions\\+meta group"):
            store.namespace("ws1")
        with pytest.raises(RuntimeError, match="sessions\\+meta group"):
            store.observer("ws1")
        await store.close()


@pytest.mark.asyncio
async def test_workspace_group_override_routes_to_s3():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        s3_store = S3WorkspaceStateStore(_config())
        store = RAMWorkspaceStateStore(workspace=s3_store)
        store.namespace("ws1")
        store.observer("ws1")
        await store.sessions("ws1").set("main", {"session_id": "main"})
        await store.set_meta("ws1", {"workspace_id": "ws1"})
        await store.close()
    assert (BUCKET, "mirage/ws1/sessions/main.json") in client.objects
    assert (BUCKET, "mirage/workspaces/ws1.json") in client.objects
