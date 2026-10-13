import asyncio
import json

import pytest

from mirage.commands.spec.types import WordKind
from mirage.policy.constants import (
    CTX_ENV,
    DEFAULT_ASK_REASON,
    DEFAULT_DENY_REASON,
    PROGRAM_MEMORY,
)
from mirage.policy.policies import Policies
from mirage.policy.script import (
    _POLICY_READ,
    ScriptPolicy,
    script_action,
    script_context,
)
from mirage.policy.types import (
    Ask,
    CommandContext,
    CommandWord,
    Deny,
    ProfileScript,
    Route,
    RouteContext,
    SessionContext,
    VfsContext,
)
from mirage.runtime.binding import RuntimeContext, WorkspaceBinding
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.resolver import MountResolver, PrefixResolver
from mirage.runtime.types import (
    CodeExecution,
    DispatchFn,
    ExecutionRequest,
    RunArgs,
    RunResult,
    ScriptSource,
)
from mirage.shell.variable import ShellValue, VarAttr
from mirage.types import PathSpec
from mirage.view.types import MountView, NamespaceView, SessionView
from mirage.workspace.dispatcher.constants import CALLS


class FakeProgram(LanguageRuntime):
    """Stands in for a policy runtime, recording each run it was handed."""

    language = "python"
    name = "fake"
    built: list["FakeProgram"] = []

    def __init__(
        self,
        stdout: bytes = b"",
        exit_code: int = 0,
        stderr: bytes | None = None,
        delay: float = 0.0,
    ) -> None:
        super().__init__()
        self.stdout = stdout
        self.exit_code = exit_code
        self.stderr = stderr
        self.delay = delay
        self.requests: list[CodeExecution] = []
        self.attached: tuple[DispatchFn, MountResolver] | None = None
        self.closed = False
        FakeProgram.built.append(self)

    def bind(self, binding: WorkspaceBinding) -> None:
        super().bind(binding)
        self.attached = (binding.dispatch, binding.resolver)

    async def execute(
        self, request: ExecutionRequest, context: RuntimeContext | None = None
    ) -> RunResult:
        assert isinstance(request, CodeExecution)
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        return RunResult(
            stdout=self.stdout, stderr=self.stderr, exit_code=self.exit_code
        )

    async def run(self, args: RunArgs) -> RunResult:
        raise NotImplementedError

    async def close(self) -> None:
        self.closed = True


class Programs:
    """A sessions query holding the same programs for every session."""

    def __init__(self, scripts: dict[str, tuple[ProfileScript, ...]]) -> None:
        self.scripts = scripts

    def scripts_of(
        self, session_id: str
    ) -> dict[str, tuple[ProfileScript, ...]]:
        return self.scripts


class ProgramsBySession:
    """A sessions query holding programs per session."""

    def __init__(
        self, scripts: dict[str, dict[str, tuple[ProfileScript, ...]]]
    ) -> None:
        self.scripts = scripts

    def scripts_of(
        self, session_id: str
    ) -> dict[str, tuple[ProfileScript, ...]]:
        return self.scripts.get(session_id, {})


@pytest.fixture(autouse=True)
def _reset_built():
    FakeProgram.built = []


def _answer(**fields: str) -> bytes:
    return json.dumps(fields).encode()


def _entry(
    runtime: str = "monty", source: str = "SOURCE", config: dict | None = None
) -> ProfileScript:
    return ProfileScript(
        profile="release",
        script=ScriptSource(source),
        runtime=runtime,
        config=config or {},
    )


