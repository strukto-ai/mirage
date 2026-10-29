from importlib import import_module
from unittest.mock import AsyncMock

import pytest

import mirage.core.msgraph.drive as drive_ops
import mirage.core.msgraph.paths as path_ops
from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.msgraph.client import GraphError
from mirage.core.msgraph.drive import (
    DriveLoc,
    write_item,
)
from mirage.core.msgraph.paths import check_item
from mirage.io.types import materialize
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.onedrive.onedrive import OneDriveVFS
from mirage.vfs.sharepoint.sharepoint import SharePointVFS


def _url(path: str, action: str = "") -> str:
    return f"https://graph.example/drives/d1/root:/{path}:{action}"


def _ref(folder: str) -> str:
    return f"/drives/d1/root:/{folder}"


def _loc(drive: str, path: str) -> DriveLoc:
    return DriveLoc(
        drive=drive, path=path, virt=f"/{path}", url=_url, ref=_ref
    )


def _accessor():
    return OneDriveAccessor(OneDriveConfig(access_token="test"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["SECRET.txt", "Vault/secret.txt", "Vault/new.txt"]
)
async def test_alias_never_uploads(monkeypatch, key):
    async def metadata(accessor, url, **kwargs):
        if url == _url("Vault"):
            return {"name": "vault", "folder": {}}
        return {"name": "secret.txt", "file": {}, "size": 6}

    upload = AsyncMock()
    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_put_bytes", upload)
    with pytest.raises(FileNotFoundError):
        await write_item(_accessor(), _loc("d1", key), b"changed")
    upload.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        "read_item",
        "stream_item",
        "stat_item",
        "readdir_items",
        "copy_source",
        "copy_destination",
        "rename_source",
        "rename_destination",
    ],
)
async def test_case_aliased_ancestor_is_refused_before_io(
    monkeypatch, operation
):
    async def metadata(accessor, url, **kwargs):
        return (
            {"name": "vault", "folder": {}}
            if url == _url("Vault")
            else {
                "name": "public.txt"
                if url == _url("public.txt")
                else "secret.txt",
                "file": {},
                "size": 6,
            }
        )

    touched = []

    async def forbidden(*args, **kwargs):
        touched.append("io")
        return b"secret"

    async def stream(*args, **kwargs):
        touched.append("stream")
        yield b"secret"

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_get", metadata)
    for name in [
        "graph_get_bytes",
        "graph_put_bytes",
        "graph_list",
        "graph_post_monitor",
        "graph_patch",
        "graph_delete",
    ]:
        monkeypatch.setattr(drive_ops, name, forbidden)
    monkeypatch.setattr(drive_ops, "graph_stream", stream)
    loc = _loc("d1", "Vault/secret.txt")
    public = _loc("d1", "public.txt")
    with pytest.raises(FileNotFoundError):
        if operation == "stream_item":
            async for _ in drive_ops.stream_item(
                _accessor(), loc, "/drive/Vault/secret.txt", "onedrive"
            ):
                pass
        elif operation in (
            "copy_source",
            "copy_destination",
            "rename_source",
            "rename_destination",
        ):
            name, side = operation.split("_")
            fn = (
                drive_ops.copy_tree
                if name == "copy"
                else drive_ops.rename_replace
            )
            await fn(
                _accessor(),
                loc if side == "source" else public,
                loc if side == "destination" else public,
            )
        else:
            args = (_accessor(), loc, "/drive/Vault/secret.txt")
            if operation == "read_item":
                args += ("onedrive",)
            await getattr(drive_ops, operation)(*args)
    assert touched == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["onedrive", "sharepoint"])
