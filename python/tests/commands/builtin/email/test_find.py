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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.email.find import find
from mirage.resource.email.config import EmailConfig
from mirage.types import PathSpec


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


def _accessor() -> EmailAccessor:
    return EmailAccessor(
        EmailConfig(imap_host="imap.test",
                    smtp_host="smtp.test",
                    username="u",
                    password="p"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    with patch("mirage.core.email.readdir.list_folders",
               new_callable=AsyncMock,
               return_value=["INBOX", "Sent"]):
        stdout, _io = await find(_accessor(),
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_lists_folders():
    lines = await _run([_spec("/")], maxdepth="1")
    assert "/INBOX" in lines
    assert "/Sent" in lines


@pytest.mark.asyncio
async def test_path_pattern_is_honored():
    lines = await _run([_spec("/")], maxdepth="1", path="*INBOX*")
    assert lines == ["/INBOX"]


@pytest.mark.asyncio
async def test_size_is_honored_dirs_count_as_zero():
    lines = await _run([_spec("/")], maxdepth="1", size="+0c")
    assert lines == []


@pytest.mark.asyncio
async def test_name_only_folder_level_pushes_down_to_imap_search():
    search = AsyncMock(return_value=[])
    with patch("mirage.commands.builtin.email.find.search_messages", search):
        stdout, _io = await find(_accessor(), [_spec("/INBOX")],
                                 name="*report*",
                                 index=RAMIndexCacheStore())
    search.assert_awaited_once()
    assert (stdout if isinstance(stdout, bytes) else b"") == b""


@pytest.mark.asyncio
async def test_name_with_size_falls_through_to_walk():
    # Any predicate beyond -name must not be dropped by the server-side
    # shortcut; the local walk applies all of them.
    search = AsyncMock(return_value=[])
    with patch("mirage.commands.builtin.email.find.search_messages", search), \
         patch("mirage.core.email.readdir.list_folders",
               new_callable=AsyncMock,
               return_value=["INBOX"]), \
         patch("mirage.core.email.stat.list_folders",
               new_callable=AsyncMock,
               return_value=["INBOX"]), \
         patch("mirage.core.email.readdir.list_message_uids",
               new_callable=AsyncMock,
               return_value=[]):
        stdout, _io = await find(_accessor(), [_spec("/INBOX")],
                                 name="*report*",
                                 size="+0c",
                                 index=RAMIndexCacheStore())
    search.assert_not_awaited()
    assert (stdout if isinstance(stdout, bytes) else b"") == b""
