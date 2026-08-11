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
import yarl

import mirage.core.gcal._client as client_mod
from mirage.core.gcal._client import delete_event, list_events
from mirage.core.google._client import TokenManager
from mirage.resource.gcal.config import GCalConfig

pytestmark = pytest.mark.asyncio

# A subscribed holiday calendar's real id. "#" opens a URL fragment and "@"
# is only legal in a userinfo segment, so an unencoded id would send the
# request to /calendars/en.usa with the rest dropped as a fragment.
HOLIDAY = "en.usa#holiday@group.v.calendar.google.com"


@pytest.fixture
def token_manager():
    return TokenManager(GCalConfig(client_id="cid", refresh_token="rt"))


async def test_list_events_encodes_the_calendar_id(monkeypatch, token_manager):
    seen: list[str] = []

    async def fake_get(tm, url, params=None):
        seen.append(url)
        return {}

    monkeypatch.setattr(client_mod, "google_get", fake_get)
    await list_events(token_manager, HOLIDAY, "2026-08-11T00:00:00+08:00",
                      "2026-08-12T00:00:00+08:00")
    assert "%23holiday%40group" in seen[0]
    parsed = yarl.URL(seen[0])
    assert parsed.fragment == ""
    assert parsed.path.endswith(f"/calendars/{HOLIDAY}/events")


async def test_delete_event_encodes_both_path_segments(monkeypatch,
                                                       token_manager):
    seen: list[str] = []

    async def fake_delete(tm, url):
        seen.append(url)

    monkeypatch.setattr(client_mod, "google_delete", fake_delete)
    await delete_event(token_manager, HOLIDAY, "evt#1")
    parsed = yarl.URL(seen[0])
    assert parsed.fragment == ""
    assert parsed.path.endswith(f"/calendars/{HOLIDAY}/events/evt#1")
