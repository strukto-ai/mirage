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

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.python import LocalRuntime
from mirage.runtime.table import (DEFAULT_ENTRIES, RUNTIMES, VfsRuntime,
                                  bind_commands, build_runtime,
                                  runtime_bindings_for)


class FakeRuntime(Runtime):
    name = "fake"
    captures = ("python3", "made-up")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_default_entries_never_include_local():
    assert "local" not in DEFAULT_ENTRIES
    assert DEFAULT_ENTRIES[-1] == "vfs"


def test_build_runtime_unknown_name_fails_loud():
    with pytest.raises(ValueError, match="unknown runtime: 'ghost'"):
        build_runtime("ghost")


def test_build_runtime_pyodide_gets_cross_language_hint():
    with pytest.raises(ValueError, match="TypeScript-only"):
        build_runtime("pyodide")


def test_build_runtime_local_takes_options():
    runtime = build_runtime("local")
    assert isinstance(runtime, LocalRuntime)


def test_bind_commands_first_capturer_wins():
    fake = FakeRuntime()
    local = LocalRuntime()
    bindings = bind_commands([fake, local, VfsRuntime()])
    assert bindings["python3"] is fake
    assert bindings["made-up"] is fake
    assert bindings["python"] is local


def test_bind_commands_vfs_runtime_binds_nothing():
    assert bind_commands([VfsRuntime()]) == {}


def test_build_runtime_vfs_is_a_named_runtime():
    assert isinstance(build_runtime("vfs"), VfsRuntime)


def test_bind_commands_rejects_duplicate_names():
    with pytest.raises(ValueError, match="duplicate runtime entry: 'local'"):
        bind_commands([LocalRuntime(), LocalRuntime()])


def test_every_runtime_declares_captures():
    for cls in RUNTIMES:
        assert cls.captures


def test_runtime_bindings_for_maps_only_the_named_captures():
    fake = FakeRuntime()
    bindings = runtime_bindings_for([fake, VfsRuntime()], "fake")
    assert bindings == {"python3": fake, "made-up": fake}


def test_runtime_bindings_for_rejects_vfs():
    with pytest.raises(ValueError, match="not a runtime you can select"):
        runtime_bindings_for([FakeRuntime(), VfsRuntime()], "vfs")


def test_runtime_bindings_for_unknown_name_lists_entries():
    with pytest.raises(ValueError, match="'fake', 'vfs'"):
        runtime_bindings_for([FakeRuntime(), VfsRuntime()], "nope")
