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


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_diff(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "diff -u /dbx/old.txt /dbx/new.txt")

    assert io.exit_code == 1
    assert b"-old" in io.stdout
    assert b"+new" in io.stdout


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_diff_resolves_glob(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "diff /dbx/old*.txt /dbx/new*.txt")

    assert io.exit_code == 1
    assert b"old" in io.stdout
    assert b"new" in io.stdout
