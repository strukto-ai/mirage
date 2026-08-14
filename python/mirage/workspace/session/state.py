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

import errno
import functools
from collections.abc import Iterator, Mapping

from mirage.ops.types import SessionView
from mirage.policy import Policies, PolicyDenied, pre_session_gate
from mirage.policy.types import SessionContext
from mirage.shell.array import ShellArray, array_values
from mirage.utils.hidden import var_hidden
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.session import Session


def env_snapshot(session: Session) -> dict[str, str]:
    """The one copy-out of a session's environment.

    Every tier that hands the env onward as a process view (command
    kwargs, ``inv.env``, guest ``RunArgs.env``, the ``env`` builtin)
    copies through here, so the hidden-vars filter lands on all of
    them by construction rather than on however many hand-rolled
    copies someone remembers.

    Args:
        session (Session): the session whose env to copy.
    """
    if session.hidden_vars is None:
        return dict(session.env)
    return {
        name: value
        for name, value in session.env.items()
        if not var_hidden(session.hidden_vars, name)
    }


def env_get(session: Session, name: str) -> str | None:
    """The variable's value, None when unset or hidden.

    Sync on purpose: ``$X`` expansion is the hot path, so a read stays
    a dict lookup plus the hidden check.

    Args:
        session (Session): the session holding the environment.
        name (str): variable name.
    """
    if var_hidden(session.hidden_vars, name):
        return None
    return session.env.get(name)


def env_is_readonly(session: Session, name: str) -> bool:
    """Whether ``readonly`` has marked the name.

    A hidden name answers False: is_readonly speaks about the
    session's visible world, and calling a name that reads as unset
    "readonly" would leak it.

    Args:
        session (Session): the session holding the readonly set.
        name (str): variable name.
    """
    if var_hidden(session.hidden_vars, name):
        return False
    return name in session.readonly_vars


class _VisibleEnv(Mapping[str, str]):
    """A live, read-only view of the session env minus hidden names.

    Handed to expansion instead of a filtered copy so a ``$X`` read
    stays one dict lookup plus the hidden check, and later writes to
    the session show through without rebuilding anything.
    """

    __slots__ = ("_session", )

    def __init__(self, session: Session) -> None:
        self._session = session

    def __getitem__(self, name: str) -> str:
        if var_hidden(self._session.hidden_vars, name):
            raise KeyError(name)
        return self._session.env[name]

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.hidden_vars
        for name in self._session.env:
            if not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        hidden = self._session.hidden_vars
        return sum(1 for name in self._session.env
                   if not var_hidden(hidden, name))


def visible_env(session: Session) -> Mapping[str, str]:
    """The env mapping a reader tier should resolve names against.

    The raw dict when nothing is hidden (the common case pays
    nothing), a filtering view otherwise. Read-only by type: writers
    go through ``set_var``/``unset_var``, never a mapping.

    Args:
        session (Session): the session holding the environment.
    """
    if session.hidden_vars is None:
        return session.env
    return _VisibleEnv(session)


class _VisibleArrays(Mapping[str, ShellArray]):
    """A live, read-only view of the session arrays minus hidden names.

    The arrays twin of ``_VisibleEnv``: the embedder can seed
    ``session.arrays`` before narrowing, so a hidden name can hold an
    array and array reads need the same filter env reads get.
    """

    __slots__ = ("_session", )

    def __init__(self, session: Session) -> None:
        self._session = session

    def __getitem__(self, name: str) -> ShellArray:
        if var_hidden(self._session.hidden_vars, name):
            raise KeyError(name)
        return self._session.arrays[name]

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.hidden_vars
        for name in self._session.arrays:
            if not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        hidden = self._session.hidden_vars
        return sum(1 for name in self._session.arrays
                   if not var_hidden(hidden, name))


def visible_arrays(session: Session) -> Mapping[str, ShellArray]:
    """The arrays mapping a reader tier should resolve names against.

    Args:
        session (Session): the session holding the arrays.
    """
    if session.hidden_vars is None:
        return session.arrays
    return _VisibleArrays(session)


def ensure_var_visible(session: Session, name: str) -> None:
    """Refuse a write that names a hidden variable.

    The sync half of ``set_var``'s hidden gate, shared with the
    expansion-time writers that land on the raw env (``${X:=d}``,
    ``$((X=5))``, ``printf -v``): a landed write would clobber the real
    value the host's wiring still reads, and a swallowed one would
    gaslight the writer; refuse loudly instead, the vars twin of EACCES
    on a create into hidden path space.

    Args:
        session (Session): the session being written.
        name (str): variable name.

    Raises:
        PolicyDenied: the name is hidden for this session.
    """
    if var_hidden(session.hidden_vars, name):
        raise PolicyDenied(errno.EACCES, f"{name}: permission denied", name)


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
        PolicyDenied: the name is hidden for this session, or a
            pre_session policy refused the write.
    """
    ensure_var_visible(session, name)
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
    if var_hidden(session.hidden_vars, name):
        # Hidden reads as unset and bash's unset of a missing name is
        # a quiet no-op; popping the real value would let a session
        # mutate state it cannot see.
        return
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
