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

from functools import partial

import pytest

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.du import du as du_builder
from mirage.commands.builtin.generic_bind.builders.find import \
    find as find_builder
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec

_FILES = {
    "/g/a.txt": b"alpha\n",
    "/g/sub/b.txt": b"bravo\n",
}
_DIRS = {"/g", "/g/sub"}


async def _readdir(accessor, path, index=None):
    base = (path.virtual if isinstance(path, PathSpec) else path).rstrip("/")
    out = []
    for p in list(_FILES) + sorted(_DIRS):
        parent = p.rsplit("/", 1)[0] or "/"
        if parent == base and p != base:
            out.append(p)
    return out


async def _stat(accessor, path, index=None):
    p = path.virtual if isinstance(path, PathSpec) else path
    p = p.rstrip("/") or "/"
    if p in _DIRS:
        return FileStat(name=p.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
    if p in _FILES:
        return FileStat(name=p.rsplit("/", 1)[-1],
                        size=len(_FILES[p]),
                        type=FileType.TEXT)
    raise FileNotFoundError(p)


async def _read(accessor, path, index=None):
    p = path.virtual if isinstance(path, PathSpec) else path
    return _FILES[p.rstrip("/")]


def _ops() -> CommandIO:
    return CommandIO(
        readdir=_readdir,
        read_bytes=_read,
        read_stream=partial(stream_from_bytes, _read),
        stat=_stat,
        is_mounted=lambda a: True,
        local=False,
    )


def _spec(original: str) -> PathSpec:
    return PathSpec(resource_path=(original).strip("/"),
                    virtual=original,
                    directory=original,
                    resolved=True)


@pytest.mark.asyncio
async def test_find_walks_tree_without_native_find_op():
    out, io = await find_builder(_ops(), object(), [_spec("/g")], type="f")
    text = (await materialize(out)).decode()
    assert "/g/a.txt" in text
    assert "/g/sub/b.txt" in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_du_walks_tree_without_native_du_op():
    out, _ = await du_builder(_ops(), object(), [_spec("/g")], s=True)
    text = (await materialize(out)).decode()
    # alpha\n (6) + bravo\n (6) = 12 bytes summed by the readdir walk.
    assert "12" in text
    assert "/g" in text
