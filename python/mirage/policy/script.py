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
import logging
from collections.abc import Callable, Mapping, Sequence
from contextvars import ContextVar
from typing import Any

from mirage.io import IOResult, OpReport
from mirage.policy.base import Policy
from mirage.policy.constants import (DEFAULT_ASK_REASON, DEFAULT_DENY_REASON,
                                     SCRIPT_EVAL_TIMEOUT_SECONDS)
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (VALIDITY, Action, Ask, CommandContext, Deny,
                                 OpsContext, ProfileScript, SessionContext,
                                 SessionScriptsQuery)
from mirage.runtime.base import Runtime
from mirage.runtime.errors import EvalError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.resolver import MountResolver
from mirage.runtime.script import eval_with_ctx, script_engine
from mirage.runtime.types import DispatchFn, EvalValue, ScriptSource
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

# The admission hooks a policy program may define, python spelling to
# JavaScript spelling. The output doors (post_ops, post_execute) stay
# coded: they answer with a Limit over a live result.
HOOKS: Mapping[str, str] = {
    "pre_command": "preCommand",
    "pre_ops": "preOps",
    "pre_session": "preSession",
}

# Set for the duration of one op the policy's own engine dispatches, so
# the policy's ``pre_ops`` lets the read through: the policy is the one
# asking, and judging its own read would re-enter the evaluation that
# is waiting on it.
_POLICY_READ: ContextVar[bool] = ContextVar("mirage_policy_read",
                                            default=False)


def script_context(profile: str, ctx: CommandContext,
                   mounts: Sequence[str]) -> dict[str, EvalValue]:
    """What a profile's policy is told about one command: the
    ``CommandContext`` the coded hooks read, as plain data.

    The same facts on both hosts, JSON-shaped because the script runs
    inside a sandboxed engine that a live object cannot cross into.
    Paths are spelled as resolved virtual paths, so a script matches
    what the command will actually touch, not what was typed; the raw
    words are in ``argv`` for a script that wants them.

    Args:
        profile (str): the profile the script speaks for.
        ctx (CommandContext): the classified command, as the gate built
            it.
        mounts (Sequence[str]): the workspace's mount prefixes.
    """
    return {
        "profile": profile,
        "command": {
            "name": ctx.command,
            "argv": list(ctx.argv),
            "tokens": list(ctx.tokens),
            "program": list(ctx.program),
            "paths": [path.virtual for path in ctx.paths],
            "operands": [path.virtual for path in ctx.operands],
            "tool": ctx.tool,
            "walks": ctx.walks,
        },
        "session": {
            "id": ctx.session_id,
            "agent": ctx.agent_id,
            "cwd": ctx.cwd,
        },
        "mounts": list(mounts),
    }


def ops_script_context(profile: str, ctx: OpsContext,
                       mounts: Sequence[str]) -> dict[str, EvalValue]:
    """What a profile's policy is told about one VFS op: the
    ``OpsContext`` the coded hooks read, as plain data.

    Args:
        profile (str): the profile the script speaks for.
        ctx (OpsContext): the op about to run, as the door built it.
        mounts (Sequence[str]): the workspace's mount prefixes.
    """
    return {
        "profile": profile,
        "op": {
            "name": ctx.op,
            "path": ctx.path.virtual,
            "write": ctx.write,
            "prefix": ctx.prefix,
        },
        "session": {
            "id": ctx.session_id
        },
        "mounts": list(mounts),
    }


def session_script_context(profile: str, ctx: SessionContext,
                           mounts: Sequence[str]) -> dict[str, EvalValue]:
    """What a profile's policy is told about one session-state write:
    the ``SessionContext`` the coded hooks read, as plain data.

    Args:
        profile (str): the profile the script speaks for.
        ctx (SessionContext): the write about to land, as the door
            built it.
        mounts (Sequence[str]): the workspace's mount prefixes.
    """
    return {
        "profile": profile,
        "write": {
            "plane": ctx.plane,
            "verb": ctx.verb,
            "key": ctx.key,
            "value": ctx.value,
        },
        "session": {
            "id": ctx.session_id
        },
        "mounts": list(mounts),
    }


def hook_name(script: ScriptSource, hook: str) -> str:
    """A hook's name in the program's own language: ``pre_ops`` in
    python, ``preOps`` in JavaScript.

    Args:
        script (ScriptSource): the policy program, carrying its
            language.
        hook (str): the hook in python spelling, a key of ``HOOKS``.
    """
    return HOOKS[hook] if script.language == "js" else hook


