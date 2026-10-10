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

from mirage import Mount, MountMode, Workspace
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS
from mirage.vfs.registry import build_vfs
from tests.fixtures.dropbox_api import FakeDropbox, serve


def make_vfs(**overrides) -> DropboxVFS:
    return DropboxVFS(
        DropboxConfig(
            client_id="c",
            client_secret="sekret",
            refresh_token="refresh-sekret",
            **overrides,
        )
    )


def test_subfolder_root_reaches_accessor():
    vfs = make_vfs(root_path="Team/data/")
    assert vfs.accessor.root_path == "/Team/data"


def test_state_does_not_leak_secrets():
    state = make_vfs().get_state()
    dumped = json.dumps(state, default=str)
    assert "sekret" not in dumped


@pytest.mark.asyncio
async def test_registry_builds_dropbox():
    vfs = build_vfs(
        "dropbox",
        {
            "client_id": "c",
            "client_secret": "s",
            "refresh_token": "r",
            "root_path": "/Team",
        },
    )
    assert isinstance(vfs, DropboxVFS)
    assert vfs.accessor.root_path == "/Team"


def test_invalid_root_path_rejected():
    with pytest.raises(ValueError, match="'\\.\\.'"):
        make_vfs(root_path="/a/../b")


def _workspace(dbx: FakeDropbox) -> Workspace:
    vfs = build_vfs(
        "dropbox",
        {
            "client_id": "c",
            "client_secret": "s",
            "refresh_token": "r",
            "endpoint": dbx.url,
        },
    )
    return Workspace({"/dbx": Mount(vfs, mode=MountMode.WRITE)})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, after",
    [
        ("cat /dbx/f >> /dbx/n", b"v1\none\n"),
        ("touch /dbx/n", b"v1\n"),
        ("sed -i s/v1/v2/ /dbx/n", b"v2\n"),
        ("{ echo x; } >> /dbx/n", b"v1\nx\n"),
    ],
    ids=["append", "touch", "sed-i", "group-append"],
)
async def test_a_file_created_after_the_listing_is_found(line, after):
    with serve(FakeDropbox(files={"f": b"one\n"})) as dbx:
        ws = _workspace(dbx)
        try:
            await (await ws.shell("ls /dbx")).stdout_str()
            dbx.write("n", b"v1\n")
            r = await ws.shell(line)
            err = await r.stderr_str()
        finally:
            await ws.close()
    assert (r.exit_code, err) == (0, "")
    assert dbx.read("n") == after


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line, code, routes",
    [
        ("", "cat /dbx/missing", 1, ["list_folder"]),
        ("", "cat /dbx/f* /dbx/missing", 1, ["list_folder", "download"]),
        ("ls /dbx", "cat /dbx/missing", 1, ["get_metadata"]),
        (
            "",
            "touch /dbx/a /dbx/b /dbx/c",
            0,
            ["list_folder", "upload"] * 3 + ["list_folder"],
        ),
        (
            "",
            "echo /dbx/* >> /dbx/new",
            0,
            ["list_folder", "upload", "list_folder", "download", "upload"],
        ),
    ],
    ids=[
        "cold",
        "glob-in-this-command",
        "earlier-line",
        "bulk-create",
        "glob-then-append",
    ],
)
async def test_a_miss_asks_dropbox_only_past_an_earlier_listing(
    setup, line, code, routes
):
    # A listing this command fetched, cold, for its own glob or re-listed
    # after its own write, is live evidence of absence; one an earlier line
    # left behind is not, and the miss asks once by path.
    with serve(FakeDropbox(files={"f": b"one\n"})) as dbx:
        ws = _workspace(dbx)
        try:
            if setup:
                await (await ws.shell(setup)).stdout_str()
            start = len(dbx.log)
            r = await ws.shell(line)
            await r.stderr_str()
        finally:
            await ws.close()
    assert r.exit_code == code
    assert [
        route for route, _ in dbx.log[start:] if route != "token"
    ] == routes


@pytest.mark.asyncio
async def test_a_miss_outside_a_command_always_asks_dropbox():
    # FUSE and programmatic calls belong to no command, so no listing is
    # theirs to trust, however recent.
    with serve(FakeDropbox(files={"f": b"one\n"})) as dbx:
        ws = _workspace(dbx)
        try:
            await (await ws.shell("ls /dbx")).stdout_str()
            start = len(dbx.log)
            with pytest.raises(FileNotFoundError):
                await ws.vfs.stat("/dbx/.DS_Store")
        finally:
            await ws.close()
    assert [r for r, _ in dbx.log[start:] if r != "token"] == ["get_metadata"]
