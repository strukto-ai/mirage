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

from mirage.core.slack.channels import list_channels_stream, list_dms_stream
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_list_channels_stream_yields_pages():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "channels": [{
                "id": "C1"
            }, {
                "id": "C2"
            }],
            "response_metadata": {
                "next_cursor": "cur1"
            }
        },
        {
            "channels": [{
                "id": "C3"
            }],
            "response_metadata": {
                "next_cursor": ""
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "conversations.list"
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in list_channels_stream(cfg):
            seen.append(page)
    assert [ch["id"] for ch in seen[0]] == ["C1", "C2"]
    assert [ch["id"] for ch in seen[1]] == ["C3"]
    assert calls[0]["types"] == "public_channel,private_channel"
    assert calls[0]["exclude_archived"] == "true"
    assert calls[0]["limit"] == 200


@pytest.mark.asyncio
async def test_list_dms_stream_uses_im_mpim_types():
    cfg = SlackConfig(token="xoxb-t")
    calls = []

    async def fake_get(_cfg, _method, params=None, token=None):
        calls.append(dict(params or {}))
        return {"channels": [], "response_metadata": {"next_cursor": ""}}

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        async for _ in list_dms_stream(cfg):
            pass
    assert calls[0]["types"] == "im,mpim"
