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

import asyncio
import threading

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk import rename as rename_module
from mirage.core.disk.rename import rename
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory="/")


@pytest.mark.asyncio
async def test_rename_moves_file(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"A")
    accessor = DiskAccessor(tmp_path)
    await rename(accessor, _spec("/a.txt"), _spec("/b.txt"))
    assert not (tmp_path / "a.txt").exists()
    assert (tmp_path / "b.txt").read_bytes() == b"A"


@pytest.mark.asyncio
async def test_a_cancelled_folder_move_is_recorded_as_one(
    tmp_path, monkeypatch
):
    (tmp_path / "d").mkdir()
    entered, release = threading.Event(), threading.Event()
    resolve = rename_module.resolve_inside_sync

    def held(root, spec, path=None):
        entered.set()
        release.wait(5)
        return resolve(root, spec, path)

    rows: list[tuple[str, str]] = []
    monkeypatch.setattr(rename_module, "resolve_inside_sync", held)
    monkeypatch.setattr(
        rename_module, "record", lambda op, path, *_: rows.append((op, path))
    )
    moving = asyncio.create_task(
        rename(DiskAccessor(tmp_path), _spec("/d"), _spec("/e"))
    )
    await asyncio.to_thread(entered.wait, 5)
    moving.cancel()
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await moving
    assert (tmp_path / "e").is_dir()
    assert rows == [("rename_prefix", "/d"), ("rename_prefix", "/e")]
