import tracemalloc
from contextlib import nullcontext
from unittest.mock import patch

import httpx
import pytest

from mirage.core.nextcloud.constants import UPLOAD_CHUNK_SIZE
from mirage.core.nextcloud.copy import copy, dir_copy
from mirage.core.nextcloud.create import create
from mirage.core.nextcloud.rename import rename
from mirage.core.nextcloud.rm import rm_r
from mirage.core.nextcloud.truncate import truncate
from mirage.core.nextcloud.unlink import unlink
from mirage.core.nextcloud.write import write
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import ROOT, answering, multistatus


@pytest.mark.asyncio
async def test_write_bytes_uploads(make_acc):
    acc = make_acc({})
    await write(acc, PathSpec.from_str_path("/hello.txt"), b"hi there")
    assert acc._fake.files == {"hello.txt": b"hi there"}


UPLOADS = "https://cloud.example.com/remote.php/dav/uploads/user"


class _Uploads:
    """Answers a chunked upload's requests, keeping each one's method,
    target, headers and body size, never the body.

    Args:
        fail (str | None): the method answered 500.
    """

    def __init__(self, fail: str | None = None) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str, dict[str, str] | None, int]] = []

    async def __call__(
        self, accessor, method, url, headers=None, content=None
    ):
        size = 0
        if content is not None:
            async for piece in content:
                size += len(piece)
        self.calls.append((method, url, headers, size))
        status = 500 if method == self.fail else 201
        return httpx.Response(status, request=httpx.Request(method, url))


@pytest.mark.asyncio
async def test_a_large_write_goes_up_in_chunks_in_bounded_memory(make_acc):
    acc = make_acc({})
    uploads = _Uploads()
    block = b"x" * (1024 * 1024)

    async def source():
        for _ in range(64):
            yield block

    with patch("mirage.core.nextcloud.write.dav_request", uploads):
        tracemalloc.start()
        try:
            await write(acc, PathSpec.from_str_path("/d/big.bin"), source())
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
    folder = uploads.calls[0][1]
    target = {"Destination": f"{ROOT}/d/big.bin"}
    total = {**target, "OC-Total-Length": str(len(block) * 64)}
    sizes = [UPLOAD_CHUNK_SIZE] * 6 + [4 * len(block)]
    assert folder.startswith(f"{UPLOADS}/mirage-")
    assert uploads.calls == [
        ("MKCOL", folder, target, 0),
        *(
            (
                "PUT",
                f"{folder}/{number:05d}",
                {**total, "Content-Length": str(size)},
                size,
            )
            for number, size in enumerate(sizes, 1)
        ),
        ("MOVE", f"{folder}/.file", total, 0),
    ]
    assert acc._fake.dirs == {"d/"}
    assert acc._fake.files == {}
    assert peak < 8 * 1024 * 1024


@pytest.mark.asyncio
async def test_a_failed_chunked_upload_deletes_its_folder(make_acc):
    uploads = _Uploads(fail="MOVE")
    with (
        patch("mirage.core.nextcloud.write.dav_request", uploads),
        pytest.raises(httpx.HTTPStatusError),
    ):
        await write(
            make_acc({}),
            PathSpec.from_str_path("/big.bin"),
            b"x" * (UPLOAD_CHUNK_SIZE + 1),
        )
    assert [call[0] for call in uploads.calls] == [
        "MKCOL",
        "PUT",
        "PUT",
        "MOVE",
        "DELETE",
    ]
    assert uploads.calls[-1][1] == uploads.calls[0][1]


@pytest.mark.asyncio
async def test_unlink_deletes_file(make_acc):
    acc = make_acc({"delete-me.txt": b"x"})
    await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    assert "delete-me.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_create_writes_empty_file(make_acc):
    acc = make_acc({})
    await create(acc, PathSpec.from_str_path("/touched.txt"))
    assert acc._fake.files.get("touched.txt") == b""


@pytest.mark.asyncio
async def test_copy_duplicates_file(make_acc):
    acc = make_acc({"src.txt": b"payload"})
    await copy(
        acc,
        PathSpec.from_str_path("/src.txt"),
        PathSpec.from_str_path("/dst.txt"),
    )
    assert acc._fake.files["dst.txt"] == b"payload"
    assert acc._fake.files["src.txt"] == b"payload"


@pytest.mark.parametrize(
    ("status", "body", "outcome"),
    [
        (201, b"", nullcontext()),
        (404, b"", pytest.raises(FileNotFoundError)),
        (207, multistatus("423 Locked"), pytest.raises(PermissionError)),
    ],
)
@pytest.mark.asyncio
async def test_dir_copy_is_one_copy_of_the_whole_tree(
    make_acc, status, body, outcome
):
    with answering("copy", status, body) as request, outcome:
        await dir_copy(
            make_acc(),
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/dst"),
        )
    assert request.await_args.args[1:] == ("COPY", f"{ROOT}/src/")
    assert request.await_args.kwargs["headers"] == {
        "Destination": f"{ROOT}/dst/",
        "Depth": "infinity",
        "Overwrite": "F",
    }


@pytest.mark.asyncio
async def test_rename_moves_file(make_acc):
    acc = make_acc({"old.txt": b"data"})
    await rename(
        acc,
        PathSpec.from_str_path("/old.txt"),
        PathSpec.from_str_path("/new.txt"),
    )
    assert acc._fake.files.get("new.txt") == b"data"
    assert "old.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_rm_r_removes_subtree(make_acc):
    acc = make_acc(
        {"dir/a.txt": b"a", "dir/sub/b.txt": b"b", "keep.txt": b"k"}
    )
    await rm_r(acc, PathSpec.from_str_path("/dir"))
    assert "dir/a.txt" not in acc._fake.files
    assert "dir/sub/b.txt" not in acc._fake.files
    assert "keep.txt" in acc._fake.files


@pytest.mark.asyncio
async def test_truncate_pads_and_shrinks(make_acc):
    acc = make_acc({"f.txt": b"abcdef"})
    await truncate(acc, PathSpec.from_str_path("/f.txt"), 3)
    assert acc._fake.files["f.txt"] == b"abc"
    await truncate(acc, PathSpec.from_str_path("/f.txt"), 5)
    assert acc._fake.files["f.txt"] == b"abc\x00\x00"
