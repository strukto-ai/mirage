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
    NAMED,
    bind_commands,
    build_entry,
    build_runtime,
    built_from,
    known_runtimes,
    machine_bindings_for,
    placement,
    register_runtime,
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
        f"machine {entry.name!r} does not run "
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
    with pytest.raises(ValueError, match="duplicate machine: 'local'"):
        bind_commands([LocalRuntime(), LocalRuntime()])


def test_bind_commands_takes_a_remote_runtime_per_machine():
    a, b = RemoteRuntime("a"), RemoteRuntime("b", ["node"])
    assert [a.name, b.name] == ["a", "b"]
    bindings = bind_commands([a, b])
    assert (bindings["@external"], bindings["node"]) == (a, b)
    with pytest.raises(ValueError, match="duplicate machine: 'a'"):
        bind_commands([a, RemoteRuntime("a", ["node"])])


def test_every_runtime_declares_captures():
    for cls in NAMED.values():
        assert cls.captures or cls is WorkspaceRuntime


def test_machine_bindings_for_maps_only_the_named_captures():
    fake = FakeRuntime()
    bindings = machine_bindings_for([fake, WorkspaceRuntime()], "fake")
    assert bindings == {"python3": fake, "made-up": fake}


@pytest.mark.parametrize(
    ("name", "refusal"),
    [
        ("workspace", "not a machine you can select"),
        ("nope", r"unknown machine: 'nope' \(workspace machines: 'fake'\)"),
    ],
)
def test_machine_bindings_for_refuses_a_name_it_cannot_bind(name, refusal):
    with pytest.raises(ValueError, match=refusal):
        machine_bindings_for([FakeRuntime(), WorkspaceRuntime()], name)


def test_machine_bindings_for_says_none_when_there_is_no_machine():
    with pytest.raises(ValueError, match=r"\(workspace machines: none\)"):
        machine_bindings_for([WorkspaceRuntime()], "nope")


def test_machine_bindings_for_takes_no_name_a_class_is_registered_as():
    try:
        register_runtime("cpython", FakeRuntime)
        with pytest.raises(ValueError, match="unknown machine: 'cpython'"):
            machine_bindings_for(
                [FakeRuntime(), WorkspaceRuntime()], "cpython"
            )
    finally:
        NAMED.pop("cpython", None)


@pytest.mark.parametrize(
    ("spec", "cls"),
    [
        ({"provider": "in_process", "runtime": "monty"}, "MontyRuntime"),
        ({"provider": "host"}, "LocalRuntime"),
        ({"provider": "host", "sandbox": {}}, "SandlockRuntime"),
        ({"provider": "in_process", "runtime": FakeRuntime}, "FakeRuntime"),
        ({"provider": "in_process"}, None),
    ],
)
def test_build_entry_builds_the_runtime_its_provider_runs(spec, cls):
    if cls is None:
        with pytest.raises(ValueError, match="the shell's machine name"):
            build_entry("py", spec)
        return
    handle, runtime = build_entry("py", spec)
    assert (handle, type(runtime).__name__, runtime.name) == (None, cls, "py")
    assert built_from(runtime) == spec


@pytest.mark.parametrize(
    ("name", "spec", "refusal"),
    [
        ("py", {"provider": "worker"}, "unknown machine provider"),
        ("py", {"provider": "in_process", "runtime": "local"}, "runs on host"),
        ("py", {"provider": "host", "runtime": "monty"}, "not a runtime"),
        (
            "py",
            {"provider": "in_process", "runtime": "monty", "sandbox": {}},
            "only a host",
        ),
        ("py", {"provider": "host", "sandbox": None}, "must be a mapping"),
        (
            "workspace",
            {"provider": "in_process", "runtime": "monty"},
            "the shell's machine name",
        ),
        ("py", {"provider": "in_process", "runtime": "ghost"}, "unknown"),
        ("py", {"provider": "in_process", "runtime": "remote"}, "provider"),
        ("py", {"provider": "in_process", "runtime": dict}, "not a Runtime"),
    ],
)
def test_build_entry_refuses_what_its_provider_does_not_run(
    name, spec, refusal
):
    with pytest.raises(ValueError, match=refusal):
        build_entry(name, spec)


def test_build_entry_names_the_shell_workspace_alone():
    _, shell = build_entry("workspace", {"provider": "in_process"})
    assert isinstance(shell, WorkspaceRuntime)
    assert built_from(shell) == {"provider": "in_process"}


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


def test_placement_keeps_the_name_an_entry_was_built_with():
    try:
        register_runtime("fake-first", FakeRuntime)
        register_runtime("fake-second", FakeRuntime)
        _, built = build_entry(
            "py", {"provider": "in_process", "runtime": "fake-second"}
        )
        assert placement(built) == ("in_process", "fake-second")
        NAMED.pop("fake-second")
        assert placement(built) == ("in_process", "fake-second")
    finally:
        NAMED.pop("fake-first", None)
        NAMED.pop("fake-second", None)


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


def test_a_runtime_built_from_an_entry_need_not_be_hashable():
    spec = {"provider": "in_process", "runtime": "unhashable"}
    try:
        register_runtime("unhashable", _Unhashable)
        _, built = build_entry("u", spec)
        assert built_from(built) == spec
        assert built_from(_Unhashable()) is None
    finally:
        NAMED.pop("unhashable", None)
