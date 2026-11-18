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

import os

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.copy import copy
from mirage.types import PathSpec


@pytest.fixture
def accessor(tmp_path):
    root = tmp_path.resolve()
    (root / "src").write_text("X")
    return DiskAccessor(root)


@pytest.mark.asyncio
async def test_copy_duplicates_a_file(accessor):
    await copy(
        accessor,
        PathSpec.from_str_path("/src"),
        PathSpec.from_str_path("/dst"),
    )
    assert (accessor.root / "dst").read_text() == "X"


@pytest.mark.asyncio
async def test_copy_leaves_the_mode_and_times_to_the_copy(accessor):
    src = accessor.root / "src"
    os.chmod(src, 0o750)
    os.utime(src, (1_000_000_000, 1_000_000_000))
    held = accessor.root / "held"
    held.write_text("old")
    os.chmod(held, 0o600)
    for name in ("held", "new"):
        await copy(
            accessor,
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path(f"/{name}"),
        )
    mask = os.umask(0)
    os.umask(mask)
    assert held.stat().st_mode & 0o7777 == 0o600
    assert (accessor.root / "new").stat().st_mode & 0o7777 == 0o666 & ~mask
    assert (accessor.root / "new").stat().st_mtime != 1_000_000_000
    assert held.read_text() == "X"


@pytest.mark.asyncio
async def test_copy_does_not_create_the_destination_parent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(
            accessor,
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/a/b/dst"),
        )
    assert not (accessor.root / "a").exists()


@pytest.mark.asyncio
async def test_copy_blames_the_destination_when_its_parent_is_missing(
    accessor,
):
    # copy2 answers ENOENT for a missing source too, so the failure has to be
    # attributed to the destination rather than assumed to be the source.
    with pytest.raises(FileNotFoundError) as excinfo:
        await copy(
            accessor,
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/a/b/dst"),
        )
    assert excinfo.value.filename == "/a/b/dst"


@pytest.mark.asyncio
async def test_copy_blames_the_source_when_it_is_the_missing_operand(accessor):
    with pytest.raises(FileNotFoundError) as excinfo:
        await copy(
            accessor,
            PathSpec.from_str_path("/nope"),
            PathSpec.from_str_path("/dst"),
        )
    assert excinfo.value.filename == "/nope"


@pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores the permission bits under test"
)
@pytest.mark.asyncio
async def test_copy_blames_the_source_when_it_is_unreadable(accessor):
    (accessor.root / "src").chmod(0)
    try:
        with pytest.raises(PermissionError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
    finally:
        (accessor.root / "src").chmod(0o644)
    assert excinfo.value.filename == "/src"


@pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores the permission bits under test"
)
@pytest.mark.asyncio
async def test_copy_blames_the_destination_when_it_is_unwritable(accessor):
    (accessor.root / "ro").mkdir()
    (accessor.root / "ro").chmod(0o555)
    try:
        with pytest.raises(PermissionError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/ro/dst"),
            )
    finally:
        (accessor.root / "ro").chmod(0o755)
    assert excinfo.value.filename == "/ro/dst"


@pytest.mark.asyncio
async def test_copy_never_leaks_the_host_path(accessor):
    for src, dst in (("/src", "/a/b/dst"), ("/nope", "/dst")):
        with pytest.raises(OSError) as excinfo:
            await copy(
                accessor,
                PathSpec.from_str_path(src),
                PathSpec.from_str_path(dst),
            )
        assert str(accessor.root) not in str(excinfo.value)
