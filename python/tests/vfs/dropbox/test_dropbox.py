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
from unittest.mock import AsyncMock, patch

import pytest

from mirage import Mount, MountMode, PathSpec, Workspace
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS
from mirage.vfs.registry import build_vfs
from tests.fixtures import dropbox_api
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
        ("touch /dbx/n", b"v1\n"),
        ("{ echo x; } >> /dbx/n", b"v1\nx\n"),
    ],
    ids=["touch", "group-append"],
)
async def test_a_file_created_after_the_listing_is_found(line, after):
    # >>, sed -i and truncate on a simple command are integ's
    # write_conditional_own_read_ops_need_no_prior_read.
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
        ("", "cat /dbx/missing", 1, ["get_metadata", "list_folder"]),
        (
            "",
            "cat /dbx/f* /dbx/missing",
            1,
            ["list_folder", "get_metadata", "download"],
        ),
        ("ls /dbx", "cat /dbx/missing", 1, ["get_metadata"]),
        (
            "",
            "touch /dbx/a /dbx/b /dbx/c",
            0,
            ["get_metadata", "get_metadata", "upload"] * 3,
        ),
    ],
    ids=[
        "cold",
        "glob-in-this-command",
        "earlier-line",
        "bulk-create",
    ],
)
async def test_a_miss_asks_dropbox_only_past_an_earlier_listing(
    setup, line, code, routes
):
    # With no listing stored a miss asks by path, and cat's directory probe
    # lists the parent. A listing this command fetched for its own glob is
    # live evidence of absence; one an earlier line left behind is not, and
    # the miss asks once by path.
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
async def test_glob_append_preserves_existing_target_and_sibling():
    with serve(FakeDropbox(files={"f": b"one\n", "out": b""})) as dbx:
        ws = _workspace(dbx)
        try:
            r = await ws.shell("echo /dbx/* >> /dbx/out")
            err = await r.stderr_str()
        finally:
            await ws.close()
    assert (r.exit_code, err) == (0, "")
    assert dbx.read("out") == b"/dbx/f /dbx/out\n"
    assert dbx.read("f") == b"one\n"
    assert [route for route, _ in dbx.log if route != "token"] == [
        "list_folder",
        "list_folder",
        "get_metadata",
        "download",
        "get_metadata",
        "upload",
    ]


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


@pytest.mark.asyncio
async def test_truncate_with_no_row_refuses_a_case_alias():
    vfs = make_vfs()
    upload = AsyncMock()
    download = AsyncMock()
    with (
        patch(
            "mirage.core.dropbox.paths.lookup",
            new=AsyncMock(return_value={".tag": "file", "name": "N"}),
        ),
        patch("mirage.core.dropbox.read.dropbox_download", download),
        patch("mirage.core.dropbox.write.dropbox_upload", upload),
    ):
        with pytest.raises(FileNotFoundError):
            await vfs.truncate(
                PathSpec(virtual="/n", directory="/", vfs_path="n"), 4
            )
    upload.assert_not_awaited()
    download.assert_not_awaited()


@pytest.mark.asyncio
async def test_hidden_case_aliases_are_refused_over_a_folding_service(
    monkeypatch,
):
    original = dropbox_api._norm

    def folded(path):
        return original(path).lower()

    monkeypatch.setattr(dropbox_api, "_norm", folded)
    with serve(
        FakeDropbox(
            files={
                "secret.txt": b"secret",
                "vault/private.txt": b"private",
                "f": b"public",
            }
        )
    ) as dbx:
        ws = _workspace(dbx)
        try:
            assert (
                await ws.shell("cat /dbx/secret.txt /dbx/vault/private.txt")
            ).exit_code == 0
            ws.create_session(
                "hidden",
                profile={"paths": {"hide": ["/dbx/secret.txt", "/dbx/vault"]}},
            )
            dbx.log.clear()
            for command in [
                "cat /dbx/SECRET.txt",
                "cat /dbx/Vault/private.txt",
                "ls /dbx/Vault",
                "echo changed > /dbx/SECRET.txt",
                "echo changed > /dbx/Vault/new.txt",
                "cp /dbx/f /dbx/SECRET.txt",
                "mv /dbx/f /dbx/SECRET.txt",
            ]:
                result = await ws.shell(command, session_id="hidden")
                assert result.exit_code != 0, command
                assert b"secret" not in await result.materialize_stdout(), (
                    command
                )
            assert dbx.read("secret.txt") == b"secret"
            assert dbx.read("vault/private.txt") == b"private"
            assert dbx.read("f") == b"public"
            assert not any(
                route in ("upload", "delete", "move", "copy")
                for route, _ in dbx.log
            )
            assert not any(
                route == "download"
                and path in ("/secret.txt", "/vault/private.txt")
                for route, path in dbx.log
            )
        finally:
            await ws.close()
