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
from typing import Any
from unittest.mock import patch

import pytest

from mirage.accessor.onedrive import OneDriveConfig
from mirage.core.msgraph.client import GraphError
from mirage.core.msgraph.watch import DeltaTarget, GraphDeltaHook
from mirage.types import FileChangeKind, PathSpec

DRIVE = "https://graph.test/drives/d"
ROOT = PathSpec.from_str_path("/m", vfs_path="")
NEW = "2026-10-01T00:00:00Z"


class FakeDrive:
    """A drive whose ``/delta`` answers link ``Ln`` with ``pages[n]``."""

    def __init__(self, folders: dict[str, str]) -> None:
        self.folders = folders
        self.pages: list[list[dict[str, Any]] | GraphError] = []

    async def get(
        self,
        config: OneDriveConfig,
        url: str,
        params: dict[str, str] | None = None,
        session: None = None,
    ) -> dict[str, Any]:
        if url.endswith("/root/delta"):
            return {"value": [], "@odata.deltaLink": "L0"}
        if url.endswith("/root"):
            return {"id": "R"}
        if url.startswith(f"{DRIVE}/root:/"):
            found = self.folders.get(url.removeprefix(f"{DRIVE}/root:/"))
            if found is None:
                raise GraphError(404, "itemNotFound", url)
            return {"id": found}
        n = int(url.removeprefix("L"))
        page = self.pages[n]
        if isinstance(page, GraphError):
            raise page
        return {"value": page, "@odata.deltaLink": f"L{n + 1}"}


def item(
    item_id: str, name: str, parent: str, **facets: Any
) -> dict[str, Any]:
    return {
        "id": item_id,
        "name": name,
        "parentReference": {"id": parent},
        "createdDateTime": NEW,
        "lastModifiedDateTime": NEW,
        **facets,
    }


def hook(folder: str = "") -> GraphDeltaHook:
    async def targets(root: PathSpec) -> list[DeltaTarget]:
        return [DeltaTarget(drive=DRIVE, folder=folder, virtual="/m")]

    return GraphDeltaHook(OneDriveConfig(access_token="t"), None, targets)


async def pulls(fake: FakeDrive, target: GraphDeltaHook, n: int) -> list:
    out = []
    with patch("mirage.core.msgraph.watch.graph_get", fake.get):
        delta = await target.pull(ROOT, None)
        for _ in range(n):
            delta = await target.pull(ROOT, delta.checkpoint)
            out.append(delta)
    return out


def pairs(delta) -> list[tuple[FileChangeKind, str]]:
    return [(c.kind, c.path.virtual) for c in delta.changes]


@pytest.mark.asyncio
async def test_a_child_listed_before_its_renamed_folder_lands_in_it():
    fake = FakeDrive({})
    fake.pages = [
        [item("F", "Docs", "R", folder={})],
        [
            item("c", "a.txt", "F", file={}),
            item("F", "Papers", "R", folder={}),
        ],
    ]
    first, second = await pulls(fake, hook(), 2)
    assert pairs(first) == [(FileChangeKind.CREATE, "/m/Docs")]
    assert pairs(second) == [
        (FileChangeKind.CREATE, "/m/Papers/a.txt"),
        (FileChangeKind.DELETE, "/m/Docs"),
        (FileChangeKind.CREATE, "/m/Papers"),
    ]


@pytest.mark.asyncio
async def test_a_resync_forgets_every_place_it_kept():
    fake = FakeDrive({})
    fake.pages = [
        [item("F", "Docs", "R", folder={})],
        GraphError(410, "resyncRequired", "resync"),
    ]
    first, second = await pulls(fake, hook(), 2)
    assert pairs(second) == [(FileChangeKind.UNKNOWN, "/m")]
    kept = json.loads(second.checkpoint or "")["graph"]["drives"][DRIVE]
    assert kept["folders"] == {} and kept["seen"] == {}
    assert kept["link"] == "L0"


