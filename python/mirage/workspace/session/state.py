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
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (ShellArray, array_extent, array_get, array_has,
                                array_values)
from mirage.shell.errors import ArithError
from mirage.shell.types import ElementOps
from mirage.shell.variable import (ShellValue, ShellVar, VarAttr, coerce_value,
                                   detach, with_attr, with_value)
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

    *Exported* names only, which is what makes this the process view
    rather than a second spelling of ``visible_env``. bash puts a
    variable in a child's environment when it carries the export
    attribute, not when it happens to hold a string: ``X=hello`` is
    absent from ``env`` and ``export Y=world`` is present. An unset
    name carrying the attribute (``export Z``) is absent too, which
    falls out of the value check rather than needing its own arm.

    Args:
        session (Session): the session whose env to copy.
    """
    return {
        name: var.value
        for name, var in session.vars.items()
        if isinstance(var.value, str) and VarAttr.EXPORT in var.attrs
        and not var_hidden(session.hidden_vars, name)
    }


def exported_names(session: Session) -> list[str]:
    """The names carrying the export attribute, sorted, hidden removed.

    Wider than `env_snapshot`'s keys by exactly the unset ones: a name
    `export Z` marked but never assigned is listed by `export -p` as
    `declare -x Z` while staying out of the environment. So the
    printers read this and the process view reads `env_snapshot`,
    rather than one of them re-deriving the other's filter.

    Args:
        session (Session): the session to read.
    """
    return sorted(name for name, var in session.vars.items()
                  if VarAttr.EXPORT in var.attrs
                  and not var_hidden(session.hidden_vars, name))


def nameref_target(session: Session, name: str) -> str | None:
    """The name a ``declare -n`` reference points at, None otherwise.

    None also for a reference declared but not yet aimed (``declare -n
    r`` before ``r=v``): bash treats the first assignment to such a
    reference as naming its target, so until then it stands for nothing.

    Args:
        session (Session): the session holding the record.
        name (str): variable name.
    """
    var = session.vars.get(name)
    if var is None or VarAttr.NAMEREF not in var.attrs:
        return None
    return var.value if isinstance(var.value, str) and var.value else None


def deref(session: Session, name: str) -> str:
    """The variable a name stands for, following ``declare -n`` chains.

    A name that is not a reference is its own answer, so every reader
    and writer can resolve unconditionally and a session with no
    namerefs pays one dict lookup. A chain that comes back to itself
    (``declare -n a=b; declare -n b=a``) is bash's "circular name
    reference", which it warns about and reads as unset: that resolves
    to the empty name, which no record ever has, so a reader sees unset
    and a writer falls back to the reference's own record. The warning
    line is the one part not reproduced.

    Args:
        session (Session): the session holding the records.
        name (str): the name as spelled.
    """
    current = name
    seen: set[str] = set()
    while True:
        target = nameref_target(session, current)
        if target is None:
            return current
        if current in seen:
            return ""
        seen.add(current)
        current = target


def env_get(session: Session, name: str) -> str | None:
    """The variable's value, None when unset or hidden.

    Sync on purpose: ``$X`` expansion is the hot path, so a read stays
    a dict lookup plus the hidden check. A name reference reads its
    target.

    Args:
        session (Session): the session holding the environment.
        name (str): variable name.
    """
    name = deref(session, name)
    if var_hidden(session.hidden_vars, name):
        return None
    var = session.vars.get(name)
    return var.value if var is not None and isinstance(var.value,
                                                       str) else None


def env_is_readonly(session: Session, name: str) -> bool:
    """Whether ``readonly`` has marked the name.

    A hidden name answers False: is_readonly speaks about the
    session's visible world, and calling a name that reads as unset
    "readonly" would leak it.

    Args:
        session (Session): the session holding the readonly set.
        name (str): variable name.
    """
    name = deref(session, name)
    if var_hidden(session.hidden_vars, name):
        return False
    var = session.vars.get(name)
    return var is not None and VarAttr.READONLY in var.attrs


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
        name = deref(self._session, name)
        if var_hidden(self._session.hidden_vars, name):
            raise KeyError(name)
        var = self._session.vars[name]
        if not isinstance(var.value, str):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.hidden_vars
        for name, var in self._session.vars.items():
            if isinstance(var.value, str) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_env(session: Session) -> Mapping[str, str]:
    """The env mapping a reader tier should resolve names against.

    Always the live view, never ``session.env``: that property is a
    projection built fresh on every access, so handing it out would
    copy the whole store per read *and* freeze the answer at that
    moment. The view costs one dict lookup plus the hidden check per
    name and shows later writes through. Read-only by type: writers go
    through ``set_var``/``unset_var``, never a mapping.

    Args:
        session (Session): the session holding the environment.
    """
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
        name = deref(self._session, name)
        if var_hidden(self._session.hidden_vars, name):
            raise KeyError(name)
        var = self._session.vars[name]
        if not isinstance(var.value, list):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.hidden_vars
        for name, var in self._session.vars.items():
            if isinstance(var.value, list) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_arrays(session: Session) -> Mapping[str, ShellArray]:
    """The arrays mapping a reader tier should resolve names against.

    Args:
        session (Session): the session holding the arrays.
    """
    return _VisibleArrays(session)


class _VisibleAssocs(Mapping[str, dict[str, str]]):
    """A live, read-only view of the associative arrays minus hidden
    names.

    The third sibling beside ``_VisibleEnv`` and ``_VisibleArrays``,
    for the same reason both exist: the embedder can seed a hidden name
    with any value shape, so every reader tier filters the same way.
    """

    __slots__ = ("_session", )

    def __init__(self, session: Session) -> None:
        self._session = session

    def __getitem__(self, name: str) -> dict[str, str]:
        name = deref(self._session, name)
        if var_hidden(self._session.hidden_vars, name):
            raise KeyError(name)
        var = self._session.vars[name]
        if not isinstance(var.value, dict):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.hidden_vars
        for name, var in self._session.vars.items():
            if isinstance(var.value, dict) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_assocs(session: Session) -> Mapping[str, dict[str, str]]:
    """The associative arrays a reader tier should resolve names
    against.

    Args:
        session (Session): the session holding the arrays.
    """
    return _VisibleAssocs(session)


def strip_key_quotes(text: str) -> str:
    """Remove one surrounding quote pair from an associative subscript.

    An arithmetic reference carries its subscript verbatim, so
    ``m["x"]`` arrives with the quotes bash would have removed; one
    layer comes off and anything else is the key itself.

    Args:
        text (str): the raw subscript text.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def element_index(subscript: str,
                  env: Mapping[str, str],
                  elements: ElementOps | None = None) -> int:
    """Resolve an indexed subscript in arithmetic context.

    bash evaluates indexed subscripts as arithmetic (``a[i+1]``); an
    unresolvable expression indexes element 0, mirroring bash's
    unset-name-is-zero arithmetic rule.

    Args:
        subscript (str): the raw subscript text.
        env (Mapping[str, str]): environment for name resolution.
        elements (ElementOps | None): element callbacks, so a nested
            reference (``a[b[0]]``) resolves too.
    """
    try:
        return int(subscript.strip())
    except ValueError:
        pass
    try:
        return evaluate_arith(subscript, env, elements=elements).value
    except ArithError:
        return 0


