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
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from typing import ParamSpec

from mirage._rs import ShellTask
from mirage.context.session_context import session_access, session_voice
from mirage.io.memory import memory_room
from mirage.policy.errors import PolicyDenied
from mirage.policy.policies import Policies, pre_session_gate
from mirage.policy.types import HandOff, SessionContext
from mirage.rs.session import ShellVars, raw_value, var_of
from mirage.shell.arith import plain_decimal
from mirage.shell.array import ShellArray, array_get
from mirage.shell.bytes import join_bytes
from mirage.shell.call_stack import CallStack
from mirage.shell.variable import ShellValue, VarAttr
from mirage.view.types import SessionView
from mirage.workspace.session.budget import (
    args_bytes,
    check_env,
    entry_bytes,
    env_limit,
    frames_bytes,
    outside_bytes,
    positional_bytes,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.task import (
    SessionGate,
    drive,
    fault_error,
    listens,
)

P = ParamSpec("P")


def frame(session: SessionState, call_stack: CallStack | None = None) -> None:
    """Hand the session's shell the state around it that a task reads:
    the positional parameters in scope, the special parameters, the
    options, ``max_env`` and the bytes the session holds beside its
    variables, the bytes left under ``max_memory``, the running command's
    line and process, and the voice the shell's diagnostics lead with.

    Args:
        session (SessionState): the session.
        call_stack (CallStack | None): function-call scope, if any.
    """
    calls = (
        [call_stack.get_all_positional()]
        if call_stack is not None and call_stack.depth > 1
        else []
    )
    limit = env_limit()
    outside = 0 if limit is None else outside_bytes(session)
    names = session.function_names
    session.vars.shell.frame(
        positional=session.positional_args,
        calls=calls,
        status=session.last_exit_code,
        pid=session.shell_pid or session.process_id or 0,
        last_job=session.last_bg_job_id,
        argv0=session.argv0,
        options=session.shell_options,
        shopts=session.shopts,
        env_limit=limit,
        outside=outside,
        pipe_status=list(session.pipe_status),
        function_names=None if names is None else list(names),
        paren=call_stack is not None and call_stack.paren,
        memory_room=memory_room(),
        line=session.line_number,
        bash_pid=session.bash_pid,
        voice=session_voice(session),
    )


async def run_write(
    session: SessionState,
    policies: Policies | None,
    start: Callable[[bool], ShellTask],
    diagnostics: list[str | bytes] | None = None,
) -> int:
    """Run one gated write on the session's shell to its end.

    Args:
        session (SessionState): the session written.
        policies (Policies | None): the policies its writes clear.
        start (Callable[[bool], ShellTask]): the task, given whether a
            policy listens.
        diagnostics (list[str | bytes] | None): where its warnings go.
    """
    heard = await listens(policies, session.session_id)
    frame(session)
    task = start(heard)
    sink: list[str | bytes] = [] if diagnostics is None else diagnostics
    return int(await drive(task, SessionGate(session, policies), sink))


def env_snapshot(session: SessionState) -> dict[str, str]:
    """The one copy-out of a session's environment.

    Every tier that hands the env onward as a process view (a command's
    or CLI's ``ctx.env``, a runtime's, the ``env`` builtin) copies
    through here, so the hidden-vars filter lands on all of them. Only
    exported scalars, as bash's child environment: ``X=hello`` is
    absent, ``export Y=world`` present, ``export Z`` (unset) absent.

    Diverges from bash on one point: bash also carries each function
    ``export -f`` marked, as a ``BASH_FUNC_NAME%%`` entry. mirage hands
    those to a nested shell directly (``SessionState.new_shell``).

    The shell reads its records out once per change: a command takes
    the snapshot several times (its words, its admission, its context),
    and every take after the first is a copy of the last.

    Args:
        session (SessionState): the session whose env to copy.
    """
    shell = session.vars.shell
    stamp = shell.stamp()
    held = session._env_held
    if held is None or held[0] != stamp:
        held = (stamp, dict(shell.exported()))
        session._env_held = held
    return dict(held[1])


def nameref_target(session: SessionState, name: str) -> str | None:
    """The name a ``declare -n`` reference points at, None otherwise
    (also for a reference not yet aimed, which stands for nothing).

    Args:
        session (SessionState): the session holding the record.
        name (str): variable name.
    """
    return session.vars.shell.nameref_target(name)


def deref(session: SessionState, name: str) -> str:
    """The variable a name stands for, following ``declare -n`` chains;
    the empty name for a chain that comes back to itself, which bash
    reads as unset.

    Args:
        session (SessionState): the session holding the records.
        name (str): the name as spelled.
    """
    return session.vars.shell.deref(name)


def _visible(session: SessionState, name: str) -> ShellValue | None:
    record = session.vars.shell.visible(name)
    return None if record is None else var_of(record).value


def env_get(session: SessionState, name: str) -> str | None:
    """The variable's value, None when unset, hidden or an array; a name
    reference reads its target.

    Args:
        session (SessionState): the session holding the environment.
        name (str): variable name.
    """
    value = _visible(session, name)
    return value if isinstance(value, str) else None


def env_is_readonly(
    session: SessionState, name: str, follow_ref: bool = True
) -> bool:
    """Whether ``readonly`` has marked the name; a hidden name is not,
    which would leak it.

    Args:
        session (SessionState): the session holding the readonly set.
        name (str): variable name.
        follow_ref (bool): ask about what a ``declare -n`` reference
            points at; a write to the reference itself asks about it.
    """
    return session.vars.shell.is_readonly(name, follow_ref)


class _VisibleEnv(Mapping[str, str]):
    """A live, read-only view of the session's scalars minus hidden
    names, a lookup following references."""

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> str:
        value = env_get(self._session, name)
        if value is None:
            raise KeyError(name)
        return value

    def __iter__(self) -> Iterator[str]:
        return iter(self._session.vars.shell.visible_names("scalar"))

    def __len__(self) -> int:
        return len(self._session.vars.shell.visible_names("scalar"))


def visible_env(session: SessionState) -> Mapping[str, str]:
    """The env mapping a reader tier resolves names against: live,
    read-only, hidden names left out.

    Args:
        session (SessionState): the session holding the environment.
    """
    return _VisibleEnv(session)


class _VisibleArrays(Mapping[str, ShellArray]):
    """A live, read-only view of the session's indexed arrays minus
    hidden names. ``PIPESTATUS`` and ``FUNCNAME`` answer a lookup from
    the shell's own bookkeeping, which the frame hands it, and never
    list: bash's ``declare -p PIPESTATUS`` is ``not found``."""

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> ShellArray:
        session = self._session
        frame(session)
        raw = session.vars.shell.indexed(name)
        if raw is None:
            raise KeyError(name)
        return ShellArray(raw)

    def __iter__(self) -> Iterator[str]:
        return iter(self._session.vars.shell.visible_names("indexed"))

    def __len__(self) -> int:
        return len(self._session.vars.shell.visible_names("indexed"))


def visible_arrays(session: SessionState) -> Mapping[str, ShellArray]:
    """The indexed arrays a reader tier resolves names against.

    Args:
        session (SessionState): the session holding the arrays.
    """
    return _VisibleArrays(session)


class _VisibleAssocs(Mapping[str, dict[str, str]]):
    """A live, read-only view of the associative arrays minus hidden
    names."""

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> dict[str, str]:
        value = _visible(self._session, name)
        if not isinstance(value, dict):
            raise KeyError(name)
        return value

    def __iter__(self) -> Iterator[str]:
        return iter(self._session.vars.shell.visible_names("assoc"))

    def __len__(self) -> int:
        return len(self._session.vars.shell.visible_names("assoc"))


def visible_assocs(session: SessionState) -> Mapping[str, dict[str, str]]:
    """The associative arrays a reader tier resolves names against.

    Args:
        session (SessionState): the session holding the arrays.
    """
    return _VisibleAssocs(session)


async def subscript_index(
    session: SessionState, subscript: str, policies: Policies | None = None
) -> int:
    """An indexed subscript resolved outside an arithmetic expression:
    ``a[i]=v``, ``unset 'a[i]'``. It is arithmetic, so it may assign
    (``a[x=3]``) and seed (``a[RANDOM=42]``); each lands through the gate.
    One that fails lands what it assigned before failing, then raises.

    Args:
        session (SessionState): the session the subscript reads.
        subscript (str): the raw subscript text.
        policies (Policies | None): the policies its writes clear.

    Raises:
        PolicyDenied: the gate refused an assignment.
        ExitSignal: an assignment named a readonly variable, which ends
            the shell wherever a subscript is.
        ArithError: the subscript does not evaluate.
    """
    plain = plain_decimal(subscript)
    if plain is not None:
        return plain
    shell = session.vars.shell
    return await run_write(
        session,
        policies,
        lambda heard: shell.index(subscript, listens=heard),
    )


async def session_arith(
    session: SessionState,
    text: str,
    policies: Policies | None = None,
    call_stack: CallStack | None = None,
    expand: bool = False,
) -> int:
    """Evaluate an arithmetic command, a ``let`` operand or a test's
    integer operand against the session, its writes landed through the
    gate in order.

    Args:
        session (SessionState): the session.
        text (str): the expression, already expanded.
        policies (Policies | None): the policies its writes clear.
        call_stack (CallStack | None): function-call scope, if any.
        expand (bool): a ``let`` operand, whose subscripts expand first.
    """
    shell = session.vars.shell
    heard = await listens(policies, session.session_id)
    frame(session, call_stack)
    task = shell.arith(text, listens=heard, expand=expand)
    return int(await drive(task, SessionGate(session, policies), []))


def conversion_scalar(session: SessionState, name: str) -> str | None:
    """The scalar an array conversion keeps as element 0; for a live
    ``RANDOM`` looking the name up draws (``RANDOM[1]=5`` leaves ``[0]``
    one draw).

    Args:
        session (SessionState): the session the conversion happens in.
        name (str): the variable turning into an array.
    """
    answer = session.vars.shell.conversion_scalar(name)
    if isinstance(answer, tuple):
        raise fault_error(("arith", answer[1]), {})
    return answer


async def evaluate_integer(
    session: SessionState,
    policies: Policies | None,
    text: str,
    added: str | None = None,
) -> str:
    """Evaluate ``text`` as an ``-i`` write coerces it, land what it
    assigns, and give back the value: a ``declare -ni r=M`` value, which
    bash evaluates before refusing the reference (``M='X=5'`` sets X).

    Args:
        session (SessionState): shell session state.
        policies (Policies | None): the policies its writes clear.
        text (str): the value, the held one for a ``r+=M``.
        added (str | None): a ``r+=M``'s added text, evaluated after
            ``text`` in the same evaluation and added to it.
    """
    shell = session.vars.shell
    value = await run_write(
        session,
        policies,
        lambda heard: shell.integer(text, added, listens=heard),
    )
    return str(value)


def appended(
    held: ShellValue | None, added: str, integer: bool
) -> tuple[str, str | None]:
    """What a ``+=`` hands ``set_var``: the held text then the added one,
    or on an integer the held text with the added one as ``added``. An
    array extends element 0 and a map key ``"0"``.

    Args:
        held (ShellValue | None): what the slot holds, None when unset.
        added (str): the text appended.
        integer (bool): the variable carries ``-i``.
    """
    if isinstance(held, dict):
        held = held.get("0")
    elif isinstance(held, ShellArray):
        held = array_get(held, 0)
    text = held or ""
    return (text, added) if integer else (join_bytes(text + added), None)


def ensure_var_visible(session: SessionState, name: str) -> None:
    """Refuse a write that names a hidden variable, the vars twin of
    EACCES on a create into hidden path space.

    Args:
        session (SessionState): the session being written.
        name (str): variable name.

    Raises:
        PolicyDenied: the name is hidden for this session.
    """
    if session.vars.shell.hidden(name):
        raise PolicyDenied(errno.EACCES, f"{name}: permission denied", name)


# The names the shell maintains itself (`seed_var`'s second caller): a
# `cd` writes the first two and `[[ =~ ]]` the third, ungated, because
# they are the shell's to keep current rather than the session's to admit.
SHELL_BOOKKEEPING = frozenset({"PWD", "OLDPWD", "BASH_REMATCH"})


async def gate_restored_vars(
    policies: Policies | None, session_id: str, table: ShellVars
) -> None:
    """Vet a variable table a snapshot restores through the session gate:
    every variable fires ``pre_session`` as a ``set`` of its rendered
    value before any of them lands, and a refusal aborts the load. The
    shell's own bookkeeping is exempt here as it is live.

    Args:
        policies (Policies | None): the target workspace's policies.
        session_id (str): the session the table is restored into.
        table (ShellVars): the restored variables.
    """
    shell = table.shell
    for name in shell.names():
        if name in SHELL_BOOKKEEPING:
            continue
        await pre_session_gate(
            policies,
            SessionContext(
                verb="set",
                key=name,
                value=shell.rendered(name),
                session_id=session_id,
            ),
        )


_ELEMENT_STATUS = ("ok", "denied", "readonly", "subscript", "notarray")


def var_kind(session: SessionState, name: str) -> str | None:
    """What the value a name stands for is, references followed:
    ``scalar``, ``indexed`` or ``assoc``; None when unset or hidden. It
    reads no value, so asking it of a large array costs nothing.

    Args:
        session (SessionState): shell session state.
        name (str): variable name.
    """
    return session.vars.shell.kind(name)


async def _element_write(
    session: SessionState,
    policies: Policies | None,
    start: Callable[[bool], ShellTask],
    diagnostics: list[str | bytes] | None = None,
) -> str:
    """Run one element write as one call, so a ONCE answer to its
    ``pre_session`` question stands until its ``post_session`` one is
    answered too, and name the status it came to.

    Args:
        session (SessionState): the session written.
        policies (Policies | None): the policies the write clears.
        start (Callable[[bool], ShellTask]): the task, given whether a
            policy listens.
        diagnostics (list[str | bytes] | None): where its warnings go.
    """

    async def write(_: HandOff | None = None) -> int:
        return await run_write(session, policies, start, diagnostics)

    if policies is None:
        return _ELEMENT_STATUS[await write()]
    code = await policies.decisions.within_call(session.session_id, write)
    return _ELEMENT_STATUS[code]


async def push_words(
    session: SessionState,
    policies: Policies | None,
    name: str,
    words: list[str],
) -> None:
    """Append words at the extent of the indexed array a name holds
    (``a+=(x y)``), as one gated write; with no policy listening it lands
    in place, so a loop building an array costs each word once.

    Args:
        session (SessionState): shell session state.
        policies (Policies | None): the policies the write clears.
        name (str): the array's name.
        words (list[str]): the words appended.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: the name is hidden, or a policy refused the write.
    """
    shell = session.vars.shell
    await _element_write(
        session, policies, lambda heard: shell.push(name, words, listens=heard)
    )


async def unset_element(
    session: SessionState,
    policies: Policies | None,
    name: str,
    subscript: str,
) -> str:
    """Clear one element (``unset 'a[i]'``) as one gated write, keeping
    the indexes after it: an associative subscript is the key verbatim, an
    indexed one arithmetic whose writes land first, and a scalar's
    element 0 the whole scalar. A hidden or unset name clears nothing.

    Args:
        session (SessionState): shell session state.
        policies (Policies | None): the policies the write and the
            subscript's assignments clear.
        name (str): the base variable name.
        subscript (str): the subscript, already expanded.

    Returns:
        str: ``"ok"``, ``"subscript"`` for a negative subscript before an
        array's first element, or ``"notarray"`` for a subscript other
        than 0 on a scalar.

    Raises:
        ArithError: the subscript does not evaluate.
        PolicyDenied: a policy refused the write.
    """
    shell = session.vars.shell
    return await _element_write(
        session,
        policies,
        lambda heard: shell.unset_element(name, subscript, listens=heard),
    )


async def element_is_set(
    session: SessionState,
    ref: str,
    policies: Policies | None = None,
    expanded: bool = False,
) -> bool:
    """Whether a ``name`` / ``name[sub]`` reference names a set value,
    what ``test -v`` asks: a bare name over an array checks element 0,
    ``name[@]`` any element, an indexed subscript evaluates and what it
    assigns lands (``[[ -v a[x=2] ]]`` leaves x at 2).

    Args:
        session (SessionState): shell session state.
        ref (str): the reference as the operand spelled it.
        policies (Policies | None): the policies the subscript's
            assignments clear; None outside a workspace.
        expanded (bool): the subscript was expanded already, so an
            associative key is taken verbatim, its quotes its own.

    Raises:
        ArithError: the subscript does not evaluate.
    """
    shell = session.vars.shell
    return bool(
        await run_write(
            session,
            policies,
            lambda heard: shell.is_set(ref, expanded=expanded, listens=heard),
        )
    )


async def assign_element(
    session: SessionState,
    policies: Policies | None,
    name: str,
    subscript: str | None,
    value: str,
    append: bool = False,
    *,
    diagnostics: list[str | bytes] | None = None,
) -> str:
    """Assign one element (or a bare name resolved as element 0 of an
    array, a scalar otherwise) as one gated write, so a ``pre_session``
    rule sees ``m[k]=v`` as a write to ``m``; with no policy listening it
    lands in place. The subscript arrives already expanded: an
    associative name takes it as the key verbatim, an indexed one
    evaluates it as arithmetic, even when the name is readonly.

    Args:
        session (SessionState): shell session state.
        policies (Policies | None): the policies the write and the
            subscript's assignments clear.
        name (str): the target's base variable name.
        subscript (str | None): the ``[...]`` text, None for a bare
            target.
        value (str): the text to store.
        append (bool): concatenate onto the existing element, or add
            to it under ``-i``.
        diagnostics (list[str | bytes] | None): evaluation-owned warnings;
            without a sink, a seed's arithmetic error propagates.

    Returns:
        str: ``"ok"``, ``"denied"``, ``"readonly"``, or ``"subscript"``.

    Raises:
        PolicyDenied: a pre_session rule refused the write.
        ArithError: the name carries ``-i`` and the text does not
            evaluate.
    """
    shell = session.vars.shell
    return await _element_write(
        session,
        policies,
        lambda heard: shell.element(
            name,
            subscript,
            value,
            append=append,
            listens=heard,
            warns=diagnostics is not None,
        ),
        diagnostics,
    )


async def set_var(
    session: SessionState,
    policies: Policies | None,
    name: str,
    value: ShellValue,
    follow_ref: bool = True,
    *,
    assigned: frozenset[int | str] | None = None,
    added: str | None = None,
    diagnostics: list[str | bytes] | None = None,
) -> None:
    """Write one variable through the session plane's gate.

    A string stores a scalar, a ShellArray an indexed array, a dict an
    associative one. Readonly and hidden names refuse; the value is
    shaped by the name's attributes (``-i -l -u``) before the
    ``pre_session`` policy judges it, lands, and is put back when
    ``post_session`` refuses. Writers with richer mechanics compute the
    resulting value on a copy and hand it here.

    Args:
        session (SessionState): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        value (ShellValue): the value to store.
        follow_ref (bool): resolve a ``declare -n`` reference to its
            target first; ``declare -n r=w`` re-aims and passes False.
        assigned (frozenset[int | str] | None): the elements an array
            write assigns, None for the whole value.
        added (str | None): an integer ``+=``'s text, evaluated after the
            held one.
        diagnostics (list[str | bytes] | None): evaluation-owned warnings;
            without a sink, a seed's arithmetic error propagates.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: the name is hidden, or a policy refused the write.
    """
    raw, assoc = raw_value(value)
    shell = session.vars.shell
    keys = None if assigned is None else list(assigned)
    await run_write(
        session,
        policies,
        lambda heard: shell.set(
            name,
            raw,
            assoc=assoc,
            follow_ref=follow_ref,
            assigned=keys,
            added=added,
            listens=heard,
            warns=diagnostics is not None,
        ),
        diagnostics,
    )


async def unset_var(
    session: SessionState,
    policies: Policies | None,
    name: str,
    follow_ref: bool = True,
) -> None:
    """Drop one variable through the session plane's gate; a missing or
    hidden name is quiet. A name an enclosing scope shadows is that
    scope's to lose: the unset reveals the value it saved.

    Args:
        session (SessionState): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        follow_ref (bool): resolve a ``declare -n`` reference to its
            target; ``unset -n r`` drops the reference and passes False.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: a pre_session policy refused the write.
    """
    shell = session.vars.shell
    await run_write(
        session,
        policies,
        lambda heard: shell.unset(name, follow_ref=follow_ref, listens=heard),
    )


async def mark_var(
    session: SessionState,
    policies: Policies | None,
    name: str,
    attr: VarAttr | None,
    on: bool = True,
    follow_ref: bool = True,
) -> None:
    """Turn one attribute on or off through the session plane's gate,
    writing no value: ``export NAME`` on a fresh name leaves it unset.
    A None attribute declares the name and changes no attribute.

    Args:
        session (SessionState): the session being written.
        policies (Policies | None): admission policies the mark clears.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name only.
        on (bool): set it, or clear it.
        follow_ref (bool): mark what a ``declare -n`` reference points
            at; ``declare -rn r`` marks the reference itself.

    Raises:
        PolicyDenied: the name is hidden, or a policy refused the mark.
    """
    shell = session.vars.shell
    letter = None if attr is None else attr.value
    await run_write(
        session,
        policies,
        lambda heard: shell.mark(
            name, letter, on, follow_ref=follow_ref, listens=heard
        ),
    )


def reach_global(
    session: SessionState, names: list[str]
) -> Callable[[], None]:
    """Put each name's global record in place for a ``declare -g``, and
    return the call that puts the running locals back (``local G=5;
    declare -gr G=1`` leaves ``$G`` at 5 in the function, 1 and frozen
    outside).

    Args:
        session (SessionState): shell session state.
        names (list[str]): the declaration's operand names.
    """
    shell = session.vars.shell
    shell.reach_global(names)
    return shell.unreach


def outlive_call(session: SessionState, name: str) -> None:
    """Let a temporary-environment variable outlive its call: bash keeps
    ``x`` from ``x=1 f`` once something inside runs ``export x`` or
    ``readonly x``.

    Args:
        session (SessionState): the session.
        name (str): variable name.
    """
    session.vars.shell.outlive_call(name)


def in_call_env(session: SessionState, name: str) -> bool:
    """Whether the running function's call assigned ``name`` in front.

    Args:
        session (SessionState): the session.
        name (str): variable name.
    """
    return session.vars.shell.in_call_env(name)


def prefix_temporaries(session: SessionState) -> list[str]:
    """The names a running builtin's or program's prefix assignments set
    for it, which no listing shows (``QX=1 export -p`` lists no QX); a
    function's are its own scope's, and list.

    Args:
        session (SessionState): the session.
    """
    return [name for saved in session._prefix_saves for name in saved]


def positional_params(
    session: SessionState, call_stack: CallStack | None
) -> list[str]:
    """The positional parameters in scope: inside a function its own,
    even none; outside every function the shell's.

    Args:
        session (SessionState): shell session state.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if call_stack is not None and call_stack.depth > 1:
        return call_stack.get_all_positional()
    return session.positional_args


def set_positional_params(
    session: SessionState, call_stack: CallStack | None, values: list[str]
) -> None:
    """Replace the positional parameters in scope; ``set --`` and
    ``shift`` inside a function change the function's own. ``values`` is
    held as given and never changed in place, which lets a frame and
    ``positional_bytes`` know a list they read already.

    Args:
        session (SessionState): shell session state.
        call_stack (CallStack | None): function-call scope, if any.
        values (list[str]): the new parameters.
    """
    if call_stack is not None and call_stack.depth > 1:
        check_env(
            session,
            args_bytes(call_stack.get_all_positional()),
            args_bytes(values),
            frames_bytes(call_stack),
        )
        call_stack.set_positional(values)
    else:
        check_env(session, positional_bytes(session), args_bytes(values))
        session.positional_args = values


def shadow_local(
    session: SessionState, name: str, inherit: bool = False
) -> None:
    """Record the caller's record before a ``local`` shadows it, once per
    function; a local ``RANDOM`` is an ordinary variable for the
    function's extent, and so is a local ``LINENO`` or ``BASHPID``, its
    ``unset`` the function's own; with ``-I`` it keeps the meaning the
    caller's has.

    Args:
        session (SessionState): the session the function runs in.
        name (str): the variable being declared local.
        inherit (bool): the declaration carried ``-I``.
    """
    session.vars.shell.shadow(name, inherit)


def seed_var(session: SessionState, name: str, value: ShellValue) -> None:
    """Write a variable without consulting the gate.

    Two kinds of caller: seeding a session before it is handed out, and
    the shell's own bookkeeping (``$PWD``/``$OLDPWD`` after a ``cd``,
    ``BASH_REMATCH`` after ``[[ =~ ]]``). A variable the line named goes
    through `SessionView.set` instead. A prefix assignment
    (``FOO=bar cmd``) lands here too, after asking ``ensure_var_visible``
    and ``pre_session`` with the value.

    Nor does it count against max_env: a caller that grows a value a
    line chose, as that prefix assignment does, calls ``check_env``
    first.

    Args:
        session (SessionState): the session being seeded.
        name (str): variable name.
        value (ShellValue): the value to store.
    """
    raw, assoc = raw_value(value)
    session.vars.shell.seed(name, raw, assoc)


def bind_last_word(session: SessionState, words: Sequence[str]) -> None:
    """Set ``$_`` as bash does once a simple command has run in the
    shell: its last word after expansion, which is its name when it took
    no argument, and empty for a line that only assigned or redirected.

    Args:
        session (SessionState): the session the command ran in.
        words (Sequence[str]): the command's expanded words, name first.
    """
    seed_var(session, "_", words[-1] if words else "")


def set_attr(
    session: SessionState, name: str, attr: VarAttr | None, on: bool = True
) -> None:
    """Turn one attribute on or off without the gate, creating the name
    unset if needed, as ``readonly NAME`` on a fresh name does; a None
    attribute only declares the name.

    Args:
        session (SessionState): the session being written.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name and change nothing.
        on (bool): set it, or clear it.
    """
    if name not in session.vars:
        check_env(session, 0, entry_bytes(name, None))
    session.vars.shell.set_attr(name, None if attr is None else attr.value, on)


def _one_call(
    session: SessionState,
    policies: Policies | None,
    write: Callable[P, Awaitable[None]],
) -> Callable[P, Awaitable[None]]:
    """A session write as one call, so a ONCE answer to its
    ``pre_session`` question stands until its ``post_session`` one is
    answered too.

    Args:
        session (SessionState): the session written.
        policies (Policies | None): the workspace's policies; None asks
            nothing.
        write (Callable[P, Awaitable[None]]): the write.
    """
    if policies is None:
        return write

    async def call(*args: P.args, **kwargs: P.kwargs) -> None:
        await policies.decisions.within_call(
            session.session_id, lambda _: write(*args, **kwargs)
        )

    return call


def session_view(
    session: SessionState,
    policies: Policies | None = None,
    *,
    diagnostics: list[str | bytes] | None = None,
) -> SessionView:
    """The session plane's view: ten facts bound to one session.

    The one constructor every tier uses, so the gate cannot be skipped by
    picking a different entry point. The view carries no handle back to
    the raw session.

    Args:
        session (SessionState): the session the view fronts.
        policies (Policies | None): admission policies writes clear;
            None gates nothing (a view constructed outside a workspace).
        diagnostics (list[str | bytes] | None): the evaluator's warning
            sink.
    """
    return SessionView(
        get=functools.partial(env_get, session),
        snapshot=functools.partial(env_snapshot, session),
        set=_one_call(
            session,
            policies,
            functools.partial(
                set_var, session, policies, diagnostics=diagnostics
            ),
        ),
        unset=_one_call(
            session, policies, functools.partial(unset_var, session, policies)
        ),
        mark=_one_call(
            session, policies, functools.partial(mark_var, session, policies)
        ),
        is_readonly=functools.partial(env_is_readonly, session),
        profile=lambda: session.profile,
        cwd=lambda: session.cwd,
        session_id=session.session_id,
        access=functools.partial(session_access, session),
    )
