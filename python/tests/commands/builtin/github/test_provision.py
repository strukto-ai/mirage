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

from mirage.commands.builtin.github.cat import cat_provision
from mirage.commands.builtin.github.find import find_provision
from mirage.commands.builtin.github.grep import grep_provision
from mirage.commands.builtin.github.head import head_provision
from mirage.commands.builtin.github.ls import ls_provision
from mirage.provision.types import Precision
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_TREE


@pytest.mark.asyncio
async def test_cat_plan_returns_file_size(github_env):
    accessor, index = github_env
    result = await cat_provision(
        accessor,
        [PathSpec(original="/README.md", directory="/", resolved=True)],
        index=index,
    )
    assert result.network_read_low == 500
    assert result.network_read_high == 500
    assert result.precision == Precision.EXACT


@pytest.mark.asyncio
async def test_head_plan_returns_file_size(github_env):
    accessor, index = github_env
    result = await head_provision(
        accessor,
        [PathSpec(original="/src/main.py", directory="/src", resolved=True)],
        index=index,
    )
    assert result.network_read_low == 3400
    assert result.network_read_high == 3400


@pytest.mark.asyncio
async def test_ls_plan_zero_network(github_env):
    accessor, index = github_env
    result = await ls_provision(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        index=index,
    )
    assert result.network_read_low == 0
    assert result.network_read_high == 0


@pytest.mark.asyncio
async def test_find_plan_zero_network(github_env):
    accessor, index = github_env
    result = await find_provision(
        accessor,
        [PathSpec(original="/", directory="/", resolved=False)],
        index=index,
    )
    assert result.network_read_low == 0
    assert result.network_read_high == 0


@pytest.mark.asyncio
async def test_grep_plan_single_file(github_env):
    accessor, index = github_env
    result = await grep_provision(
        accessor,
        [PathSpec(original="/src/main.py", directory="/src", resolved=True)],
        "import",
        index=index,
    )
    assert result.network_read_low == 3400
    assert result.read_ops == 1


@pytest.mark.asyncio
async def test_grep_plan_multiple_files(github_env):
    accessor, index = github_env
    result = await grep_provision(
        accessor,
        [
            PathSpec(original="/src/main.py", directory="/src", resolved=True),
            PathSpec(original="/src/utils.py", directory="/src",
                     resolved=True),
        ],
        "import",
        index=index,
    )
    assert result.network_read_low == 3400 + 1800
    assert result.read_ops == 2


@pytest.mark.asyncio
async def test_grep_plan_dir_without_r_skips(github_env):
    accessor, index = github_env
    result = await grep_provision(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        "import",
        index=index,
    )
    assert result.network_read_low == 0
    assert result.read_ops == 0


@pytest.mark.asyncio
async def test_grep_plan_recursive_on_dir(github_env):
    accessor, index = github_env
    result = await grep_provision(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        "import",
        r=True,
        index=index,
    )
    assert result.network_read_low > 0
    assert result.read_ops > 0
    expected_size = sum(e.size or 0 for p, e in MOCK_TREE.items()
                        if p.startswith("src/") and e.type == "blob")
    assert result.network_read_low == expected_size
