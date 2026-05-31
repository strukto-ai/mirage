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

slack_cat = importlib.import_module("mirage.commands.builtin.slack.cat")
cat = slack_cat.cat


@pytest.mark.asyncio
async def test_cat_single_file(monkeypatch):

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return b'{"ts": "1.0", "text": "hi"}\n'

    monkeypatch.setattr(slack_cat, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_cat, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    path = PathSpec(original="/channels/general__C1/2024-01-01/chat.jsonl",
                    directory="/channels/general__C1/2024-01-01",
                    prefix="",
                    resolved=True)
    out, io = await cat(acc, [path])
    data = out if isinstance(out, bytes) else b""
    assert data == b'{"ts": "1.0", "text": "hi"}\n'
    assert "/channels/general__C1/2024-01-01/chat.jsonl" in io.reads


@pytest.mark.asyncio
async def test_cat_concatenates_multiple_days(monkeypatch):
    contents = {
        "/channels/general__C1/2024-01-01/chat.jsonl": b"day1\n",
        "/channels/general__C1/2024-01-02/chat.jsonl": b"day2\n",
        "/channels/general__C1/2024-01-03/chat.jsonl": b"day3\n",
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    async def fake_read(accessor, path, index=None):
        return contents[path.original]

    monkeypatch.setattr(slack_cat, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(slack_cat, "slack_read", fake_read)

    acc = SlackAccessor.__new__(SlackAccessor)
    paths = [
        PathSpec(original=key,
                 directory=key.rsplit("/", 1)[0],
                 prefix="",
                 resolved=True) for key in contents
    ]
    out, io = await cat(acc, paths)
    data = out if isinstance(out, bytes) else b""
    assert data == b"day1\nday2\nday3\n"
    assert set(io.reads) == set(contents)
    assert list(io.cache) == list(contents)
