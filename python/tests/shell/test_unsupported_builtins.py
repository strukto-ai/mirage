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

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.parametrize("name", [
    "bg",
    "complete",
    "compgen",
    "ulimit",
])
def test_unsupported_builtin_returns_clear_error(name):
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(name))
    assert io.exit_code == 2, (
        f"expected exit 2 for {name!r}, got {io.exit_code}")
    stderr = io.stderr or b""
    assert f"unsupported builtin: {name}".encode() in stderr, (
        f"expected 'unsupported builtin: {name}' in stderr, got {stderr!r}")


@pytest.mark.parametrize("cmd", [
    "echo hi >(cat)",
    "tee >(grep foo) /tmp/out",
    "cat >(wc)",
])
def test_output_process_substitution_unsupported(cmd):
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(cmd))
    assert io.exit_code == 2, (
        f"expected exit 2 for {cmd!r}, got {io.exit_code}")
    stderr = io.stderr or b""
    assert b"process substitution" in stderr, (
        f"expected 'process substitution' in stderr, got {stderr!r}")
    assert b"unsupported" in stderr


def test_input_process_substitution_still_works():
    ram = RAMVFS()
    ram._store.files["/a"] = b"line1\nline2\n"
    ws = Workspace({"/data": (ram, MountMode.READ)})
    io = asyncio.run(ws.shell("cat <(cat /data/a)"))
    assert io.exit_code == 0, (
        f"input process substitution should still work, got {io}")
