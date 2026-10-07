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

import importlib
import sys
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.email.io import IO as EMAIL_IO
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _io(**slots: Callable[..., Any]) -> SimpleNamespace:
    """The command's IO with the given slots faked; the rest stay real."""
    real = {
        "readdir": EMAIL_IO.readdir,
        "stat": EMAIL_IO.stat,
        "read_bytes": EMAIL_IO.read_bytes,
    }
    return SimpleNamespace(**{**real, **slots})


sys.modules.setdefault(
    "aioimaplib",
    SimpleNamespace(IMAP4=object, IMAP4_SSL=object),
)
sys.modules.setdefault(
    "aiosmtplib",
    SimpleNamespace(SMTP=object, send=AsyncMock()),
)

rg = importlib.import_module("mirage.commands.builtin.email.rg").rg


def _path(s: str = "/email/INBOX") -> PathSpec:
    return PathSpec(vfs_path=mount_key(s, "/email"), virtual=s, directory=s)


@pytest.mark.asyncio
async def test_rg_multi_pattern_skips_imap_search():
    # A newline-joined multi -e set must bypass the IMAP text search and
    # still resolve globs before the generic runs (#347).
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, paths, index=None):
        seen["resolved"] = [p.virtual for p in paths]
        return paths

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with (
        patch(
            "mirage.commands.builtin.email.rg.search_messages",
            new=AsyncMock(side_effect=AssertionError("imap search ran")),
        ),
        patch(
            "mirage.commands.builtin.email.rg.IO",
            _io(resolve_glob=fake_resolve),
        ),
        patch(
            "mirage.commands.builtin.email.rg.rg_generic",
            new=fake_generic,
        ),
    ):
        _, io = await rg(
            accessor,
            [_path()],
            [],
            CommandOpts(
                index=RAMIndexCacheStore(), flags={"regexp": ["ada", "ben"]}
            ),
        )

    assert io.exit_code == 0
    assert seen["resolved"] == ["/email/INBOX"]
    assert seen["generic"] == ["/email/INBOX"]


@pytest.mark.asyncio
async def test_rg_single_pattern_uses_imap_search():
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    search = AsyncMock(return_value=[])
    with (
        patch(
            "mirage.commands.builtin.email.rg.search_messages",
            new=search,
        ),
        patch(
            "mirage.commands.builtin.email.rg.IO",
            _io(
                resolve_glob=AsyncMock(side_effect=AssertionError("glob ran")),
            ),
        ),
    ):
        _, io = await rg(
            accessor,
            [_path()],
            ["ada"],
            CommandOpts(index=RAMIndexCacheStore()),
        )

    assert io.exit_code == 1
    search.assert_awaited_once()


@pytest.mark.asyncio
async def test_rg_message_file_operand_defers_to_generic():
    # A single .email.json is not a folder scope, so it reads the one file
    # rather than reporting exit 1 without searching.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    msg = _path("/email/INBOX/2026-01-05/Q2__1.email.json")
    with (
        patch(
            "mirage.commands.builtin.email.rg.search_messages",
            new=AsyncMock(return_value=[]),
        ) as search,
        patch(
            "mirage.commands.builtin.email.rg.IO",
            _io(resolve_glob=AsyncMock(return_value=[])),
        ),
        patch(
            "mirage.commands.builtin.email.rg.rg_generic",
            new=AsyncMock(return_value=(b"", IOResult())),
        ) as generic,
    ):
        _out, io = await rg(
            accessor,
            [msg],
            ["foo"],
            CommandOpts(index=RAMIndexCacheStore(), flags={}),
        )
    search.assert_not_awaited()
    generic.assert_awaited_once()
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_regex_hands_the_server_its_required_literal():
    # `worker.3` matches `worker-3`; the server is asked for `worker`.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    search = AsyncMock(return_value=[])
    with (
        patch("mirage.commands.builtin.email.rg.search_messages", new=search),
        patch(
            "mirage.commands.builtin.email.rg.IO",
            _io(
                resolve_glob=AsyncMock(side_effect=AssertionError("glob ran")),
            ),
        ),
    ):
        _, io = await rg(
            accessor,
            [_path()],
            ["worker.3"],
            CommandOpts(index=RAMIndexCacheStore()),
        )
    assert io.exit_code == 1
    assert search.await_args.kwargs["text"] == "worker"
