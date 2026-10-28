import asyncio
import threading
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass, field

import pytest
import pytest_asyncio
from aiohttp import ClientConnectionError, web
from aiohttp.test_utils import TestServer
from pydantic import SecretStr, ValidationError

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.client import (
    create_directory,
    delete_directory,
    delete_file,
    download,
    download_stream,
    get_directory_metadata,
    get_metadata,
    list_directory_contents,
    upload,
)
from mirage.core.databricks_volume.errors import (
    DatabricksVolumeApiError,
    is_not_found,
)
from mirage.core.databricks_volume.read import read
from mirage.io.types import materialize
from mirage.types import MountMode, PathSpec
from mirage.utils.ranges import ByteWindow
from mirage.vfs.databricks_volume import (
    DatabricksVolumeConfig,
    DatabricksVolumeVFS,
)
from mirage.vfs.secrets import revealed_config_dump
from mirage.workspace import Workspace
from mirage.workspace.snapshot.state import build_mount_args, to_state_dict

REMOTE = "/Volumes/main/default/files/percent%question? space/한글.txt"


@dataclass
class HttpFiles:
    host: str = ""
    requests: list[tuple[str, str, str | None, bytes]] = field(
        default_factory=list
    )
    handler: Callable[[web.Request], Awaitable[web.StreamResponse]] | None = (
        None
    )

    async def respond(self, request: web.Request) -> web.StreamResponse:
        self.requests.append(
            (
                request.method,
                request.raw_path,
                request.headers.get("Authorization"),
                await request.read(),
            )
        )
        if self.handler is not None:
            return await self.handler(request)
        return web.Response(
            body=b"abcdefgh",
            headers={"Last-Modified": "Tue, 14 Nov 2023 22:13:20 GMT"},
        )

    def accessor(self, token="static", **kwargs) -> DatabricksVolumeAccessor:
        return DatabricksVolumeAccessor(
            DatabricksVolumeConfig(
                catalog="main",
                schema="default",
                volume="files",
                host=self.host,
                token=token,
                **kwargs,
            )
        )


@pytest_asyncio.fixture
async def http_files():
    state = HttpFiles()
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", state.respond)
    async with TestServer(app) as server:
        state.host = str(server.make_url("")).rstrip("/")
        yield state


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["PUT", "DELETE"])
async def test_disconnect_after_mutation_is_not_replayed_after_session_recreation(
    http_files, method
):
    calls = 0

    def provider():
        nonlocal calls
        calls += 1
        return f"generation-{calls}"

    async def disconnect(request):
        assert request.method == method
        assert request.transport is not None
        request.transport.close()
        return web.Response(status=204)

    http_files.handler = disconnect
    async with http_files.accessor(provider) as accessor:
        for generation in (1, 2):
            operation = (
                upload(accessor, REMOTE, b"committed", overwrite=True)
                if method == "PUT"
                else delete_file(accessor, REMOTE)
            )
            result = await asyncio.gather(operation, return_exceptions=True)
            assert len(http_files.requests) == generation
            assert isinstance(result[0], ClientConnectionError)
            assert calls == generation
            assert http_files.requests[-1][0] == method
            assert (
                http_files.requests[-1][2] == f"Bearer generation-{generation}"
            )
            assert http_files.requests[-1][3] == (
                b"committed" if method == "PUT" else b""
            )
            await accessor.close()


@pytest.mark.asyncio
async def test_rotates_credentials_for_same_principal_and_escapes_path(
    http_files,
):
    token = "generation-one"

    def provider():
        return SecretStr(token)

    async with http_files.accessor(provider) as accessor:
        assert http_files.requests == []
        assert await download(accessor, REMOTE) == b"abcdefgh"
        token = "generation-two"
        assert await download(accessor, REMOTE) == b"abcdefgh"
    assert [request[2] for request in http_files.requests] == [
        "Bearer generation-one",
        "Bearer generation-two",
    ]
    assert [request[1] for request in http_files.requests] == [
        "/api/2.0/fs/files/Volumes/main/default/files/percent%25question%3F%20space/%ED%95%9C%EA%B8%80.txt"
    ] * 2


