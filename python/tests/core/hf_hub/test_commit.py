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

import base64
import json
from unittest.mock import patch

import pytest

from mirage.core.hf_hub.commit import (
    Addition,
    LfsRequiredError,
    commit,
    commit_url,
    payload,
    upload_modes,
)


def _lines(raw: bytes):
    return [json.loads(line) for line in raw.splitlines()]


def test_commit_url_targets_the_mount_revision(accessor):
    assert commit_url(accessor).endswith("/api/models/acme/widget/commit/main")
    assert commit_url(accessor, "dev").endswith("/commit/dev")


def test_commit_url_encodes_a_revision_holding_a_slash(accessor):
    """Unencoded, `feature/foo` names revision `feature` and a subtree,
    so the commit lands somewhere else or not at all."""
    assert commit_url(accessor, "feature/foo").endswith(
        "/commit/feature%2Ffoo"
    )


def test_payload_puts_the_header_first():
    lines = _lines(payload([], [], "msg", "body"))
    assert lines[0] == {
        "key": "header",
        "value": {"summary": "msg", "description": "body"},
    }


def test_payload_base64_encodes_a_file():
    lines = _lines(payload([Addition("a.txt", b"hi")], [], "m"))
    assert lines[1]["key"] == "file"
    assert lines[1]["value"]["encoding"] == "base64"
    assert base64.b64decode(lines[1]["value"]["content"]) == b"hi"
    assert lines[1]["value"]["path"] == "a.txt"


def test_payload_spells_a_deletion_as_a_deleted_file():
    lines = _lines(payload([], ["a.txt"], "m"))
    assert lines[1] == {"key": "deletedFile", "value": {"path": "a.txt"}}


def test_payload_carries_a_parent_commit_when_given():
    lines = _lines(payload([], [], "m", parent="abc"))
    assert lines[0]["value"]["parentCommit"] == "abc"


def test_payload_omits_the_parent_when_absent():
    assert "parentCommit" not in _lines(payload([], [], "m"))[0]["value"]


def test_payload_is_newline_delimited():
    raw = payload([Addition("a", b"x")], ["b"], "m")
    assert raw.endswith(b"\n")
    assert len(raw.splitlines()) == 3


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_upload_modes_sends_a_sample_not_the_content(
    mock_post, accessor
):
    mock_post.return_value = {
        "files": [{"path": "a.txt", "uploadMode": "regular"}]
    }
    modes = await upload_modes(accessor, [Addition("a.txt", b"x" * 2000)])
    body = mock_post.await_args.args[2]
    sample = base64.b64decode(body["files"][0]["sample"])
    assert len(sample) == 512
    assert body["files"][0]["size"] == 2000
    assert modes == {"a.txt": "regular"}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_upload_modes_asks_nothing_for_no_additions(mock_post, accessor):
    assert await upload_modes(accessor, []) == {}
    mock_post.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post_ndjson")
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_commit_refuses_a_file_the_hub_wants_via_lfs(
    mock_post, mock_ndjson, accessor
):
    """Committing it anyway would reference content the Hub never
    received: the file would appear in the tree and every read fail."""
    mock_post.return_value = {
        "files": [{"path": "big.bin", "uploadMode": "lfs"}]
    }
    with pytest.raises(LfsRequiredError):
        await commit(accessor, additions=[Addition("big.bin", b"x")])
    mock_ndjson.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post_ndjson")
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_commit_posts_ndjson_for_a_regular_file(
    mock_post, mock_ndjson, accessor
):
    mock_post.return_value = {
        "files": [{"path": "a.txt", "uploadMode": "regular"}]
    }
    mock_ndjson.return_value = {"commitOid": "abc"}
    result = await commit(accessor, additions=[Addition("a.txt", b"hi")])
    assert result == {"commitOid": "abc"}
    assert mock_ndjson.await_args.args[3] is None


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post_ndjson")
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_commit_can_open_a_pull_request(
    mock_post, mock_ndjson, accessor
):
    mock_post.return_value = {"files": []}
    mock_ndjson.return_value = {}
    await commit(accessor, deletions=["a.txt"], create_pr=True)
    assert mock_ndjson.await_args.args[3] == {"create_pr": "1"}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post_ndjson")
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_a_delete_only_commit_skips_the_preupload_probe(
    mock_post, mock_ndjson, accessor
):
    mock_ndjson.return_value = {}
    await commit(accessor, deletions=["a.txt"])
    mock_post.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.commit.hub_post")
async def test_upload_modes_encodes_a_revision_holding_a_slash(
    mock_post, accessor
):
    mock_post.return_value = {"files": []}
    await upload_modes(accessor, [Addition("a.txt", b"x")], "feature/foo")
    assert mock_post.await_args.args[1].endswith("/preupload/feature%2Ffoo")
