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

from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.vfs.tidb_filesystem.config import TiDBFilesystemConfig
from tests.fixtures.drive9_api import TOKEN, FakeDrive9, serve


@pytest.fixture
def drive9() -> Iterator[FakeDrive9]:
    with serve(FakeDrive9(dirs={"/root"})) as fake:
        yield fake


@pytest_asyncio.fixture
async def accessor(
    drive9: FakeDrive9,
) -> AsyncIterator[TiDBFilesystemAccessor]:
    accessor = TiDBFilesystemAccessor(
        TiDBFilesystemConfig(host=drive9.url, token=TOKEN, root_path="/root")
    )
    yield accessor
    await accessor.close()
