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

from mirage.core.gcal.unlink import unlink
from mirage.types import PathSpec

pytestmark = pytest.mark.asyncio

EVENT = "/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


async def test_unlink_deletes_the_event_the_name_carries(api, accessor, index):
    await unlink(accessor, spec(EVENT), index)
    assert api.deleted == [("integ@example.com", "aaaa1")]


async def test_unlink_needs_no_read_first(api, accessor, index):
    # The id comes off the filename, so deleting costs one API call.
    await unlink(accessor, spec(EVENT), index)
    assert api.listed == []


async def test_unlink_refuses_a_directory(api, accessor, index):
    with pytest.raises(IsADirectoryError):
        await unlink(accessor, spec("/primary/2026-08-11"), index)
    assert api.deleted == []


async def test_unlink_refuses_a_read_only_calendar(api, accessor, index):
    path = ("/Engineering__team@group.calendar.google.com/2026-08-11/"
            "aaaa1__0900-1030_PhD_Defense.gcal.json")
    # accessRole reader: refuse at the mount rather than surfacing a 403
    # from inside the API after the call has already gone out.
    with pytest.raises(PermissionError):
        await unlink(accessor, spec(path), index)
    assert api.deleted == []


async def test_unlink_refuses_a_free_busy_calendar(api, accessor, index):
    path = ("/Exec__busy@group.calendar.google.com/2026-08-11/"
            "aaaa1__0900-1030_busy.gcal.json")
    with pytest.raises(PermissionError):
        await unlink(accessor, spec(path), index)
    assert api.deleted == []


async def test_unlink_on_an_unknown_calendar_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await unlink(accessor,
                     spec("/nope/2026-08-11/aaaa1__0900-1030_X.gcal.json"),
                     index)