class _SessionElements:
    """The ``ElementOps`` implementation bound to one session.

    A class rather than closures because the resolver recurses: an
    indexed subscript is arithmetic and may itself hold an element
    reference, so ``resolve`` hands the evaluator the same pair of
    callbacks it is one of. It lives beside the other reader
    projections because the session door needs it too: the ``-i``
    coercion evaluates ``n=a[1]+1`` at the write, and a resolver that
    imported the door would close a cycle.
    """

    __slots__ = ("_session", )

    def __init__(self, session: Session) -> None:
        self._session = session

    def resolve(self, name: str, subscript: str, env: Mapping[str,
                                                              str]) -> str:
        """Canonical key for one reference.

        Args:
            name (str): the array variable's name.
            subscript (str): the raw subscript text.
            env (Mapping[str, str]): the evaluator's current view,
                pending assignments included.
        """
        if name in visible_assocs(self._session):
            return strip_key_quotes(subscript)
        idx = element_index(subscript, env, session_elements(self._session))
        if idx < 0:
            arr = visible_arrays(self._session).get(name)
            if arr is not None:
                idx += array_extent(arr)
            elif env_get(self._session, name) is not None:
                idx += 1
            if idx < 0:
                raise ArithError(f"{name}[{subscript}]: bad array subscript")
        return str(idx)

    def read(self, name: str, key: str) -> str | None:
        """The element's stored text, None when unset.

        Args:
            name (str): the array variable's name.
            key (str): the canonical key ``resolve`` produced.
        """
        session = self._session
        amap = visible_assocs(session).get(name)
        if amap is not None:
            return amap.get(key)
        arr = visible_arrays(session).get(name)
        idx = int(key)
        if arr is None:
            scalar = env_get(session, name)
            if scalar is None:
                return None
            return scalar if idx == 0 else None
        return array_get(arr, idx) if array_has(arr, idx) else None


