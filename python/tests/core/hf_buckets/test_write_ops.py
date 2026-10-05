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

import pytest
from opendal.exceptions import NotFound

from mirage.core.hf_buckets.create import create
from mirage.core.hf_buckets.unlink import unlink
from mirage.core.hf_buckets.write import write
from mirage.types import PathSpec
from tests.core.hf_buckets.conftest import FakeAsyncOperator


@pytest.mark.asyncio
async def test_write_bytes_uploads(make_acc):
    acc = make_acc({})
    await write(acc, PathSpec.from_str_path("/hello.txt"), b"hi there")
    assert acc._fake.files == {"hello.txt": b"hi there"}


@pytest.mark.asyncio
async def test_unlink_deletes_file(make_acc):
    acc = make_acc({"delete-me.txt": b"x"})
    await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    assert "delete-me.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_unlink_refuses_a_directory_and_leaves_its_subtree(make_acc):
    # unlink(2) refuses a directory with EISDIR, and the op answers it
    # itself: a guest, FUSE and ws.vfs reach it without the rm builder's
    # stat. A directory owns no key of its own, so nothing is touched.
    acc = make_acc({"some-dir/child.txt": b"x"})
    with pytest.raises(IsADirectoryError):
        await unlink(acc, PathSpec.from_str_path("/some-dir"))
    assert acc._fake.files == {"some-dir/child.txt": b"x"}


@pytest.mark.asyncio
async def test_unlink_refuses_a_missing_key(make_acc):
    # unlink(2) answers ENOENT, which the store's own delete never says.
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await unlink(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_create_writes_empty_file(make_acc):
    acc = make_acc({})
    await create(acc, PathSpec.from_str_path("/touched.txt"))
    assert acc._fake.files.get("touched.txt") == b""


class _MissingRepoOperator(FakeAsyncOperator):
    """Refuses writes the way a missing repo or revision does."""

    async def write(self, key: str, data: bytes) -> None:
        raise NotFound("repository not found", key)


@pytest.mark.asyncio
async def test_write_into_a_missing_repo_names_the_virtual_path(make_acc):
    # The driver's put speaks keys ("out.txt"), so letting its error
    # through would put a backend key in a user-facing message; the kit's
    # write factory restates it on the path the user typed.
    acc = make_acc({})
    acc.operator = lambda: _MissingRepoOperator(files={})
    with pytest.raises(FileNotFoundError) as caught:
        await write(acc, PathSpec.from_str_path("/out.txt"), b"hi")
    assert str(caught.value) == "/out.txt"


@pytest.mark.asyncio
async def test_create_into_a_missing_repo_names_the_virtual_path(make_acc):
    acc = make_acc({})
    acc.operator = lambda: _MissingRepoOperator(files={})
    with pytest.raises(FileNotFoundError) as caught:
        await create(acc, PathSpec.from_str_path("/new.txt"))
    assert str(caught.value) == "/new.txt"
