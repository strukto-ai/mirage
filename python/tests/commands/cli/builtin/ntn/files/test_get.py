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

import json

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.builtin.ntn.files.get import files_get
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.core.notion.config import NotionConfig
from mirage.io.types import materialize

NOTION = NotionAccessor(NotionConfig(api_key="secret"))
UPLOAD = {"object": "file_upload", "id": "U1", "status": "pending"}


def _ctx(**flags) -> Context:
    group = next(s for s in NTN.spec.subcommands if s.name == "files")
    spec = next(s for s in group.subcommands if s.name == "get")
    return Context(flags=flags, spec=spec)


@pytest.mark.asyncio
async def test_prints_the_object_under_json(monkeypatch):
    seen = []

    async def fake_get(accessor, upload_id):
        seen.append(upload_id)
        return UPLOAD

    monkeypatch.setitem(files_get.__globals__, "get_file_upload", fake_get)
    out, _ = await files_get(NOTION, [], ["U1"], _ctx(json=True))
    assert seen == ["U1"]
    assert json.loads(await materialize(out)) == UPLOAD


@pytest.mark.asyncio
async def test_refuses_a_missing_id():
    with pytest.raises(UsageError, match="upload id is required"):
        await files_get(NOTION, [], [], _ctx())