def session_elements(session: Session) -> ElementOps:
    """Element callbacks bound to one session, for ``evaluate_arith``.

    Args:
        session (Session): the session references resolve against.
    """
    bound = _SessionElements(session)
    return ElementOps(resolve=bound.resolve, read=bound.read)


def _integer_text(session: Session, text: str) -> str:
    """The `-i` coercion: evaluate the incoming text as arithmetic.

    Reads resolve against the visible env, so `n=x+1` sees `x`, and
    element references resolve through the session's resolver, so
    `n=a[1]+1` and `n=m[k]+1` see the element; an unresolvable name is
    0 (`n=abc` stores `0`), which is the arithmetic rule, not a
    refusal. A malformed expression raises ArithError, and the caller
    decides how to voice it (bash aborts the line with the evaluator's
    own message).

    Args:
        session (Session): the session the expression reads.
        text (str): the incoming value.
    """
    try:
        return str(
            evaluate_arith(text,
                           visible_env(session),
                           elements=session_elements(session)).value)
    except ArithError as exc:
        # The offending text leads, which is how every caller voices it
        # (`bash: 1+: syntax error: operand expected`), so it is spelled
        # once here rather than at each of the sites that catch it.
        raise ArithError(f"{text}: {exc}") from exc


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


async def set_var(session: Session,
                  policies: Policies | None,
                  name: str,
                  value: ShellValue,
                  follow_ref: bool = True) -> None:
    """Write one variable through the session plane's gate.

    General over variable shapes: a string stores a scalar, a
    ShellArray stores an indexed array, a dict stores an associative
    one, and the storages stay exclusive. Semantics live here once —
    readonly refusal, the ``pre_session`` policy gate (whose context
    value renders an array as its present elements joined by spaces,
    an associative one in sorted-key order), then the store — so
    every writer states them the same way whichever tier or spelling
    asked. Writers with richer mechanics (subscripts, appends, holes)
    compute the resulting value on a copy and hand it here, so a
    denial never leaves a half-applied write. None policies gate
    nothing (a writer outside a workspace).

    Args:
        session (Session): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        value (ShellValue): the value to store.
        follow_ref (bool): resolve a ``declare -n`` reference to its
            target first, which is what every ordinary assignment does.
            ``declare -n r=w`` on an existing reference is the one
            writer that re-aims the reference instead, and passes False.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: the name is hidden for this session, or a
            pre_session policy refused the write.
    """
    if follow_ref:
        name = deref(session, name) or name
    ensure_var_visible(session, name)
    # The record, not the `readonly_vars` projection: that property
    # rebuilds a frozenset over every variable in the session, and this
    # is the hot path every assignment takes. TypeScript's `setVar` has
    # always read the record directly. `ensure_var_visible` has already
    # refused a hidden name, so the two answer identically here.
    if env_is_readonly(session, name):
        raise ReadonlyVariableError(name)
    existing = session.vars.get(name)
    # Attributes belong to the name, not to the value, so a plain
    # assignment keeps them: `declare -i n; n=3` stays an integer. The
    # old two-container store had to remember to evict the name from
    # whichever container it was not landing in; one record cannot
    # disagree with itself that way. The value-shaping attributes
    # (`-i -l -u`) apply here, at the write, which is where bash applies
    # them: `declare -l s; s=ABC` stores `abc`, so every reader agrees
    # without per-read work. `-i` evaluates against the visible env,
    # and a bad expression raises the arithmetic error as bash does.
    # Coercion runs before the gate so a rule judges the value that
    # will land: `declare -l profile; profile=ADMIN` stores `admin`, and a
    # rule refusing `admin` must see that, not the raw text.
    if existing is not None and existing.attrs:
        value = coerce_value(value, existing.attrs,
                             functools.partial(_integer_text, session))
    if isinstance(value, str):
        rendered = value
    elif isinstance(value, dict):
        rendered = " ".join(value[k] for k in sorted(value))
    else:
        rendered = " ".join(array_values(value))
    await pre_session_gate(
        policies,
        SessionContext(plane="env",
                       verb="set",
                       key=name,
                       value=rendered,
                       session_id=session.session_id))
    stored = ShellVar(value) if existing is None else with_value(
        existing, value)
    # An agent write to a managed name shadows session-locally: the
    # pointer drops and the record becomes a plain variable for this
    # session only. Only the host-tier fill step writes pointer-keeping
    # records, and it goes directly into `session.vars`, not here.
    if stored.managed is not None:
        stored = detach(stored)
    # `set -a` marks every name assigned *while it is on*, which is why
    # it is read here at write time rather than applied to the session
    # in bulk when the option flips: `B=1; set -a; C=2; set +a; D=3`
    # exports only C.
    if session.shell_options.get("allexport"):
        stored = with_attr(stored, VarAttr.EXPORT)
    session.vars[name] = stored


