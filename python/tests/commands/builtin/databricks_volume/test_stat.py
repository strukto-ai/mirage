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
async def test_stat_default_format(databricks_text_workspace):
    io = await databricks_text_workspace.shell("stat /dbx/words.txt")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "name=words.txt" in out
    assert "size=17" in out


@pytest.mark.asyncio
async def test_stat_custom_format(databricks_text_workspace):
    io = await databricks_text_workspace.shell("stat -c '%n %s' /dbx/words.txt"
                                               )

    assert io.exit_code == 0
    assert io.stdout.decode().strip() == "/dbx/words.txt 17"


@pytest.mark.asyncio
async def test_stat_missing_file_fails(databricks_text_workspace):
    io = await databricks_text_workspace.shell("stat /dbx/missing.txt")

    assert io.exit_code != 0
