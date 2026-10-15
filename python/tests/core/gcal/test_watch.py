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

import aiohttp
import pytest

from mirage.core.gcal.watch import build_delta_hook, event_paths
from mirage.types import FileChangeKind
from tests.fixtures.gcal_api import (
    EVENTS,
    HK,
    PRIMARY,
    event,
    make_accessor,
    spec,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("gcal_api")]

DAY = "/primary/2026-08-11"
MOVED = {
    **event(
        "aaaa1",
        "PhD Defense",
        "2026-08-11T10:00:00+08:00",
        "2026-08-11T11:30:00+08:00",
    ),
    "updated": "2026-08-02T00:00:00.000Z",
}
NEW = event(
    "ffff6", "Retro", "2026-08-12T09:00:00+08:00", "2026-08-12T10:00:00+08:00"
)


class Syncs:
    """Calendar's incremental sync, scripted by the token it is asked from."""

    def __init__(self, answers):
        self.answers = answers
        self.asked: list[str | None] = []

    async def __call__(
        self, token_manager, calendar_id, token, time_zone=None
    ):
        assert calendar_id == PRIMARY["id"]
        self.asked.append(token)
        answer = self.answers[token]
        if isinstance(answer, Exception):
            raise answer
        return answer


def _gone() -> aiohttp.ClientResponseError:
    return aiohttp.ClientResponseError(None, (), status=410)  # type: ignore[arg-type]


async def test_a_watch_follows_each_event_s_files(monkeypatch):
    syncs = Syncs(
        {
            None: ([EVENTS[0], EVENTS[1]], "t1"),
            "t1": (
                [MOVED, {"id": "bbbb2", "status": "cancelled"}, NEW],
                "t2",
            ),
            "t2": _gone(),
        }
    )
    monkeypatch.setattr("mirage.core.gcal.watch.sync_events", syncs)
    hook = build_delta_hook(make_accessor())
    root = spec("/primary")
    baseline = await hook.pull(root, None)
    assert baseline.changes == ()
    moved = await hook.pull(root, baseline.checkpoint)
    assert [(c.kind, c.path.virtual) for c in moved.changes] == [
        (
            FileChangeKind.DELETE,
            f"{DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json",
        ),
        (
            FileChangeKind.CREATE,
            f"{DAY}/aaaa1__1000-1130_PhD_Defense.gcal.json",
        ),
        (
            FileChangeKind.DELETE,
            f"{DAY}/bbbb2__1500-1600_Committee_Meeting.gcal.json",
        ),
        (
            FileChangeKind.CREATE,
            "/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json",
        ),
    ]
    # A token Calendar dropped is answered by the whole calendar, where
    # only an event whose stamp moved since is reported.
    syncs.answers[None] = (
        [MOVED, {**NEW, "updated": "2026-08-03T00:00:00.000Z"}],
        "t3",
    )
    expired = await hook.pull(root, moved.checkpoint)
    assert [(c.kind, c.path.virtual) for c in expired.changes] == [
        (
            FileChangeKind.UPDATE,
            "/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json",
        ),
    ]
    assert syncs.asked == [None, "t1", "t2", None]


async def test_an_event_outside_the_time_range_is_no_file():
    # The listing of its day leaves it out, so its changes name nothing.
    accessor = make_accessor(
        start_time="2026-08-12T12:00:00+08:00",
        end_time="2026-08-12T18:00:00+08:00",
    )
    inside = event(
        "eeee5",
        "Lunch",
        "2026-08-12T13:00:00+08:00",
        "2026-08-12T14:00:00+08:00",
    )
    assert event_paths(accessor, "/primary", NEW, HK, False) == []
    assert event_paths(accessor, "/primary", inside, HK, False) == [
        "/primary/2026-08-12/eeee5__1300-1400_Lunch.gcal.json"
    ]