@pytest.mark.asyncio
async def test_async_callable_object_and_awaitable_from_sync_provider(
    http_files,
):
    class Provider:
        async def __call__(self):
            await asyncio.sleep(0)
            return "async-object"

    async def token():
        return "sync-awaitable"

    for provider in (Provider(), lambda: token()):
        async with http_files.accessor(provider) as accessor:
            await download(accessor, REMOTE)
    assert [request[2] for request in http_files.requests] == [
        "Bearer async-object",
        "Bearer sync-awaitable",
    ]


@pytest.mark.asyncio
async def test_sync_provider_runs_off_loop_and_does_not_block_heartbeat(
    http_files,
):
    release = threading.Event()
    entered = threading.Event()
    thread_ids = []

    def provider():
        thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(2)
        return "blocking-provider"

    async with http_files.accessor(provider) as accessor:
        task = asyncio.create_task(download(accessor, REMOTE))
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.001)
            assert entered.is_set()
            assert not task.done()
        finally:
            release.set()
        assert await task == b"abcdefgh"
    assert len(thread_ids) == 1
    assert thread_ids[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_concurrent_requests_keep_independent_headers(http_files):
    count = 0
    both = asyncio.Event()

    async def provider():
        nonlocal count
        count += 1
        generation = count
        if count == 2:
            both.set()
        await both.wait()
        return f"generation-{generation}"

    async with http_files.accessor(provider) as accessor:
        result = await asyncio.gather(
            download(accessor, REMOTE), download(accessor, REMOTE)
        )
    assert result == [b"abcdefgh", b"abcdefgh"]
    assert {request[2] for request in http_files.requests} == {
        "Bearer generation-1",
        "Bearer generation-2",
    }
    assert count == 2


@pytest.mark.asyncio
async def test_zero_read_snapshot_and_deferred_stream_do_not_resolve_token(
    http_files,
):
    calls = 0
    token = "old"

    def provider():
        nonlocal calls
        calls += 1
        return token

    async with http_files.accessor(provider) as accessor:
        mount = DatabricksVolumeVFS(accessor.config)
        stream = download_stream(accessor, REMOTE)
        assert (
            await read(accessor, PathSpec.from_str_path("/empty"), size=0)
            == b""
        )
        state = mount.get_state()
        assert state["needs_override"] is True
        assert state["config"]["token"] == "<REDACTED>"
        assert revealed_config_dump(accessor.config)["token"] == "<REDACTED>"
        assert calls == 0
        assert http_files.requests == []
        token = "fresh"
        async with aclosing(stream):
            assert b"".join([chunk async for chunk in stream]) == b"abcdefgh"
        assert calls == 1
        assert http_files.requests[0][2] == "Bearer fresh"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value", [None, 123, "", " ", "bad\rheader", "bad\nheader"]
)
async def test_invalid_provider_value_is_rejected_without_request(
    http_files, value
):
    async with http_files.accessor(lambda: value) as accessor:
        with pytest.raises(ValueError, match="nonblank string") as error:
            await download(accessor, REMOTE)
    assert "bad" not in str(error.value)
    assert http_files.requests == []


@pytest.mark.asyncio
async def test_provider_exception_preserves_cause_and_is_not_missing(
    http_files,
):
    failure = RuntimeError("credential not found")

    async def provider():
        raise failure

    async with http_files.accessor(provider) as accessor:
        with pytest.raises(RuntimeError) as error:
            await download(accessor, REMOTE)
    assert error.value.__cause__ is failure
    assert str(error.value) == "databricks_volume: credential provider failed"
    assert not is_not_found(error.value)
    assert http_files.requests == []


@pytest.mark.asyncio
async def test_provider_cancellation_propagates_unchanged(http_files):
    failure = asyncio.CancelledError()

    async def provider():
        raise failure

    async with http_files.accessor(provider) as accessor:
        with pytest.raises(asyncio.CancelledError) as error:
            await download(accessor, REMOTE)
    assert error.value is failure
    assert http_files.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["exists", "append", "append_empty"])
