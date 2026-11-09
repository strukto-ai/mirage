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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya import HIMALAYA
from mirage.commands.cli.builtin.himalaya.transfer import (
    message_copy,
    message_move,
)
from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

EMAIL = EmailAccessor(
    EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")
)


def _ctx(*names: str, **flags: FlagValue) -> Context:
    spec = HIMALAYA.spec
    for name in names:
        spec = next(s for s in spec.subcommands if s.name == name)
    return Context(flags=flags, spec=spec)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "count,text",
    [
        (0, "No message copied: no id matched in the source mailbox"),
        (1, "1 message successfully copied"),
        (3, "3 messages successfully copied"),
    ],
)
async def test_copy_reports_the_count(monkeypatch, count, text):
    async def fake_copy(accessor, source, target, uids):
        return count

    monkeypatch.setitem(message_copy.__globals__, "copy_messages", fake_copy)
    out, _ = await message_copy(
        EMAIL, [], ["1"], _ctx("message", "copy", to="Archive")
    )
    assert (await materialize(out)).decode().startswith(text)


@pytest.mark.asyncio
async def test_move_reads_both_mailboxes(monkeypatch):
    seen = []

    async def fake_move(accessor, source, target, uids):
        seen.append((source, target, uids))
        return 1

    monkeypatch.setitem(message_move.__globals__, "move_messages", fake_move)
    await message_move(
        EMAIL,
        [],
        ["4"],
        _ctx("message", "move", **{"from": "Old", "to": "New"}),
    )
    assert seen == [("Old", "New", ["4"])]
