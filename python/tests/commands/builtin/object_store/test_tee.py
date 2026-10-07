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

import dataclasses
from typing import cast

import pytest

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.object_store import make_object_store_commands
from mirage.commands.config import CommandOpts
from mirage.types import (
    FileStat,
    FileType,
    MountMode,
    PathSpec,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.access import io_context


async def _readdir(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> list[str]:
    return []


async def _missing(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> bytes:
    raise FileNotFoundError(_path.virtual)


async def _exists(
    _accessor: Accessor, _path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> bool:
    return False


async def _stat(
    _accessor: Accessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> FileStat:
    # The parents the outputs land in hold keys, so they read as
    # directories; every output itself is new.
    if path.virtual.rstrip("/") in ("/s3", "/s3/build"):
        return FileStat(name=path.name, type=FileType.DIRECTORY)
    raise FileNotFoundError(path.virtual)


async def _unused_dir_op(_accessor: Accessor, _path: PathSpec) -> None:
    raise AssertionError("directory op must not run")


def _io(writes: list[str]) -> CommandIO:
    async def write(_accessor: Accessor, path: PathSpec, _data: bytes) -> None:
        writes.append(path.virtual)

    return CommandIO(
        readdir=_readdir,
        read_bytes=_missing,
        read_stream=_missing,
        stat=_stat,
        write=write,
        exists=_exists,
        mkdir=_unused_dir_op,
        unlink=_unused_dir_op,
        rmdir=_unused_dir_op,
        rm_r=_unused_dir_op,
        is_mounted=lambda a: True,
    )


def _tee(writes: list[str]):
    cmds = make_object_store_commands("s3", _io(writes))
    return next(c for c in cmds if c._registered_commands[0].name == "tee")


@pytest.mark.asyncio
async def test_tee_holds_each_path_to_its_regions_mode():
    writes: list[str] = []
    tee = _tee(writes)
    sess = SessionState(
        session_id="agent",
        mount_modes={"/s3": MountMode.READ},
        visibility=Visibility(
            shown=ShownPaths(
                entries=(ShowEntry("/s3/build", MountMode.WRITE),)
            )
        ),
    )
    context = dataclasses.replace(
        io_context(sess, policies=None), mount_gate=("/s3", MountMode.WRITE)
    )
    _, result = await tee(
        cast(Accessor, object()),
        [PathSpec.from_str_path("/s3/data.txt")],
        [],
        CommandOpts(io_context=context, index=NULL_INDEX),
    )
    assert result.exit_code == 1
    assert b"Read-only file system" in (result.stderr or b"")
    assert writes == []


@pytest.mark.asyncio
async def test_tee_writes_inside_the_granted_region():
    writes: list[str] = []
    tee = _tee(writes)
    sess = SessionState(
        session_id="agent",
        mount_modes={"/s3": MountMode.READ},
        visibility=Visibility(
            shown=ShownPaths(
                entries=(ShowEntry("/s3/build", MountMode.WRITE),)
            )
        ),
    )
    context = dataclasses.replace(
        io_context(sess, policies=None), mount_gate=("/s3", MountMode.WRITE)
    )
    _, result = await tee(
        cast(Accessor, object()),
        [PathSpec.from_str_path("/s3/build/out.txt")],
        [],
        CommandOpts(io_context=context, index=NULL_INDEX),
    )
    assert result.exit_code == 0, result.stderr
    assert writes == ["/s3/build/out.txt"]
