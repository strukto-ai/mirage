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
from mirage.commands.builtin.databricks_volume import awk as awk_command
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_awk(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "awk '{print $1}' /dbx/table.csv")

    assert io.exit_code == 0
    assert io.stdout == b"name,score\nann,2\nbob,3\n"


@pytest.mark.asyncio
async def test_databricks_volume_awk_forwards_index(
    index_tracker,
    expected_index: RAMIndexCacheStore,
    materialize_output,
):
    source, _io = await awk_command(
        object(),
        [PathSpec.from_str_path("/dbx/sample.csv", "/dbx")],
        "{print $1}",
        index=expected_index,
    )

    await materialize_output(source)

    assert index_tracker.seen_indexes
    assert all(index is expected_index for index in index_tracker.seen_indexes)
