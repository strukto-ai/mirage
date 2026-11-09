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
from mirage.commands.cli.builtin.himalaya.delete import message_delete
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


@pytest.fixture
def mailboxes(monkeypatch):
    calls = {}

    async def fake_tagged(accessor, attribute, default):
        return "Bin"

    async def fake_move(accessor, source, target, uids):
        calls["moved"] = (source, target, uids)
        return len(uids)

    async def fake_delete(accessor, mailbox, uids):
        calls["deleted"] = (mailbox, uids)
        return True

    globals_ = message_delete.__globals__
    monkeypatch.setitem(globals_, "tagged_folder", fake_tagged)
    monkeypatch.setitem(globals_, "move_messages", fake_move)
    monkeypatch.setitem(globals_, "delete_messages", fake_delete)
    return calls


@pytest.mark.asyncio
async def test_outside_the_trash_it_moves(mailboxes):
    out, _ = await message_delete(EMAIL, [], ["1"], _ctx("message", "delete"))
    assert mailboxes == {"moved": ("INBOX", "Bin", ["1"])}
    assert (
        (await materialize(out))
        .decode()
        .startswith("Successfully moved 1 message(s) to the trash")
    )


@pytest.mark.asyncio
async def test_inside_the_trash_it_deletes(mailboxes):
    out, _ = await message_delete(
        EMAIL, [], ["1", "2"], _ctx("message", "delete", mailbox="Bin")
    )
    assert mailboxes == {"deleted": ("Bin", ["1", "2"])}
    assert (
        (await materialize(out))
        .decode()
        .startswith("Successfully deleted 2 message(s) from the trash")
    )
