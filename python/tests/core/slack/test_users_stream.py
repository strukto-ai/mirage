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

from mirage.core.slack.users import list_users_stream
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_list_users_stream_walks_pages_and_filters():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "members": [
                {
                    "id": "U1",
                    "name": "alice",
                    "deleted": False,
                    "is_bot": False
                },
                {
                    "id": "U2",
                    "name": "bot",
                    "deleted": False,
                    "is_bot": True
                },
            ],
            "response_metadata": {
                "next_cursor": "cur1"
            },
        },
        {
            "members": [
                {
                    "id": "USLACKBOT",
                    "name": "slackbot",
                    "deleted": False,
                    "is_bot": False
                },
                {
                    "id": "U3",
                    "name": "bob",
                    "deleted": False,
                    "is_bot": False
                },
            ],
            "response_metadata": {
                "next_cursor": ""
            },
        },
    ]
    calls = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "users.list"
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in list_users_stream(cfg):
            seen.append(page)

    assert len(seen) == 2
    assert [u["name"] for u in seen[0]] == ["alice"]
    assert [u["name"] for u in seen[1]] == ["bob"]
    assert calls[0]["limit"] == 200
    assert calls[1]["cursor"] == "cur1"
