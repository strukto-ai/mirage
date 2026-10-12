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
import dataclasses
import json
import logging
from collections.abc import Mapping
from contextvars import ContextVar
from enum import Enum
from typing import Any

from pydantic import BaseModel, ValidationError

from mirage.io import IOResult, OpReport
from mirage.policy.base import Policy
from mirage.policy.constants import (
    CTX_ENV,
    DEFAULT_ASK_REASON,
    DEFAULT_DENY_REASON,
    PROGRAM_FLAGS,
    PROGRAM_RUNTIMES,
)
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (
    VALIDITY,
    Answer,
    Ask,
    CommandContext,
    Deny,
    ProfileScript,
    Route,
    RouteContext,
    SessionContext,
    SessionScriptsQuery,
    VfsContext,
)
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.constants import SCRIPT_EVAL_TIMEOUT_SECONDS
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.resolver import MountResolver
from mirage.runtime.script import script_engine
from mirage.runtime.types import CodeExecution, DispatchFn, EvalValue
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

# The live handles every context carries, which a program reads as
# data instead: the session as its cwd, env and profile, the namespace
# as the mounts it shows, the files through the program's own open().
_LIVE = frozenset({"session", "ns", "vfs"})

# Set for the duration of one op the policy's own engine dispatches, so
# the policy's ``pre_vfs`` lets the read through: the policy is the one
# asking, and judging its own read would re-enter the run that is
# waiting on it.
_POLICY_READ: ContextVar[bool] = ContextVar(
    "mirage_policy_read", default=False
)


