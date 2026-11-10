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

from mirage.commands.builtin.general.getconf import (
    GETCONF_VARIABLES,
    PATH_VARIABLES,
    live_value,
    variable,
)
from mirage.io.memory import MemoryBudget, run_with_memory


def test_every_pathconf_variable_is_a_table_row():
    assert PATH_VARIABLES <= {name for name, _ in GETCONF_VARIABLES}


def test_a_name_without_its_posix_prefix_finds_the_first_row():
    assert variable("VERSION") == ("_POSIX_VERSION", "200809")
    assert variable("LINK_MAX") == ("LINK_MAX", "127")
    assert variable("NO_SUCH_VAR") is None


def test_the_listing_follows_the_posix_tables():
    names = [name for name, _ in GETCONF_VARIABLES]
    assert names[:3] == ["FILESIZEBITS", "LINK_MAX", "MAX_CANON"]
    assert names.index("ARG_MAX") < names.index("PATH")
    assert names.index("PATH") < names.index("CHAR_BIT")
    assert names[-1] == "UIO_MAXIOV"


def test_a_name_with_its_own_row_finds_it_before_a_posix_one():
    assert variable("ARG_MAX") == ("ARG_MAX", "2097152")
    assert variable("SSIZE_MAX") == ("SSIZE_MAX", "32767")


@pytest.mark.asyncio
async def test_the_memory_variables_are_the_workspaces_max_memory():
    async def read() -> tuple[str | None, str | None, str | None]:
        return (
            live_value("_PHYS_PAGES", None),
            live_value("_AVPHYS_PAGES", None),
            live_value("PAGESIZE", "4096"),
        )

    budget = MemoryBudget(1 << 20, lambda: 8192)
    assert await run_with_memory(budget, read()) == ("256", "254", "4096")
    assert await read() == (None, None, "4096")