@pytest.mark.parametrize("async_provider", [False, True])
async def test_missing_credential_does_not_hide_or_replace_existing_file(
    http_files, operation, async_provider
):
    failure = FileNotFoundError("credential file is absent")
    calls = 0
    contents = b"original contents"

    def token():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise failure
        return "recovered"

    async def async_token():
        return token()

    async def handler(request):
        nonlocal contents
        if request.method == "PUT":
            contents = await request.read()
        return web.Response(body=contents)

    http_files.handler = handler
    accessor = http_files.accessor(async_token if async_provider else token)
    mount = DatabricksVolumeVFS(accessor.config)
    workspace = Workspace({"/dbx": mount}, mode=MountMode.WRITE)
    path = PathSpec.from_str_path("/existing.txt")
    try:
        with pytest.raises(RuntimeError) as error:
            if operation == "exists":
                await mount.exists(path)
            else:
                await workspace.dispatch(
                    "append",
                    PathSpec.from_str_path("/dbx/existing.txt"),
                    data=b"" if operation == "append_empty" else b" appended",
                )
        assert error.value.__cause__ is failure
        assert http_files.requests == []
        assert contents == b"original contents"
        assert (
            await materialize(await mount.read(path)) == b"original contents"
        )
    finally:
        await workspace.close()


@pytest.mark.asyncio
async def test_paginates_through_empty_page_and_encodes_query(http_files):
    calls = 0

    async def provider():
        nonlocal calls
        calls += 1
        return f"page-{calls}"

    async def handler(request):
        if "page_token" not in request.query:
            return web.json_response(
                {"contents": [], "next_page_token": "next+/? &=한"}
            )
        assert request.query["page_token"] == "next+/? &=한"
        return web.json_response(
            {
                "contents": [
                    {
                        "path": REMOTE,
                        "file_size": 8,
                        "last_modified": 1700000000000,
                    }
                ]
            }
        )

    http_files.handler = handler
    async with http_files.accessor(provider) as accessor:
        entries = await list_directory_contents(accessor, REMOTE)
    assert len(entries) == 1
    assert entries[0].is_directory is False
    assert (
        entries[0].path,
        entries[0].file_size,
        entries[0].last_modified,
    ) == (REMOTE, 8, 1700000000000)
    assert [request[2] for request in http_files.requests] == [
        "Bearer page-1",
        "Bearer page-2",
    ]


@pytest.mark.asyncio
async def test_listing_pages_no_further_than_a_limit(http_files):
    async def handler(request):
        return web.json_response(
            {
                "contents": [{"path": f"{REMOTE}/a", "file_size": 1}],
                "next_page_token": "more",
            }
        )

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        entries = await list_directory_contents(accessor, REMOTE, 1)
    assert [entry.path for entry in entries] == [f"{REMOTE}/a"]
    assert len(http_files.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 206])
async def test_range_respects_response_status_even_when_body_is_short(
    http_files, status
):
    async def handler(request):
        assert request.headers["Range"] == "bytes=3-10"
        return web.Response(
            status=status, body=b"abcdefgh" if status == 200 else b"defgh"
        )

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        assert (
            await download(accessor, REMOTE, window=ByteWindow(3, 8))
            == b"defgh"
        )


@pytest.mark.asyncio
async def test_metadata_and_mutations_use_files_contract(http_files):
    async def handler(request):
        if request.method == "HEAD":
            return web.Response(
                headers={
                    "Content-Length": "8",
                    "Last-Modified": "Tue, 14 Nov 2023 22:13:20 GMT",
                }
            )
        return web.Response(status=204)

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        metadata = await get_metadata(accessor, REMOTE)
        assert (metadata.content_length, metadata.last_modified) == (
            8,
            "Tue, 14 Nov 2023 22:13:20 GMT",
        )
        assert await get_directory_metadata(accessor, REMOTE) is None
        await upload(accessor, REMOTE, b"\x00payload", overwrite=True)
        await create_directory(accessor, REMOTE)
        await delete_file(accessor, REMOTE)
        await delete_directory(accessor, REMOTE)
    assert [request[0] for request in http_files.requests] == [
        "HEAD",
        "HEAD",
        "PUT",
        "PUT",
        "DELETE",
        "DELETE",
    ]
    assert http_files.requests[2][1].endswith("?overwrite=true")
    assert http_files.requests[2][3] == b"\x00payload"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 429, 500])
