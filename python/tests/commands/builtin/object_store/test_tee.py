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
from mirage.commands.builtin.object_store import make_object_store_commands
from mirage.commands.config import CommandOpts
from mirage.context import (reset_current_session, reset_mount_gate,
                            set_current_session, set_mount_gate)
from mirage.types import MountMode, PathSpec, ShowEntry, ShownPaths
from mirage.workspace.session import SessionState


async def _readdir(_accessor: Accessor,
                   _path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> list[str]:
    return []


async def _missing(_accessor: Accessor,
                   _path: PathSpec,
                   index: IndexCacheStore = NULL_INDEX) -> bytes:
    raise FileNotFoundError(_path.virtual)


async def _exists(_accessor: Accessor,
                  _path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> bool:
    return False


async def _unused_dir_op(_accessor: Accessor, _path: PathSpec) -> None:
    raise AssertionError("directory op must not run")


def _io(writes: list[str]) -> CommandIO:

    async def write(_accessor: Accessor, path: PathSpec, _data: bytes) -> None:
        writes.append(path.virtual)

    return CommandIO(readdir=_readdir,
                     read_bytes=_missing,
                     read_stream=_missing,
                     stat=_missing,
                     write=write,
                     exists=_exists,
                     mkdir=_unused_dir_op,
                     unlink=_unused_dir_op,
                     rmdir=_unused_dir_op,
                     rm_r=_unused_dir_op,
                     is_mounted=lambda a: True)


def _tee(writes: list[str]):
    cmds = make_object_store_commands("s3", _io(writes))
    return next(c for c in cmds if c._registered_commands[0].name == "tee")


@pytest.mark.asyncio
async def test_tee_holds_each_path_to_its_regions_mode():
    # The override rides the same guard chain as the generic it
    # replaces: the command gate admits tee because one region grants
    # writes, and the write below the read-only cap still refuses
    # before the backend sees it.
    writes: list[str] = []
    tee = _tee(writes)
    sess = SessionState(
        session_id="agent",
        mount_modes={"/s3": MountMode.READ},
        shown_paths=ShownPaths(
            entries=(ShowEntry("/s3/build", MountMode.WRITE), )))
    session_token = set_current_session(sess)
    gate_token = set_mount_gate("/s3", MountMode.WRITE)
    try:
        _, result = await tee(cast(Accessor, object()),
                              [PathSpec.from_str_path("/s3/data.txt")], [],
                              CommandOpts(index=NULL_INDEX))
    finally:
        reset_mount_gate(gate_token)
        reset_current_session(session_token)
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
        shown_paths=ShownPaths(
            entries=(ShowEntry("/s3/build", MountMode.WRITE), )))
    session_token = set_current_session(sess)
    gate_token = set_mount_gate("/s3", MountMode.WRITE)
    try:
        _, result = await tee(cast(Accessor, object()),
                              [PathSpec.from_str_path("/s3/build/out.txt")],
                              [], CommandOpts(index=NULL_INDEX))
    finally:
        reset_mount_gate(gate_token)
        reset_current_session(session_token)
    assert result.exit_code == 0, result.stderr
    assert writes == ["/s3/build/out.txt"]
