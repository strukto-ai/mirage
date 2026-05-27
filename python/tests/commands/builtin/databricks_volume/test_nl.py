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

from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.databricks_volume import nl as nl_command
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_nl(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute("nl /dbx/words.txt")

    assert io.exit_code == 0
    assert b"     1\tbeta\n" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_nl_resolves_glob(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute("nl /dbx/*.txt")

    assert io.exit_code == 0
    assert b"     1\tdelta\n" in io.stdout


@pytest.mark.asyncio
async def test_databricks_volume_nl_forwards_index(
    index_tracker,
    expected_index: RAMIndexCacheStore,
    materialize_output,
):
    source, _io = await nl_command(
        object(),
        [PathSpec.from_str_path("/dbx/sample.txt", "/dbx")],
        index=expected_index,
    )

    await materialize_output(source)

    assert index_tracker.seen_indexes
    assert all(index is expected_index for index in index_tracker.seen_indexes)
