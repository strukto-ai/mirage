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

from mirage.core.slack.files_list import (list_files_for_day,
                                          list_files_for_day_stream)
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_list_files_for_day_scopes_to_channel_and_date():
    cfg = SlackConfig(token="xoxp-t")
    captured = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "files.list"
        captured.append(dict(params or {}))
        return {
            "files": [{
                "id": "F1",
                "title": "doc.pdf"
            }],
            "paging": {
                "page": 1,
                "pages": 1
            }
        }

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        files = await list_files_for_day(cfg,
                                         channel_id="C1",
                                         date_str="2026-05-10")

    assert files[0]["id"] == "F1"
    assert captured[0]["channel"] == "C1"
    assert "ts_from" in captured[0]
    assert "ts_to" in captured[0]
    assert captured[0]["count"] == "200"
    assert captured[0]["page"] == "1"


@pytest.mark.asyncio
async def test_list_files_for_day_walks_multiple_pages():
    cfg = SlackConfig(token="xoxp-t")
    pages = [
        {
            "files": [{
                "id": "F1"
            }],
            "paging": {
                "page": 1,
                "pages": 2
            }
        },
        {
            "files": [{
                "id": "F2"
            }],
            "paging": {
                "page": 2,
                "pages": 2
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, _method, params=None, token=None):
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        files = await list_files_for_day(cfg, "C1", "2026-05-10")

    assert [f["id"] for f in files] == ["F1", "F2"]
    assert calls[0]["page"] == "1"
    assert calls[1]["page"] == "2"


@pytest.mark.asyncio
async def test_list_files_for_day_stream_yields_each_page():
    cfg = SlackConfig(token="xoxp-t")
    pages = [
        {
            "files": [{
                "id": "F1"
            }],
            "paging": {
                "page": 1,
                "pages": 2
            }
        },
        {
            "files": [{
                "id": "F2"
            }],
            "paging": {
                "page": 2,
                "pages": 2
            }
        },
    ]
    calls = {"n": 0}

    async def fake_get(_cfg, _method, params=None, token=None):
        page = pages[calls["n"]]
        calls["n"] += 1
        return page

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in list_files_for_day_stream(cfg, "C1", "2026-05-10"):
            seen.append(page)

    assert seen == [[{"id": "F1"}], [{"id": "F2"}]]
