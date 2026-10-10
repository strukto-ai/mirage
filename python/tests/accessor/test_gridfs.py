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

from unittest.mock import MagicMock, patch

import pytest

from mirage.accessor.gridfs import GridFSAccessor
from mirage.vfs.gridfs.config import GridFSConfig


@pytest.mark.asyncio
async def test_client_connects_to_the_configured_uri():
    accessor = GridFSAccessor(
        config=GridFSConfig(
            uri="mongodb://localhost:27017", database="db", bucket="data"
        )
    )
    sentinel = MagicMock()
    with patch(
        "mirage.accessor.mongodb.AsyncMongoClient", return_value=sentinel
    ) as ctor:
        client = accessor.client
    assert client is sentinel
    ctor.assert_called_once_with("mongodb://localhost:27017")
