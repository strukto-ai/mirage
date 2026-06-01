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

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.types import PathSpec

slack_head = importlib.import_module("mirage.commands.builtin.slack.head")
slack_tail = importlib.import_module("mirage.commands.builtin.slack.tail")


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(original=n,
                 directory=n.rsplit("/", 1)[0],
                 prefix="",
                 resolved=True) for n in names
    ]


async def _collect(out) -> bytes:
    if isinstance(out, bytes):
        return out
    data = b""
    async for chunk in out:
        data += chunk
    return data


@pytest.mark.asyncio
async def test_head_multi_files_with_headers(monkeypatch):
    contents = {
        "/c/a/2024-01-01/chat.jsonl": b"a1\na2\na3\n",
        "/c/a/2024-01-02/chat.jsonl": b"b1\nb2\nb3\n",
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return contents[path.original]

    monkeypatch.setattr(slack_head, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_head, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    out, _ = await slack_head.head(acc, _paths(*contents), n="2")
    data = await _collect(out)
    assert data == (b"==> /c/a/2024-01-01/chat.jsonl <==\na1\na2\n"
                    b"\n==> /c/a/2024-01-02/chat.jsonl <==\nb1\nb2\n")


@pytest.mark.asyncio
async def test_head_single_file_no_header(monkeypatch):

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return b"x1\nx2\nx3\n"

    monkeypatch.setattr(slack_head, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_head, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    out, _ = await slack_head.head(acc,
                                   _paths("/c/a/2024-01-01/chat.jsonl"),
                                   n="2")
    data = await _collect(out)
    assert data == b"x1\nx2\n"


@pytest.mark.asyncio
async def test_tail_multi_files_with_headers(monkeypatch):
    contents = {
        "/c/a/2024-01-01/chat.jsonl": b"a1\na2\na3\n",
        "/c/a/2024-01-02/chat.jsonl": b"b1\nb2\nb3\n",
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return contents[path.original]

    monkeypatch.setattr(slack_tail, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_tail, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    out, _ = await slack_tail.tail(acc, _paths(*contents), n="2")
    data = await _collect(out)
    assert data == (b"==> /c/a/2024-01-01/chat.jsonl <==\na2\na3\n"
                    b"\n==> /c/a/2024-01-02/chat.jsonl <==\nb2\nb3\n")


@pytest.mark.asyncio
async def test_tail_multi_files_quiet_suppresses_headers(monkeypatch):
    contents = {
        "/c/a/2024-01-01/chat.jsonl": b"a1\na2\n",
        "/c/a/2024-01-02/chat.jsonl": b"b1\nb2\n",
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return contents[path.original]

    monkeypatch.setattr(slack_tail, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_tail, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    out, _ = await slack_tail.tail(acc, _paths(*contents), n="1", q=True)
    data = await _collect(out)
    assert data == b"a2\nb2\n"
