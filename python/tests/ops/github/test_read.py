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

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexEntry, LookupResult, LookupStatus
from mirage.ops.github.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GitHubAccessor(
        config=MagicMock(),
        owner="org",
        repo="repo",
        ref="main",
        default_branch="main",
    )


@pytest.fixture
def index():
    mock = AsyncMock()
    mock.get.return_value = LookupResult(
        status=LookupStatus.EXPIRED,
        entry=IndexEntry(id="abc123",
                         name="file.py",
                         resource_type="file",
                         size=100),
    )
    return mock


@pytest.mark.asyncio
async def test_read_calls_core(accessor, index):
    fn = read._registered_ops[0].fn
    with patch(
            "mirage.ops.github.read.core_read",
            new_callable=AsyncMock,
            return_value=b"print('hello')",
    ) as mock:
        scope = _scope("/github/src/file.py", prefix="/github")
        result = await fn(accessor, scope, index=index)
        mock.assert_called_once_with(
            accessor, _scope("/github/src/file.py", prefix="/github"), index)
        assert result == b"print('hello')"


@pytest.mark.asyncio
async def test_read_not_found(accessor):
    fn = read._registered_ops[0].fn
    index = AsyncMock()
    index.get.return_value = LookupResult(status=LookupStatus.NOT_FOUND,
                                          entry=None)
    with patch(
            "mirage.ops.github.read.core_read",
            new_callable=AsyncMock,
            side_effect=FileNotFoundError("/missing.py"),
    ):
        with pytest.raises(FileNotFoundError):
            await fn(accessor, _scope("/missing.py"), index=index)
