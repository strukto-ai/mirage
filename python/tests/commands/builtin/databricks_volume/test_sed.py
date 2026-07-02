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
from mirage.commands.builtin.databricks_volume import sed as sed_command
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_sed(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "sed s/alpha/ALPHA/g /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nALPHA\nALPHA\n"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_sed_resolves_glob(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "sed s/delta/DELTA/ /dbx/*.txt")

    assert io.exit_code == 0
    assert b"DELTA\n" in io.stdout


@pytest.mark.asyncio
async def test_databricks_volume_sed_forwards_index(
    index_tracker,
    expected_index: RAMIndexCacheStore,
    materialize_output,
):
    source, _io = await sed_command(
        object(),
        [
            PathSpec.from_str_path("/dbx/sample.txt",
                                   mount_key("/dbx/sample.txt", "/dbx"))
        ],
        "s/alpha/ALPHA/g",
        index=expected_index,
    )

    await materialize_output(source)

    assert index_tracker.seen_indexes
    assert all(index is expected_index for index in index_tracker.seen_indexes)


@pytest.mark.asyncio
async def test_databricks_volume_sed_in_place_is_not_supported(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "sed -i s/alpha/ALPHA/g /dbx/words.txt")

    assert io.exit_code == 1
    assert b"-i is not supported" in io.stderr
