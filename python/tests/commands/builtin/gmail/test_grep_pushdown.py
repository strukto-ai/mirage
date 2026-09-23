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
from mirage.io.types import IOResult
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
    return PathSpec(vfs_path=mount_key(original, "/gmail"),
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


def _glob_scope() -> PathSpec:
    # A glob whose directory IS searchable, so only the glob half of the gate
    # can defer it.
    original = "/gmail/INBOX/2026-01-01/*.gmail.json"
    return PathSpec(vfs_path=mount_key(original, "/gmail"),
                    virtual=original,
                    directory="/gmail/INBOX/2026-01-01",
                    pattern="*.gmail.json",
                    resolved=False)


@pytest.mark.asyncio
async def test_grep_second_operand_defers_to_generic():
    # The push-down answers for one label, so a second operand used to be
    # dropped in silence: this line reported INBOX and never mentioned Sent.
    accessor = AsyncMock()
    sent = PathSpec(vfs_path=mount_key("/gmail/Sent", "/gmail"),
                    virtual="/gmail/Sent",
                    directory="/gmail/Sent")
    with patch("mirage.commands.builtin.gmail.grep.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[])), \
            patch("mirage.commands.builtin.gmail.grep.generic_grep",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic:
        await grep(accessor, [_label_scope(), sent], ['hello'],
                   CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    spy.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_second_operand_defers_to_generic():
    accessor = AsyncMock()
    sent = PathSpec(vfs_path=mount_key("/gmail/Sent", "/gmail"),
                    virtual="/gmail/Sent",
                    directory="/gmail/Sent")
    with patch("mirage.commands.builtin.gmail.rg.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.rg.resolve_glob",
                  new=AsyncMock(return_value=[])), \
            patch("mirage.commands.builtin.gmail.rg.generic_rg",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic:
        await rg(accessor, [_label_scope(), sent], ['hello'],
                 CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    spy.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_unresolved_glob_defers_to_generic():
    # There was no glob check at all: the unexpanded `*.gmail.json` segment
    # reached the native search, which reads it as a literal.
    accessor = AsyncMock()
    with patch("mirage.commands.builtin.gmail.grep.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[])), \
            patch("mirage.commands.builtin.gmail.grep.generic_grep",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic:
        await grep(accessor, [_glob_scope()], ['hello'],
                   CommandOpts(index=RAMIndexCacheStore(), flags={'w': True}))
    spy.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_context_flag_defers_to_generic():
    # -A was not in the open-coded shaping list, so the push-down ran and the
    # context lines were dropped without a word.
    accessor = AsyncMock()
    with patch("mirage.commands.builtin.gmail.grep.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[])), \
            patch("mirage.commands.builtin.gmail.grep.generic_grep",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic:
        await grep(
            accessor, [_label_scope()], ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'A': "2"
                        }))
    spy.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_quiet_flag_defers_to_generic():
    # py grep checked -q and py rg did not; both read the one shared table.
    accessor = AsyncMock()
    with patch("mirage.commands.builtin.gmail.rg.search_messages",
               new=AsyncMock(return_value=ROWS)) as spy, \
            patch("mirage.commands.builtin.gmail.rg.resolve_glob",
                  new=AsyncMock(return_value=[])), \
            patch("mirage.commands.builtin.gmail.rg.generic_rg",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic:
        await rg(
            accessor, [_label_scope()], ['hello'],
            CommandOpts(index=RAMIndexCacheStore(),
                        flags={
                            'w': True,
                            'q': True
                        }))
    spy.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{
    "args_I": True
}, {
    "text": True
}, {
    "binary_files": "without-match"
}, {
    "binary_files": "binary"
}])
async def test_binary_options_use_rendered_file_scan(flags):
    with (
            patch("mirage.commands.builtin.gmail.grep.search_messages",
                  new=AsyncMock(return_value=ROWS)) as search,
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[_label_scope()])),
            patch("mirage.commands.builtin.gmail.grep.generic_grep",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic,
    ):
        await grep(
            AsyncMock(), [_label_scope()], ["hello"],
            CommandOpts(index=RAMIndexCacheStore(), flags={
                "w": True,
                **flags
            }))
    search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_binary_search_snippet_uses_rendered_file_scan():
    rows = [{**ROWS[0], "snippet": "hello\0tail", "subject": ""}]
    with (
            patch("mirage.commands.builtin.gmail.grep.search_messages",
                  new=AsyncMock(return_value=rows)),
            patch("mirage.commands.builtin.gmail.grep.resolve_glob",
                  new=AsyncMock(return_value=[_label_scope()])),
            patch("mirage.commands.builtin.gmail.grep.generic_grep",
                  new=AsyncMock(return_value=(b"", IOResult()))) as generic,
    ):
        await grep(AsyncMock(), [_label_scope()], ["hello"],
                   CommandOpts(index=RAMIndexCacheStore(), flags={"w": True}))
    generic.assert_awaited_once()
