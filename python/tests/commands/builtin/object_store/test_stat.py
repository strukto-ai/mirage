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

from typing import cast

import pytest

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.object_store.stat import make_stat
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.ops.types import NamespaceView, StatOverlay
from mirage.types import ContentType, FileStat, FileType, PathSpec

_BACKEND_MTIME = "2020-05-05T05:05:05Z"
_OVERLAY_MTIME = "2024-01-01T00:00:00Z"


def _backend_stat() -> FileStat:
    return FileStat(
        name="f.txt",
        size=6,
        modified=_BACKEND_MTIME,
        mode=0o644,
        type=FileType.FILE,
        content=ContentType.TEXT,
    )


async def _fake_stat_core(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> FileStat:
    return _backend_stat()


async def _unused_readdir(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> list[str]:
    raise AssertionError("readdir must not run for a plain operand")


async def _unused_read(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> bytes:
    raise AssertionError("read must not run")


def _overlay(_virtual: str, st: FileStat) -> FileStat:
    return st.model_copy(update={"mode": 0o600, "modified": _OVERLAY_MTIME})


_IO = CommandIO(
    readdir=_unused_readdir,
    read_bytes=_unused_read,
    read_stream=_unused_read,
    stat=_fake_stat_core,
    is_mounted=lambda a: True,
)

stat = make_stat("s3", _IO)


async def _render(
    fmt: str, stat_overlay: StatOverlay | None = None
) -> tuple[int, str]:
    out, io = await stat(
        cast(Accessor, object()),
        [PathSpec.from_str_path("/s3/f.txt")],
        [],
        CommandOpts(
            index=NULL_INDEX,
            ns=NamespaceView(stat_overlay=stat_overlay),
            flags={"c": fmt},
        ),
    )
    return io.exit_code, (await materialize(out)).decode()


@pytest.mark.asyncio
async def test_stat_c_applies_namespace_overlay():
    """Keyed stores register no setattr op, so chmod/touch state lives
    only in the namespace overlay; the override must merge it in, like
    the generic_bind builder does, or stat -c disagrees with ls -l."""
    code, out = await _render("%a|%y", stat_overlay=_overlay)
    assert code == 0
    assert out == "600|2024-01-01 00:00:00.000000000 +0000\n"


@pytest.mark.asyncio
async def test_stat_c_without_overlay_reports_backend_values():
    code, out = await _render("%a|%y")
    assert code == 0
    assert out == "644|2020-05-05 05:05:05.000000000 +0000\n"
