import asyncio

import pytest

from mirage.policy.constants import DEFAULT_ASK_REASON, DEFAULT_DENY_REASON
from mirage.policy.script import (_POLICY_READ, HOOKS, ScriptPolicy,
                                  defined_hooks, hook_call, hook_name,
                                  hook_probe, ops_script_context,
                                  script_action, script_context,
                                  session_script_context)
from mirage.policy.types import (Ask, CommandContext, Deny, DenyScope,
                                 OpsContext, ProfileScript, SessionContext)
from mirage.runtime.errors import EvalError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.types import (EvalResult, EvalValue, RunArgs, RunResult,
                                  ScriptSource)
from mirage.types import PathSpec

DENY_ANSWER = {"deny": "sealed"}


class FakeRegistry:
    """The one registry question a CommandContext carries."""

    def is_mount_root(self, path: str) -> bool:
        return False


class FakeEngine(EvaluatorMixin):
    """Stands in for a built engine, recording what it saw."""

    built: list["FakeEngine"] = []

    def __init__(
        self,
        value: EvalValue = None,
        error: Exception | None = None,
        delay: float = 0.0,
        hooks: tuple[str, ...] = ("pre_command", )) -> None:
        self.value = value
        self.error = error
        self.delay = delay
        self.hooks = hooks
        self.seen: dict[str, EvalValue] = {}
        self.code = ""
        self.evals = 0
        self.closed = False
        FakeEngine.built.append(self)

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        self.code = code
        self.seen = dict(inputs or {})
        self.evals += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        # The probe asks which hooks the program defines; every other
        # evaluation ends in a hook call and gets the configured answer.
        if not code.rstrip().endswith("(ctx)"):
            return EvalResult(value=list(self.hooks))
        return EvalResult(value=self.value)

    async def close(self) -> None:
        self.closed = True


class FakeLanguageEngine(LanguageRuntime, EvaluatorMixin):
    """An interpreter engine, recording the doors it was attached to."""

    language = "python"
    name = "fake"

    def __init__(self) -> None:
        super().__init__()
        self.attached: tuple[object, object] | None = None

    def attach(self, dispatch, resolver) -> None:
        self.attached = (dispatch, resolver)

    async def run(self, args: RunArgs) -> RunResult:
        raise NotImplementedError

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        # A program defining the command hook alone, silent when called.
        if not code.rstrip().endswith("(ctx)"):
            return EvalResult(value=["pre_command"])
        return EvalResult(value=None)

    async def close(self) -> None:
        pass


async def _door(op, path, **kwargs):
    raise AssertionError("the door is attached, never called here")


class OneScript:
    """A sessions query holding one script for every known session."""

    def __init__(self, entry: ProfileScript | None) -> None:
        self.entry = entry

    def script_of(self, session_id: str) -> ProfileScript | None:
        return self.entry


class ScriptsBySession:
    """A sessions query holding one script per session."""

    def __init__(self, entries: dict[str, ProfileScript]) -> None:
        self.entries = entries

    def script_of(self, session_id: str) -> ProfileScript | None:
        return self.entries.get(session_id)


@pytest.fixture(autouse=True)
def _reset_built():
    FakeEngine.built = []


def _entry(runtime: str = "monty") -> ProfileScript:
    return ProfileScript(profile="release",
                         script=ScriptSource("SOURCE"),
                         runtime=runtime)


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory="/",
                    resource_path=virtual.lstrip("/"),
                    raw_path=virtual)


def _ctx(command: str = "cat", session_id: str = "s") -> CommandContext:
    return CommandContext(command=command,
                          paths=(_path("/repo/sealed/k"), ),
                          argv=("/repo/sealed/k", ),
                          cwd="/repo",
                          registry=FakeRegistry(),
                          operands=(_path("/repo/sealed/k"), ),
                          session_id=session_id,
                          agent_id="agent-1",
                          tokens=(command, "/repo/sealed/k"),
                          program=(command, ))


def _mounts() -> list[str]:
    return ["/repo/", "/scratch/"]


def _policy(
    value: EvalValue = None,
    error: Exception | None = None,
    delay: float = 0.0,
    entry: ProfileScript | None = None,
    hooks: tuple[str, ...] = ("pre_command", )
) -> ScriptPolicy:
    policy = ScriptPolicy(OneScript(entry if entry is not None else _entry()),
                          _mounts)
    policy._engines["monty"] = FakeEngine(value, error, delay, hooks)
    return policy


