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
from mirage.commands.cli.builtin.himalaya.flag import flag_add, flag_remove
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
def stored(monkeypatch):
    calls = []

    async def fake_store(accessor, mailbox, uids, flags, op):
        calls.append((mailbox, uids, flags, op))

    monkeypatch.setitem(flag_add.__globals__, "store_flags", fake_store)
    return calls


@pytest.mark.asyncio
async def test_add_names_the_imap_flags(stored):
    out, _ = await flag_add(
        EMAIL, [], ["1", "2"], _ctx("flag", "add", flag=["seen", "flagged"])
    )
    assert stored == [("INBOX", ["1", "2"], ["\\Seen", "\\Flagged"], "add")]
    assert (
        (await materialize(out))
        .decode()
        .startswith("Successfully added flags: seen, flagged")
    )


@pytest.mark.asyncio
async def test_remove_reads_the_mailbox(stored):
    await flag_remove(
        EMAIL,
        [],
        ["7"],
        _ctx("flag", "remove", flag=["draft"], mailbox="Archive"),
    )
    assert stored == [("Archive", ["7"], ["\\Draft"], "remove")]
