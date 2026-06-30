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
async def test_head_c_positive_prefix(databricks_text_workspace):
    io = await databricks_text_workspace.execute("head -c 4 /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta"


@pytest.mark.asyncio
async def test_head_c_negative_all_but_last(databricks_text_workspace):
    # GNU `head -c -N` emits all but the last N bytes. words.txt is 17 bytes,
    # so -c -6 yields the first 11. A negative -c must not take the prefix
    # fast path (range read 0..-6 is meaningless).
    io = await databricks_text_workspace.execute("head -c -6 /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\n"