@pytest.mark.parametrize("operation", ["mkdir", "unlink", "rm_r"])
async def test_provider_mutation_rejects_aliased_parent(
    monkeypatch, provider, operation
):
    async def metadata(accessor, url, **kwargs):
        return {"name": "vault", "folder": {}}

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    accessor = (
        _accessor()
        if provider == "onedrive"
        else SharePointAccessor(
            SharePointConfig(access_token="test", site="s", drive="d")
        )
    )
    if provider == "sharepoint":
        accessor.site_cache["s"] = "s1"
        accessor.drive_cache[("s1", "d")] = "d1"
    module = import_module(
        "mirage.core."
        + provider
        + "."
        + ("rm" if operation == "rm_r" else operation)
    )
    mutation = AsyncMock()
    monkeypatch.setattr(
        module,
        "_create_dir" if operation == "mkdir" else "graph_delete",
        mutation,
    )
    with pytest.raises(FileNotFoundError):
        await getattr(module, operation)(
            accessor,
            PathSpec.from_str_path(
                "/drive/Vault/secret.txt", "Vault/secret.txt"
            ),
        )
    mutation.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["exact", "missing", "refused", "root"])
async def test_check_item_distinguishes_absence_errors_and_configured_root(
    monkeypatch, case
):
    asked = []
    refusal = GraphError(403, "accessDenied", "refused")

    async def metadata(accessor, url, **kwargs):
        asked.append(url)
        if case == "refused":
            raise refusal
        if case == "missing" and url == _url("Configured/Root/vault/new"):
            raise GraphError(404, "itemNotFound", "missing")
        return {"name": url.rstrip(":").rsplit("/", 1)[-1], "folder": {}}

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    key = (
        ""
        if case == "root"
        else "vault/" + ("new/child" if case == "missing" else "secret.txt")
    )
    loc = DriveLoc(
        drive="d1",
        path="Configured/Root" + ("/" + key if key else ""),
        virt=key,
        url=_url,
        ref=_ref,
    )
    if case == "refused":
        with pytest.raises(GraphError) as caught:
            await check_item(_accessor(), loc)
        assert caught.value is refusal
    else:
        result = await check_item(_accessor(), loc)
        assert (result is None) == (case in ("missing", "root"))
    assert len(asked) == (
        0 if case == "root" else 1 if case == "refused" else 2
    )


@pytest.mark.asyncio
async def test_tree_validates_scope_once_then_walks_canonical_children(
    monkeypatch,
):
    asked = []
    listed = []

    async def metadata(accessor, url, **kwargs):
        asked.append(url)
        return {"name": url.rstrip(":").rsplit("/", 1)[-1], "folder": {}}

    async def children(accessor, url):
        listed.append(url)
        depth = url.count("/nested")
        return [{"name": "nested", "folder": {}}] if depth < 10 else []

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_list", children)
    entries = [
        entry
        async for entry in drive_ops.iter_tree(
            _accessor(), _loc("d1", "scope")
        )
    ]
    assert len(entries) == 10
    assert len(listed) == 11
    assert asked == [_url("scope")]


@pytest.mark.asyncio
async def test_delta_reuses_validated_leaf_metadata(monkeypatch):
    asked = []

    async def metadata(accessor, url, params=None):
        asked.append(url)
        return {"id": "S", "name": "scope", "folder": {}}

    async def children(accessor, url):
        return [{"id": "S", "name": "scope", "folder": {}}]

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_list", children)
    assert await drive_ops.delta_tree(_accessor(), _loc("d1", "scope")) == {}
    assert asked == [_url("scope")]


@pytest.mark.asyncio
@pytest.mark.parametrize("recorded", [False, True])
@pytest.mark.parametrize("stream", [False, True])
async def test_alias_read_errors_keep_the_full_virtual_path(
    monkeypatch, recorded, stream
):
    metadata = AsyncMock(return_value={"name": "secret.txt", "file": {}})
    content = AsyncMock()
    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_get_bytes", content)
    vfs = OneDriveVFS(OneDriveConfig(access_token="test"))
    spec = PathSpec.from_str_path("/od/SECRET.txt", "SECRET.txt")
    scope = RecordingScope() if recorded else None
    try:
        with pytest.raises(FileNotFoundError) as caught:
            source = await vfs.read(spec, size=None if stream else 1)
            await materialize(source)
        assert caught.value.filename == spec.virtual
        metadata.assert_awaited_once()
        content.assert_not_awaited()
    finally:
        if scope is not None:
            scope.close()


