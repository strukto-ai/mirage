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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.patch import patch_generic
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.types import MountMode, PathSpec
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["", "/data", "/nested/data"])
@pytest.mark.parametrize("source", ["stdin", "operand", "input"])
async def test_patch_preserves_virtual_paths_for_mounted_io(prefix, source):
    patch_data = (
        b"--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n"
        b" hello\n-world\n+universe\n"
    )
    files = {"hello.txt": b"hello\nworld\n", "fix.diff": patch_data}
    seen = []

    async def read(path):
        assert path.virtual == prefix + "/" + path.vfs_path
        seen.append(path.vfs_path)
        return files[path.vfs_path]

    async def write(path, data):
        assert path.virtual == prefix + "/" + path.vfs_path
        files[path.vfs_path] = data

    input_path = PathSpec.from_str_path(prefix + "/fix.diff", "fix.diff")
    orig_path = PathSpec.from_str_path(prefix + "/hello.txt", "hello.txt")
    flags = {"p": "1"}
    if source == "input":
        flags["i"] = input_path
    # The patch's own names resolve against the root of the mount the
    # command runs on.
    rows = (
        [
            MountRow(
                prefix=prefix + "/", resource_type="ram", mode=MountMode.WRITE
            )
        ]
        if prefix
        else []
    )
    ctx = Context(
        flags=flags,
        cwd=PathSpec.from_str_path(prefix or "/"),
        vfs=Files(AsyncMock(), readers(rows), ledger=False),
        stdin=patch_data if source == "stdin" else None,
    )
    operands = [orig_path, input_path] if source == "operand" else []
    token = set_mount_gate(prefix + "/", MountMode.WRITE)
    try:
        await patch_generic(operands, [], ctx, read, write)
    finally:
        reset_mount_gate(token)
    assert "hello.txt" in seen
    assert files["hello.txt"] == b"hello\nuniverse\n"