def hook_call(script: ScriptSource, hook: str) -> str:
    """The call that runs one of a policy's hooks, in its language's own
    spelling.

    A policy program defines the hooks it answers at, the way a coded
    Policy overrides only the hooks it cares about: ``pre_command(ctx)``
    in python, ``preCommand(ctx)`` in JavaScript, returning the verdict.
    The program is evaluated whole, with this call appended as its last
    expression, so the definitions run and the call's return is what
    the evaluator hands back.

    Args:
        script (ScriptSource): the policy program, carrying its
            language.
        hook (str): the hook in python spelling, a key of ``HOOKS``.
    """
    return f"{hook_name(script, hook)}(ctx)"


def hook_probe(script: ScriptSource) -> str:
    """The expression that lists which hooks a policy program defines.

    Appended to the program once, before its first judgment, so a hook
    the program leaves out is silence at that door rather than a call
    that fails, and the op door in particular is never charged an
    evaluation for a program that only judges commands. Spelled per
    language and in the engines' common subset: monty has neither
    ``globals()`` nor ``callable()``, so python asks each name and
    catches the NameError; JavaScript asks ``typeof``, behind a ``;``
    that ends whatever statement the program left open, since a
    bracket on the next line would otherwise index its last value. A
    name the program binds is a hook it defines, whatever it bound.

    Args:
        script (ScriptSource): the policy program, carrying its
            language.
    """
    names = [hook_name(script, hook) for hook in HOOKS]
    if script.language == "js":
        pairs = ", ".join(f"['{name}', typeof {name}]" for name in names)
        return (f";[{pairs}].filter((h) => h[1] !== 'undefined')"
                f".map((h) => h[0])")
    arms = "".join(f"try:\n    {name}\n    _mirage_hooks.append('{name}')\n"
                   f"except NameError:\n    pass\n" for name in names)
    return f"_mirage_hooks = []\n{arms}_mirage_hooks"


def defined_hooks(script: ScriptSource, value: EvalValue) -> frozenset[str]:
    """The hooks ``hook_probe`` found, in python spelling.

    Args:
        script (ScriptSource): the probed program, carrying its
            language.
        value (EvalValue): what the probe evaluated to.

    Raises:
        ValueError: the value is not a list of the probe's names. The
            message is a clause about "script", for the caller to prefix
            with whose policy it is.
    """
    spelled = {hook_name(script, hook): hook for hook in HOOKS}
    if isinstance(value, list):
        names = [
            name for name in value if isinstance(name, str) and name in spelled
        ]
        if len(names) == len(value):
            return frozenset(spelled[name] for name in names)
    raise ValueError(f"script hook probe answered {value!r}")


def script_action(value: EvalValue,
                  hook: str = "pre_command") -> Deny | Ask | None:
    """The policy answer a policy's hook returns.

    The vocabulary is the coded hook's own, spelled as data: ``None``
    or ``'allow'`` is no opinion (the command runs unless another rule
    refuses it, and can never override one that does), ``'deny'`` /
    ``{'deny': reason}`` refuses, and at ``pre_command`` alone ``'ask'``
    / ``{'ask': reason}`` takes the line to the approval door, since the
    op and session doors cannot wait on a host (``VALIDITY``). The bare
    strings carry the document's default reasons, the same ones a rule
    stating no reason gets.

    Args:
        value (EvalValue): what the script evaluated to.
        hook (str): the hook that answered, in python spelling.

    Raises:
        ValueError: the value is none of the hook's shapes. The message
            is a clause about "script", for the caller to prefix with
            whose policy it is.
    """
    asks = Ask.kind in VALIDITY[hook]
    if value is None or value == "allow":
        return None
    if value == "deny":
        return Deny(DEFAULT_DENY_REASON)
    if asks and value == "ask":
        return Ask(DEFAULT_ASK_REASON)
    if isinstance(value, Mapping) and len(value) == 1:
        verb, reason = next(iter(value.items()))
        if isinstance(reason, str) and reason:
            if verb == "deny":
                return Deny(reason)
            if asks and verb == "ask":
                return Ask(reason)
    if asks:
        raise ValueError(
            f"script must answer allow, deny or ask: None or 'allow', "
            f"'deny', 'ask', {{'deny': reason}} or {{'ask': reason}}; "
            f"got {value!r}")
    raise ValueError(f"script must answer allow or deny: None or 'allow', "
                     f"'deny' or {{'deny': reason}}; got {value!r}")