def _ops_ctx(op: str = "write",
             path: str = "/scratch/frozen/f",
             write: bool = True,
             session_id: str = "s") -> OpsContext:
    return OpsContext(op=op,
                      path=_path(path),
                      write=write,
                      prefix="/scratch",
                      session_id=session_id)


def _session_ctx(key: str = "AWS_KEY",
                 session_id: str = "s") -> SessionContext:
    return SessionContext(plane="env",
                          verb="set",
                          key=key,
                          value="v",
                          session_id=session_id)


def test_script_context_is_the_command_context_as_data():
    ctx = script_context("release", _ctx(), _mounts())
    assert ctx == {
        "profile": "release",
        "command": {
            "name": "cat",
            "argv": ["/repo/sealed/k"],
            "tokens": ["cat", "/repo/sealed/k"],
            "program": ["cat"],
            "paths": ["/repo/sealed/k"],
            "operands": ["/repo/sealed/k"],
            "tool": True,
            "walks": False,
        },
        "session": {
            "id": "s",
            "agent": "agent-1",
            "cwd": "/repo",
        },
        "mounts": ["/repo/", "/scratch/"],
    }


@pytest.mark.parametrize("value", [None, "allow"])
def test_allow_and_silence_are_no_opinion(value):
    assert script_action(value) is None


def test_a_deny_answer_becomes_a_whole_command_deny():
    action = script_action({"deny": "sealed"})
    assert action == Deny("sealed", DenyScope.COMMAND)


def test_an_ask_answer_goes_to_the_approval_door():
    action = script_action({"ask": "sign-off"})
    assert action == Ask("sign-off")
    assert action.rule is None


def test_bare_verbs_carry_the_documents_default_reasons():
    assert script_action("deny") == Deny(DEFAULT_DENY_REASON)
    assert script_action("ask") == Ask(DEFAULT_ASK_REASON)


@pytest.mark.parametrize("value", [
    [1, 2],
    7,
    "nope",
    {},
    {
        "deny": ""
    },
    {
        "deny": 3
    },
    {
        "allow": True
    },
    {
        "deny": "a",
        "ask": "b"
    },
])
def test_anything_else_is_refused(value):
    with pytest.raises(ValueError, match="must answer allow, deny or ask"):
        script_action(value)


@pytest.mark.asyncio
async def test_a_session_without_a_script_is_not_judged():
    policy = ScriptPolicy(OneScript(None), _mounts)
    assert await policy.pre_command(_ctx()) is None
    assert FakeEngine.built == []


@pytest.mark.asyncio
async def test_the_policy_is_shown_the_commands_facts_and_its_hook_is_called():
    policy = _policy(None)
    assert await policy.pre_command(_ctx()) is None
    engine = FakeEngine.built[0]
    # The program whole, then the call to the hook it defines, so its
    # return is the value the evaluator hands back.
    assert engine.code == "SOURCE\n\npre_command(ctx)\n"
    assert engine.seen == {"ctx": script_context("release", _ctx(), _mounts())}


def test_the_hook_is_called_in_the_programs_own_language():
    py, js = ScriptSource("x"), ScriptSource("x", language="js")
    assert hook_call(py, "pre_command") == "pre_command(ctx)"
    assert hook_call(js, "pre_command") == "preCommand(ctx)"
    assert hook_call(py, "pre_ops") == "pre_ops(ctx)"
    assert hook_call(js, "pre_ops") == "preOps(ctx)"
    assert hook_name(py, "pre_session") == "pre_session"
    assert hook_name(js, "pre_session") == "preSession"


@pytest.mark.asyncio
async def test_a_deny_it_computed_refuses_the_command():
    policy = _policy(DENY_ANSWER)
    assert await policy.pre_command(_ctx()) == Deny("sealed")


@pytest.mark.asyncio
async def test_an_ask_it_computed_reaches_the_door():
    policy = _policy({"ask": "sign-off"})
    assert await policy.pre_command(_ctx()) == Ask("sign-off")


@pytest.mark.asyncio
async def test_the_engine_is_built_once_and_reused():
    policy = _policy(None)
    await policy.pre_command(_ctx("cat"))
    await policy.pre_command(_ctx("ls"))
    assert len(FakeEngine.built) == 1
    # One probe for the program's hooks, then one evaluation per command.
    assert FakeEngine.built[0].evals == 3


