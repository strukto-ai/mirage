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

import asyncio

import pytest

from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.unlink import make_unlink
from mirage.types import FileStat, FileType
from tests.core.hierarchy.conftest import FakeAccessor, detect_scope, spec


async def _delete(
    accessor: FakeAccessor, match: ScopeMatch, entry: FileStat
) -> None:
    accessor.calls.append(f"delete:{entry.name}")


UNLINK = make_unlink(detect_scope, deleters={"note": _delete})
NOTE = FileStat(name="a.json", type=FileType.FILE)


def test_unlink_deletes_the_row_it_is_handed(accessor):
    asyncio.run(UNLINK(accessor, spec("/rooms/red/a.json"), NOTE))
    assert accessor.calls == ["delete:a.json"]


def test_unlink_refuses_a_directory(accessor):
    with pytest.raises(IsADirectoryError):
        asyncio.run(UNLINK(accessor, spec("/rooms/red")))
    with pytest.raises(IsADirectoryError):
        asyncio.run(UNLINK(accessor, spec("/")))


def test_unlink_of_a_path_no_listing_names_is_enoent(accessor):
    path = spec("/rooms/red/nope.json")
    with pytest.raises(FileNotFoundError) as excinfo:
        asyncio.run(UNLINK(accessor, path))
    assert excinfo.value.filename == path.virtual
    with pytest.raises(FileNotFoundError):
        asyncio.run(UNLINK(accessor, spec("/halls/x.json"), NOTE))
    assert accessor.calls == []
