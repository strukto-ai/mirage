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

from mirage.commands.config import Context
from mirage.runtime.base import Runtime
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python import LocalRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.table import (
    BUILTIN_RUNTIMES,
    DEFAULT_ENTRIES,
    NAMED,
    bind_commands,
    build_runtime,
    built_from,
    known_runtimes,
    register_runtime,
    runtime_bindings_for,
    shadowed_captures,
    whole_line_runtime,
)
from mirage.runtime.types import RunResult
from mirage.runtime.workspace import WorkspaceRuntime


class FakeRuntime(Runtime):
    name = "fake"
    captures = ("python3", "made-up")

    async def run(self, engine, paths, texts, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class PyEngine(PythonRuntime):
    name = "pyengine"

    async def interpret(self, engine, program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class JsEngine(JsRuntime):
    name = "jsengine"

    async def interpret(self, engine, program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class DirectEngine(LanguageRuntime):
    name = "direct"
    language = "python"
    captures = ("python3", "python")

    async def interpret(self, engine, program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_default_world_is_the_workspace_alone():
    assert DEFAULT_ENTRIES == ("workspace",)


@pytest.mark.parametrize(
    ("name", "refusal"),
    [
        ("ghost", "unknown runtime: 'ghost'"),
        ("pyodide", "TypeScript-only"),
    ],
)
def test_build_runtime_refuses_a_name_it_cannot_build(name, refusal):
    with pytest.raises(ValueError, match=refusal):
        build_runtime(name)


def test_build_runtime_local_takes_options():
    runtime = build_runtime("local")
    assert isinstance(runtime, LocalRuntime)


def test_bind_commands_first_capturer_wins():
    fake = FakeRuntime()
    local = LocalRuntime()
    bindings = bind_commands([fake, local, WorkspaceRuntime()])
    assert bindings["python3"] is fake
    assert bindings["made-up"] is fake
    assert bindings["python"] is local


@pytest.mark.parametrize("capture", ["*", "@all", "@lines", "@pyton"])
def test_bind_commands_refuses_a_group_it_does_not_have(capture):
    with pytest.raises(ValueError) as refused:
        bind_commands([FakeRuntime(captures=[capture])])
    assert str(refused.value) == (
        f"{capture!r} is not a program or a group; the groups are"
        " '@external', '@line', '@python' and '@js'"
    )


@pytest.mark.parametrize(
    "entry, capture",
    [
        (PyEngine, "node"),
        (PyEngine, "gcc"),
        (JsEngine, "python3"),
        (PyEngine, "@js"),
    ],
)
def test_bind_commands_refuses_a_capture_a_language_runtime_does_not_run(
    entry, capture
):
    with pytest.raises(ValueError) as refused:
        bind_commands([entry(captures=[capture])])
    assert str(refused.value) == (
        f"runtime {entry.name!r} does not run "
        f"{('node' if capture == '@js' else capture)!r}"
    )


def test_bind_commands_lets_a_language_runtime_that_runs_processes_take_any_name():
    local = LocalRuntime(captures=["python3", "node"])
    assert bind_commands([local]) == {"python3": local, "node": local}


def test_bind_commands_reads_the_tier_from_the_language_not_from_commands():
    engine = DirectEngine()
    assert bind_commands([engine]) == {"python3": engine, "python": engine}


def test_a_group_expands_to_the_interpreter_names_mirage_owns():
    assert PyEngine(captures=["@python"]).captures == ("python3", "python")
    assert JsEngine(captures=["@js"]).captures == ("node", "js")
    mixed = FakeRuntime(captures=["@python", "pip", "python3", "@external"])
    assert mixed.captures == ("python3", "python", "pip", "@external")


def test_an_explicit_empty_list_captures_nothing():
    assert PyEngine(captures=[]).captures == ()


def test_a_group_in_a_class_default_expands_too():
    class GroupDefault(FakeRuntime):
        captures = ("@python", "pip")

    assert GroupDefault().captures == ("python3", "python", "pip")


def test_a_group_binds_both_names_to_the_runtime_that_took_it():
    fake = FakeRuntime(captures=["@python", "pip"])
    bindings = bind_commands([fake, PyEngine()])
    assert {n: bindings[n] for n in ("python3", "python", "pip")} == {
        "python3": fake,
        "python": fake,
        "pip": fake,
    }


def test_bind_commands_workspace_runtime_binds_nothing():
    assert bind_commands([WorkspaceRuntime()]) == {}


def test_build_runtime_workspace_is_a_named_runtime():
    assert isinstance(build_runtime("workspace"), WorkspaceRuntime)


def test_bind_commands_rejects_duplicate_names():
    with pytest.raises(ValueError, match="duplicate runtime entry: 'local'"):
        bind_commands([LocalRuntime(), LocalRuntime()])


def test_bind_commands_takes_a_remote_entry_per_machine():
    a, b = RemoteRuntime(machine="a"), RemoteRuntime(["node"], machine="b")
    assert [a.name, b.name, RemoteRuntime().name] == [
        "remote:a",
        "remote:b",
        "remote",
    ]
    bindings = bind_commands([a, b])
    assert (bindings["@external"], bindings["node"]) == (a, b)
    with pytest.raises(
        ValueError, match="duplicate runtime entry: 'remote:a'"
    ):
        bind_commands([a, RemoteRuntime(["node"], machine="a")])


def test_every_runtime_declares_captures():
    for cls in NAMED.values():
        assert cls.captures or cls is WorkspaceRuntime


def test_runtime_bindings_for_maps_only_the_named_captures():
    fake = FakeRuntime()
    bindings = runtime_bindings_for([fake, WorkspaceRuntime()], "fake")
    assert bindings == {"python3": fake, "made-up": fake}


@pytest.mark.parametrize(
    ("name", "refusal"),
    [
        ("workspace", "not a runtime you can select"),
        ("nope", "'fake', 'workspace'"),
    ],
)
def test_runtime_bindings_for_refuses_a_name_it_cannot_bind(name, refusal):
    with pytest.raises(ValueError, match=refusal):
        runtime_bindings_for([FakeRuntime(), WorkspaceRuntime()], name)


def test_runtime_bindings_for_takes_a_runtimes_name_while_it_has_one_entry():
    a, b = RemoteRuntime(machine="a"), RemoteRuntime(["node"], machine="b")
    assert runtime_bindings_for([a, WorkspaceRuntime()], "remote") == {
        "@external": a
    }
    assert runtime_bindings_for([a, b], "remote:b") == {"node": b}
    with pytest.raises(
        ValueError,
        match=r"ambiguous runtime: 'remote' \(workspace runtimes: 'remote:a',"
        r" 'remote:b'\)",
    ):
        runtime_bindings_for([a, b], "remote")


def test_runtime_bindings_for_takes_no_other_name_a_class_is_registered_as():
    try:
        register_runtime("cpython", FakeRuntime)
        with pytest.raises(ValueError, match="unknown runtime: 'cpython'"):
            runtime_bindings_for(
                [FakeRuntime(), WorkspaceRuntime()], "cpython"
            )
    finally:
        NAMED.pop("cpython", None)


class _LineRuntime(Runtime, LineExecutorMixin):
    name = "boxy"
    captures = ("nvidia-smi",)

    async def run_line(self, engine, paths, texts, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def test_named_capture_does_not_take_the_whole_line():
    box = _LineRuntime()
    assert whole_line_runtime({"nvidia-smi": box}) is None


def test_only_a_line_capture_takes_the_whole_line():
    box, star = _LineRuntime(), _LineRuntime()
    bindings = {"nvidia-smi": box, "@line": star}
    assert whole_line_runtime(bindings) is star


def test_whole_line_runtime_skips_stage_engines_and_workspace():
    vfs = WorkspaceRuntime(captures=["grep"])
    monty_like = FakeRuntime()
    bindings = {"grep": vfs, "python3": monty_like}
    assert whole_line_runtime(bindings) is None


def test_workspace_runtime_is_a_pure_routing_marker():
    # A line resolved to workspace runs on the workspace executor inline, so
    # the marker carries no line entry point and no interpreter entry point.
    vfs = WorkspaceRuntime()
    assert not isinstance(vfs, LineExecutorMixin)
    assert not hasattr(vfs, "run_line")
    with pytest.raises(UnsupportedExecutionError, match="code execution"):
        asyncio.run(vfs.execute([], [], Context()))


def test_workspace_runtime_reach_is_workspace():
    assert WorkspaceRuntime.reach == "workspace"


def test_default_world_reaches_only_the_workspace():
    # The default world's sandbox story rests on every entry keeping
    # its effects behind the workspace gate; `local` (process reach)
    # is deliberately not a default entry.
    assert all(NAMED[name].reach == "workspace" for name in DEFAULT_ENTRIES)


def test_register_runtime_makes_a_host_class_buildable_by_name():
    try:
        register_runtime("fake", FakeRuntime)
        assert "fake" in known_runtimes()
        built = build_runtime("fake", captures=("python3",))
        assert isinstance(built, FakeRuntime)
        assert built.captures == ("python3",)
    finally:
        NAMED.pop("fake", None)


def test_register_runtime_refuses_a_builtin_name():
    assert {"monty", "workspace", "remote"} <= BUILTIN_RUNTIMES
    with pytest.raises(ValueError, match="shadows a builtin"):
        register_runtime("monty", FakeRuntime)
    with pytest.raises(ValueError, match="shadows a builtin"):
        register_runtime("remote", FakeRuntime)


def test_register_runtime_replaces_a_custom_name():
    class Other(FakeRuntime):
        name = "fake"

    try:
        register_runtime("fake", FakeRuntime)
        register_runtime("fake", Other)
        assert isinstance(build_runtime("fake"), Other)
    finally:
        NAMED.pop("fake", None)


class Named(Runtime):
    def __init__(self, name: str, *captures: str) -> None:
        super().__init__(captures=captures)
        self.name = name


def test_shadowed_captures_names_each_capture_an_earlier_entry_wins():
    entries = [
        Named("e2b", "@external", "gcc"),
        Named("docker", "gcc", "@external", "make"),
        Named("box", "@line"),
        Named("other", "@line"),
        WorkspaceRuntime(),
    ]
    assert shadowed_captures(entries) == [
        ("gcc", "e2b", "docker"),
        ("@external", "e2b", "docker"),
        ("@line", "box", "other"),
    ]
    assert shadowed_captures([Named("a", "x"), Named("b", "y")]) == []


class _Unhashable(FakeRuntime):
    __hash__ = None  # type: ignore[assignment]


def test_a_runtime_built_by_name_need_not_be_hashable():
    try:
        register_runtime("unhashable", _Unhashable)
        built = build_runtime("unhashable")
        assert built_from(built) == "unhashable"
        assert built_from(_Unhashable()) is None
    finally:
        NAMED.pop("unhashable", None)
