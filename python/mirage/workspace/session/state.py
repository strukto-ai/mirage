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

import functools

from mirage.ops.types import SessionView
from mirage.policy import Policies, pre_session_gate
from mirage.policy.types import SessionContext
from mirage.shell.array import ShellArray, array_values
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.session import Session


def env_snapshot(session: Session) -> dict[str, str]:
    """The one copy-out of a session's environment.

    Every tier that hands the env onward as a process view (command
    kwargs, ``inv.env``, guest ``RunArgs.env``, the ``env`` builtin)
    copies through here, so a filter added later lands on all of them
    by construction rather than on however many hand-rolled copies
    someone remembers.

    Args:
        session (Session): the session whose env to copy.
    """
    return dict(session.env)


def env_get(session: Session, name: str) -> str | None:
    """The variable's value, None when unset.

    Sync on purpose: ``$X`` expansion is the hot path, so a read stays
    a dict lookup.

    Args:
        session (Session): the session holding the environment.
        name (str): variable name.
    """
    return session.env.get(name)


def env_is_readonly(session: Session, name: str) -> bool:
    """Whether ``readonly`` has marked the name.

    Args:
        session (Session): the session holding the readonly set.
        name (str): variable name.
    """
    return name in session.readonly_vars


async def set_var(session: Session, policies: Policies | None, name: str,
                  value: str | ShellArray) -> None:
    """Write one variable through the session plane's gate.

    General over variable shapes: a string stores a scalar, a
    ShellArray stores a whole array, and the two storages stay
    exclusive. Semantics live here once — readonly refusal, the
    ``pre_session`` policy gate (whose context value renders an array
    as its present elements joined by spaces), then the store — so
    every writer states them the same way whichever tier or spelling
    asked. Writers with richer mechanics (subscripts, appends, holes)
    compute the resulting value on a copy and hand it here, so a
    denial never leaves a half-applied write. None policies gate
    nothing (a writer outside a workspace).

    Args:
        session (Session): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        value (str | ShellArray): the value to store.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: a pre_session policy refused the write.
    """
    if name in session.readonly_vars:
        raise ReadonlyVariableError(name)
    rendered = value if isinstance(value, str) else " ".join(
        array_values(value))
    await pre_session_gate(
        policies,
        SessionContext(plane="env",
                       verb="set",
                       key=name,
                       value=rendered,
                       session_id=session.session_id))
    if isinstance(value, str):
        session.env[name] = value
        session.arrays.pop(name, None)
    else:
        session.arrays[name] = value
        session.env.pop(name, None)


async def unset_var(session: Session, policies: Policies | None,
                    name: str) -> None:
    """Drop one variable through the session plane's gate; a missing
    name is quiet.

    Args:
        session (Session): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: a pre_session policy refused the write.
    """
    if name in session.readonly_vars:
        raise ReadonlyVariableError(name)
    await pre_session_gate(
        policies,
        SessionContext(plane="env",
                       verb="unset",
                       key=name,
                       value=None,
                       session_id=session.session_id))
    session.env.pop(name, None)


def session_view(session: Session,
                 policies: Policies | None = None) -> SessionView:
    """The session plane's view: five facts bound to one session.

    The one constructor every tier uses — builtins, the command
    dispatcher, a bare unit test — so the gate cannot be skipped by
    picking a different door. The view is the whole capability: it
    carries no handle back to the raw session.

    Args:
        session (Session): the session the view fronts.
        policies (Policies | None): admission policies writes clear;
            None gates nothing (a view constructed outside a
            workspace).
    """
    return SessionView(get=functools.partial(env_get, session),
                       snapshot=functools.partial(env_snapshot, session),
                       set=functools.partial(set_var, session, policies),
                       unset=functools.partial(unset_var, session, policies),
                       is_readonly=functools.partial(env_is_readonly, session))
