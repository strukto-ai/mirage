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

from mirage.ops.gdrive.identity import live_identity
from mirage.types import PathSpec


class _PoisonIndex:
    """An index cache that fails loudly if the op ever consults it."""

    def __getattr__(self, name):
        raise AssertionError(f"live_identity must not touch index.{name}")


def _path(key: str) -> PathSpec:
    return PathSpec(virtual="/" + key, directory="/", resource_path=key)


@pytest.mark.asyncio
async def test_live_identity_ignores_a_poisoned_index(fake_drive,
                                                      gdrive_accessor):
    fake_drive.add("a.txt", content=b"hi")
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={
                "headRevisionId": "r9",
                "md5Checksum": "abc"
            },
    ):
        result = await live_identity(gdrive_accessor,
                                     _path("a.txt"),
                                     index=_PoisonIndex())
    assert result.exists is True
    assert result.revision == "r9"
    assert result.fingerprint == "abc"
