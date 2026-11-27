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

import json

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from tests.fixtures.vfs_io import call_over

APP = "/gdocs"
MIME = "application/vnd.google-apps.document"


def _scope(path: str, prefix: str = APP) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


def _accessor(google_account) -> GDocsAccessor:
    manager = google_account.token_manager()
    return GDocsAccessor(config=manager.config, token_manager=manager)


@pytest.mark.asyncio
async def test_read_calls_core(google_account):
    made = await google_account.create("Report", MIME)
    await google_account.patch(made, modifiedTime="2026-04-01T00:00:00.000Z")
    fn = call_over(GDocsVFS, "read_doc")
    result = await fn(
        _accessor(google_account),
        _scope(f"{APP}/owned/2026-04-01_Report__{made}.gdoc.json"),
    )
    assert json.loads(result)["documentId"] == made


@pytest.mark.asyncio
async def test_read_not_found(google_account):
    fn = call_over(GDocsVFS, "read_doc")
    with pytest.raises(FileNotFoundError):
        await fn(
            _accessor(google_account),
            _scope(f"{APP}/owned/Nonexistent__doc9.gdoc.json"),
        )
