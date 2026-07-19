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

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.generic.rm_command import make_rm
from mirage.types import PathSpec


class FakeAccessor:
    pass


def _make_rm(files: set[str], calls: list[tuple]):

    async def resolve_glob(accessor, paths, index):
        return paths

    async def unlink(accessor, path, index=NULL_INDEX):
        calls.append((accessor, path, index))
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        files.remove(path.virtual)

    return make_rm(resource="gdocs", glob_fn=resolve_glob, unlink=unlink)


@pytest.mark.asyncio
async def test_rm_threads_accessor_and_index_into_unlink():
    calls: list[tuple] = []
    accessor = FakeAccessor()
    rm = _make_rm({"/owned/a.gdoc.json"}, calls)
    path = PathSpec.from_str_path("/owned/a.gdoc.json")
    _, result = await rm(accessor, [path], index=NULL_INDEX)
    assert result.exit_code == 0
    assert calls == [(accessor, path, NULL_INDEX)]


@pytest.mark.asyncio
async def test_rm_missing_operand():
    rm = _make_rm(set(), [])
    with pytest.raises(ValueError, match="missing operand"):
        await rm(FakeAccessor(), [])


@pytest.mark.asyncio
async def test_rm_enoent_propagates_without_force():
    rm = _make_rm(set(), [])
    with pytest.raises(FileNotFoundError):
        await rm(FakeAccessor(), [PathSpec.from_str_path("/owned/x.json")])


@pytest.mark.asyncio
async def test_rm_force_swallows_enoent():
    calls: list[tuple] = []
    rm = _make_rm(set(), calls)
    _, result = await rm(FakeAccessor(),
                         [PathSpec.from_str_path("/owned/x.json")],
                         f=True)
    assert result.exit_code == 0
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_rm_verbose_reports_each_removal():
    files = {"/owned/a.gdoc.json", "/owned/b.gdoc.json"}
    rm = _make_rm(files, [])
    paths = [
        PathSpec.from_str_path("/owned/a.gdoc.json"),
        PathSpec.from_str_path("/owned/b.gdoc.json"),
    ]
    output, result = await rm(FakeAccessor(), paths, v=True)
    assert isinstance(output, bytes)
    text = output.decode()
    assert "removed '/owned/a.gdoc.json'" in text
    assert "removed '/owned/b.gdoc.json'" in text
    assert result.exit_code == 0
    assert not files
