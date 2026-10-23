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

from mirage.core.gcal import client
from mirage.core.gcal.api import CalendarApi, CalendarClient
from mirage.core.time_range import TimeRange
from tests.fixtures.gcal_api import FakeCalendarApi
from tests.fixtures.google_api import (
    Delegation,
    parameter_drift,
    protocol_calls,
    sends,
)

SCOPE = TimeRange.from_strings("2026-08-01T00:00:00Z", None)

DELEGATIONS = [
    Delegation("list_calendars", ("writer",), ("writer",)),
    Delegation(
        "list_events",
        ("c1", "lo", "hi", "UTC"),
        ("c1", "lo", "hi", "UTC"),
        {"scope": TimeRange(), "query": None},
    ),
    Delegation("sync_events", ("c1", "t1", "UTC"), ("c1", "t1", "UTC")),
    Delegation("delete_event", ("c1", "e1"), ("c1", "e1")),
]


@pytest.mark.parametrize("fake", [CalendarClient, FakeCalendarApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(CalendarApi, fake) == {}


def test_every_call_has_a_case():
    assert sorted(case.call for case in DELEGATIONS) == protocol_calls(
        CalendarApi
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", DELEGATIONS, ids=lambda case: case.call)
async def test_each_call_sends_its_wire_request(case):
    got, answer = await sends(CalendarClient, client, case)
    assert got is (None if case.call == "delete_event" else answer)


@pytest.mark.asyncio
async def test_a_listing_hands_on_its_scope_and_query():
    case = Delegation(
        "list_events",
        ("c1", None, "hi"),
        ("c1", None, "hi", None),
        {"scope": SCOPE, "query": "lunch"},
        kwargs={"scope": SCOPE, "query": "lunch"},
    )
    got, answer = await sends(CalendarClient, client, case)
    assert got is answer
