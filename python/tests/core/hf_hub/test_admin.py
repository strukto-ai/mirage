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

from unittest.mock import patch

import pytest

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.hf_hub.admin import (
    create_repo,
    create_tag,
    delete_tag,
    list_tags,
    split_repo_id,
)
from mirage.core.hf_hub.config import HfConfig

ACCOUNT = HfAccountAccessor(HfConfig(token="t"))


def test_split_repo_id_takes_the_two_halves_apart():
    """The create and delete endpoints do not take a namespace/name id;
    they take the two separately, and a bare name means your own."""
    assert split_repo_id("acme/widget") == ("acme", "widget")
    assert split_repo_id("widget") == (None, "widget")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_post")
async def test_create_repo_sends_name_organization_and_type(mock_post):
    mock_post.return_value = {"url": "https://huggingface.co/acme/widget"}
    await create_repo(ACCOUNT, "acme/widget", "dataset")
    url, body = mock_post.await_args.args[1], mock_post.await_args.args[2]
    assert url.endswith("/api/repos/create")
    assert body == {
        "name": "widget",
        "organization": "acme",
        "type": "dataset",
    }


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_post")
async def test_create_repo_marks_visibility_only_when_private(mock_post):
    mock_post.return_value = {}
    await create_repo(ACCOUNT, "a/b", "model", private=True)
    assert mock_post.await_args.args[2]["visibility"] == "private"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_post")
async def test_create_repo_carries_a_space_sdk(mock_post):
    mock_post.return_value = {}
    await create_repo(ACCOUNT, "a/b", "space", space_sdk="gradio")
    assert mock_post.await_args.args[2]["sdk"] == "gradio"


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_post")
async def test_create_tag_targets_the_revision(mock_post):
    mock_post.return_value = {}
    await create_tag(ACCOUNT, "a/b", "v1", "model", "abc123", "note")
    assert mock_post.await_args.args[1].endswith("/tag/abc123")
    assert mock_post.await_args.args[2] == {"tag": "v1", "message": "note"}


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_request")
async def test_delete_tag_targets_the_tag_not_a_revision(mock_request):
    await delete_tag(ACCOUNT, "a/b", "v1")
    assert mock_request.await_args.args[2].endswith("/tag/v1")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_get")
async def test_list_tags_reads_refs_because_there_is_no_tag_listing(mock_get):
    mock_get.return_value = {
        "branches": [{"name": "main"}],
        "tags": [{"name": "v1"}, {"name": "v2"}],
    }
    assert await list_tags(ACCOUNT, "a/b") == ["v1", "v2"]
    assert mock_get.await_args.args[1].endswith("/refs")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_get")
async def test_list_tags_of_an_untagged_repo_is_empty(mock_get):
    mock_get.return_value = {"branches": [{"name": "main"}], "tags": []}
    assert await list_tags(ACCOUNT, "a/b") == []


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_post")
async def test_create_tag_encodes_a_revision_holding_a_slash(mock_post):
    mock_post.return_value = {}
    await create_tag(ACCOUNT, "a/b", "v1", "model", "feature/foo", None)
    assert mock_post.await_args.args[1].endswith("/tag/feature%2Ffoo")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.admin.hub_request")
async def test_delete_tag_encodes_a_tag_holding_a_slash(mock_request):
    await delete_tag(ACCOUNT, "a/b", "release/v1")
    assert mock_request.await_args.args[2].endswith("/tag/release%2Fv1")
