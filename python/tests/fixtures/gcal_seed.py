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

from collections.abc import Callable
from typing import Any

import pytest_asyncio

from mirage.accessor.gcal import GCalAccessor
from mirage.core.google.client import TokenManager
from mirage.types import PathSpec
from mirage.utils.clock import Clock
from mirage.vfs.gcal.config import GCalConfig
from tests.fixtures.google_account import GoogleAccount

HK = "Asia/Hong_Kong"
TODAY = "2026-08-11"
TEAM = "team@group.calendar.google.com"
SHARED = "busy@group.calendar.google.com"

# Each event of the primary calendar: its id, title, start and end. A
# ``YYYY-MM-DD`` pair is an all-day event.
EVENTS = [
    (
        "aaaa1",
        "PhD Defense",
        "2026-08-11T09:00:00+08:00",
        "2026-08-11T10:30:00+08:00",
    ),
    (
        "bbbb2",
        "Committee Meeting",
        "2026-08-11T15:00:00+08:00",
        "2026-08-11T16:00:00+08:00",
    ),
    (
        "cccc3",
        "Conference",
        "2026-08-10T09:00:00+08:00",
        "2026-08-13T17:00:00+08:00",
    ),
    ("dddd4", "Public Holiday", "2026-08-11", "2026-08-12"),
    (
        "eeee5",
        "Last Year",
        "2025-01-05T09:00:00+08:00",
        "2025-01-05T10:00:00+08:00",
    ),
]


def copies(prefix: str) -> list[dict[str, Any]]:
    """``EVENTS`` as a shared calendar holds them, each id led by
    ``prefix``: an event id is unique in the account.

    Args:
        prefix (str): what leads each id.
    """
    out: list[dict[str, Any]] = []
    for event_id, summary, start, end in EVENTS:
        key = "date" if len(start) == 10 else "dateTime"
        out.append(
            {
                "id": prefix + event_id,
                "summary": summary,
                "start": {key: start},
                "end": {key: end},
            }
        )
    return out


async def seed(account: GoogleAccount) -> None:
    """Give the account the calendars the gcal tests read: its own
    primary, in Hong Kong, holding ``EVENTS``; Engineering, a Los Angeles
    calendar shared with it to read; and Exec, shared with it free/busy
    only. Both shared calendars hold the same events under ids of their
    own, ``t`` and ``s`` before each.

    Args:
        account (GoogleAccount): the account.
    """
    await account.calendars(
        {
            "id": TEAM,
            "summary": "Engineering",
            "timeZone": "America/Los_Angeles",
            "accessRole": "reader",
            "events": copies("t"),
        },
        {
            "id": SHARED,
            "summary": "Exec",
            "timeZone": HK,
            "accessRole": "freeBusyReader",
            "events": copies("s"),
        },
    )
    for event_id, summary, start, end in EVENTS:
        await account.event(summary, start, end, event_id=event_id)


@pytest_asyncio.fixture
async def calendar(google_account: GoogleAccount) -> GoogleAccount:
    """The account holding the calendars ``seed`` gives it, its requests
    recorded from here."""
    await seed(google_account)
    await google_account.run.record_requests()
    return google_account


def gcal_config(account: GoogleAccount, **overrides: Any) -> GCalConfig:
    """A mount config signed in to ``account``, today pinned to ``TODAY``.

    Args:
        account (GoogleAccount): the account.
        **overrides (Any): GCalConfig fields to set.
    """
    return account.config(GCalConfig, **({"today": TODAY} | overrides))


def make_accessor(
    account: GoogleAccount,
    capped: Callable[[], bool] = lambda: True,
    clock: Clock | None = None,
    **overrides: Any,
) -> GCalAccessor:
    """An accessor for ``gcal_config(account, **overrides)``.

    Args:
        account (GoogleAccount): the account.
        capped (Callable[[], bool]): whether its mount walks under a
            ``walk_limit``.
        clock (Clock | None): the clock its retries wait on; None is the
            system clock.
        **overrides (Any): GCalConfig fields to set.
    """
    config = gcal_config(account, **overrides)
    return GCalAccessor(config, TokenManager(config, clock), capped)


async def event_listings(
    account: GoogleAccount,
) -> list[tuple[str, ...]]:
    """Each events listing asked since recording started, as
    ``(calendar, timeMin, timeMax)``, None for a bound it leaves open.

    Args:
        account (GoogleAccount): the account.
    """
    return [
        entry[1:]
        for entry in await account.calendar_log()
        if entry[0] == "list"
    ]


def spec(virtual: str, pattern: str | None = None) -> PathSpec:
    """A mount-relative PathSpec, globbed when a pattern is given.

    Args:
        virtual (str): the path below the mount root.
        pattern (str | None): the glob typed for the directory's children.
    """
    directory = (virtual.rsplit("/", 1)[0] or "/") if pattern else virtual
    return PathSpec(
        virtual=virtual,
        directory=directory,
        vfs_path=virtual.lstrip("/"),
        pattern=pattern,
    )


def names(paths: list[str]) -> list[str]:
    """The last segment of each listed path.

    Args:
        paths (list[str]): what a readdir returned.
    """
    return [p.rsplit("/", 1)[-1] for p in paths]
