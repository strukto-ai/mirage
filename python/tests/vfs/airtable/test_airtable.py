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

import pytest

from mirage import Workspace
from mirage.core.airtable.config import AirtableConfig
from mirage.types import VFSName
from mirage.vfs.airtable import AirtableVFS
from mirage.vfs.registry import build_vfs
from tests.fixtures.airtable_api import TOKEN

TABLE = ("/at/bases/Product_Roadmap__appRoadmapBase001/"
         "Features__tblFeatures000001")


def _vfs(**overrides) -> AirtableVFS:
    return AirtableVFS(
        AirtableConfig(**{
            "token": TOKEN,
            "requests_per_second": 10_000.0,
            **overrides
        }))


def test_the_registry_builds_it_and_refuses_a_typo():
    vfs = build_vfs("airtable", {"token": "t"})
    assert isinstance(vfs, AirtableVFS)
    assert vfs.name == VFSName.AIRTABLE
    with pytest.raises(ValueError, match="base_idz"):
        build_vfs("airtable", {"token": "t", "base_idz": ["appX"]})


def test_reads_are_never_served_from_the_file_cache():
    vfs = _vfs()
    assert vfs.caches_reads is False
    assert vfs.SIZES_ALWAYS_KNOWN is False
    assert vfs.SUPPORTS_SNAPSHOT is False


def test_the_file_surface_is_read_only():
    names = {c.name for c in _vfs().commands()}
    assert {"cat", "ls", "find", "grep", "head", "jq", "wc"} <= names
    assert not [op.name for op in _vfs().ops_list() if op.write]


def test_state_redacts_the_token():
    state = _vfs().get_state()
    assert state["type"] == "airtable"
    assert TOKEN not in str(state)


@pytest.mark.asyncio
async def test_a_workspace_browses_bases_tables_and_records(airtable_api):
    ws = Workspace({"/at/": _vfs(max_read_records=5)})
    try:
        tree = await ws.shell(
            "tree /at/bases/Product_Roadmap__appRoadmapBase001")
        assert "records.jsonl" in await tree.stdout_str()
        names = await ws.shell(f"head -n 3 {TABLE}/records.jsonl"
                               " | jq -r .fields.Name")
        assert (await names.stdout_str()).split("\n")[:3] == [
            "Feature 1", "Feature 2", "Feature 3"
        ]
        done = await ws.shell(
            f"wc -l < {TABLE}/views/Done_shipped__viwDone0000000001.jsonl")
        assert (await done.stdout_str()).strip() == "4"
        refused = await ws.shell(f"cat {TABLE}/records.jsonl")
        assert refused.exit_code == 1
        assert await refused.stderr_str() == (
            f"cat: {TABLE}/records.jsonl: File too large\n")
    finally:
        await ws.close()
