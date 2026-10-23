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

import errno
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.rename import rename
from mirage.core.google.rename import app_title
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import serve

MODIFIED = "2026-10-01T09:00:00.000Z"
OLD = "2026-10-01_Old_Plan__doc1.gdoc.json"
NEW = "2026-10-01_New_Plan__doc1.gdoc.json"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/gdocs"),
        virtual=virtual,
        directory=virtual,
    )


@pytest.fixture
def patched():
    patched = AsyncMock()
    with (
        serve(
            drive=StubDrive(
                get_file=AsyncMock(
                    return_value={"id": "doc1", "modifiedTime": MODIFIED}
                ),
                patch_file=patched,
            )
        ),
    ):
        yield patched


async def renamed(dst: str) -> None:
    entry = FileStat(
        name=OLD,
        type=FileType.FILE,
        modified=MODIFIED,
        extra={"doc_id": "doc1", "doc_name": "Old Plan"},
    )
    await rename(
        GDocsAccessor(config=None, token_manager=None),
        spec(f"/gdocs/owned/{OLD}"),
        spec(dst),
        entry,
    )


@pytest.mark.parametrize(
    ("name", "title"),
    [
        (NEW, "New_Plan"),
        ("2026-09-30_New__doc1.gdoc.json", None),
        ("2026-10-01_New__doc2.gdoc.json", None),
        ("2026-10-01_New Plan__doc1.gdoc.json", None),
    ],
)
def test_only_a_name_the_listing_renders_back_gives_a_title(name, title):
    assert app_title(name, "doc1", MODIFIED, ".gdoc.json") == title


@pytest.mark.asyncio
async def test_rename_sets_the_title_and_keeps_the_modified_time(patched):
    await renamed(f"/gdocs/owned/{NEW}")
    assert patched.await_args.args == (
        "doc1",
        {"name": "New_Plan", "modifiedTime": MODIFIED},
    )


@pytest.mark.parametrize(
    "dst", ["/gdocs/owned/New_Plan.gdoc.json", f"/gdocs/shared/{NEW}"]
)
@pytest.mark.asyncio
async def test_a_name_the_listing_cannot_render_is_eperm(patched, dst):
    with pytest.raises(OSError) as raised:
        await renamed(dst)
    assert raised.value.errno == errno.EPERM
    assert patched.await_count == 0
