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

from mirage.accessor.gcal import GCalAccessor
from mirage.types import PathSpec
from mirage.vfs.gcal import GCalVFS
from tests.fixtures.gcal_api import make_accessor, spec
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio


async def unlink(accessor: GCalAccessor, path: PathSpec) -> None:
    await mounted(GCalVFS, accessor).unlink(path)


@pytest.mark.parametrize(
    "size, path",
    [
        (1, "/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"),
        (
            7,
            "/primary/2026-08-10--2026-08-16/"
            "aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json",
        ),
    ],
)
async def test_unlink_deletes_the_event_the_name_carries(
    gcal_api, size, path, index
):
    await unlink(make_accessor(bucket_days=size), spec(path))
    assert gcal_api.deleted == [("integ@example.com", "aaaa1")]
    # The entry resolves through the parent bucket's one listing first, so
    # an unlisted name is refused without a destructive call.
    assert [call[0] for call in gcal_api.listed] == ["integ@example.com"]


@pytest.mark.parametrize(
    "path, error",
    [
        ("/primary/2026-08-11", IsADirectoryError),
        # accessRole reader and freeBusyReader: refused at the mount rather
        # than surfacing a 403 after the call has already gone out.
        (
            "/Engineering__team@group.calendar.google.com/2026-08-11/"
            "aaaa1__0900-1030_PhD_Defense.gcal.json",
            PermissionError,
        ),
        (
            "/Exec__busy@group.calendar.google.com/2026-08-11/"
            "aaaa1__0900-1030_busy.gcal.json",
            PermissionError,
        ),
        ("/nope/2026-08-11/aaaa1__0900-1030_X.gcal.json", FileNotFoundError),
    ],
)
async def test_unlink_refuses_without_deleting(
    gcal_api, accessor, index, path, error
):
    with pytest.raises(error):
        await unlink(accessor, spec(path))
    assert gcal_api.deleted == []
