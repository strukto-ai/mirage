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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gmail.grep import grep
from mirage.commands.builtin.gmail.rg import rg
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

ROWS = [{
    "path": "INBOX/2026-01-01/msg.gmail.json",
    "subject": "hello there",
    "snippet": "hello there",
    "sender": "a@b.c",
}]


def _label_scope() -> PathSpec:
    original = "/gmail/INBOX"
    return PathSpec(resource_path=mount_key(original, "/gmail"),
                    virtual=original,
                    directory=original)


@pytest.mark.asyncio
async def test_grep_word_uses_native_search():
    accessor = AsyncMock()
    with patch("mirage.commands.builtin.gmail.grep.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy:
        await grep(accessor, [_label_scope()], ['hello'],
                   CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    spy.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_without_word_flag_skips_native_search():
    # Gmail search matches whole words while grep matches substrings, and the
    # native path returns search results verbatim as the grep output, so a
    # bare literal would under-report. Only -w may take it.
    accessor = AsyncMock()
    # Falling through to the per-message scan is the point. The stubbed
    # glob resolves to no files, which the generic command reports as a
    # usage error; what matters is that the native path was not taken.
    with patch("mirage.commands.builtin.gmail.grep.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[])):
        with pytest.raises(UsageError):
            await grep(accessor, [_label_scope()], ['hello'],
                       CommandOpts(index=RAMIndexCacheStore()))
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_rg_word_uses_native_search():
    accessor = AsyncMock()
    with patch("mirage.commands.builtin.gmail.rg.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy:
        await rg(accessor, [_label_scope()], ['hello'],
                 CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    spy.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_without_word_flag_skips_native_search():
    accessor = AsyncMock()
    # Falling through to the per-message scan is the point. The stubbed
    # glob resolves to no files, which the generic command reports as a
    # usage error; what matters is that the native path was not taken.
    with patch("mirage.commands.builtin.gmail.rg.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.rg.resolve_glob",
                  new=AsyncMock(return_value=[])):
        with pytest.raises(UsageError):
            await rg(accessor, [_label_scope()], ['hello'],
                     CommandOpts(index=RAMIndexCacheStore()))
    spy.assert_not_awaited()