@pytest.mark.asyncio
async def test_a_root_folder_replaced_or_gone_is_found_again():
    # The mount root is a path: a folder recreated there takes over, and
    # one moved away leaves the root unknown until something is there.
    fake = FakeDrive({"Work": "w1"})
    fake.pages = [[], [], []]
    target = hook("Work")
    with patch("mirage.core.msgraph.watch.graph_get", fake.get):
        delta = await target.pull(ROOT, None)
        fake.folders["Work"] = "w2"
        fake.pages[0] = [
            item("w1", "Work", "R", deleted={}),
            item("w2", "Work", "R", folder={}),
            item("x", "x.txt", "w2", file={}),
        ]
        replaced = await target.pull(ROOT, delta.checkpoint)
        del fake.folders["Work"]
        gone = await target.pull(ROOT, replaced.checkpoint)
        fake.folders["Work"] = "w3"
        back = await target.pull(ROOT, gone.checkpoint)
    assert pairs(replaced) == [
        (FileChangeKind.UNKNOWN, "/m"),
        (FileChangeKind.CREATE, "/m/x.txt"),
    ]
    assert pairs(gone) == [(FileChangeKind.UNKNOWN, "/m")]
    assert pairs(back) == [(FileChangeKind.UNKNOWN, "/m")]


@pytest.mark.asyncio
async def test_a_folder_taking_anothers_name_keeps_its_own_children():
    # A renamed to Z and B renamed to A in one read, B's child listed
    # first: the child is in the new A, and stays there for the next read.
    fake = FakeDrive({})
    fake.pages = [
        [
            item("A", "A", "R", folder={}),
            item("B", "B", "R", folder={}),
            item("c", "c.txt", "B", file={}),
        ],
        [
            item("c", "c.txt", "B", file={}),
            item("A", "Z", "R", folder={}),
            item("B", "A", "R", folder={}),
        ],
        [{"id": "c", "deleted": {}}],
    ]
    _, second, third = await pulls(fake, hook(), 3)
    assert pairs(second) == [
        (FileChangeKind.DELETE, "/m/B/c.txt"),
        (FileChangeKind.CREATE, "/m/A/c.txt"),
        (FileChangeKind.DELETE, "/m/A"),
        (FileChangeKind.CREATE, "/m/Z"),
        (FileChangeKind.DELETE, "/m/B"),
        (FileChangeKind.CREATE, "/m/A"),
    ]
    assert pairs(third) == [(FileChangeKind.DELETE, "/m/A/c.txt")]


@pytest.mark.asyncio
async def test_an_item_listed_twice_is_taken_at_its_last_row():
    # Graph may list a folder once per rename across pages: only the last
    # row says where it is, and what it holds follows it there.
    fake = FakeDrive({})
    fake.pages = [
        [item("F", "A", "R", folder={}), item("x", "x.txt", "F", file={})],
        [item("F", "B", "R", folder={}), item("F", "C", "R", folder={})],
        [{"id": "x", "deleted": {}}],
    ]
    _, second, third = await pulls(fake, hook(), 3)
    assert pairs(second) == [
        (FileChangeKind.DELETE, "/m/A"),
        (FileChangeKind.CREATE, "/m/C"),
    ]
    assert pairs(third) == [(FileChangeKind.DELETE, "/m/C/x.txt")]


@pytest.mark.asyncio
async def test_the_drives_a_root_covers_are_found_again_each_read():
    # A library added is created and read from then on, one renamed moves,
    # and one gone is deleted.
    other = "https://graph.test/drives/e"
    names = [
        [(DRIVE, "/m/Docs")],
        [(DRIVE, "/m/Docs"), (other, "/m/Two")],
        [(DRIVE, "/m/Files"), (other, "/m/Two")],
        [(other, "/m/Two")],
    ]

    async def targets(root: PathSpec) -> list[DeltaTarget]:
        return [
            DeltaTarget(drive=drive, folder="", virtual=virtual)
            for drive, virtual in names.pop(0)
        ]

    fake = FakeDrive({})
    fake.pages = [[], [], []]
    target = GraphDeltaHook(OneDriveConfig(access_token="t"), None, targets)
    added, renamed, gone = await pulls(fake, target, 3)
    assert pairs(added) == [(FileChangeKind.CREATE, "/m/Two")]
    assert pairs(renamed) == [
        (FileChangeKind.DELETE, "/m/Docs"),
        (FileChangeKind.CREATE, "/m/Files"),
    ]
    assert pairs(gone) == [(FileChangeKind.DELETE, "/m/Files")]