async def unset_var(session: Session,
                    policies: Policies | None,
                    name: str,
                    follow_ref: bool = True) -> None:
    """Drop one variable through the session plane's gate; a missing
    name is quiet.

    Args:
        session (Session): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        follow_ref (bool): resolve a ``declare -n`` reference to its
            target, which is what ``unset r`` does in bash; ``unset -n r``
            drops the reference itself and passes False.

    Raises:
        ReadonlyVariableError: the name is readonly.
        PolicyDenied: a pre_session policy refused the write.
    """
    if follow_ref:
        name = deref(session, name) or name
    if var_hidden(session.hidden_vars, name):
        # Hidden reads as unset and bash's unset of a missing name is
        # a quiet no-op; popping the real value would let a session
        # mutate state it cannot see.
        return
    # Same as `set_var`: the record, not the projection. The hidden
    # branch above has already returned, so the answers match.
    if env_is_readonly(session, name):
        raise ReadonlyVariableError(name)
    await pre_session_gate(
        policies,
        SessionContext(plane="env",
                       verb="unset",
                       key=name,
                       value=None,
                       session_id=session.session_id))
    session.vars.pop(name, None)


def seed_var(session: Session, name: str, value: ShellValue) -> None:
    """Write a variable without consulting the gate.

    Two kinds of caller. One is seeding a session before it is handed
    out: the embedder populating an environment, a test arranging
    state. `visible_arrays` already names this case ("the embedder can
    seed session.arrays before narrowing"). The other is the shell
    writing its own bookkeeping -- ``$PWD``/``$OLDPWD`` after a ``cd``,
    ``BASH_REMATCH`` after a ``[[ =~ ]]``, the loop variable a ``for``
    puts back when it ends -- which are the shell's to maintain, not
    the session's to admit, and which a ``pre_session`` rule refusing
    them could only break.

    A variable the *line* named goes through `SessionView.set` instead,
    which is the whole point of the store being read-only from outside.
    One caller is neither, and is called out here rather than left to
    be discovered: `execute_command` lands a prefix assignment
    (``FOO=bar cmd``) through this door. That is not a way around the
    gate. The same site asks ``ensure_var_visible`` and then
    ``pre_session``, with the value, before it seeds anything, because
    a prefix assignment is a session write like any other and the form
    exports the name for the command. A refusal there takes the whole
    statement, which is a deliberate divergence: GNU prints its
    readonly refusal, runs the command anyway and exits 0.

    Args:
        session (Session): the session being seeded.
        name (str): variable name.
        value (ShellValue): the value to store.
    """
    existing = session.vars.get(name)
    session.vars[name] = (ShellVar(value) if existing is None else with_value(
        existing, value))


