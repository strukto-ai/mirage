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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.rm import rm_r
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_rm_r_deletes_recursively_in_one_call():
    with patch("mirage.core.dropbox.rm.delete_path",
               new_callable=AsyncMock) as deleted:
        await rm_r(make_accessor("/Team"), PathSpec.from_str_path("/docs"))
    assert deleted.await_args.args[1] == "/Team/docs"


@pytest.mark.asyncio
async def test_rm_r_missing_raises_enoent():
    with patch("mirage.core.dropbox.rm.delete_path",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("nf", 409,
                                           "path_lookup/not_found/...")):
        with pytest.raises(FileNotFoundError):
            await rm_r(make_accessor(), PathSpec.from_str_path("/ghost"))
