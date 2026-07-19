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

import aiohttp
import pytest
from multidict import CIMultiDict, CIMultiDictProxy
from yarl import URL

import mirage.core.gdrive.resolve as resolve_mod
from mirage.core.gdrive.resolve import (DriveNode, drive_target_name,
                                        eacces_on_denied, query_candidates,
                                        resolve_dir, resolve_key,
                                        resolve_parent)
from mirage.types import PathSpec

FOLDER_MIME = "application/vnd.google-apps.folder"

DOC_MIME = "application/vnd.google-apps.document"


@pytest.mark.asyncio
async def test_resolve_key_nested(fake_drive, gdrive_accessor):
    folder = fake_drive.folder("a")
    sub = fake_drive.folder("b", parent=folder)
    file_id = fake_drive.add("f.txt", parent=sub, content=b"x")
    node = await resolve_key(gdrive_accessor, "a/b/f.txt")
    assert node is not None
    assert node.id == file_id
    assert not node.is_folder


@pytest.mark.asyncio
async def test_resolve_key_missing_returns_none(fake_drive, gdrive_accessor):
    fake_drive.folder("a")
    assert await resolve_key(gdrive_accessor, "a/missing.txt") is None
    assert await resolve_key(gdrive_accessor, "nope/f.txt") is None


@pytest.mark.asyncio
async def test_resolve_key_file_in_middle_raises(fake_drive, gdrive_accessor):
    fake_drive.add("f.txt", content=b"x")
    with pytest.raises(NotADirectoryError):
        await resolve_key(gdrive_accessor, "f.txt/child")


@pytest.mark.asyncio
async def test_resolve_key_native_suffix(fake_drive, gdrive_accessor):
    doc_id = fake_drive.add("Report", mime=DOC_MIME)
    node = await resolve_key(gdrive_accessor, "Report.gdoc.json")
    assert node is not None
    assert node.id == doc_id
    assert node.is_native


@pytest.mark.asyncio
async def test_resolve_key_prefers_literal_name(fake_drive, gdrive_accessor):
    literal = fake_drive.add("x.gdoc.json", content=b"raw")
    fake_drive.add("x", mime=DOC_MIME)
    node = await resolve_key(gdrive_accessor, "x.gdoc.json")
    assert node is not None
    assert node.id == literal


@pytest.mark.asyncio
async def test_resolve_dir_root_and_errors(fake_drive, gdrive_accessor):
    assert await resolve_dir(gdrive_accessor, "", "/") == ("root", None)
    folder = fake_drive.folder("d")
    assert (await resolve_dir(gdrive_accessor, "d", "/d"))[0] == folder
    fake_drive.add("f.txt")
    with pytest.raises(NotADirectoryError):
        await resolve_dir(gdrive_accessor, "f.txt", "/f.txt")
    with pytest.raises(FileNotFoundError):
        await resolve_dir(gdrive_accessor, "missing", "/missing")


@pytest.mark.asyncio
async def test_resolve_parent(fake_drive, gdrive_accessor):
    folder = fake_drive.folder("a")
    path = PathSpec(virtual="/a/new.txt",
                    directory="/a",
                    resource_path="a/new.txt")
    assert (await resolve_parent(gdrive_accessor, path))[0] == folder


def test_query_candidates():
    assert query_candidates("plain.txt") == [("plain.txt", None)]
    cands = query_candidates("r.gdoc.json")
    assert cands[0] == ("r.gdoc.json", None)
    assert ("r", DOC_MIME) in cands
    # A bare suffix is not a native candidate.
    assert query_candidates(".gdoc.json") == [(".gdoc.json", None)]


def test_drive_target_name():
    doc = DriveNode(id="1", name="r", mime_type=DOC_MIME)
    plain = DriveNode(id="2", name="f", mime_type="text/plain")
    assert drive_target_name("new.gdoc.json", doc) == "new"
    assert drive_target_name("new.gdoc.json", plain) == "new.gdoc.json"
    assert drive_target_name("new.txt", doc) == "new.txt"


@pytest.mark.asyncio
async def test_resolve_scoped_to_folder(fake_drive, scoped_accessor):
    scope = fake_drive.folder("scope")
    inner = fake_drive.add("f.txt", parent=scope, content=b"in")
    fake_drive.add("f.txt", content=b"out")
    accessor = scoped_accessor(scope)
    node = await resolve_key(accessor, "f.txt")
    assert node is not None
    assert node.id == inner
    assert await resolve_dir(accessor, "", "/") == (scope, None)


@pytest.mark.asyncio
async def test_root_context_shared_drive_scope(fake_drive, scoped_accessor):
    scope = fake_drive.add("team", mime=FOLDER_MIME, drive_id="d1")
    inner = fake_drive.add("f.txt", parent=scope, drive_id="d1")
    accessor = scoped_accessor(scope)
    assert await resolve_dir(accessor, "", "/") == (scope, "d1")
    node = await resolve_key(accessor, "f.txt")
    assert node is not None
    assert node.id == inner
    assert node.drive_id == "d1"


@pytest.mark.asyncio
async def test_root_context_memoizes_drive_lookup(fake_drive, scoped_accessor,
                                                  monkeypatch):
    scope = fake_drive.add("team", mime=FOLDER_MIME, drive_id="d1")
    accessor = scoped_accessor(scope)
    calls = 0

    async def counting_get_file(token_manager, file_id):
        nonlocal calls
        calls += 1
        return await fake_drive.get_file(token_manager, file_id)

    monkeypatch.setattr(resolve_mod, "get_file", counting_get_file)
    assert await resolve_dir(accessor, "", "/") == (scope, "d1")
    assert await resolve_dir(accessor, "", "/") == (scope, "d1")
    assert calls == 1


@pytest.mark.asyncio
async def test_eacces_on_denied_maps_403():
    request_info = aiohttp.RequestInfo(url=URL("https://x"),
                                       method="POST",
                                       headers=CIMultiDictProxy(CIMultiDict()),
                                       real_url=URL("https://x"))

    @eacces_on_denied
    async def denied(accessor, path: PathSpec) -> None:
        raise aiohttp.ClientResponseError(request_info, (), status=403)

    @eacces_on_denied
    async def server_error(accessor, path: PathSpec) -> None:
        raise aiohttp.ClientResponseError(request_info, (), status=500)

    spec = PathSpec.from_str_path("/gd/a.txt", "a.txt")
    with pytest.raises(PermissionError, match="/gd/a.txt"):
        await denied(None, spec)
    with pytest.raises(aiohttp.ClientResponseError):
        await server_error(None, spec)