@pytest.mark.asyncio
async def test_close_closes_the_engines():
    policy = _policy(None)
    await policy.pre_command(_ctx())
    await policy.close()
    assert FakeEngine.built[0].closed


@pytest.mark.asyncio
async def test_a_script_that_raised_fails_closed():
    # Silence on failure would run exactly the commands the script
    # existed to judge, so every failure arm refuses instead.
    policy = _policy(error=EvalError("boom"))
    action = await policy.pre_command(_ctx())
    assert action == Deny("profile 'release' policy failed: boom")


@pytest.mark.asyncio
async def test_a_syntax_error_is_named_as_one():
    policy = _policy(error=EvalError("bad token", syntax=True))
    action = await policy.pre_command(_ctx())
    assert isinstance(action, Deny)
    assert "profile 'release' policy syntax error" in action.reason


@pytest.mark.asyncio
async def test_a_script_that_timed_out_fails_closed(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.SCRIPT_EVAL_TIMEOUT_SECONDS",
                        0.01)
    policy = _policy(None, delay=0.2)
    action = await policy.pre_command(_ctx())
    assert isinstance(action, Deny)
    assert "profile 'release' policy timed out" in action.reason


@pytest.mark.asyncio
async def test_a_wrong_answer_shape_fails_closed():
    policy = _policy([1, 2])
    action = await policy.pre_command(_ctx())
    assert isinstance(action, Deny)
    assert "profile 'release' policy must answer" in action.reason


def _no_engine(script: ScriptSource, runtime: str) -> FakeEngine:
    raise ValueError(f"script names runtime {runtime!r}: nope")


@pytest.mark.asyncio
async def test_an_engine_it_cannot_build_fails_closed(monkeypatch):
    monkeypatch.setattr("mirage.policy.script.script_engine", _no_engine)
    policy = ScriptPolicy(OneScript(_entry("ghost")), _mounts)
    action = await policy.pre_command(_ctx())
    assert isinstance(action, Deny)
    assert action.reason == "profile 'release' policy names runtime " \
                            "'ghost': nope"


@pytest.mark.asyncio
async def test_a_wired_policy_attaches_the_doors_to_the_engine(monkeypatch):
    # The facts name the path; the engine opens it. Attached before the
    # first evaluation, as Runtimes attaches an agent's engine, so the
    # script's open() reads the mounts through the same door.
    engine = FakeLanguageEngine()
    monkeypatch.setattr("mirage.policy.script.script_engine",
                        lambda script, runtime: engine)
    resolver = PrefixResolver(lambda: ["/repo/"])
    marked: list[bool] = []

    async def door(op, path, **kwargs):
        marked.append(_POLICY_READ.get())
        return None, None

    policy = ScriptPolicy(OneScript(_entry()),
                          _mounts,
                          dispatch=door,
                          resolver=resolver)
    assert await policy.pre_command(_ctx()) is None
    assert engine.attached is not None
    dispatch, attached = engine.attached
    assert attached is resolver
    # The door is the workspace's, reached through the policy's own
    # wrapper, which marks the op as the policy's read for as long as it
    # runs so the policy's pre_ops lets it through; outside the call the
    # mark is down.
    await dispatch("read", _path("/repo/sealed/k"))
    assert marked == [True]
    assert _POLICY_READ.get() is False


@pytest.mark.asyncio
async def test_a_bare_policy_attaches_nothing(monkeypatch):
    # Outside a workspace there is no door to hand over, and the
    # engine is left as built: its scripts see no file.
    engine = FakeLanguageEngine()
    monkeypatch.setattr("mirage.policy.script.script_engine",
                        lambda script, runtime: engine)
    policy = ScriptPolicy(OneScript(_entry()), _mounts)
    assert await policy.pre_command(_ctx()) is None
    assert engine.attached is None


def test_dispatch_and_resolver_travel_together():
    with pytest.raises(ValueError, match="travel together"):
        ScriptPolicy(OneScript(None), _mounts, dispatch=_door)
    with pytest.raises(ValueError, match="travel together"):
        ScriptPolicy(OneScript(None),
                     _mounts,
                     resolver=PrefixResolver(lambda: []))


