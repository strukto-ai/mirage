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

from mirage.commands.cli.builtin.git.io import (read_file, read_names,
                                                read_optional)


@pytest.mark.asyncio
async def test_read_file_returns_bytes(workspace):
    data = await read_file(workspace.dispatch, "/repo/a.txt")
    assert data == b"one changed\n"


@pytest.mark.asyncio
async def test_read_file_propagates_a_miss(workspace):
    with pytest.raises(FileNotFoundError):
        await read_file(workspace.dispatch, "/repo/nope.txt")


@pytest.mark.asyncio
async def test_read_optional_answers_none_for_a_miss(workspace):
    # packed-refs is absent from a perfectly valid repository, so a miss
    # is an answer rather than an error.
    assert await read_optional(workspace.dispatch, "/repo/nope.txt") is None


@pytest.mark.asyncio
async def test_read_optional_returns_content_when_present(workspace):
    assert await read_optional(workspace.dispatch,
                               "/repo/a.txt") == b"one changed\n"


@pytest.mark.asyncio
async def test_read_names_lists_a_directory(workspace):
    names = await read_names(workspace.dispatch, "/repo")
    assert any(n.rstrip("/").rsplit("/", 1)[-1] == "a.txt" for n in names)


@pytest.mark.asyncio
async def test_read_names_is_empty_for_a_missing_directory(workspace):
    assert await read_names(workspace.dispatch, "/repo/nodir") == []
