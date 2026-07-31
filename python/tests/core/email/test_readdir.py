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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.email.readdir import readdir
from mirage.core.email.render import message_json_bytes
from mirage.types import PathSpec

HEADERS = [{
    "from": {
        "name": "Alice",
        "email": "alice@example.com"
    },
    "to": [{
        "name": "",
        "email": "bob@example.com"
    }],
    "subject": "Hello",
    "date": "Mon, 15 Jan 2024 10:00:00 +0000",
    "body_text": "hi there",
    "attachments": [],
    "uid": "101",
    "flags": ["\\Seen"],
}]


@pytest.fixture
def accessor():
    return SimpleNamespace(config=SimpleNamespace(max_messages=50))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_folder_sizes_messages(accessor, index):
    with (patch("mirage.core.email.readdir.list_folders",
                new_callable=AsyncMock,
                return_value=["INBOX"]),
          patch("mirage.core.email.readdir.list_message_uids",
                new_callable=AsyncMock,
                return_value=["101"]),
          patch("mirage.core.email.readdir.fetch_headers",
                new_callable=AsyncMock,
                return_value=HEADERS)):
        result = await readdir(
            accessor,
            PathSpec(resource_path="INBOX",
                     virtual="/INBOX",
                     directory="/INBOX"), index)

    assert result == ["/INBOX/2024-01-15"]
    listing = await index.list_dir("/INBOX/2024-01-15")
    lookup = await index.get(listing.entries[0])
    assert lookup.entry.size == len(message_json_bytes(HEADERS[0]))
