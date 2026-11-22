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

from mirage.core.machine.copy import copy, dir_copy
from mirage.core.machine.mkdir import mkdir
from mirage.core.machine.rename import rename
from mirage.core.machine.rm import rm_r
from mirage.core.machine.rmdir import rmdir
from mirage.core.machine.unlink import unlink
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import bound, spec


@pytest.mark.asyncio
async def test_tree_ops_run_one_line_each():
    box = ScriptedMachine("box", lambda line, data: ok(b"copied\n"))
    accessor = bound(box)
    await mkdir(accessor, "box", spec("/d"), parents=True)
    await unlink(accessor, "box", spec("/f"))
    await rmdir(accessor, "box", spec("/d"))
    await rm_r(accessor, "box", spec("/t"))
    await rename(accessor, "box", spec("/a"), spec("/b/c"), make_parent=True)
    await copy(accessor, "box", spec("/a"), spec("/b"))
    await dir_copy(accessor, "box", spec("/s"), spec("/t"))
    await copy(accessor, "box", spec("/a"), spec("/n/b"), make_parent=True)
    await dir_copy(accessor, "box", spec("/s"), spec("/n/t"), make_parent=True)
    assert box.lines == [
        "mkdir -p -- '/tmp/d'",
        "rm -- '/tmp/f'",
        "rmdir -- '/tmp/d'",
        "rm -r -- '/tmp/t'",
        "mkdir -p -- '/tmp/b' && mv -T -- '/tmp/a' '/tmp/b/c'",
        "cp -T -- '/tmp/a' '/tmp/b'",
        "env LC_ALL=C cp -RL -- '/tmp/s' '/tmp/t' && echo copied",
        "mkdir -p -- '/tmp/n' && cp -T -- '/tmp/a' '/tmp/n/b'",
        "mkdir -p -- '/tmp/n' && env LC_ALL=C cp -RL -- '/tmp/s' '/tmp/n/t'"
        " && echo copied",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("said", "error"),
    [
        (b"rmdir: failed to remove '/tmp/d': Directory not empty\n", OSError),
        (
            b"mkdir: cannot create directory '/tmp/d': File exists\n",
            FileExistsError,
        ),
        (b"rm: cannot remove '/tmp/d': Is a directory\n", IsADirectoryError),
    ],
)
async def test_each_refusal_keeps_its_errno(said, error):
    box = ScriptedMachine("box", lambda line, data: failed(said))
    with pytest.raises(error) as caught:
        await rmdir(bound(box), "box", spec("/d"))
    assert caught.value.filename == "/tmp/d"
