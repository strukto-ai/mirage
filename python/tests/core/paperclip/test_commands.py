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
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.paperclip import PaperclipAccessor
from mirage.commands.builtin.paperclip.grep import grep
from mirage.commands.builtin.paperclip.lookup import lookup
from mirage.commands.builtin.paperclip.map import map_cmd
from mirage.commands.builtin.paperclip.scan import scan
from mirage.commands.builtin.paperclip.search import search
from mirage.resource.paperclip.config import PaperclipConfig
from mirage.types import PathSpec

FAKE_CREDENTIALS = {
    "refresh_token": "fake-refresh-token",
    "email": "test@example.com",
    "uid": "uid-123",
    "id_token": "fake-id-token",
    "id_token_expires_at": 9999999999,
    "created_at": 1700000000,
}


@pytest.fixture
def tmp_credentials(tmp_path):
    creds_file = tmp_path / "credentials.json"
    creds_file.write_text(json.dumps(FAKE_CREDENTIALS))
    return str(creds_file)


@pytest.fixture
def config(tmp_credentials):
    return PaperclipConfig(credentials_path=tmp_credentials)


@pytest.fixture
def accessor(config):
    acc = PaperclipAccessor(config)
    acc.execute = AsyncMock(return_value={"output": "mock output"})
    return acc


@pytest.mark.asyncio
async def test_search_basic(accessor):
    output, io_result = await search(accessor, [], "BRCA1", "cancer")
    accessor.execute.assert_called_once_with("search", '"BRCA1 cancer"')
    assert output == b"mock output"
    assert io_result.exit_code == 0


@pytest.mark.asyncio
async def test_search_with_source_path(accessor):
    path = PathSpec(original="biorxiv/2024", directory="biorxiv/2024")
    output, io_result = await search(accessor, [path], "BRCA1")
    accessor.execute.assert_called_once_with(
        "search", '--source biorxiv --year 2024 "BRCA1"')
    assert io_result.exit_code == 0


@pytest.mark.asyncio
async def test_search_with_n_flag(accessor):
    output, io_result = await search(accessor, [], "BRCA1", n="5")
    accessor.execute.assert_called_once_with("search", '-n 5 "BRCA1"')
    assert io_result.exit_code == 0


@pytest.mark.asyncio
async def test_lookup(accessor):
    output, io_result = await lookup(accessor, [], "doi:10.1234/test")
    accessor.execute.assert_called_once_with("lookup", "doi:10.1234/test")
    assert output == b"mock output"
    assert io_result.exit_code == 0


@pytest.mark.asyncio
async def test_scan(accessor):
    path = PathSpec(
        original="biorxiv/2024/01/paper-123/full.txt",
        directory="biorxiv/2024/01/paper-123",
    )
    output, io_result = await scan(accessor, [path], "BRCA1", "mutation")
    accessor.execute.assert_called_once_with(
        "scan",
        'biorxiv/2024/01/paper-123/full.txt "BRCA1" "mutation"',
    )
    assert output == b"mock output"
    assert io_result.exit_code == 0


@pytest.mark.asyncio
async def test_map_cmd(accessor):
    output, io_result = await map_cmd(accessor, [], "--from", "res-abc",
                                      "What are the key findings?")
    accessor.execute.assert_called_once_with(
        "map", "--from res-abc What are the key findings?")
    assert output == b"mock output"
    assert io_result.exit_code == 0


SEARCH_OUTPUT = ("  paper-001  ·  biorxiv  ·  2024-03-15\n"
                 "  paper-002  ·  biorxiv  ·  2024-03-20\n")

GREP_OUTPUT_1 = "L10:BRCA1 is a tumor suppressor\nL25:BRCA1 mutations\n"
GREP_OUTPUT_2 = "L5:BRCA1 expression levels\n"


@pytest.fixture
def search_accessor(config):
    acc = PaperclipAccessor(config)

    async def mock_execute(command, raw=""):
        if command == "search":
            return {"output": SEARCH_OUTPUT}
        if command == "grep":
            if "paper-001" in raw:
                return {"output": GREP_OUTPUT_1}
            if "paper-002" in raw:
                return {"output": GREP_OUTPUT_2}
        return {"output": ""}

    acc.execute = AsyncMock(side_effect=mock_execute)
    return acc


@pytest.mark.asyncio
async def test_grep_broad_scope_uses_search(search_accessor):
    path = PathSpec(original="/paperclip/biorxiv/2024/03",
                    directory="/paperclip/biorxiv/2024/03",
                    prefix="/paperclip")
    output, io_result = await grep(search_accessor, [path], "BRCA1")
    assert io_result.exit_code == 0
    decoded = output.decode()
    assert "content.lines:" in decoded
    assert "BRCA1" in decoded


@pytest.mark.asyncio
async def test_grep_broad_scope_source_level(search_accessor):
    path = PathSpec(original="/paperclip/biorxiv",
                    directory="/paperclip/biorxiv",
                    prefix="/paperclip")
    output, io_result = await grep(search_accessor, [path], "BRCA1")
    assert io_result.exit_code == 0
    calls = search_accessor.execute.call_args_list
    search_call = [c for c in calls if c[0][0] == "search"][0]
    assert "--source biorxiv" in search_call[0][1]


@pytest.mark.asyncio
async def test_grep_broad_scope_root_level(search_accessor):
    path = PathSpec(original="/paperclip/",
                    directory="/paperclip/",
                    prefix="/paperclip")
    output, io_result = await grep(search_accessor, [path], "BRCA1")
    assert io_result.exit_code == 0
    calls = search_accessor.execute.call_args_list
    search_call = [c for c in calls if c[0][0] == "search"][0]
    assert "--source" not in search_call[0][1]


@pytest.mark.asyncio
async def test_grep_broad_scope_no_results(config):
    acc = PaperclipAccessor(config)
    acc.execute = AsyncMock(return_value={"output": ""})
    path = PathSpec(original="/paperclip/biorxiv",
                    directory="/paperclip/biorxiv",
                    prefix="/paperclip")
    output, io_result = await grep(acc, [path], "nonexistent")
    assert io_result.exit_code == 1


@pytest.mark.asyncio
async def test_grep_broad_scope_max_count(search_accessor):
    path = PathSpec(original="/paperclip/biorxiv/2024",
                    directory="/paperclip/biorxiv/2024",
                    prefix="/paperclip")
    output, io_result = await grep(search_accessor, [path], "BRCA1", m="1")
    assert io_result.exit_code == 0
    lines = output.decode().strip().splitlines()
    assert len(lines) == 1