def test_ops_script_context_is_the_op_context_as_data():
    assert ops_script_context("release", _ops_ctx(), _mounts()) == {
        "profile": "release",
        "op": {
            "name": "write",
            "path": "/scratch/frozen/f",
            "write": True,
            "prefix": "/scratch",
        },
        "session": {
            "id": "s"
        },
        "mounts": ["/repo/", "/scratch/"],
    }


def test_session_script_context_is_the_session_context_as_data():
    assert session_script_context("release", _session_ctx(), _mounts()) == {
        "profile": "release",
        "write": {
            "plane": "env",
            "verb": "set",
            "key": "AWS_KEY",
            "value": "v",
        },
        "session": {
            "id": "s"
        },
        "mounts": ["/repo/", "/scratch/"],
    }


def test_the_probe_asks_for_every_hook_in_the_programs_own_language():
    probe = hook_probe(ScriptSource("x"))
    for name in HOOKS:
        assert f"try:\n    {name}\n" in probe
    assert probe.endswith("_mirage_hooks")
    js = hook_probe(ScriptSource("x", language="js"))
    for name in HOOKS.values():
        assert f"typeof {name}" in js


def test_defined_hooks_reads_the_probes_answer_in_python_spelling():
    assert defined_hooks(ScriptSource("x"), ["pre_ops"]) == {"pre_ops"}
    assert defined_hooks(
        ScriptSource("x", language="js"),
        ["preCommand", "preSession"]) == {"pre_command", "pre_session"}
    assert defined_hooks(ScriptSource("x"), []) == frozenset()


@pytest.mark.parametrize("value", [None, "pre_ops", ["nope"], [1]])
def test_defined_hooks_refuses_anything_else(value):
    with pytest.raises(ValueError, match="hook probe answered"):
        defined_hooks(ScriptSource("x"), value)


@pytest.mark.parametrize("hook", ["pre_ops", "pre_session"])
def test_an_op_or_session_hook_may_not_ask(hook):
    # The op and session doors cannot wait on a host, so the vocabulary
    # there is allow or deny, and an ask is a wrong answer.
    assert script_action({"deny": "frozen"}, hook) == Deny("frozen")
    assert script_action("deny", hook) == Deny(DEFAULT_DENY_REASON)
    assert script_action(None, hook) is None
    for value in ("ask", {"ask": "nod"}):
        with pytest.raises(ValueError, match="must answer allow or deny"):
            script_action(value, hook)


@pytest.mark.asyncio
async def test_a_hook_the_program_leaves_out_is_silence_without_an_evaluation(
):
    # The probe found pre_command alone, so the op and session doors
    # cost no evaluation: a program that judges commands is not charged
    # per op for a hook it never wrote.
    policy = _policy(DENY_ANSWER)
    assert await policy.pre_ops(_ops_ctx()) is None
    assert await policy.pre_session(_session_ctx()) is None
    assert FakeEngine.built[0].evals == 1
    assert await policy.pre_command(_ctx()) == Deny("sealed")
    assert FakeEngine.built[0].evals == 2


@pytest.mark.asyncio
async def test_an_op_hook_it_defines_judges_the_op_with_its_facts():
    policy = _policy({"deny": "frozen"}, hooks=("pre_ops", ))
    assert await policy.pre_ops(_ops_ctx()) == Deny("frozen")
    engine = FakeEngine.built[0]
    assert engine.code == "SOURCE\n\npre_ops(ctx)\n"
    assert engine.seen == {
        "ctx": ops_script_context("release", _ops_ctx(), _mounts())
    }
    # The command door, which the program leaves out, is silence.
    assert await policy.pre_command(_ctx()) is None


@pytest.mark.asyncio
async def test_a_session_hook_it_defines_judges_the_write_with_its_facts():
    policy = _policy("deny", hooks=("pre_session", ))
    assert await policy.pre_session(_session_ctx()
                                    ) == Deny(DEFAULT_DENY_REASON)
    engine = FakeEngine.built[0]
    assert engine.code == "SOURCE\n\npre_session(ctx)\n"
    assert engine.seen == {
        "ctx": session_script_context("release", _session_ctx(), _mounts())
    }


