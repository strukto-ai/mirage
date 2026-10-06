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

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from aiohttp import ClientSession, web

from tests.fixtures.box_api import FakeBox, serve


def test_delete_refuses_an_unknown_mode():
    box = FakeBox(files={"a.txt": b"x"})
    with pytest.raises(AssertionError):
        box.delete("a.txt", "trashed")


@pytest.mark.parametrize("stage", ["setup", "start"])
def test_serve_propagates_startup_failure_and_closes_loop(monkeypatch, stage):
    loop = asyncio.new_event_loop()
    before = set(threading.enumerate())
    monkeypatch.setattr(asyncio, "new_event_loop", lambda: loop)
    target = web.AppRunner if stage == "setup" else web.TCPSite
    monkeypatch.setattr(
        target, stage, AsyncMock(side_effect=OSError("injected startup"))
    )
    with pytest.raises(OSError, match="injected startup"):
        with serve():
            pytest.fail("failed startup must not yield")
    assert loop.is_closed()
    assert set(threading.enumerate()) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "deleted,mode,code",
    [
        ("a/b/c.txt", "trash", "trashed"),
        ("a/b", "trash_ancestor", "not_found"),
        ("a", "trash_ancestor", "not_found"),
    ],
)
async def test_metadata_of_trashed_paths_matches_box(deleted, mode, code):
    box = FakeBox(files={"a/b/c.txt": b"x", "live.txt": b"y"})
    fid, sibling = box.id_of("a/b/c.txt"), box.id_of("live.txt")
    box.delete(deleted, mode)
    with serve(box):
        async with ClientSession() as session:
            async with session.get(f"{box.url}/2.0/files/{fid}") as response:
                assert response.status == 404
                assert await response.json() == {"code": code}
            async with session.get(
                f"{box.url}/2.0/files/{sibling}"
            ) as response:
                assert response.status == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("fields", ["name", "size"])
async def test_listing_projects_fields_plus_mini(fields):
    box = FakeBox(files={"c.txt": b"x", "folder/child": b"y"})
    with serve(box):
        async with ClientSession() as session:
            async with session.get(
                f"{box.url}/2.0/folders/0/items", params={"fields": fields}
            ) as response:
                rows = (await response.json())["entries"]
    file, folder = rows
    assert {"id", "name", "type", "etag", "sha1"} <= file.keys()
    assert ("size" in file) == (fields == "size")
    assert "modified_at" not in file
    assert folder["name"] == "folder" and "sha1" not in folder


@pytest.mark.asyncio
async def test_fixture_wire_matches_shared_golden():
    golden = (
        Path(__file__).resolve().parents[3] / "integ/fixtures/box/wire.json"
    )
    cases = json.loads(golden.read_text())
    assert cases, "shared Box wire corpus must contain comparisons"
    with serve(FakeBox(files={"a/b/c.txt": b"x"})) as box:
        async with ClientSession() as session:
            for case in cases:
                async with session.get(box.url + case["path"]) as response:
                    assert response.status == case["status"]
                    assert await response.json() == case["body"]
