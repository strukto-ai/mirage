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

import json

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya import HIMALAYA
from mirage.commands.cli.builtin.himalaya.mailbox import mailbox_list
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


@pytest.fixture(autouse=True)
def listing(monkeypatch):
    async def fake_entries(accessor):
        return [
            ("INBOX", ["\\HasNoChildren"]),
            ("Parent", ["\\Noselect"]),
            ("Work", []),
        ]

    async def fake_counts(accessor, name):
        return (9, 2)

    globals_ = mailbox_list.__globals__
    monkeypatch.setitem(globals_, "list_folder_entries", fake_entries)
    monkeypatch.setitem(globals_, "mailbox_counts", fake_counts)


@pytest.mark.asyncio
async def test_skips_what_cannot_be_selected():
    out, _ = await mailbox_list(
        EMAIL, [], [], _ctx("mailbox", "list", json=True)
    )
    document = json.loads(await materialize(out))
    assert [entry["name"] for entry in document["mailboxes"]] == [
        "Inbox",
        "Work",
    ]
    assert document["mailboxes"][0]["role"] == "inbox"
    assert document["mailboxes"][0]["total"] is None


@pytest.mark.asyncio
async def test_counts_add_two_columns():
    out, _ = await mailbox_list(
        EMAIL, [], [], _ctx("mailbox", "list", counts=True)
    )
    header = (await materialize(out)).decode().splitlines()[2]
    assert "TOTAL ┆ UNREAD" in header