async def test_errors_are_structured_auth_precedence_and_writes_are_not_replayed(
    http_files, status
):
    async def handler(request):
        return web.json_response(
            {"error_code": "RESOURCE_DOES_NOT_EXIST", "message": "refused"},
            status=status,
        )

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        with pytest.raises(DatabricksVolumeApiError) as error:
            await upload(accessor, REMOTE, b"payload", overwrite=True)
    assert error.value.status == status
    assert error.value.error_code == "RESOURCE_DOES_NOT_EXIST"
    assert str(error.value) == "refused"
    assert not is_not_found(error.value)
    assert len(http_files.requests) == 1


@pytest.mark.asyncio
async def test_non_json_error_body_and_invalid_listing_are_preserved(
    http_files,
):
    async def handler(request):
        return web.Response(status=503, text="gateway unavailable")

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        with pytest.raises(
            DatabricksVolumeApiError, match="gateway unavailable"
        ):
            await download(accessor, REMOTE)

    async def invalid_listing(request):
        return web.json_response(
            {"contents": [{"path": REMOTE, "is_directory": "false"}]}
        )

    http_files.handler = invalid_listing
    async with http_files.accessor() as accessor:
        with pytest.raises(ValidationError):
            await list_directory_contents(accessor, REMOTE)


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_timeout_remains_active_while_body_is_consumed(
    http_files, streaming
):
    release = asyncio.Event()

    async def handler(request):
        response = web.StreamResponse()
        await response.prepare(request)
        await response.write(b"first")
        await release.wait()
        return response

    http_files.handler = handler
    async with http_files.accessor(timeout=1) as accessor:
        try:
            with pytest.raises(asyncio.TimeoutError):
                if streaming:
                    async with aclosing(
                        download_stream(accessor, REMOTE)
                    ) as stream:
                        async for _ in stream:
                            pass
                else:
                    await download(accessor, REMOTE)
        finally:
            release.set()


@pytest.mark.asyncio
async def test_early_stream_close_releases_connection(http_files):
    disconnected = asyncio.Event()
    release = asyncio.Event()

    async def handler(request):
        response = web.StreamResponse()
        await response.prepare(request)
        await response.write(b"first")
        try:
            for _ in range(200):
                if request.transport is None or request.transport.is_closing():
                    disconnected.set()
                    return response
                await asyncio.sleep(0.005)
            await release.wait()
        except asyncio.CancelledError:
            disconnected.set()
            raise
        finally:
            release.set()
        return response

    http_files.handler = handler
    async with http_files.accessor() as accessor:
        stream = download_stream(accessor, REMOTE)
        assert await anext(stream) == b"first"
        await stream.aclose()
        try:
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            release.set()


@pytest.mark.asyncio
async def test_snapshot_requires_fresh_vfs_override_and_preserves_live_provider(
    http_files,
):
    calls = 0

    def old_provider():
        nonlocal calls
        calls += 1
        return "old"

    original = DatabricksVolumeVFS(http_files.accessor(old_provider).config)
    workspace = Workspace({"/dbx": original})
    try:
        state = await to_state_dict(workspace)
    finally:
        await workspace.close()
    assert calls == 0
    assert http_files.requests == []
    with pytest.raises(ValueError, match="/dbx"):
        build_mount_args(state)
    restored = DatabricksVolumeVFS(http_files.accessor(lambda: "fresh").config)
    args = build_mount_args(state, mounts={"/dbx": restored})
    assert args.mount_args["/dbx/"].vfs is restored
    async with restored.accessor:
        assert await download(restored.accessor, REMOTE) == b"abcdefgh"
    assert http_files.requests[-1][2] == "Bearer fresh"
