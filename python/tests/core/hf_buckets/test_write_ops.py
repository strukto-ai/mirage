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

import hashlib
import tracemalloc

import pytest

from mirage.core.hf_buckets.create import create
from mirage.core.hf_buckets.unlink import unlink
from mirage.core.hf_buckets.write import write
from mirage.types import PathSpec

COMMIT = "/api/buckets/:ns/:name/batch"


@pytest.mark.asyncio
async def test_write_bytes_uploads(make_acc, bucket):
    acc = await make_acc({})
    await write(acc, PathSpec.from_str_path("/hello.txt"), b"hi there")
    assert await bucket.files() == {"hello.txt": b"hi there"}


@pytest.mark.asyncio
async def test_unlink_deletes_file(make_acc, bucket):
    acc = await make_acc({"delete-me.txt": b"x"})
    await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    assert "delete-me.txt" not in await bucket.files()


@pytest.mark.asyncio
async def test_unlink_refuses_a_directory_and_leaves_its_subtree(
    make_acc, bucket
):
    # unlink(2) refuses a directory with EISDIR, and the op answers it
    # itself: a guest, FUSE and ws.vfs reach it without the rm builder's
    # stat. A directory owns no key of its own, so nothing is touched.
    acc = await make_acc({"some-dir/child.txt": b"x"})
    with pytest.raises(IsADirectoryError):
        await unlink(acc, PathSpec.from_str_path("/some-dir"))
    assert await bucket.files() == {"some-dir/child.txt": b"x"}


@pytest.mark.asyncio
async def test_unlink_refuses_a_missing_key(make_acc):
    # unlink(2) answers ENOENT, which the store's own delete never says.
    acc = await make_acc({})
    with pytest.raises(FileNotFoundError):
        await unlink(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_create_writes_empty_file(make_acc, bucket):
    acc = await make_acc({})
    await create(acc, PathSpec.from_str_path("/touched.txt"))
    assert (await bucket.files()).get("touched.txt") == b""


async def _missing_repo(bucket) -> None:
    # The Hub refuses the commit of a write to a repository it does not
    # have with 404 RepoNotFound, which opendal reports as NotFound.
    await bucket.run.answer_next(
        "POST",
        COMMIT,
        404,
        {"error": "Repository not found"},
        headers={
            "X-Error-Code": "RepoNotFound",
            "X-Error-Message": "Repository not found",
        },
    )


@pytest.mark.asyncio
async def test_write_into_a_missing_repo_names_the_virtual_path(
    make_acc, bucket
):
    # The driver's put speaks keys ("out.txt"), so letting its error
    # through would put a backend key in a user-facing message; the kit's
    # write factory restates it on the path the user typed.
    acc = await make_acc({})
    await _missing_repo(bucket)
    with pytest.raises(FileNotFoundError) as caught:
        await write(acc, PathSpec.from_str_path("/out.txt"), b"hi")
    assert caught.value.filename == "/out.txt"


@pytest.mark.asyncio
async def test_create_into_a_missing_repo_names_the_virtual_path(
    make_acc, bucket
):
    acc = await make_acc({})
    await _missing_repo(bucket)
    with pytest.raises(FileNotFoundError) as caught:
        await create(acc, PathSpec.from_str_path("/new.txt"))
    assert caught.value.filename == "/new.txt"


@pytest.mark.asyncio
async def test_a_large_streamed_write_holds_a_bounded_amount_of_memory(
    make_acc, bucket
):
    acc = await make_acc({})
    block = b"x" * (1024 * 1024)

    async def source():
        for _ in range(64):
            yield block

    tracemalloc.start()
    try:
        written = await write(
            acc, PathSpec.from_str_path("/big.bin"), source()
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    stored = await bucket.operator().read("big.bin")
    assert hashlib.sha256(bytes(stored)).hexdigest() == (
        hashlib.sha256(block * 64).hexdigest()
    )
    assert written is not None and written.size == len(block) * 64
    assert peak < 8 * 1024 * 1024


@pytest.mark.asyncio
async def test_a_failed_stream_commits_nothing(make_acc, bucket):
    acc = await make_acc({})

    async def source():
        yield b"partial"
        raise RuntimeError("producer failed")

    with pytest.raises(RuntimeError, match="producer failed"):
        await write(acc, PathSpec.from_str_path("/out.txt"), source())
    assert await bucket.files() == {}