def set_attr(session: Session,
             name: str,
             attr: VarAttr | None,
             on: bool = True) -> None:
    """Turn one attribute on or off, creating the name if needed.

    bash's `readonly NAME` / `export NAME` on a name that does not exist
    yet marks it anyway, and the name stays *unset*: GNU prints
    `declare -r ONLY` with no value and `${ONLY-d}` still expands to
    `d`. So the record is created with no value, not with an empty
    string.

    A None attribute changes no attribute and only ensures the name
    exists, which is what a bare `local L` / `declare D` does: GNU
    answers `declare -- L` and `${L-d}` still expands to `d`, so those
    two cannot route through a value writer either.

    Args:
        session (Session): the session being written.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name and change nothing.
        on (bool): set it, or clear it.
    """
    existing = session.vars.get(name, ShellVar())
    session.vars[name] = (existing if attr is None else with_attr(
        existing, attr, on))


async def mark_var(session: Session,
                   policies: Policies | None,
                   name: str,
                   attr: VarAttr | None,
                   on: bool = True) -> None:
    """Turn one attribute on or off through the session plane's gate.

    The no-value writer beside ``set_var``. ``export NAME``,
    ``readonly NAME`` and a bare ``local NAME`` on a fresh name write no
    value at all -- the name stays unset and merely declared -- so
    routing them through ``set_var`` would have to invent one, and
    inventing ``""`` is exactly the divergence that made ``export Z``
    show up in ``env`` and ``${L-d}`` stop expanding to ``d``. A None
    attribute declares the name and changes no attribute.

    Gated all the same, because a mark is still a session write: a
    hidden name refuses, and ``pre_session`` sees it with a None value,
    which is how a rule tells a mark from an assignment if it cares.
    Skipping the gate here would let a line the agent types put an
    attribute on a name the deployment refused it.

    Args:
        session (Session): the session being written.
        policies (Policies | None): admission policies the mark clears.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name and change nothing.
        on (bool): set it, or clear it.

    Raises:
        PolicyDenied: the name is hidden for this session, or a
            pre_session policy refused the mark.
    """
    # `readonly r` and `export r` on a reference mark what it points at,
    # as bash does; the nameref attribute itself is the one mark that
    # belongs to the reference's own record, on and off.
    if attr is not VarAttr.NAMEREF:
        name = deref(session, name) or name
    ensure_var_visible(session, name)
    await pre_session_gate(
        policies,
        SessionContext(plane="env",
                       verb="set",
                       key=name,
                       value=None,
                       session_id=session.session_id))
    set_attr(session, name, attr, on)


def session_view(session: Session,
                 policies: Policies | None = None) -> SessionView:
    """The session plane's view: six facts bound to one session.

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
                       mark=functools.partial(mark_var, session, policies),
                       is_readonly=functools.partial(env_is_readonly, session))
