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
from mirage.core.email.readdir import _date_bucket, readdir
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
    "internal_date": "18-Mar-2024 08:00:00 +0000",
}]

NO_DATE_HEADERS = [{
    "from": {
        "name": "Alice",
        "email": "alice@example.com"
    },
    "to": [{
        "name": "",
        "email": "bob@example.com"
    }],
    "subject": "Hello",
    "date": "",
    "body_text": "hi there",
    "attachments": [],
    "uid": "101",
    "flags": [],
    "internal_date": "07-Aug-2026 20:54:05 +0000",
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


@pytest.mark.asyncio
async def test_readdir_buckets_a_dateless_message_by_internaldate(
        accessor, index):
    # Without INTERNALDATE every message a sender left undated lands in
    # one 1970 directory, which is the mount's only organizing axis.
    with (patch("mirage.core.email.readdir.list_folders",
                new_callable=AsyncMock,
                return_value=["INBOX"]),
          patch("mirage.core.email.readdir.list_message_uids",
                new_callable=AsyncMock,
                return_value=["101"]),
          patch("mirage.core.email.readdir.fetch_headers",
                new_callable=AsyncMock,
                return_value=NO_DATE_HEADERS)):
        result = await readdir(
            accessor,
            PathSpec(resource_path="INBOX",
                     virtual="/INBOX",
                     directory="/INBOX"), index)

    assert result == ["/INBOX/2026-08-07"]


def test_date_bucket_prefers_the_header():
    assert _date_bucket({
        "date": "Mon, 15 Jan 2024 10:00:00 +0000",
        "internal_date": "18-Mar-2024 08:00:00 +0000",
    }) == "2024-01-15"


def test_date_bucket_falls_back_to_internaldate():
    assert _date_bucket({
        "date": "",
        "internal_date": "07-Aug-2026 20:54:05 +0000",
    }) == "2026-08-07"


def test_date_bucket_falls_back_on_an_unparseable_header():
    assert _date_bucket({
        "date": "yesterday-ish",
        "internal_date": "07-Aug-2026 20:54:05 +0000",
    }) == "2026-08-07"


def test_date_bucket_reaches_the_epoch_only_with_neither():
    assert _date_bucket({"date": "", "internal_date": ""}) == "1970-01-01"
    assert _date_bucket({}) == "1970-01-01"


def test_date_bucket_reads_offsets_in_utc():
    # The TS backend and both gmail backends bucket in UTC; honoring the
    # sender's offset instead filed a late-evening message a day early.
    assert _date_bucket({"date":
                         "Mon, 05 Jan 2026 23:30:00 -0500"}) == "2026-01-06"
    assert _date_bucket({
        "date": "",
        "internal_date": " 7-Aug-2026 20:54:05 -0500",
    }) == "2026-08-08"
