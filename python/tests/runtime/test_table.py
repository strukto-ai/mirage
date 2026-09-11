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

from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python import LocalRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.table import (BUILTIN_RUNTIMES, DEFAULT_ENTRIES,
                                  DEFAULT_PYTHON, NAMED, RUNTIMES, VFSRuntime,
                                  bind_commands, build_runtime, known_runtimes,
                                  register_runtime, runtime_bindings_for,
                                  whole_line_runtime)
from mirage.runtime.types import RunArgs, RunResult


class FakeRuntime(Runtime):
    name = "fake"
    captures = ("python3", "made-up")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_default_entries_never_include_local():
    assert "local" not in DEFAULT_ENTRIES
    assert DEFAULT_ENTRIES[-1] == "vfs"


def test_default_python_is_monty_and_leads_the_default_world():
    # The one entry TypeScript disagrees on, so it is named rather than
    # left to a slot: TypeScript registers pyodide.
    assert DEFAULT_PYTHON == "monty"
    assert DEFAULT_ENTRIES[0] == DEFAULT_PYTHON


def test_default_python_is_a_registered_python_engine():
    assert issubclass(NAMED[DEFAULT_PYTHON], PythonRuntime)


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
    bindings = bind_commands([fake, local, VFSRuntime()])
    assert bindings["python3"] is fake
    assert bindings["made-up"] is fake
    assert bindings["python"] is local


def test_bind_commands_vfs_runtime_binds_nothing():
    assert bind_commands([VFSRuntime()]) == {}


def test_build_runtime_vfs_is_a_named_runtime():
    assert isinstance(build_runtime("vfs"), VFSRuntime)


def test_bind_commands_rejects_duplicate_names():
    with pytest.raises(ValueError, match="duplicate runtime entry: 'local'"):
        bind_commands([LocalRuntime(), LocalRuntime()])


def test_every_runtime_declares_captures():
    for cls in RUNTIMES:
        assert cls.captures


def test_runtime_bindings_for_maps_only_the_named_captures():
    fake = FakeRuntime()
    bindings = runtime_bindings_for([fake, VFSRuntime()], "fake")
    assert bindings == {"python3": fake, "made-up": fake}


def test_runtime_bindings_for_rejects_vfs():
    with pytest.raises(ValueError, match="not a runtime you can select"):
        runtime_bindings_for([FakeRuntime(), VFSRuntime()], "vfs")


def test_runtime_bindings_for_unknown_name_lists_entries():
    with pytest.raises(ValueError, match="'fake', 'vfs'"):
        runtime_bindings_for([FakeRuntime(), VFSRuntime()], "nope")


class _LineRuntime(Runtime, LineExecutorMixin):
    name = "boxy"
    captures = ("nvidia-smi", )

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_whole_line_runtime_matches_a_captured_command():
    box = _LineRuntime()
    assert whole_line_runtime({"nvidia-smi": box},
                              ["cat", "nvidia-smi"]) is box


def test_whole_line_runtime_specific_beats_star():
    box, star = _LineRuntime(), _LineRuntime()
    bindings = {"nvidia-smi": box, "*": star}
    assert whole_line_runtime(bindings, ["nvidia-smi"]) is box
    assert whole_line_runtime(bindings, ["ls"]) is star


def test_whole_line_runtime_skips_stage_engines_and_vfs():
    vfs = VFSRuntime(captures=["grep"])
    monty_like = FakeRuntime()
    bindings = {"grep": vfs, "python3": monty_like}
    assert whole_line_runtime(bindings, ["grep", "python3"]) is None


def test_vfs_is_a_pure_routing_marker():
    # A line resolved to vfs runs on the workspace executor inline, so
    # the marker carries no line door and no interpreter door.
    vfs = VFSRuntime()
    assert not isinstance(vfs, LineExecutorMixin)
    assert not hasattr(vfs, "run_line")
    assert not hasattr(vfs, "run")


def test_vfs_marker_reach_is_vfs():
    assert VFSRuntime.reach == "vfs"


def test_default_world_reaches_only_the_vfs():
    # The default world's sandbox story rests on every entry keeping
    # its effects behind the workspace gate; `local` (process reach)
    # is deliberately not a default entry.
    assert all(NAMED[name].reach == "vfs" for name in DEFAULT_ENTRIES)


def test_register_runtime_makes_a_host_class_buildable_by_name():
    try:
        register_runtime("fake", FakeRuntime)
        assert "fake" in known_runtimes()
        built = build_runtime("fake", captures=("python3", ))
        assert isinstance(built, FakeRuntime)
        assert built.captures == ("python3", )
    finally:
        NAMED.pop("fake", None)


def test_register_runtime_refuses_a_builtin_name():
    assert {"monty", "vfs", "docker"} <= BUILTIN_RUNTIMES
    with pytest.raises(ValueError, match="shadows a builtin"):
        register_runtime("monty", FakeRuntime)
    with pytest.raises(ValueError, match="shadows a builtin"):
        register_runtime("docker", FakeRuntime)


def test_register_runtime_replaces_a_custom_name():

    class Other(FakeRuntime):
        name = "fake"

    try:
        register_runtime("fake", FakeRuntime)
        register_runtime("fake", Other)
        assert isinstance(build_runtime("fake"), Other)
    finally:
        NAMED.pop("fake", None)