class ScriptPolicy(Policy, SessionScopedMixin):
    """Each profile's policy, enforced at the admission gates.

    The scripted twin of ``PermissionsPolicy``, registered right after
    it: where that policy evaluates the document's declarative rules,
    this one calls the profile's policy program with the same facts. A
    program defines the hooks it answers at, the way a coded Policy
    overrides only the hooks it cares about: ``pre_command`` per
    command (``script_context``), ``pre_ops`` per VFS op
    (``ops_script_context``), ``pre_session`` per env write
    (``session_script_context``). Which ones it defines is probed once
    per program (``hook_probe``), so a hook it leaves out is silence at
    that door and costs no evaluation, and a program defining none
    fails closed at every door. It reads the session's policy through
    the narrow ``SessionScriptsQuery`` by the session id the door put
    in the context, so a session whose profile states no policy costs
    one lookup and nothing else.

    Every failure fails closed: a policy that raised, timed out,
    answered with the wrong shape, defines no hook, or names an engine
    that cannot be built refuses the command, op or write with a reason
    naming the profile, and is logged. Silence on failure would run
    exactly what the policy existed to judge.

    The facts name the paths; the engine can open them. It is wired to
    the workspace's files the way an agent's runtime is (``dispatch``
    and ``resolver``, attached before its first evaluation exactly as
    ``Runtimes`` attaches an agent's engine), so a policy may read what
    an operand holds and answer for its content, not only its name. A
    read from a policy clears the op door like any other, except this
    policy's own ``pre_ops``: the policy is the one asking, and judging
    its own read would re-enter the evaluation waiting on it.

    Engines are built lazily on the first judgment that needs one,
    shared per engine name, and closed by the workspace's own close.
    Evaluations are serialized: the engines are worker processes, and
    two concurrent evals on one would interleave.

    Args:
        sessions (SessionScriptsQuery): the session manager, answering
            ``script_of(session_id)``.
        mounts (Callable[[], Sequence[str]]): the workspace's mount
            prefixes, read per evaluation so a mount added after
            construction is visible to the script.
        dispatch (DispatchFn | None): the workspace's op dispatch, the
            door a policy's ``open()`` reads the mounts through; None
            for a ScriptPolicy outside a workspace, whose programs see
            no file.
        resolver (MountResolver | None): the live mount routing table
            the dispatch is attached with. Travels with ``dispatch``:
            one without the other is refused.

    Raises:
        ValueError: ``dispatch`` and ``resolver`` were not given
            together.
    """

    def __init__(self,
                 sessions: SessionScriptsQuery,
                 mounts: Callable[[], Sequence[str]],
                 dispatch: DispatchFn | None = None,
                 resolver: MountResolver | None = None) -> None:
        if (dispatch is None) != (resolver is None):
            raise ValueError(
                "a script policy's dispatch and resolver travel together")
        self._sessions = sessions
        self._mounts = mounts
        self._dispatch = dispatch
        self._resolver = resolver
        self._engines: dict[str, Runtime] = {}
        self._defined: dict[tuple[str, str, str], frozenset[str]] = {}
        self._lock = asyncio.Lock()

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return await self._judge(
            "pre_command", ctx.session_id,
            lambda entry: script_context(entry.profile, ctx, self._mounts()))

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if _POLICY_READ.get():
            return None
        return await self._judge(
            "pre_ops", ctx.session_id, lambda entry: ops_script_context(
                entry.profile, ctx, self._mounts()))

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return await self._judge(
            "pre_session", ctx.session_id,
            lambda entry: session_script_context(entry.profile, ctx,
                                                 self._mounts()))

    async def wants_for(self, hook: str, session_id: str) -> bool:
        """Whether this session's policy speaks at ``hook``: it has a
        program, and the program defines the hook, or defines none and
        so refuses at every door. A probe that fails answers True for
        the same reason: the door will refuse.

        Args:
            hook (str): the hook in python spelling.
            session_id (str): the session the door serves.
        """
        entry = self._sessions.script_of(session_id)
        if entry is None or hook not in HOOKS:
            return False
        try:
            defined = await self._hooks_of(entry)
        except (asyncio.TimeoutError, EvalError, ValueError):
            return True
        return not defined or hook in defined

    async def close(self) -> None:
        """Close every engine a script was evaluated on."""
        engines = list(self._engines.values())
        self._engines.clear()
        for engine in engines:
            await engine.close()

    async def _judge(
        self, hook: str, session_id: str,
        facts: Callable[[ProfileScript], dict[str,
                                              EvalValue]]) -> Action | None:
        """One hook of the session's policy, with the door's facts.

        Args:
            hook (str): the hook the door fired, in python spelling.
            session_id (str): the session the door serves.
            facts (Callable[[ProfileScript], dict[str, EvalValue]]):
                builds what the program sees as ``ctx``, given the
                policy it speaks for.
        """
        entry = self._sessions.script_of(session_id)
        if entry is None:
            return None
        try:
            defined = await self._hooks_of(entry)
            if not defined:
                names = [hook_name(entry.script, name) for name in HOOKS]
                return self._failed(
                    entry, f"defines no hook: {', '.join(names[:-1])} or "
                    f"{names[-1]}")
            if hook not in defined:
                return None
            value = await self._evaluate(entry, hook_call(entry.script, hook),
                                         facts(entry))
        except asyncio.TimeoutError:
            return self._failed(
                entry, f"timed out after {SCRIPT_EVAL_TIMEOUT_SECONDS:g}s")
        except EvalError as exc:
            arm = "syntax error" if exc.syntax else "failed"
            return self._failed(entry, f"{arm}: {exc}")
        except ValueError as exc:
            # script_engine's refusal (the engine cannot be built) or the
            # probe's (the program answered it with something else).
            return self._failed(entry, _clause(exc))
        try:
            return script_action(value, hook)
        except ValueError as exc:
            return self._failed(entry, _clause(exc))

    async def _hooks_of(self, entry: ProfileScript) -> frozenset[str]:
        """The hooks one profile's program defines, probed on its first
        judgment and remembered by runtime, program text and language.
        A runtime change must probe again, including its validation;
        a cached absent hook must never bypass a broken new engine.

        Args:
            entry (ProfileScript): the session's policy.
        """
        key = (entry.runtime, entry.script.language, entry.script.source)
        defined = self._defined.get(key)
        if defined is None:
            value = await self._evaluate(entry, hook_probe(entry.script), {})
            defined = defined_hooks(entry.script, value)
            self._defined[key] = defined
        return defined

    async def _evaluate(self, entry: ProfileScript, tail: str,
                        ctx: dict[str, EvalValue]) -> EvalValue:
        """The program whole, then ``tail`` as its last expression,
        on the profile's engine, serialized.

        Args:
            entry (ProfileScript): the session's policy.
            tail (str): the hook call or the probe.
            ctx (dict[str, EvalValue]): what the program sees as
                ``ctx``.
        """
        async with self._lock:
            engine = self._engines.get(entry.runtime)
            if engine is None:
                engine = script_engine(entry.script, entry.runtime)
                # Attached before the first eval, as Runtimes attaches
                # an agent's engine: the script's open() then reads the
                # mounts through the same door, and an unattached
                # engine sees no file.
                if (self._dispatch is not None and self._resolver is not None
                        and isinstance(engine, LanguageRuntime)):
                    engine.attach(self._reading, self._resolver)
                self._engines[entry.runtime] = engine
            # script_engine refuses anything that cannot evaluate, so
            # this narrows a fact already established.
            assert isinstance(engine, EvaluatorMixin)
            return await eval_with_ctx(f"{entry.script.source}\n\n{tail}\n",
                                       ctx, engine,
                                       SCRIPT_EVAL_TIMEOUT_SECONDS)

    async def _reading(self,
                       op: str,
                       path: PathSpec,
                       *,
                       report: OpReport | None = None,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        """The door the policy's engine reads through: the workspace's
        dispatch, with the op marked as the policy's own for as long as
        it runs, so ``pre_ops`` above lets it through.

        Args:
            op (str): the op the engine asked for.
            path (PathSpec): the resolved virtual path.
            report (OpReport | None): the caller's accounting, which a
                runtime never passes.
            **kwargs (Any): the op's own arguments.
        """
        assert self._dispatch is not None
        token = _POLICY_READ.set(True)
        try:
            return await self._dispatch(op, path, report=report, **kwargs)
        finally:
            _POLICY_READ.reset(token)

    def _failed(self, entry: ProfileScript, detail: str) -> Deny:
        """The fail-closed refusal: one wording, logged.

        Args:
            entry (ProfileScript): the policy that failed.
            detail (str): what went wrong, as the clause after
                "policy".
        """
        reason = f"profile {entry.profile!r} policy {detail}"
        logger.error("%s", reason)
        return Deny(reason)


def _clause(exc: Exception) -> str:
    """An error's message as the clause after "policy": the engine door
    and the answer reader both speak of "script", which is the
    program's generic name, and the profile's word for its program is
    policy.

    Args:
        exc (Exception): the refusal.
    """
    message = str(exc)
    return message[len("script "):] if message.startswith(
        "script ") else message
