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

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.email.read import read_many
from mirage.core.email.render import message_json_bytes
from mirage.types import FileStat, FileType, JsonValue, PathSpec

DAY = "/INBOX/2024-01-15"


def _message(uid: str) -> dict[str, JsonValue]:
    return {
        "from": {"name": "Alice", "email": "alice@example.com"},
        "to": [],
        "subject": f"Note {uid}",
        "date": "Mon, 15 Jan 2024 10:00:00 +0000",
        "body_text": "hi",
        "attachments": [],
        "uid": uid,
        "flags": [],
        "internal_date": "15-Jan-2024 10:00:00 +0000",
    }


@pytest.mark.asyncio
async def test_a_batch_fetches_a_folders_messages_at_once():
    # A message the listing sizes past the limit is not fetched.
    names = {f"{DAY}/note__{uid}.email.json": uid for uid in ("101", "102")}
    gone = f"{DAY}/gone__103.email.json"
    big = f"{DAY}/big__104.email.json"

    def row(uid: str, size: int) -> FileStat:
        return FileStat(
            name=f"m__{uid}", type=FileType.FILE, size=size, extra={"uid": uid}
        )

    rows = [row(uid, 300) for uid in names.values()]
    fetch = AsyncMock(return_value=[_message("102"), _message("101")])
    with patch("mirage.core.email.read.fetch_headers", fetch):
        answers = await read_many(
            SimpleNamespace(),
            [PathSpec.from_str_path(p) for p in [*names, gone, big]],
            1 << 20,
            [*rows, None, row("104", 1 << 30)],
        )
    assert answers == {
        path: message_json_bytes(_message(uid)) for path, uid in names.items()
    }
    fetch.assert_awaited_once()
    assert fetch.await_args.args[1:] == ("INBOX", ["101", "102"])
