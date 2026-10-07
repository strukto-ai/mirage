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

from collections.abc import Callable
from dataclasses import replace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.gmail.grep import grep
from mirage.commands.builtin.gmail.io import IO as GMAIL_IO
from mirage.commands.builtin.gmail.rg import rg
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _io(
    monkeypatch: pytest.MonkeyPatch, **slots: Callable[..., Any]
) -> CommandIO:
    """Replace backend slots while retaining the checked adapter contract."""
    resolve = slots.pop("resolve_glob", None)
    if resolve is not None:
        monkeypatch.setattr(CommandIO, "resolve_glob", staticmethod(resolve))
    return replace(GMAIL_IO, **slots)


ROWS = [
    {
        "path": "INBOX/2026-01-01/msg.gmail.json",
        "subject": "hello there",
        "snippet": "hello there",
        "sender": "a@b.c",
    }
]


def _label_scope() -> PathSpec:
    original = "/gmail/INBOX"
    return PathSpec(
        vfs_path=mount_key(original, "/gmail"),
        virtual=original,
        directory=original,
    )


@pytest.mark.asyncio
async def test_grep_without_word_flag_skips_native_search(monkeypatch):
    # Gmail search matches whole words while grep matches substrings, and the
    # native path returns search results verbatim as the grep output, so a
    # bare literal would under-report. Only -w may take it.
    accessor = AsyncMock()
    # Falling through to the per-message scan is the point. The stubbed
    # glob resolves to no files, which leaves the generic command an empty
    # stdin and no match; what matters is that the native path was not taken.
    spy = AsyncMock(return_value=ROWS)
    ops = _io(monkeypatch, resolve_glob=AsyncMock(return_value=[]))
    with patch.dict(
        grep.__globals__,
        {
            "search_messages": spy,
        },
    ):
        _, io = await grep(
            ops,
            accessor,
            [_label_scope()],
            ["hello"],
            CommandOpts(index=RAMIndexCacheStore()),
        )
    assert io.exit_code == 1
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_rg_without_word_flag_skips_native_search(monkeypatch):
    accessor = AsyncMock()
    # Falling through to the per-message scan is the point. The stubbed
    # glob resolves to no files, which the generic command reports as a
    # usage error; what matters is that the native path was not taken.
    spy = AsyncMock(return_value=ROWS)
    ops = _io(monkeypatch, resolve_glob=AsyncMock(return_value=[]))
    with patch.dict(
        rg.__globals__,
        {
            "search_messages": spy,
        },
    ):
        with pytest.raises(UsageError):
            await rg(
                ops,
                accessor,
                [_label_scope()],
                ["hello"],
                CommandOpts(index=RAMIndexCacheStore()),
            )
    spy.assert_not_awaited()


@pytest.mark.asyncio
async def test_binary_search_snippet_uses_rendered_file_scan(monkeypatch):
    rows = [{**ROWS[0], "snippet": "hello\0tail", "subject": ""}]
    generic = AsyncMock(return_value=(b"", IOResult()))
    ops = _io(
        monkeypatch,
        resolve_glob=AsyncMock(return_value=[_label_scope()]),
    )
    with patch.dict(
        grep.__globals__,
        {
            "search_messages": AsyncMock(return_value=rows),
            "grep_generic": generic,
        },
    ):
        await grep(
            ops,
            AsyncMock(),
            [_label_scope()],
            ["hello"],
            CommandOpts(index=RAMIndexCacheStore(), flags={"w": True}),
        )
    generic.assert_awaited_once()
