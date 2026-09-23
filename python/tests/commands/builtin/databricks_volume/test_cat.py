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
async def test_cat_single_file(databricks_text_workspace):
    io = await databricks_text_workspace.shell("cat /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\n"


@pytest.mark.asyncio
async def test_cat_multiple_files_concatenated(databricks_text_workspace):
    io = await databricks_text_workspace.shell(
        "cat /dbx/words.txt /dbx/more.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\ndelta\n"


@pytest.mark.asyncio
async def test_cat_n_numbers_lines(databricks_text_workspace):
    io = await databricks_text_workspace.shell("cat -n /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"     1\tbeta\n     2\talpha\n     3\talpha\n"
