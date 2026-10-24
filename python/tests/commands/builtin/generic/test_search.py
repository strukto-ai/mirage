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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.search import (
    search_resources,
    semantic_options,
    unit_threshold,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec, SearchQuery

PATH = PathSpec(virtual="/data", directory="/", vfs_path="")


def test_semantic_options_default_the_method_only_when_absent():
    assert semantic_options(FlagView({})) == {
        "method": "semantic",
        "threshold": 0.0,
    }
    with pytest.raises(UsageError, match="only the 'semantic' method"):
        semantic_options(FlagView({"method": ""}))


@pytest.mark.parametrize("value", ["-0.1", "1.5"])
def test_a_threshold_outside_zero_to_one_is_a_usage_error(value):
    assert unit_threshold(FlagView({})) == 0.0
    assert unit_threshold(FlagView({"threshold": "0.4"})) == 0.4
    with pytest.raises(UsageError, match=r"threshold must be in \[0, 1\]"):
        unit_threshold(FlagView({"threshold": value}))


@pytest.mark.asyncio
async def test_a_query_is_one_search_over_every_scope():
    dispatch = AsyncMock(
        return_value=([("/data/a", "highest"), ("/data/b", "second")], None)
    )
    query = SearchQuery("question", options={"top_k": 2})
    assert (
        await search_resources(dispatch, [PATH, PATH], query)
        == b"highest\nsecond\n"
    )
    dispatch.assert_awaited_once_with(
        "search", PATH, query=query, scopes=[PATH]
    )


@pytest.mark.asyncio
async def test_declined_search_does_not_become_no_matches():
    dispatch = AsyncMock(return_value=(None, None))
    with pytest.raises(NotImplementedError, match="declined"):
        await search_resources(dispatch, [PATH], SearchQuery("query"))
