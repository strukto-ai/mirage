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

from importlib import import_module
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.types import ABSENT_WRITE, ReplaceRequest
from mirage.core.dropbox import api
from mirage.core.dropbox import read as read_ops
from mirage.core.dropbox import write as write_ops
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.paths import check_path, dropbox_path_of
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dropbox.config import DropboxConfig


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


def test_account_root_maps_to_empty_path():
    assert dropbox_path_of(make_accessor(), PathSpec.from_str_path("/")) == ""


def test_subfolder_root_prefixes_api_path():
    assert (
        dropbox_path_of(
            make_accessor("/Team/data"), PathSpec.from_str_path("/a.txt")
        )
        == "/Team/data/a.txt"
    )


def test_mount_prefix_is_stripped():
    spec = PathSpec(
        virtual="/dropbox/docs/a.txt",
        directory="/dropbox/docs",
        vfs_path=mount_key("/dropbox/docs/a.txt", "/dropbox"),
    )
    assert dropbox_path_of(make_accessor(), spec) == "/docs/a.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        "stat",
        "readdir",
        "read",
        "read_stream",
        "write",
        "mkdir",
        "unlink",
        "rmdir",
        "rm_r",
        "tree",
        "copy_source",
        "copy_destination",
        "rename_source",
        "rename_destination",
    ],
)
async def test_case_aliased_ancestor_is_refused_before_io(
    dropbox_accessor, monkeypatch, operation
):
    touched = []

    async def rpc(tm, endpoint, body):
        if endpoint != "/files/get_metadata":
            touched.append(endpoint)
            raise AssertionError("aliased operand reached " + endpoint)
        key = body["path"].strip("/")
        name = key.rsplit("/", 1)[-1]
        return {
            ".tag": "folder" if key.lower() == "vault" else "file",
            "name": "vault" if key.lower() == "vault" else name,
            "size": 6,
        }

    async def stream(*args, **kwargs):
        touched.append("download")
        yield b"secret"

    monkeypatch.setattr(api, "dropbox_rpc", rpc)
    download = AsyncMock(return_value=(b"secret", None))
    upload = AsyncMock(return_value=None)
    monkeypatch.setattr(read_ops, "dropbox_download", download)
    monkeypatch.setattr(read_ops, "dropbox_download_stream", stream)
    monkeypatch.setattr(write_ops, "dropbox_upload", upload)
    path = PathSpec.from_str_path("/Vault/secret.txt")
    public = PathSpec.from_str_path("/public.txt")
    with pytest.raises(FileNotFoundError):
        if operation == "read_stream":
            async for _ in read_ops.read_stream(
                dropbox_accessor,
                path,
                entry=FileStat(name="secret.txt", type=FileType.FILE, size=6),
            ):
                pass
        elif operation == "read":
            await read_ops.read(
                dropbox_accessor,
                path,
                entry=FileStat(name="secret.txt", type=FileType.FILE, size=6),
            )
        elif operation == "write":
            await write_ops.write(dropbox_accessor, path, b"changed")
        elif operation in (
            "copy_source",
            "copy_destination",
            "rename_source",
            "rename_destination",
        ):
            name, side = operation.split("_")
            fn = getattr(import_module("mirage.core.dropbox." + name), name)
            await fn(
                dropbox_accessor,
                path if side == "source" else public,
                path if side == "destination" else public,
            )
        else:
            module = (
                "stat"
                if operation == "tree"
                else "rm"
                if operation == "rm_r"
                else operation
            )
            await getattr(
                import_module("mirage.core.dropbox." + module), operation
            )(dropbox_accessor, path)
    assert touched == []
    download.assert_not_awaited()
    upload.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["SECRET.txt", "Vault/secret.txt", "Vault/new.txt"]
)
async def test_alias_never_uploads(dropbox_accessor, monkeypatch, key):
    async def metadata(tm, endpoint, body):
        assert endpoint == "/files/get_metadata"
        asked = body["path"].strip("/")
        if asked.lower() == "vault":
            return {".tag": "folder", "name": "vault"}
        return {".tag": "file", "name": "secret.txt", "size": 6}

    monkeypatch.setattr(api, "dropbox_rpc", metadata)
    with patch(
        "mirage.core.dropbox.write.dropbox_upload", new_callable=AsyncMock
    ) as upload:
        with pytest.raises(FileNotFoundError):
            await write_ops.write(
                dropbox_accessor, PathSpec.from_str_path("/" + key), b"changed"
            )
        upload.assert_not_awaited()


@pytest.mark.asyncio
async def test_alias_is_not_reinterpreted_as_an_unsupported_create(
    dropbox_accessor, monkeypatch
):
    async def metadata(tm, path):
        return {".tag": "file", "name": "secret.txt"}

    monkeypatch.setattr("mirage.core.dropbox.paths.lookup", metadata)
    with pytest.raises(FileNotFoundError):
        await write_ops.replace(
            dropbox_accessor,
            ReplaceRequest(
                PathSpec.from_str_path("/SECRET.txt"), b"changed", ABSENT_WRITE
            ),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["exact", "missing", "refused", "root"])
async def test_check_path_distinguishes_absence_errors_and_configured_root(
    dropbox_accessor, monkeypatch, case
):
    asked = []
    refusal = DropboxApiError("refused", 403, "access_denied")
    dropbox_accessor.root_path = "/Configured/Root"

    async def metadata(tm, path):
        asked.append(path)
        if case == "refused":
            raise refusal
        if case == "missing" and path.endswith("/new"):
            return None
        return {".tag": "folder", "name": path.rsplit("/", 1)[-1]}

    monkeypatch.setattr("mirage.core.dropbox.paths.lookup", metadata)
    spec = PathSpec.from_str_path(
        "/"
        if case == "root"
        else "/vault/" + ("new/child" if case == "missing" else "secret.txt")
    )
    if case == "refused":
        with pytest.raises(DropboxApiError) as caught:
            await check_path(dropbox_accessor, spec)
        assert caught.value is refusal
    else:
        result = await check_path(dropbox_accessor, spec)
        assert (result is None) == (case in ("missing", "root"))
    assert len(asked) == (
        0 if case == "root" else 1 if case == "refused" else 2
    )
    assert all(path.startswith("/Configured/Root/vault") for path in asked)
