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

from dataclasses import dataclass
from typing import Protocol

from mirage.core.gcal import client
from mirage.core.google.client import TokenManager
from mirage.core.time_range import TimeRange
from mirage.types import JsonValue


class CalendarApi(Protocol):
    """Every Calendar request the gcal backend makes, as one object.

    A core op reaches Calendar only through ``GCalAccessor.calendar``, so
    the backend runs against an in-memory calendar wherever another
    implementation is served there.
    """

    async def list_calendars(
        self, min_access_role: str | None = None
    ) -> list[dict[str, JsonValue]]: ...

    async def list_events(
        self,
        calendar_id: str,
        time_min: str | None,
        time_max: str,
        time_zone: str | None = None,
        *,
        scope: TimeRange = TimeRange(),
        query: str | None = None,
    ) -> list[dict[str, JsonValue]]: ...

    async def sync_events(
        self,
        calendar_id: str,
        sync_token: str | None,
        time_zone: str | None = None,
    ) -> tuple[list[dict[str, JsonValue]], str | None]: ...

    async def delete_event(self, calendar_id: str, event_id: str) -> None: ...


@dataclass(frozen=True, slots=True)
class CalendarClient:
    """The live ``CalendarApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def list_calendars(
        self, min_access_role: str | None = None
    ) -> list[dict[str, JsonValue]]:
        return await client.list_calendars(self.token_manager, min_access_role)

    async def list_events(
        self,
        calendar_id: str,
        time_min: str | None,
        time_max: str,
        time_zone: str | None = None,
        *,
        scope: TimeRange = TimeRange(),
        query: str | None = None,
    ) -> list[dict[str, JsonValue]]:
        return await client.list_events(
            self.token_manager,
            calendar_id,
            time_min,
            time_max,
            time_zone,
            scope=scope,
            query=query,
        )

    async def sync_events(
        self,
        calendar_id: str,
        sync_token: str | None,
        time_zone: str | None = None,
    ) -> tuple[list[dict[str, JsonValue]], str | None]:
        return await client.sync_events(
            self.token_manager, calendar_id, sync_token, time_zone
        )

    async def delete_event(self, calendar_id: str, event_id: str) -> None:
        await client.delete_event(self.token_manager, calendar_id, event_id)
