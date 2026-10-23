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

from mirage.core.gmail import history, labels, messages
from mirage.core.gmail.api import GmailApi, GmailClient
from tests.core.gmail.test_events import Mailbox
from tests.fixtures.gmail_api import FakeGmail
from tests.fixtures.google_api import (
    Delegation,
    parameter_drift,
    protocol_calls,
    sends,
)

MODULES = {
    "list_labels": labels,
    "list_messages": messages,
    "get_message_raw": messages,
    "get_attachment": messages,
    "current_history_id": history,
    "list_history": history,
}

DELEGATIONS = [
    Delegation("list_labels", (), ()),
    Delegation("list_messages", ("L1", "q", 5), ("L1", "q", 5)),
    Delegation("get_message_raw", ("m1",), ("m1",)),
    Delegation("get_attachment", ("m1", "a1"), ("m1", "a1")),
    Delegation("current_history_id", (), ()),
    Delegation("list_history", ("h1",), ("h1",)),
]


@pytest.mark.parametrize("fake", [GmailClient, FakeGmail, Mailbox])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(GmailApi, fake) == {}


def test_every_call_has_a_case():
    assert sorted(case.call for case in DELEGATIONS) == protocol_calls(
        GmailApi
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", DELEGATIONS, ids=lambda case: case.call)
async def test_each_call_sends_its_wire_request(case):
    got, answer = await sends(GmailClient, MODULES[case.call], case)
    assert got is answer
