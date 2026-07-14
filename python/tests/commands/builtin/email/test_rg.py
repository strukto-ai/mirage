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
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

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
    return PathSpec(resource_path=mount_key(s, "/email"),
                    virtual=s,
                    directory=s)


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

    with patch(
            "mirage.commands.builtin.email.rg.search_messages",
            new=AsyncMock(side_effect=AssertionError("imap search ran")),
    ), patch(
            "mirage.commands.builtin.email.rg.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.email.rg.generic_rg",
            new=fake_generic,
    ):
        _, io = await rg(accessor, [_path()],
                         index=RAMIndexCacheStore(),
                         e=["ada", "ben"])

    assert io.exit_code == 0
    assert seen["resolved"] == ["/email/INBOX"]
    assert seen["generic"] == ["/email/INBOX"]


@pytest.mark.asyncio
async def test_rg_single_pattern_uses_imap_search():
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    search = AsyncMock(return_value=[])
    with patch(
            "mirage.commands.builtin.email.rg.search_messages",
            new=search,
    ), patch(
            "mirage.commands.builtin.email.rg.resolve_glob",
            new=AsyncMock(side_effect=AssertionError("glob ran")),
    ):
        _, io = await rg(accessor, [_path()],
                         "ada",
                         index=RAMIndexCacheStore())

    assert io.exit_code == 1
    search.assert_awaited_once()