def _plain(value: Any) -> EvalValue:
    """A value as a program reads it: JSON-shaped data, bytes as text,
    a path as its virtual spelling, a model or record as its fields
    (the live handles left out).

    Args:
        value (Any): what a context holds.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    if isinstance(value, Enum):
        return _plain(value.value)
    if isinstance(value, PathSpec):
        return value.virtual
    if isinstance(value, BaseModel):
        return _plain(value.model_dump())
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            f.name: _plain(getattr(value, f.name))
            for f in dataclasses.fields(value)
            if f.name not in _LIVE
        }
    if isinstance(value, tuple) and hasattr(value, "_asdict"):
        return _plain(value._asdict())
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_plain(item) for item in value]
    return str(value)


def script_context(
    ctx: CommandContext | RouteContext | VfsContext | SessionContext,
) -> dict[str, EvalValue]:
    """A policy context as a program reads it: every field a coded
    policy reads, under the same name, as plain data.

    The live handles become data: the session its ``cwd``, ``env`` and
    ``profile``, the namespace the ``mounts`` the session sees. The
    files are the program's own ``open()``, which reads as the session.

    Args:
        ctx (CommandContext | RouteContext | VfsContext | SessionContext):
            the context a method was handed, a ``post_`` one included.
    """
    data = _plain(ctx)
    assert isinstance(data, dict)
    session, ns = ctx.session, ctx.ns
    if session is not None:
        data["cwd"] = session.cwd()
        data["env"] = dict(session.snapshot())
        data["profile"] = session.profile() or ""
    else:
        data.setdefault("cwd", "/")
        data["env"] = {}
        data["profile"] = ""
    data["mounts"] = (
        list(ns.mounts.visible_descendants("/"))
        if ns is not None and ns.mounts is not None
        else []
    )
    return data


def script_action(output: bytes, method: str) -> Deny | Ask | Route | None:
    """The answer a policy program printed at one method.

    Nothing (or ``null``) is no opinion. Anything else is one JSON
    answer (``Answer``): ``{"kind": "deny", "reason": ...}``,
    ``{"kind": "ask", "reason": ...}``, or at ``pre_execute``
    ``{"kind": "route", "runtime": ...}``. A deny or an ask without a
    reason carries the document's default one.

    Args:
        output (bytes): what the program wrote to stdout.
        method (str): the method it answered at.

    Raises:
        ValueError: the output is not an answer the method may give. The
            message is a clause about "script", for the caller to prefix
            with whose policy it is.
    """
    text = output.decode(errors="replace").strip()
    if not text or text == "null":
        return None
    try:
        answer = Answer.model_validate_json(text)
    except ValidationError as exc:
        raise ValueError(
            f"script must print a JSON answer at {method}, "
            f'{{"kind": "deny" | "ask" | "route", ...}}'
        ) from exc
    if answer.kind not in VALIDITY[method]:
        raise ValueError(f"script cannot answer {answer.kind} at {method}")
    if answer.kind == Deny.kind:
        return Deny(answer.reason or DEFAULT_DENY_REASON)
    if answer.kind == Ask.kind:
        return Ask(answer.reason or DEFAULT_ASK_REASON)
    assert answer.runtime is not None
    return Route(answer.runtime)


class ScriptPolicy(Policy, SessionScopedMixin):
    """Each profile's policy programs, run at the ``pre_`` methods.

    The scripted twin of ``PermissionsPolicy``, registered right after
    it: where that policy evaluates the document's declarative rules,
    this one runs the profile's programs. A profile names, per method,
    a list of programs and the runtime each runs on; they are asked in
    order, up to the first deny, and their answers reach the chain as
    one tuple, each read as if its own policy had said it: an Ask from
    one program and a Route from another both stand, and two routes
    that disagree refuse the line. A method with no program is silence
    and costs nothing. It reads the session's programs through the narrow
    ``SessionScriptsQuery`` by the session id the entry point put in the
    context.

    A program runs as any program does on its runtime: never edited,
    in the session's cwd, with the context as JSON (``script_context``)
    in ``CTX_ENV`` and on stdin, and its answer printed on stdout
    (``script_action``). ``CTX_ENV`` is its only environment variable:
    the session's variables are in the context, so none the agent sets
    changes how the program starts, and on wasi it runs with ``-P``
    (``PROGRAM_FLAGS``), so no file the agent writes stands in for a
    module it imports. Every failure fails closed: a program
    that exits non-zero, runs past the timeout, prints something else,
    or names a runtime that cannot be built refuses the action with a
    reason naming the profile, and is logged.

    The runtime is the policy's own, built from the name and settings
    the profile gives, shared across sessions and never the agent's. It
    is wired to the workspace's files the way an agent's runtime is, so
    a program reads what an operand holds as the session reads it: a
    hidden path is absent and a write is refused. A read from a program
    clears the dispatcher like any other, except this policy's own
    ``pre_vfs``: the policy is the one asking, and judging its own read
    would re-enter the run waiting on it. Runs are serialized.

    Args:
        sessions (SessionScriptsQuery): the session manager, answering
            ``scripts_of(session_id)``.
        dispatch (DispatchFn | None): the workspace's op dispatch, the
            entry point a program's ``open()`` reads the mounts through;
            None for a ScriptPolicy outside a workspace, whose programs
            see no file.
        resolver (MountResolver | None): the live mount routing table
            the dispatch is attached with. Travels with ``dispatch``:
            one without the other is refused.

    Raises:
        ValueError: ``dispatch`` and ``resolver`` were not given
            together.
    """

    def __init__(
        self,
        sessions: SessionScriptsQuery,
        dispatch: DispatchFn | None = None,
        resolver: MountResolver | None = None,
    ) -> None:
        if (dispatch is None) != (resolver is None):
            raise ValueError(
                "a script policy's dispatch and resolver travel together"
            )
        self._sessions = sessions
        self._dispatch = dispatch
        self._resolver = resolver
        self._engines: dict[tuple[str, str], LanguageRuntime] = {}
        self._lock = asyncio.Lock()

    async def pre_execute(
        self, ctx: RouteContext
    ) -> tuple[Deny | Ask | Route, ...] | None:
        return await self._judge("pre_execute", ctx)

    async def pre_command(
        self, ctx: CommandContext
    ) -> tuple[Deny | Ask | Route, ...] | None:
        return await self._judge("pre_command", ctx)

    async def pre_vfs(
        self, ctx: VfsContext
    ) -> tuple[Deny | Ask | Route, ...] | None:
        if _POLICY_READ.get():
            return None
        return await self._judge("pre_vfs", ctx)

    async def pre_session(
        self, ctx: SessionContext
    ) -> tuple[Deny | Ask | Route, ...] | None:
        return await self._judge("pre_session", ctx)

    async def wants_for(self, hook: str, session_id: str) -> bool:
        """Whether this session's profile names a program at ``hook``.

        Args:
            hook (str): the method in python spelling.
            session_id (str): the session the entry point serves.
        """
        return bool(self._sessions.scripts_of(session_id).get(hook))

    async def close(self) -> None:
        """Close every runtime a program ran on."""
        engines = list(self._engines.values())
        self._engines.clear()
        for engine in engines:
            await engine.close()

    async def _judge(
        self,
        method: str,
        ctx: CommandContext | RouteContext | VfsContext | SessionContext,
    ) -> tuple[Deny | Ask | Route, ...] | None:
        """Every program the session's profile names at one method, each
        answer in order, up to the first deny.

        Args:
            method (str): the method the entry point fired.
            ctx (CommandContext | RouteContext | VfsContext |
                SessionContext): its context.
        """
        programs = self._sessions.scripts_of(ctx.session_id).get(method, ())
        if not programs:
            return None
        payload = json.dumps(script_context(ctx))
        cwd = await self._cwd(ctx)
        answers: list[Deny | Ask | Route] = []
        for entry in programs:
            answer = await self._run(entry, method, payload, cwd)
            if answer is not None:
                answers.append(answer)
            if isinstance(answer, Deny):
                break
        return tuple(answers) or None

    async def _cwd(
        self, ctx: CommandContext | RouteContext | VfsContext | SessionContext
    ) -> str:
        """The directory a program starts in: the session's, or ``/``
        once the session's has gone, since a runtime that enters it
        first (wasi) cannot start in a directory that is not there.

        Args:
            ctx (CommandContext | RouteContext | VfsContext |
                SessionContext): the method's context.
        """
        cwd = ctx.session.cwd() if ctx.session is not None else "/"
        if (
            cwd != "/"
            and ctx.vfs is not None
            and not await ctx.vfs.exists(cwd)
        ):
            return "/"
        return cwd

    async def _run(
        self,
        entry: ProfileScript,
        method: str,
        payload: str,
        cwd: str,
    ) -> Deny | Ask | Route | None:
        """One program at one method, failing closed.

        Args:
            entry (ProfileScript): the program.
            method (str): the method it answers at.
            payload (str): the context as JSON.
            cwd (str): the directory it starts in.
        """
        try:
            async with self._lock:
                engine = self._engine(entry)
                result = await asyncio.wait_for(
                    engine.execute(
                        CodeExecution(
                            language=entry.script.language,
                            code=entry.script.source,
                            args=[],
                            cwd=PathSpec.from_str_path(cwd),
                            env={CTX_ENV: payload},
                            stdin=payload.encode(),
                            flags=dict(PROGRAM_FLAGS.get(entry.runtime, {})),
                        )
                    ),
                    timeout=SCRIPT_EVAL_TIMEOUT_SECONDS,
                )
        except asyncio.TimeoutError:
            return self._failed(
                entry, f"timed out after {SCRIPT_EVAL_TIMEOUT_SECONDS:g}s"
            )
        except ValueError as exc:
            # script_engine's refusal: the runtime cannot be built here.
            return self._failed(entry, _clause(exc))
        if result.exit_code != 0:
            stderr = (result.stderr or b"").decode(errors="replace")
            return self._failed(
                entry, f"exited {result.exit_code}", stderr[-2000:]
            )
        try:
            return script_action(result.stdout, method)
        except ValueError as exc:
            return self._failed(entry, _clause(exc))

    def _engine(self, entry: ProfileScript) -> LanguageRuntime:
        """The policy's own runtime for one program, built on first use
        and shared by every program naming the same runtime and
        settings.

        Args:
            entry (ProfileScript): the program.

        Raises:
            ValueError: the runtime is not one a policy program runs on,
                or cannot be built here.
        """
        if entry.runtime not in PROGRAM_RUNTIMES:
            raise ValueError(
                f"script names runtime {entry.runtime!r}; a policy program "
                f"runs on {' or '.join(sorted(PROGRAM_RUNTIMES))}"
            )
        key = (entry.runtime, json.dumps(dict(entry.config), sort_keys=True))
        engine = self._engines.get(key)
        if engine is None:
            engine = script_engine(entry.script, entry.runtime, entry.config)
            if self._dispatch is not None and self._resolver is not None:
                engine.bind(WorkspaceBinding(self._reading, self._resolver))
            self._engines[key] = engine
        return engine

    async def _reading(
        self,
        name: str,
        path: PathSpec,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[Any, IOResult]:
        """The entry point the policy's runtime reads through: the
        workspace's dispatch, with the op marked as the policy's own for
        as long as it runs, so ``pre_vfs`` above lets it through.

        Args:
            name (str): the function the runtime asked for.
            path (PathSpec): the resolved virtual path.
            report (OpReport | None): the caller's accounting, which a
                runtime never passes.
            **kwargs (Any): the op's own arguments.
        """
        assert self._dispatch is not None
        token = _POLICY_READ.set(True)
        try:
            return await self._dispatch(name, path, report=report, **kwargs)
        finally:
            _POLICY_READ.reset(token)

    def _failed(
        self, entry: ProfileScript, detail: str, stderr: str = ""
    ) -> Deny:
        """The fail-closed refusal: one wording, logged with what the
        program wrote to stderr.

        Args:
            entry (ProfileScript): the program that failed.
            detail (str): what went wrong, as the clause after
                "policy".
            stderr (str): the tail of the program's stderr, if any.
        """
        reason = f"profile {entry.profile!r} policy {detail}"
        logger.error("%s%s", reason, f"\n{stderr}" if stderr else "")
        return Deny(reason)


def _clause(exc: Exception) -> str:
    """An error's message as the clause after "policy": the runtime
    builder and the answer reader both speak of "script", which is the
    program's generic name, and the profile's word for its program is
    policy.

    Args:
        exc (Exception): the refusal.
    """
    message = str(exc)
    return (
        message[len("script ") :] if message.startswith("script ") else message
    )