async def _public_alias_metadata(accessor, url, **kwargs):
    name = url.rsplit("/", 1)[-1].rstrip(":")
    return {
        "name": "secret.txt" if name == "SECRET.txt" else name,
        "file": {},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["onedrive", "sharepoint"])
@pytest.mark.parametrize(
    "operation",
    [
        "write",
        "create",
        "copy_source",
        "copy_destination",
        "rename_source",
        "rename_destination",
        "rmdir",
        "tree",
    ],
)
async def test_public_alias_refusals_keep_mutation_and_tree_operands(
    monkeypatch, provider, operation
):
    monkeypatch.setattr(path_ops, "graph_get", _public_alias_metadata)
    mutations = [AsyncMock() for _ in range(4)]
    for name, mutation in zip(
        [
            "graph_put_bytes",
            "graph_post_monitor",
            "graph_patch",
            "graph_delete",
        ],
        mutations,
        strict=True,
    ):
        monkeypatch.setattr(drive_ops, name, mutation)
    if provider == "onedrive":
        vfs = OneDriveVFS(OneDriveConfig(access_token="test"))
        vfs.accessor.drive_type = "personal"
    else:
        vfs = SharePointVFS(
            SharePointConfig(
                access_token="test", site="Team", drive="Documents"
            )
        )
        vfs.accessor.site_cache["Team"] = "site-id"
        vfs.accessor.drive_cache[("site-id", "Documents")] = "drive-id"
    alias = PathSpec.from_str_path("/mount/SECRET.txt", "SECRET.txt")
    public = PathSpec.from_str_path("/mount/public.txt", "public.txt")
    try:
        with pytest.raises(FileNotFoundError) as caught:
            if operation == "write":
                await vfs.write(alias, b"changed")
            elif operation == "create":
                await vfs.create(alias)
            elif operation.startswith("copy"):
                await vfs.copy(
                    alias if operation.endswith("source") else public,
                    public if operation.endswith("source") else alias,
                )
            elif operation.startswith("rename"):
                await vfs.rename(
                    alias if operation.endswith("source") else public,
                    public if operation.endswith("source") else alias,
                )
            elif operation == "rmdir":
                await vfs.rmdir(alias)
            else:
                await vfs.read_tree(alias)
        assert caught.value.filename == alias.virtual
        for mutation in mutations:
            mutation.assert_not_awaited()
    finally:
        await vfs.accessor.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("side", ["source", "destination"])
async def test_recursive_public_copy_keeps_the_full_child_operand(
    monkeypatch,
    side,
):
    async def metadata(accessor, url, **kwargs):
        key = url.split("/root:/", 1)[1].rstrip(":")
        name = key.rsplit("/", 1)[-1]
        if key == f"{side}/child.txt":
            name = "CHILD.txt"
        return {"name": name, "folder" if "/" not in key else "file": {}}

    monkeypatch.setattr(path_ops, "graph_get", metadata)
    monkeypatch.setattr(drive_ops, "graph_get", metadata)
    monkeypatch.setattr(
        drive_ops,
        "graph_list",
        AsyncMock(return_value=[{"name": "child.txt", "file": {}}]),
    )
    copy = AsyncMock(
        side_effect=GraphError(409, "nameAlreadyExists", "occupied")
    )
    delete = AsyncMock()
    monkeypatch.setattr(drive_ops, "graph_post_monitor", copy)
    monkeypatch.setattr(drive_ops, "graph_delete", delete)
    vfs = OneDriveVFS(OneDriveConfig(access_token="test"))
    try:
        with pytest.raises(FileNotFoundError) as caught:
            await vfs.copy(
                PathSpec.from_str_path("/mount/source", "source"),
                PathSpec.from_str_path("/mount/destination", "destination"),
            )
        assert caught.value.filename == f"/mount/{side}/child.txt"
        copy.assert_awaited_once()
        assert copy.await_args.args[1].endswith("/root:/source:/copy")
        delete.assert_not_awaited()
    finally:
        await vfs.accessor.close()