def _path(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


async def _refused(
    name: str,
    *args: ShellValue | VarAttr | bool | None,
    **kwargs: bool | frozenset[int | str] | str | None,
) -> None:
    raise PermissionError(f"{name}: read only")


def _session(cwd: str = "/data") -> SessionView:
    env = {"TEAM": "core", "HOME": "/home/agent"}
    return SessionView(
        get=env.get,
        snapshot=lambda: dict(env),
        set=_refused,
        unset=_refused,
        mark=_refused,
        is_readonly=lambda name, follow_ref=True: name == "HOME",
        profile=lambda: "reviewer",
        cwd=lambda: cwd,
    )


def _ns() -> NamespaceView:
    return NamespaceView(
        mounts=MountView(
            descendants=lambda path: ["/data", "/vault"],
            visible_descendants=lambda path: ["/data"],
            is_root=lambda path: path in ("/data", "/vault"),
            root_of=lambda path: "/data",
        )
    )


def _ctx(
    command: str = "cat",
    session_id: str = "s",
    session: SessionView | None = None,
    ns: NamespaceView | None = None,
) -> CommandContext:
    return CommandContext(
        command=command,
        paths=(_path("/repo/sealed/k"),),
        argv=("/repo/sealed/k",),
        cwd="/repo",
        line=f"{command} /repo/sealed/k",
        words=(
            CommandWord(command, WordKind.NAME),
            CommandWord(
                "/repo/sealed/k",
                WordKind.OPERAND,
                path=_path("/repo/sealed/k"),
            ),
        ),
        session_id=session_id,
        tokens=(command, "/repo/sealed/k"),
        program=(command,),
        session=session,
        ns=ns,
    )


def _ops_ctx(
    op: str = "write", path: str = "/scratch/frozen/f", write: bool = True
) -> VfsContext:
    return VfsContext(
        call=CALLS[op],
        path=_path(path),
        write=write,
        prefix="/scratch",
        session_id="s",
    )


def _session_ctx(key: str = "AWS_KEY") -> SessionContext:
    return SessionContext(verb="set", key=key, value="v", session_id="s")


def _key(entry: ProfileScript) -> tuple[str, str]:
    """The engine a program runs on, as the policy keys it: its runtime
    and its settings with the default memory cap."""
    config = {"max_memory": PROGRAM_MEMORY.get(entry.runtime), **entry.config}
    return entry.runtime, json.dumps(config, sort_keys=True)


def _policy(
    method: str = "pre_command",
    *engines: FakeProgram,
    entries: tuple[ProfileScript, ...] | None = None,
) -> ScriptPolicy:
    programs = entries if entries is not None else (_entry(),) * len(engines)
    policy = ScriptPolicy(Programs({method: programs}))
    for entry, engine in zip(programs, engines, strict=False):
        policy._engines.setdefault(_key(entry), engine)
    return policy


def test_nothing_printed_is_no_opinion():
    assert script_action(b"", "pre_command") is None
    assert script_action(b"  \n", "pre_command") is None
    assert script_action(b"null\n", "pre_command") is None


def test_a_deny_or_an_ask_is_read_with_its_reason():
    assert script_action(_answer(kind="deny", reason="no"), "pre_vfs") == Deny(
        "no"
    )
    assert script_action(_answer(kind="ask", reason="nod"), "pre_vfs") == Ask(
        "nod"
    )


def test_a_reason_left_out_is_the_documents_default():
    for printed in (_answer(kind="deny"), _answer(kind="deny", reason="")):
        assert script_action(printed, "pre_command") == Deny(
            DEFAULT_DENY_REASON
        )
    for printed in (_answer(kind="ask"), _answer(kind="ask", reason="")):
        assert script_action(printed, "pre_command") == Ask(DEFAULT_ASK_REASON)


def test_a_route_places_the_line_at_pre_execute_only():
    printed = _answer(kind="route", runtime="docker")
    assert script_action(printed, "pre_execute") == Route("docker")
    with pytest.raises(ValueError, match="cannot answer route at pre_command"):
        script_action(printed, "pre_command")


@pytest.mark.parametrize(
    "printed",
    [
        b"deny",
        b'"deny"',
        b'{"deny": "x"}',
        b'{"kind": "allow"}',
        b'{"kind": "route"}',
        b'{"kind": "deny", "runtime": "docker"}',
        b'{"kind": "deny", "reason": "x", "policy": "Mine"}',
        b'{"kind": "deny"}\n{"kind": "ask"}',
    ],
)
def test_anything_else_is_refused(printed):
    with pytest.raises(ValueError, match="must print a JSON answer"):
        script_action(printed, "pre_execute")


def test_a_context_reads_as_its_fields_with_the_session_as_data():
    data = script_context(_ctx(session=_session(), ns=_ns()))
    assert data["command"] == "cat"
    assert data["line"] == "cat /repo/sealed/k"
    assert data["paths"] == ["/repo/sealed/k"]
    assert data["words"] == [
        {"text": "cat", "kind": "name", "option": None, "path": None},
        {
            "text": "/repo/sealed/k",
            "kind": "operand",
            "option": None,
            "path": "/repo/sealed/k",
        },
    ]
    assert data["session_id"] == "s"
    assert "agent_id" not in data
    assert data["cwd"] == "/data"
    assert data["env"] == {"TEAM": "core", "HOME": "/home/agent"}
    assert data["profile"] == "reviewer"
    assert data["mounts"] == ["/data"]
    assert not {"session", "ns", "vfs"} & set(data)
    json.dumps(data)


def test_a_line_lists_each_command_as_pre_command_reads_it():
    line = RouteContext(
        line="cat /repo/sealed/k",
        commands=(_ctx(session=_session()),),
        session_id="s",
        session=_session(),
    )
    data = script_context(line)
    assert data["line"] == "cat /repo/sealed/k"
    assert [c["command"] for c in data["commands"]] == ["cat"]
    assert "session" not in data["commands"][0]
    assert data["cwd"] == "/data"


def test_an_op_and_a_variable_write_read_as_their_fields():
    op = script_context(_ops_ctx())
    assert op["call"]["name"] == "write"
    assert op["call"]["effect"] == "write"
    assert op["path"] == "/scratch/frozen/f"
    assert op["write"] is True
    assert op["cwd"] == "/" and op["env"] == {} and op["mounts"] == []
    written = script_context(_session_ctx())
    assert (written["verb"], written["key"], written["value"]) == (
        "set",
        "AWS_KEY",
        "v",
    )


@pytest.mark.asyncio
async def test_a_method_without_a_program_runs_nothing():
    engine = FakeProgram(_answer(kind="deny"))
    policy = _policy("pre_command", engine)
    assert await policy.pre_vfs(_ops_ctx()) is None
    assert await policy.pre_session(_session_ctx()) is None
    assert engine.requests == []


@pytest.mark.asyncio
async def test_a_program_runs_unedited_with_its_context_in_the_env_and_stdin():
    engine = FakeProgram(_answer(kind="deny", reason="sealed"))
    policy = _policy("pre_command", engine)
    ctx = _ctx(session=_session(cwd="/"), ns=_ns())
    assert await policy.pre_command(ctx) == (Deny("sealed"),)
    [request] = engine.requests
    assert request.code == "SOURCE"
    assert request.language == "python"
    assert request.cwd.virtual == "/"
    payload = request.env[CTX_ENV]
    assert json.loads(payload) == script_context(ctx)
    assert request.stdin == payload.encode()
    assert request.env == {CTX_ENV: payload}
    assert json.loads(payload)["env"]["TEAM"] == "core"
    assert request.flags == {}


@pytest.mark.asyncio
async def test_a_program_on_wasi_keeps_the_sessions_directory_off_its_path():
    engine = FakeProgram()
    policy = _policy("pre_command", engine, entries=(_entry("wasi"),))
    await policy.pre_command(_ctx(session=_session(cwd="/data")))
    assert engine.requests[0].flags == {"P": True}


def _programs(method: str, *printed: bytes) -> ScriptPolicy:
    """A policy whose programs at ``method`` print ``printed`` in order,
    each on its own runtime."""
    entries = tuple(
        _entry("monty", config={"n": str(i)}) for i in range(len(printed))
    )
    policy = ScriptPolicy(Programs({method: entries}))
    for entry, out in zip(entries, printed, strict=True):
        policy._engines[_key(entry)] = FakeProgram(out)
    return policy


def _line() -> RouteContext:
    return RouteContext(line="python3 job.py", commands=(), session_id="s")


@pytest.mark.asyncio
async def test_each_answer_is_returned_in_order_up_to_the_first_deny():
    policy = _programs(
        "pre_command",
        b"",
        _answer(kind="ask", reason="nod"),
        _answer(kind="deny", reason="no"),
        _answer(kind="ask", reason="late"),
    )
    assert await policy.pre_command(_ctx()) == (Ask("nod"), Deny("no"))
    assert [len(e.requests) for e in policy._engines.values()] == [1, 1, 1, 0]


@pytest.mark.asyncio
async def test_the_chain_reads_each_answer_as_its_own_policys():
    denies = _programs(
        "pre_command",
        _answer(kind="ask", reason="nod"),
        _answer(kind="deny", reason="no"),
    )
    action = await Policies([denies]).pre_command(_ctx())
    assert isinstance(action, Deny) and action.reason == "no"
    asks = _programs("pre_vfs", b"", _answer(kind="ask", reason="nod"))
    action = await Policies([asks]).pre_vfs(_ops_ctx())
    assert isinstance(action, Ask) and action.reason == "nod"


@pytest.mark.asyncio
async def test_an_ask_and_a_route_both_stand():
    policy = _programs(
        "pre_execute",
        _answer(kind="ask", reason="nod"),
        _answer(kind="route", runtime="docker"),
    )
    said, route = await Policies([policy]).pre_execute(_line())
    assert isinstance(said, Ask) and said.reason == "nod"
    assert route is not None and route.runtime == "docker"


@pytest.mark.asyncio
async def test_routes_must_agree():
    agree = _programs(
        "pre_execute",
        _answer(kind="route", runtime="docker"),
        _answer(kind="route", runtime="docker"),
    )
    said, route = await Policies([agree]).pre_execute(_line())
    assert said is None
    assert route is not None and route.runtime == "docker"
    differ = _programs(
        "pre_execute",
        _answer(kind="route", runtime="docker"),
        _answer(kind="route", runtime="monty"),
    )
    said, route = await Policies([differ]).pre_execute(_line())
    assert route is None
    assert isinstance(said, Deny)
    assert said.reason == (
        "policies place the line on different runtimes: "
        "ScriptPolicy on docker, ScriptPolicy on monty"
    )


@pytest.mark.asyncio
async def test_a_program_that_exits_non_zero_fails_closed():
    policy = _policy("pre_command", FakeProgram(b"", 3, b"Traceback"))
    assert await policy.pre_command(_ctx()) == (
        Deny("profile 'release' policy exited 3"),
    )


@pytest.mark.asyncio
async def test_a_program_that_timed_out_fails_closed(monkeypatch):
    monkeypatch.setattr(
        "mirage.policy.script.SCRIPT_EVAL_TIMEOUT_SECONDS", 0.01
    )
    policy = _policy("pre_command", FakeProgram(delay=1.0))
    assert await policy.pre_command(_ctx()) == (
        Deny("profile 'release' policy timed out after 0.01s"),
    )


@pytest.mark.asyncio
async def test_a_wrong_answer_fails_closed():
    policy = _policy("pre_command", FakeProgram(b'{"deny": "x"}'))
    [action] = await policy.pre_command(_ctx()) or ()
    assert isinstance(action, Deny)
    assert action.reason.startswith(
        "profile 'release' policy must print a JSON answer at pre_command"
    )


@pytest.mark.asyncio
async def test_a_runtime_policies_do_not_run_on_fails_closed():
    policy = ScriptPolicy(Programs({"pre_command": (_entry("quickjs"),)}))
    assert await policy.pre_command(_ctx()) == (
        Deny(
            "profile 'release' policy names runtime 'quickjs'; a policy "
            "program runs on monty or wasi"
        ),
    )


def _no_engine(script, runtime, config):
    raise ValueError(f"script names runtime {runtime!r}: nope")


@pytest.mark.asyncio
async def test_a_runtime_it_cannot_build_fails_closed(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _no_engine)
    policy = ScriptPolicy(Programs({"pre_command": (_entry("wasi"),)}))
    assert await policy.pre_command(_ctx()) == (
        Deny("profile 'release' policy names runtime 'wasi': nope"),
    )


def _fresh_engine(script, runtime, config):
    return FakeProgram()


@pytest.mark.asyncio
async def test_a_program_gets_its_runtimes_memory_cap_unless_it_names_one(
    monkeypatch,
):
    settings: list[dict] = []

    def recording(script, runtime, config):
        settings.append(dict(config))
        return FakeProgram()

    monkeypatch.setattr("mirage.policy.script.script_engine", recording)
    entries = (
        _entry("monty"),
        _entry("wasi", config={"home": "/a"}),
        _entry("wasi", config={"home": "/a", "max_memory": "1G"}),
        _entry("monty", config={"max_memory": None}),
    )
    policy = ScriptPolicy(Programs({"pre_command": entries}))
    await policy.pre_command(_ctx())
    assert settings == [
        {"max_memory": "10M"},
        {"max_memory": "128M", "home": "/a"},
        {"max_memory": "1G", "home": "/a"},
        {"max_memory": None},
    ]


@pytest.mark.asyncio
async def test_run_answers_one_program_and_raises_what_went_wrong():
    policy = _policy(
        "pre_execute", FakeProgram(_answer(kind="route", runtime="x"))
    )
    assert await policy.run(_entry(), "pre_execute", _line()) == Route("x")
    failing = _policy("pre_execute", FakeProgram(b"", 3, b"Traceback"))
    with pytest.raises(ValueError, match="^exited 3$"):
        await failing.run(_entry(), "pre_execute", _line())


@pytest.mark.asyncio
async def test_a_runtime_is_built_once_per_name_and_settings(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _fresh_engine)
    entries = (
        _entry("wasi", config={"home": "/a"}),
        _entry("wasi", config={"home": "/a"}),
        _entry("wasi", config={"home": "/b"}),
    )
    policy = ScriptPolicy(Programs({"pre_command": entries}))
    await policy.pre_command(_ctx())
    await policy.pre_command(_ctx())
    assert len(FakeProgram.built) == 2
    assert [len(e.requests) for e in FakeProgram.built] == [4, 2]
    await policy.close()
    assert all(e.closed for e in FakeProgram.built)


@pytest.mark.asyncio
async def test_a_wired_policy_attaches_the_entry_points_to_its_runtime(
    monkeypatch,
):
    engine = FakeProgram()
    monkeypatch.setattr(
        "mirage.policy.script.script_engine",
        lambda script, runtime, config: engine,
    )
    resolver = PrefixResolver(lambda: ["/repo/"])
    marked: list[bool] = []

    async def backend(op, path, **kwargs):
        marked.append(_POLICY_READ.get())
        return None, None

    policy = ScriptPolicy(
        Programs({"pre_command": (_entry(),)}),
        dispatch=backend,
        resolver=resolver,
    )
    assert await policy.pre_command(_ctx()) is None
    assert engine.attached is not None
    dispatch, attached = engine.attached
    assert attached is resolver
    await dispatch("read", _path("/repo/sealed/k"))
    assert marked == [True]
    assert _POLICY_READ.get() is False


@pytest.mark.asyncio
async def test_a_bare_policy_attaches_nothing(monkeypatch):
    engine = FakeProgram()
    monkeypatch.setattr(
        "mirage.policy.script.script_engine",
        lambda script, runtime, config: engine,
    )
    policy = ScriptPolicy(Programs({"pre_command": (_entry(),)}))
    assert await policy.pre_command(_ctx()) is None
    assert engine.attached is None


async def _no_dispatch(op, path, **kwargs):
    return None, None


def test_dispatch_and_resolver_travel_together():
    with pytest.raises(ValueError, match="travel together"):
        ScriptPolicy(Programs({}), dispatch=_no_dispatch)
    with pytest.raises(ValueError, match="travel together"):
        ScriptPolicy(Programs({}), resolver=PrefixResolver(lambda: []))


@pytest.mark.asyncio
async def test_the_policys_own_read_is_not_judged_by_its_vfs_program():
    engine = FakeProgram(_answer(kind="deny", reason="frozen"))
    policy = _policy("pre_vfs", engine)
    token = _POLICY_READ.set(True)
    try:
        assert await policy.pre_vfs(_ops_ctx("read", write=False)) is None
    finally:
        _POLICY_READ.reset(token)
    assert engine.requests == []
    assert await policy.pre_vfs(_ops_ctx("read", write=False)) == (
        Deny("frozen"),
    )


@pytest.mark.asyncio
async def test_wants_for_says_which_sessions_a_method_speaks_for():
    policy = ScriptPolicy(
        ProgramsBySession({"s": {"pre_command": (_entry(),)}, "t": {}})
    )
    assert await policy.wants_for("pre_command", "s") is True
    assert await policy.wants_for("pre_vfs", "s") is False
    assert await policy.wants_for("pre_command", "t") is False
    assert await policy.wants_for("pre_command", "unknown") is False


@pytest.mark.asyncio
async def test_a_program_starts_in_the_sessions_directory():
    engine = FakeProgram()
    policy = _policy("pre_command", engine)
    await policy.pre_command(_ctx(session=_session(cwd="/data")))
    assert engine.requests[0].cwd.virtual == "/data"
