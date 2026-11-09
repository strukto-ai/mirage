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

from mirage.accessor.linear import LinearAccessor
from mirage.commands.cli.builtin.linear.issue.remove_label import remove_label
from mirage.commands.config import Context
from mirage.core.linear.config import LinearConfig
from mirage.io.types import materialize

ACCESSOR = LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.mark.asyncio
async def test_keeps_every_other_label(monkeypatch):
    async def fake_labels(accessor, texts, fl):
        return "i1", ["keep", "drop"], "drop"

    seen = {}

    async def fake_update(accessor, **fields):
        seen.update(fields)
        return {"id": "i1"}

    globals_ = remove_label.__globals__
    monkeypatch.setitem(globals_, "issue_labels", fake_labels)
    monkeypatch.setitem(globals_, "issue_update", fake_update)
    monkeypatch.setitem(globals_, "normalize_issue", lambda issue: issue)
    out, _ = await remove_label(ACCESSOR, [], ["ENG-1"], Context(flags={}))
    assert seen == {
        "issue_id": "i1",
        "title": None,
        "description": None,
        "label_ids": ["keep"],
    }
    assert json.loads(await materialize(out)) == {"id": "i1"}
