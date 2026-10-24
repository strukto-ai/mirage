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

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import install, replaces


@replaces("read", filetype=".tally")
async def _rendered(accessor, path, **kwargs):
    return b"RENDERED"


def test_xxd_reverse_across_mounts_writes_into_the_stored_bytes():
    # The OUTFILE's mount renders .tally reads; -r writes into what the
    # store holds, never into a rendering of it.
    async def run():
        source, target = RAMVFS(), RAMVFS()
        ws = Workspace({"/a": source, "/b": target}, mode=MountMode.WRITE)
        install(ws.mount("/b"), [_rendered])
        await ws.shell("printf ABCDEFGH > /b/out.tally")
        await ws.shell("printf '00000004: 6869  hi\\n' > /a/dump")
        io = await ws.shell("xxd -r /a/dump /b/out.tally")
        stored, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/b/out.tally"), filetype=None
        )
        await ws.close()
        return io.exit_code, stored

    exit_code, stored = asyncio.run(run())
    assert exit_code == 0
    assert stored == b"ABCDhiGH"


class _CachingRAM(RAMVFS):
    caches_reads = True


def test_xxd_reverse_into_its_own_input_reads_back_patched():
    # INFILE is OUTFILE on a caching mount: the cache must not keep the
    # write's marker as the file, so the next read sees the store.
    async def run():
        ws = Workspace({"/data": _CachingRAM()}, mode=MountMode.WRITE)
        await ws.shell("printf '00000000: 4142  AB\\n' > /data/d")
        await ws.shell("cat /data/d")
        io = await ws.shell("xxd -r /data/d /data/d")
        cat = await ws.shell("cat /data/d")
        out = await cat.materialize_stdout()
        await ws.close()
        return io.exit_code, out

    exit_code, out = asyncio.run(run())
    assert exit_code == 0
    assert out == b"AB000000: 4142  AB\n"