@pytest.mark.asyncio
async def test_an_ask_from_an_op_hook_fails_closed():
    # Refused here, in the policy's own words, before the seam could see
    # it as a programming error.
    policy = _policy({"ask": "nod"}, hooks=("pre_ops", ))
    action = await policy.pre_ops(_ops_ctx())
    assert isinstance(action, Deny)
    assert "profile 'release' policy must answer allow or deny" in \
        action.reason


@pytest.mark.asyncio
async def test_a_program_defining_no_hook_fails_closed_at_every_door():
    policy = _policy(None, hooks=())
    for action in (await policy.pre_command(_ctx()), await
                   policy.pre_ops(_ops_ctx()), await
                   policy.pre_session(_session_ctx())):
        assert action == Deny("profile 'release' policy defines no hook: "
                              "pre_command, pre_ops or pre_session")
    # One probe; nothing else was evaluated.
    assert FakeEngine.built[0].evals == 1


@pytest.mark.asyncio
async def test_the_no_hook_refusal_speaks_the_programs_language():
    entry = ProfileScript(profile="release",
                          script=ScriptSource("x", language="js"),
                          runtime="quickjs")
    policy = ScriptPolicy(OneScript(entry), _mounts)
    policy._engines["quickjs"] = FakeEngine(None, hooks=())
    assert await policy.pre_command(_ctx()) == Deny(
        "profile 'release' policy defines no hook: preCommand, preOps or "
        "preSession")


@pytest.mark.asyncio
async def test_the_probe_runs_once_per_program():
    policy = _policy(None, hooks=("pre_ops", ))
    await policy.pre_ops(_ops_ctx())
    await policy.pre_ops(_ops_ctx("read", write=False))
    await policy.pre_command(_ctx())
    # The probe, then two op judgments; the command door was silence.
    assert FakeEngine.built[0].evals == 3


@pytest.mark.asyncio
async def test_the_hook_set_is_remembered_per_language():
    # One text, two programs: the probe asks in each language's own
    # spelling, so what it found in one says nothing about the other.
    # Here the js probe finds no hook and the python probe finds one.
    text = "pre_command = 1"
    policy = ScriptPolicy(
        ScriptsBySession({
            "j":
            ProfileScript(profile="j",
                          script=ScriptSource(text, language="js"),
                          runtime="quickjs"),
            "p":
            ProfileScript(profile="p",
                          script=ScriptSource(text),
                          runtime="monty"),
        }), _mounts)
    policy._engines["quickjs"] = FakeEngine(None, hooks=())
    policy._engines["monty"] = FakeEngine(None, hooks=("pre_command", ))
    assert await policy.wants_for("pre_session", "j") is True
    assert await policy.wants_for("pre_session", "p") is False


@pytest.mark.asyncio
async def test_the_policys_own_read_is_not_judged_by_its_op_hook():
    # The mark the reading door raises is what pre_ops reads first, so a
    # read the engine issues never re-enters the evaluation waiting on
    # it; the same op from anyone else is judged.
    policy = _policy({"deny": "frozen"}, hooks=("pre_ops", ))
    token = _POLICY_READ.set(True)
    try:
        assert await policy.pre_ops(_ops_ctx("read", write=False)) is None
    finally:
        _POLICY_READ.reset(token)
    assert FakeEngine.built[0].evals == 0
    assert await policy.pre_ops(_ops_ctx("read",
                                         write=False)) == Deny("frozen")


@pytest.mark.asyncio
async def test_wants_for_says_which_sessions_a_hook_speaks_for():
    # The per-session refinement the secret fill asks: the door is
    # overridden for everyone, but speaks only for a session whose
    # program defines the hook.
    policy = _policy(None, hooks=("pre_command", ))
    assert await policy.wants_for("pre_command", "s") is True
    assert await policy.wants_for("pre_session", "s") is False
    assert await policy.wants_for("pre_ops", "s") is False
    assert await policy.wants_for("post_ops", "s") is False
    assert await ScriptPolicy(OneScript(None),
                              _mounts).wants_for("pre_session", "s") is False


@pytest.mark.asyncio
async def test_wants_for_counts_a_program_the_door_will_refuse():
    # No hook at all, or a probe that failed: the door refuses every
    # write for this program, which is speaking.
    assert await _policy(None, hooks=()).wants_for("pre_session", "s") is True
    broken = _policy(error=EvalError("boom"))
    assert await broken.wants_for("pre_session", "s") is True
