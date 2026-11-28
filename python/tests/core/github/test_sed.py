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
"""sed over the read-only GitHub mount (factory-built command).

GitHub is read-only: `sed` is a read-transform (output to stdout) and `-i` is
rejected. Exercises the generic sed builder wiring for github (index-aware
read, write-gated -i).
"""

import pytest

from mirage.types import PathSpec
from mirage.vfs.github import GitHubVFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import run_on_mount
from tests.fixtures.vfs_io import vfs_over


def _scope(path: str) -> PathSpec:
    norm = "/" + path.lstrip("/")
    directory = norm.rsplit("/", 1)[0] + "/"
    return PathSpec(
        vfs_path=(norm).strip("/"),
        virtual=norm,
        directory=directory,
        resolved=True,
    )


async def _run(accessor, path, expr, **kwargs):
    ws = Workspace({"/": vfs_over(GitHubVFS, accessor)})
    out, io = await run_on_mount(ws, "sed", [_scope(path)], [expr], kwargs)
    return out.decode(errors="replace"), io


@pytest.mark.asyncio
async def test_sed_inplace_rejected(repo):
    await repo.create({"src/main.py": b"import os\nimport sys\n"})
    text, io = await _run(
        repo.accessor(), "src/main.py", "s/import/X/", in_place=True
    )
    assert text == ""
    assert io.exit_code == 1
    assert io.stderr == (
        b"sed: -i not supported on this backend: Permission denied\n"
    )
