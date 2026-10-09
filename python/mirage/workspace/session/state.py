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
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import replace

from mirage.policy import Policies, PolicyDenied, pre_session_gate
from mirage.policy.types import SessionContext
from mirage.shell.arith import evaluate_arith, plain_decimal
from mirage.shell.array import (
    ShellArray,
    array_extent,
    array_get,
    array_has,
    array_values,
    array_with,
    make_array,
)
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import (
    FUNCNAME,
    PIPESTATUS,
    RANDOM,
    RANDOM_MODULUS,
    RANDOM_UNSET,
)
from mirage.shell.errors import ArithError, ExitSignal, ReadonlyError
from mirage.shell.types import ArithResult, ArithWrite, ElementOps
from mirage.shell.variable import (
    ShellValue,
    ShellVar,
    TempEnv,
    VarAttr,
    coerce_value,
    detach,
    with_attr,
    with_value,
)
from mirage.utils.hidden import var_hidden
from mirage.view.types import EnvSet, SessionView
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.rng import draw, initial_seed
from mirage.workspace.session.session import SessionState


def env_snapshot(session: SessionState) -> dict[str, str]:
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

    Diverges from bash on one point: bash also carries each function
    ``export -f`` marked, as a ``BASH_FUNC_NAME%%`` entry. mirage hands
    those to a nested shell directly (``SessionState.new_shell``), so
    neither ``env`` nor a runtime lists them.

    Args:
        session (SessionState): the session whose env to copy.
    """
    return {
        name: var.value
        for name, var in session.vars.items()
        if isinstance(var.value, str)
        and VarAttr.EXPORT in var.attrs
        and not var_hidden(session.visibility, name)
    }


def exported_names(session: SessionState) -> list[str]:
    """The names carrying the export attribute, sorted, hidden removed.

    Wider than `env_snapshot`'s keys by exactly the unset ones: a name
    `export Z` marked but never assigned is listed by `export -p` as
    `declare -x Z` while staying out of the environment. So the
    printers read this and the process view reads `env_snapshot`,
    rather than one of them re-deriving the other's filter.

    Args:
        session (SessionState): the session to read.
    """
    return sorted(
        name
        for name, var in session.vars.items()
        if VarAttr.EXPORT in var.attrs
        and not var_hidden(session.visibility, name)
    )


def nameref_target(session: SessionState, name: str) -> str | None:
    """The name a ``declare -n`` reference points at, None otherwise.

    None also for a reference declared but not yet aimed (``declare -n
    r`` before ``r=v``): bash treats the first assignment to such a
    reference as naming its target, so until then it stands for nothing.

    Args:
        session (SessionState): the session holding the record.
        name (str): variable name.
    """
    var = session.vars.get(name)
    if var is None or VarAttr.NAMEREF not in var.attrs:
        return None
    return var.value if isinstance(var.value, str) and var.value else None


def deref(session: SessionState, name: str) -> str:
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
        session (SessionState): the session holding the records.
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


def env_get(session: SessionState, name: str) -> str | None:
    """The variable's value, None when unset or hidden.

    Sync on purpose: ``$X`` expansion is the hot path, so a read stays
    a dict lookup plus the hidden check. A name reference reads its
    target.

    Args:
        session (SessionState): the session holding the environment.
        name (str): variable name.
    """
    name = deref(session, name)
    if var_hidden(session.visibility, name):
        return None
    var = session.vars.get(name)
    return (
        var.value if var is not None and isinstance(var.value, str) else None
    )


def env_is_readonly(
    session: SessionState, name: str, follow_ref: bool = True
) -> bool:
    """Whether ``readonly`` has marked the name.

    A hidden name answers False: is_readonly speaks about the
    session's visible world, and calling a name that reads as unset
    "readonly" would leak it.

    Args:
        session (SessionState): the session holding the readonly set.
        name (str): variable name.
        follow_ref (bool): ask about what a ``declare -n`` reference
            points at; a write to the reference itself (``declare -n
            r=w``, ``unset -n r``) asks about the reference.
    """
    if follow_ref:
        name = deref(session, name)
    if var_hidden(session.visibility, name):
        return False
    var = session.vars.get(name)
    return var is not None and VarAttr.READONLY in var.attrs


class _VisibleEnv(Mapping[str, str]):
    """A live, read-only view of the session env minus hidden names.

    Handed to expansion instead of a filtered copy so a ``$X`` read
    stays one dict lookup plus the hidden check, and later writes to
    the session show through without rebuilding anything.
    """

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> str:
        name = deref(self._session, name)
        if var_hidden(self._session.visibility, name):
            raise KeyError(name)
        var = self._session.vars[name]
        if not isinstance(var.value, str):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.visibility
        for name, var in self._session.vars.items():
            if isinstance(var.value, str) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_env(session: SessionState) -> Mapping[str, str]:
    """The env mapping a reader tier should resolve names against.

    Always the live view, never ``session.env``: that property is a
    projection built fresh on every access, so handing it out would
    copy the whole store per read *and* freeze the answer at that
    moment. The view costs one dict lookup plus the hidden check per
    name and shows later writes through. Read-only by type: writers go
    through ``set_var``/``unset_var``, never a mapping.

    Args:
        session (SessionState): the session holding the environment.
    """
    return _VisibleEnv(session)


class _VisibleArrays(Mapping[str, ShellArray]):
    """A live, read-only view of the session arrays minus hidden names.

    The arrays twin of ``_VisibleEnv``: the embedder can seed
    ``session.arrays`` before narrowing, so a hidden name can hold an
    array and array reads need the same filter env reads get.
    """

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> ShellArray:
        name = deref(self._session, name)
        if var_hidden(self._session.visibility, name):
            raise KeyError(name)
        if name == PIPESTATUS:
            return [str(code) for code in self._session.pipe_status]
        if name == FUNCNAME and self._session.function_names is not None:
            return list(self._session.function_names)
        var = self._session.vars[name]
        if not isinstance(var.value, list):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        # PIPESTATUS and FUNCNAME answer a lookup (and so `in`, which
        # Mapping derives from the lookup) and never list: bash's
        # `declare -p PIPESTATUS` is `not found`, and an assignment to
        # either is ignored, which this view honors by answering the
        # session's record before the store.
        hidden = self._session.visibility
        for name, var in self._session.vars.items():
            if isinstance(var.value, list) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_arrays(session: SessionState) -> Mapping[str, ShellArray]:
    """The arrays mapping a reader tier should resolve names against.

    Args:
        session (SessionState): the session holding the arrays.
    """
    return _VisibleArrays(session)


class _VisibleAssocs(Mapping[str, dict[str, str]]):
    """A live, read-only view of the associative arrays minus hidden
    names.

    The third sibling beside ``_VisibleEnv`` and ``_VisibleArrays``,
    for the same reason both exist: the embedder can seed a hidden name
    with any value shape, so every reader tier filters the same way.
    """

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def __getitem__(self, name: str) -> dict[str, str]:
        name = deref(self._session, name)
        if var_hidden(self._session.visibility, name):
            raise KeyError(name)
        var = self._session.vars[name]
        if not isinstance(var.value, dict):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        hidden = self._session.visibility
        for name, var in self._session.vars.items():
            if isinstance(var.value, dict) and not var_hidden(hidden, name):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


def visible_assocs(session: SessionState) -> Mapping[str, dict[str, str]]:
    """The associative arrays a reader tier should resolve names
    against.

    Args:
        session (SessionState): the session holding the arrays.
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


async def _land_writes(
    session: SessionState, store: EnvSet, writes: Sequence[ArithWrite]
) -> None:
    """Land arithmetic assignments in order, each as the whole variable
    it produces, so a refusal never leaves one half-applied.

    Each lands the way ``assign_element`` lands one: through a
    reference on its target, a bare name over an array at element 0
    (``A=(old keep); n='A=9'`` keeps ``keep``), naming the element it
    assigns so an ``-i`` array never runs its other elements again
    (``A=(0 'x++'); declare -i A; (( A[0]=9 ))`` leaves ``x++``). Both
    of its contexts, a subscript and an ``-i`` value, end the shell on
    a readonly name (``declare -i n; ( n='R=3'; echo no )`` ends only
    the subshell).

    Args:
        session (SessionState): the session the writes read.
        store (EnvSet): the session view each write goes through.
        writes (Sequence[ArithWrite]): the assignments, in order.

    Raises:
        ExitSignal: an assignment named a readonly variable.
        PolicyDenied: the session view refused an assignment.
    """
    for write in writes:
        name = deref(session, write.name) or write.name
        assoc = visible_assocs(session).get(name)
        arr = visible_arrays(session).get(name)
        value: ShellValue = write.value
        assigned: frozenset[int | str] | None = None
        if assoc is not None:
            key = "0" if write.key is None else write.key
            value = {**assoc, key: write.value}
            assigned = frozenset({key})
        elif write.key is not None or arr is not None:
            index = 0 if write.key is None else int(write.key)
            if arr is None:
                # A scalar becomes element 0, as `assign_element` turns
                # it (`x=7; n='x[1]=5'` keeps the 7).
                scalar = conversion_scalar(session, name)
                arr = make_array([] if scalar is None else [scalar])
            value = array_with(arr, index, write.value)
            assigned = frozenset({index})
        try:
            await store(name, value, assigned=assigned)
        except ReadonlyVariableError as exc:
            raise ReadonlyError(exc.name).signal(fatal=True) from exc


async def subscript_index(
    session: SessionState, subscript: str, view: SessionView | None = None
) -> int:
    """An indexed subscript resolved outside an arithmetic expression:
    ``${a[i]}``, ``a[i]=v``, ``unset 'a[i]'``, ``[[ -v a[i] ]]``.

    The subscript is arithmetic, so it may assign (``a[x=3]``) and seed
    (``a[RANDOM=42]``), and bash binds those as it evaluates them. Each
    lands through the session view once the index is known, then the ``RANDOM``
    reader replays the draws made after the seed. A subscript that
    fails to evaluate lands what it assigned before failing and then
    raises, the subscript text leading the message, since bash aborts
    the line on it (``${a[1/0]}`` is ``1/0: division by 0``) rather
    than reading element 0.

    Args:
        session (SessionState): the session the subscript reads.
        subscript (str): the raw subscript text.
        view (SessionView | None): the gated session view the assignments land
            through; None lands them ungated, outside a workspace.

    Raises:
        PolicyDenied: the session view refused an assignment.
        ExitSignal: an assignment named a readonly variable, which ends
            the shell wherever a subscript is (``${a[R=3]}``).
        ArithError: the subscript does not evaluate, or an assigned name
            carries ``-i`` and the value does not evaluate.
    """
    plain = plain_decimal(subscript)
    if plain is not None:
        return plain
    reader = random_reader(session)
    error: ArithError | ReadonlyError | None = None
    idx = 0
    try:
        result = session_arith(
            session,
            subscript,
            reader,
            nounset=bool(session.shell_options.get("nounset")),
        )
        idx, writes = result.value, result.writes
    except (ArithError, ReadonlyError) as exc:
        error, writes = exc, exc.writes
    await _land_writes(
        session,
        view.set
        if view is not None
        else functools.partial(set_var, session, None),
        writes,
    )
    reader.settle()
    if isinstance(error, ReadonlyError):
        raise error.signal(fatal=True) from error
    if error is not None:
        raise error
    return idx


class _SessionElements:
    """The ``ElementOps`` implementation bound to one session.

    It lives beside the other reader projections because the session
    view needs it too: the ``-i`` coercion evaluates ``n=a[1]+1`` at the
    write, and a resolver that imported the session view would close a
    cycle.
    """

    __slots__ = ("_session",)

    def __init__(self, session: SessionState) -> None:
        self._session = session

    def resolve(
        self, name: str, subscript: str, env: Mapping[str, str]
    ) -> str:
        """Canonical key for one reference.

        Args:
            name (str): the array variable's name.
            subscript (str): an associative array's raw subscript text,
                or an indexed one's index, which the evaluator has
                already read as arithmetic.
            env (Mapping[str, str]): the evaluator's current view,
                pending assignments included.
        """
        if name in visible_assocs(self._session):
            return strip_key_quotes(subscript)
        idx = int(subscript)
        if idx < 0:
            arr = visible_arrays(self._session).get(name)
            if arr is not None:
                idx += array_extent(arr)
            elif env_get(self._session, name) is not None:
                idx += 1
            if idx < 0:
                raise ArithError("bad array subscript", f"{name}[{subscript}]")
        return str(idx)

    def is_assoc(self, name: str) -> bool:
        """Whether the name holds an associative array.

        Args:
            name (str): the array variable's name.
        """
        return name in visible_assocs(self._session)

    def holds_array(self, name: str) -> bool:
        """Whether the name holds an array, indexed or associative.

        Args:
            name (str): the variable's name.
        """
        return name in visible_assocs(self._session) or name in visible_arrays(
            self._session
        )

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


def session_elements(session: SessionState) -> ElementOps:
    """Element callbacks bound to one session, for ``evaluate_arith``.

    Args:
        session (SessionState): the session references resolve against.
    """
    bound = _SessionElements(session)
    return ElementOps(
        resolve=bound.resolve,
        read=bound.read,
        is_assoc=bound.is_assoc,
        holds_array=bound.holds_array,
    )


def seed_from(word: str, session: SessionState) -> int:
    """Evaluate a host-supplied seed; invalid arithmetic propagates.

    Read without the generator on offer: a host word naming ``RANDOM``
    would otherwise draw, and the draw reseed, without end.

    Args:
        word (str): the seed expression.
        session (SessionState): the session the expression reads.
    """
    value = evaluate_arith(
        word, visible_env(session), elements=session_elements(session)
    ).value
    return value % RANDOM_MODULUS


def next_random(session: SessionState, stored: str | None) -> int | None:
    """Draw from the session generator, or None after RANDOM is unset.

    Shell assignments validate and seed at the session view. A host-seeded
    variable is consumed here on its first read. The last draw is separate
    from the stored word because a reseed resets repeat suppression to zero.

    Args:
        session (SessionState): generator and variable state.
        stored (str | None): the visible RANDOM value.
    """
    if session._random_seed == RANDOM_UNSET or (
        stored is None and session._random_seed is not None
    ):
        return None
    seed = (
        seed_from(stored, session)
        if stored is not None and stored != session._random_seed
        else None
    )
    if seed is not None:
        state = seed
        last = 0
    elif session._random_state is None:
        state = initial_seed(session.session_id)
        last = 0
    else:
        state = session._random_state
        last = session._random_last
    state, value = draw(state, last)
    session._random_state = state
    session._random_last = value
    word = str(value)
    existing = session.vars.get(RANDOM)
    session.vars[RANDOM] = (
        replace(existing, value=word)
        if existing is not None
        else ShellVar(word)
    )
    session._random_seed = word
    return value


def note_random_kind(
    session: SessionState, name: str, value: ShellValue
) -> None:
    """End ``RANDOM``'s special meaning when a non-string lands on it.

    Once bash turns ``RANDOM`` into an array it neither draws nor seeds,
    so ``RANDOM=(1 2)``, ``declare -a RANDOM``,
    ``RANDOM[1]=5`` and ``RANDOM+=(3)`` all leave an ordinary array that
    ``$RANDOM`` reads element 0 of, for good, as ``unset RANDOM`` does.
    Every store entry point calls this, gated or not, since a host seeding an
    array onto the name means the same thing.

    Args:
        session (SessionState): the session the store landed in.
        name (str): the variable stored.
        value (ShellValue): what it now holds.
    """
    if name == RANDOM and not isinstance(value, str):
        session._random_seed = RANDOM_UNSET


def conversion_scalar(session: SessionState, name: str) -> str | None:
    """The scalar an array conversion keeps as element 0.

    When bash turns a variable into an array, its current value becomes
    element 0, and for a live ``RANDOM`` looking the name up is
    what draws: ``RANDOM[1]=5`` leaves ``[0]`` holding one draw and
    ``declare -a RANDOM`` one alone, after which the array is ordinary.

    Args:
        session (SessionState): the session the conversion happens in.
        name (str): the variable turning into an array.
    """
    if name == RANDOM:
        drawn = next_random(session, visible_env(session).get(RANDOM))
        if drawn is not None:
            return str(drawn)
    return session.env.get(name)


class RandomReader:
    """Arithmetic's reads of ``$RANDOM``, bound to one session.

    A read before the expression assigns ``RANDOM`` draws from the
    session generator. bash seeds at the instant of an assignment and
    every later read draws from the new seed (``$((RANDOM=42, RANDOM))``
    is the first draw after seeding with 42). Here the assignment is
    still pending at the session view, which lands it gated after
    evaluation, so the evaluator tells the reader of each assignment as
    it is made (``wrote``), the reader seeds a scratch generator the way
    the session view will and draws from that, and ``settle`` replays the draws
    on the session once the session view has seeded it: the session ends where
    bash's does, seeded and advanced by every read since the last
    assignment, and the write still reaches the gate as the assignment
    it is. Each assignment restarts the scratch generator and the count,
    since the session view lands only the last value written, and the draws are
    replayed only if the session view did land it: an assignment the caller
    never applied leaves the session as it was.

    Lives beside the session view rather than with the generator because the
    session view needs it too: ``RANDOM=RANDOM`` draws once while the seed is
    evaluated, then seeds with the draw, as bash does: it reads an
    assigned seed as an arithmetic expression.

    Args:
        session (SessionState): generator and visibility state.
    """

    def __init__(self, session: SessionState) -> None:
        self.session = session
        self.seeded: str | None = None
        self.state = 0
        self.last = 0
        self.draws = 0

    def _special(self, name: str) -> bool:
        session = self.session
        return (
            name == RANDOM
            and not var_hidden(session.visibility, name)
            and session._random_seed != RANDOM_UNSET
        )

    def read(self, name: str) -> str | None:
        """The dynamic value of a name, None for a name that has none.

        Args:
            name (str): the variable the expression reads.
        """
        if not self._special(name):
            return None
        if self.seeded is None:
            value = next_random(
                self.session, visible_env(self.session).get(name)
            )
            return None if value is None else str(value)
        self.state, value = draw(self.state, self.last)
        self.last = value
        self.draws += 1
        return str(value)

    def wrote(self, name: str, value: str) -> None:
        """Note an assignment the expression made.

        Args:
            name (str): the variable assigned.
            value (str): the value, an integer's text.
        """
        if not self._special(name):
            return
        self.seeded = value
        self.state = int(value) % RANDOM_MODULUS
        self.last = 0
        self.draws = 0

    def settle(self) -> None:
        """Replay the scratch draws on the session generator, once the
        session view has seeded it with the value the expression assigned."""
        if self.seeded is None or self.session._random_seed != self.seeded:
            return
        for _ in range(self.draws):
            next_random(self.session, visible_env(self.session).get(RANDOM))
        self.draws = 0


def random_reader(session: SessionState) -> RandomReader:
    """Bind arithmetic ``$RANDOM`` reads to a session.

    Args:
        session (SessionState): generator and visibility state.
    """
    return RandomReader(session)


def session_arith(
    session: SessionState,
    text: str,
    reader: RandomReader,
    nounset: bool = False,
    added: str | None = None,
) -> ArithResult:
    """Evaluate ``text`` as every arithmetic context of the shell does:
    against the visible env and the session's elements, drawing through
    ``reader``, and stopping at a write to a readonly name, as bash's
    evaluation does (``(( X=5, R=3 ))`` binds X and refuses R).

    Args:
        session (SessionState): the session the expression reads.
        text (str): the expression.
        reader (RandomReader): the expression's ``RANDOM`` reader.
        nounset (bool): ``set -u`` for the names it reads.
        added (str | None): an integer ``+=``'s added text, read after
            ``text`` in the same evaluation and added to it.

    Raises:
        ArithError: the text does not evaluate.
        ReadonlyError: an assignment named a readonly variable; its
            ``writes`` are the ones made before it.
    """
    return evaluate_arith(
        text,
        visible_env(session),
        elements=session_elements(session),
        read_var=reader.read,
        wrote_var=reader.wrote,
        nounset=nounset,
        frozen=functools.partial(_readonly_target, session),
        added=added,
    )


def _readonly_target(session: SessionState, name: str) -> str | None:
    """The readonly variable a write to ``name`` reaches, through a
    ``declare -n`` reference, which the refusal names; None when the
    write lands.

    Args:
        session (SessionState): the session holding the readonly marks.
        name (str): the name the expression writes.
    """
    target = deref(session, name)
    return target if env_is_readonly(session, target, False) else None


class _IntegerCoercion:
    """The `-i` coercion and the ``RANDOM`` seed, as one evaluation.

    The incoming text evaluates as arithmetic against the visible env,
    element references resolving through the session's resolver, so
    `n=x+1` sees `x` and `n=a[1]+1` the element; an unresolvable name
    is 0 (`n=abc` stores `0`), the arithmetic rule, not a refusal.
    ``RANDOM`` draws, as in every other arithmetic context, so `n=RANDOM`
    and a `RANDOM=RANDOM` seed both advance the generator. The
    assignments the expression makes are kept for the session view to land
    (``_land_coercion``): bash binds `x` in `n='x=5'` and in
    `RANDOM='x=5'`, before the error too if the expression then fails.
    A malformed expression raises ArithError with the offending text
    leading, the way every caller voices it; a write to a readonly name
    ends the shell (``ExitSignal``), as bash's coercion does, where a
    seed (``evaluate``) reports it the way it reports a malformed one.

    Args:
        session (SessionState): the session the expression reads.
    """

    def __init__(self, session: SessionState) -> None:
        self.session = session
        self.reader = random_reader(session)
        self.writes: list[ArithWrite] = []

    def __call__(self, text: str, added: str | None = None) -> str:
        try:
            return self.evaluate(text, added)
        except ReadonlyError as exc:
            raise exc.signal(fatal=True) from exc

    def evaluate(self, text: str, added: str | None = None) -> str:
        """The value ``text`` evaluates to, keeping the writes it made
        before an ``ArithError`` or a ``ReadonlyError``.

        With ``added``, the two sides of an integer ``+=`` (``appended``)
        evaluate in turn in one evaluation and add: the second sees what
        the first assigned, and an error names the side that made it, as
        bash's does (``N+=1+`` is ``1+: syntax error``).

        Args:
            text (str): the expression, the held value for a ``+=``.
            added (str | None): a ``+=``'s added text.
        """
        session = self.session
        # Inside a `declare -g` the expression still reads the
        # function's scope, as bash's does (`local H=2; declare -gi
        # G=H` stores 2), while the value lands on the global.
        reach_again = _step_back(session)
        try:
            result = session_arith(session, text, self.reader, added=added)
        except (ArithError, ReadonlyError) as exc:
            self.writes.extend(exc.writes)
            raise
        finally:
            reach_again()
        self.writes.extend(result.writes)
        return str(result.value)


async def _land_coercion(
    session: SessionState, store: EnvSet, coercion: _IntegerCoercion
) -> None:
    """Land the assignments a coercion made, each through the session view, in
    the scope it read, then settle its ``RANDOM`` draws.

    Inside a ``declare -g`` that is the function's: ``local G=3; declare
    -gi G='G=G+10'`` leaves the local at 13 and stores 13 globally, as
    bash's does (``_step_back``).

    Args:
        session (SessionState): the shell session.
        store (EnvSet): the session view each write goes through.
        coercion (_IntegerCoercion): the evaluation that made the writes.
    """
    reach_again = _step_back(session)
    try:
        await _land_writes(session, store, coercion.writes)
    finally:
        reach_again()
    coercion.reader.settle()


async def evaluate_integer(
    session: SessionState,
    view: SessionView,
    text: str,
    added: str | None = None,
) -> str:
    """Evaluate ``text`` as an ``-i`` write coerces it, land what it
    assigns through ``view``, and give back the value: a ``declare -ni
    r=M`` value, which bash evaluates before refusing the reference
    (``M='X=5'`` sets X). Inside a ``declare -g`` it reads the
    function's scope, as the coercion does.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the gated session view.
        text (str): the value, the held one for a ``r+=M``.
        added (str | None): a ``r+=M``'s added text, evaluated after
            ``text`` in the same evaluation and added to it.

    Raises:
        PolicyDenied: an assignment named a hidden variable or the gate
            refused it; the ones before it have landed.
        ExitSignal: an assignment named a readonly variable, which
            ends the shell, as bash's does.
        ArithError: the text does not evaluate; the assignments made
            before the error have landed.
    """
    coercion = _IntegerCoercion(session)
    try:
        return coercion(text, added)
    finally:
        await _land_coercion(session, view.set, coercion)


def appended(
    held: ShellValue | None, added: str, integer: bool
) -> tuple[str, str | None]:
    """What a ``+=`` hands ``set_var``: the held text then the added one,
    or on an integer the held text with the added one as ``added``, the
    two evaluating there in turn and summing behind the store's
    refusals. The held value evaluates too, so ``n='x=5'; declare -i n;
    n+=x`` stores 10, and an empty side counts as 0. An array extends
    element 0 and a map key ``"0"`` (``S=x; declare -a S+=y`` gives
    ``([0]="xy")``).

    Args:
        held (ShellValue | None): what the slot holds, None when unset.
        added (str): the text appended.
        integer (bool): the variable carries ``-i``.
    """
    if isinstance(held, dict):
        held = held.get("0")
    elif isinstance(held, list):
        held = array_get(held, 0)
    text = held or ""
    return (text, added) if integer else (text + added, None)


def ensure_var_visible(session: SessionState, name: str) -> None:
    """Refuse a write that names a hidden variable.

    The sync half of ``set_var``'s hidden gate, shared with the
    expansion-time writers that land on the raw env (``${X:=d}``,
    ``$((X=5))``, ``printf -v``): a landed write would clobber the real
    value the host's wiring still reads, and a swallowed one would
    gaslight the writer; refuse loudly instead, the vars twin of EACCES
    on a create into hidden path space.

    Args:
        session (SessionState): the session being written.
        name (str): variable name.

    Raises:
        PolicyDenied: the name is hidden for this session.
    """
    if var_hidden(session.visibility, name):
        raise PolicyDenied(errno.EACCES, f"{name}: permission denied", name)


# The names the shell maintains itself (`seed_var`'s second caller): a
# `cd` writes the first two and `[[ =~ ]]` the third, ungated, because
# they are the shell's to keep current rather than the session's to admit.
SHELL_BOOKKEEPING = frozenset({"PWD", "OLDPWD", "BASH_REMATCH"})


def gate_rendering(value: ShellValue | None) -> str | None:
    """The value a ``pre_session`` hook is shown for one variable.

    A scalar as itself, an indexed array as its present elements joined
    by spaces, an associative one in sorted-key order, and None for a
    variable that is declared but unset. One rendering, so a rule reads
    the same text whether the write came from a typed line or a restore.

    Args:
        value (ShellValue | None): the variable's value.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(value[k] for k in sorted(value))
    return " ".join(array_values(value))


async def gate_restored_vars(
    policies: Policies | None, session_id: str, table: Mapping[str, ShellVar]
) -> None:
    """Vet a variable table a snapshot restores through the session gate.

    A snapshot is the one env input the deployment did not author, so
    the ``pre_session`` rule that refuses a name on a typed line has to
    see the restore too. Every restored variable fires the gate as a
    ``set`` of its rendered value before any of them lands, and a
    refusal aborts the load with the ``PolicyDenied`` a live ``export``
    of that name reports, rather than dropping the one variable: a
    partial restore is a workspace whose state matches no snapshot. The
    shell's own bookkeeping (``SHELL_BOOKKEEPING``) is exempt here as it
    is live. None policies gate nothing.

    Args:
        policies (Policies | None): the target workspace's policies.
        session_id (str): the session the table is restored into.
        table (Mapping[str, ShellVar]): the restored variables.
    """
    for name, var in table.items():
        if name in SHELL_BOOKKEEPING:
            continue
        await pre_session_gate(
            policies,
            SessionContext(
                plane="env",
                verb="set",
                key=name,
                value=gate_rendering(var.value),
                session_id=session_id,
            ),
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

    General over variable shapes: a string stores a scalar, a
    ShellArray stores an indexed array, a dict stores an associative
    one, and the storages stay exclusive. Semantics live here once —
    readonly refusal, the ``pre_session`` policy gate (whose context
    value renders an array as its present elements joined by spaces,
    an associative one in sorted-key order), then the store — so
    every writer states them the same way whichever tier or spelling
    asked. Writers with richer mechanics (subscripts, appends, holes)
    compute the resulting value on a copy and hand it here, so a
    denial never leaves a half-applied write; an integer ``+=`` hands
    its held text and the added one (``appended``), which evaluate here
    behind the same refusals. None policies gate nothing (a writer
    outside a workspace).

    Args:
        session (SessionState): the session being written.
        policies (Policies | None): admission policies the write clears.
        name (str): variable name.
        value (ShellValue): the value to store.
        diagnostics (list[str | bytes] | None): evaluation-owned warnings;
            without a sink, arithmetic errors propagate to the caller.
        follow_ref (bool): resolve a ``declare -n`` reference to its
            target first, which is what every ordinary assignment does.
            ``declare -n r=w`` on an existing reference is the one
            writer that re-aims the reference instead, and passes False.
        assigned (frozenset[int | str] | None): the elements an array
            write assigns (``coerce_value``), None for the whole value.
        added (str | None): an integer ``+=``'s text, which the assigned
            value evaluates after its held one in one evaluation.

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
    # refused a hidden name, so the two answer identically here. The name
    # is resolved already: `declare -n r=w` on a frozen `r` refuses.
    if env_is_readonly(session, name, follow_ref=False):
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
    coercion = _IntegerCoercion(session)
    store = functools.partial(
        set_var, session, policies, diagnostics=diagnostics
    )
    if existing is not None and existing.attrs:
        try:
            value = coerce_value(
                value,
                existing.attrs,
                functools.partial(coercion, added=added),
                assigned,
            )
        except (ArithError, ExitSignal):
            # bash bound what the expression assigned before it failed
            # (`declare -i n; x='y=5,1/0'; n=x` leaves y at 5, and a
            # RANDOM seed in it seeds); they land, gated, before the
            # refusal reports.
            await _land_coercion(session, store, coercion)
            raise
    await pre_session_gate(
        policies,
        SessionContext(
            plane="env",
            verb="set",
            key=name,
            value=gate_rendering(value),
            session_id=session.session_id,
        ),
    )
    if (
        name == RANDOM
        and session._random_seed != RANDOM_UNSET
        and isinstance(value, str)
    ):
        # A seed that fails or writes a readonly name seeds nothing: its
        # earlier writes land and the error is reported, but the line
        # goes on, unless the write was in a subscript.
        try:
            seed = int(coercion.evaluate(value)) % RANDOM_MODULUS
        except ExitSignal:
            await _land_coercion(session, store, coercion)
            raise
        except (ArithError, ReadonlyError) as exc:
            await _land_coercion(session, store, coercion)
            if isinstance(exc, ReadonlyError) and (
                exc.in_subscript or diagnostics is None
            ):
                raise exc.signal() from exc
            if diagnostics is None:
                raise
            diagnostics.append(str(exc))
            return
        session._random_state = seed
        session._random_seed = value
        session._random_last = 0
    note_random_kind(session, name, value)
    # The assignments the coercion or the seed made land now, gated
    # each, before the name they were made for.
    await _land_coercion(session, store, coercion)
    # A reference cannot hold an array: one landing on an unaimed
    # `declare -n` record drops the mark (`with_value`) and bash says so
    # (`declare -n r; r=(x)`). A declaration that named the kind (`-a`,
    # `-A`) took the mark off before writing, silently, as bash does.
    if (
        diagnostics is not None
        and existing is not None
        and VarAttr.NAMEREF in existing.attrs
        and isinstance(value, (list, dict))
    ):
        diagnostics.append(
            encode_text(f"bash: warning: {name}: removing nameref attribute\n")
        )
    stored = (
        ShellVar(value) if existing is None else with_value(existing, value)
    )
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


async def unset_var(
    session: SessionState,
    policies: Policies | None,
    name: str,
    follow_ref: bool = True,
) -> None:
    """Drop one variable through the session plane's gate; a missing
    name is quiet.

    Args:
        session (SessionState): the session being written.
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
    if var_hidden(session.visibility, name):
        # Hidden reads as unset and bash's unset of a missing name is
        # a quiet no-op; popping the real value would let a session
        # mutate state it cannot see.
        return
    # Same as `set_var`: the record, not the projection. The hidden
    # branch above has already returned, so the answers match.
    if env_is_readonly(session, name, follow_ref=False):
        raise ReadonlyVariableError(name)
    await pre_session_gate(
        policies,
        SessionContext(
            plane="env",
            verb="unset",
            key=name,
            value=None,
            session_id=session.session_id,
        ),
    )
    _drop(session, name)
    if name == RANDOM:
        # bash: unsetting RANDOM strips its special meaning for good.
        session._random_seed = RANDOM_UNSET


def _shadowing_frame(
    session: SessionState, name: str
) -> dict[str, ShellVar | None] | None:
    """The innermost scope on the call path that saved ``name``.

    Args:
        session (SessionState): the session.
        name (str): variable name.
    """
    return next(
        (f for f in reversed(session._local_frames) if name in f), None
    )


def _drop(session: SessionState, name: str) -> None:
    """Remove a variable as bash's ``unset`` does.

    A name the running function made local stays unset until it
    returns. A name an enclosing scope shadows, a caller's ``local`` or
    the temporary environment of ``x=1 f``, is that scope's to lose:
    the unset reveals the value it saved, and the name holds that value
    from then on (GNU: ``x=old; x=pre f`` where f runs ``unset x``
    reads ``old`` inside f and after it).

    Args:
        session (SessionState): the session being written.
        name (str): variable name.
    """
    frame = _shadowing_frame(session, name)
    if frame is None or frame is session._local_vars or name == RANDOM:
        session.vars.pop(name, None)
        return
    saved = frame.pop(name)
    if saved is None:
        session.vars.pop(name, None)
    else:
        session.vars[name] = saved


def _place(session: SessionState, name: str, var: ShellVar | None) -> None:
    if var is None:
        session.vars.pop(name, None)
    else:
        session.vars[name] = var


def reach_global(
    session: SessionState, names: list[str]
) -> Callable[[], None]:
    """Put each name's global record in place for a ``declare -g``, and
    return the call that puts the running locals back.

    Outside a function, or for a name no frame on the call path shadows,
    the global record is already in place. Otherwise the running local
    lives in ``session.vars`` and the global is what the *outermost*
    shadowing frame saved, so the two swap for the declaration: its
    writes, marks and kind checks reach the global, and the local comes
    back untouched, which is what GNU shows (``local G=5; declare -gr
    G=1`` leaves ``$G`` at 5 and writable in the function, 1 and frozen
    outside, and a nested ``declare -g`` reaches past the caller's local
    too). Arithmetic it runs still reads and writes the locals
    (``_step_back``), so the local comes back with what that gave it.

    Args:
        session (SessionState): shell session state.
        names (list[str]): the declaration's operand names.
    """
    swapped: list[tuple[str, dict[str, ShellVar | None], ShellVar | None]]
    swapped = []
    for name in dict.fromkeys(names):
        outer = next(
            (frame for frame in session._local_frames if name in frame), None
        )
        if outer is None:
            continue
        swapped.append((name, outer, session.vars.get(name)))
        _place(session, name, outer[name])
    session._reached = swapped

    def restore() -> None:
        for name, outer, running in session._reached:
            outer[name] = session.vars.get(name)
            _place(session, name, running)
        session._reached = []

    return restore


def _step_back(session: SessionState) -> Callable[[], None]:
    """Put the locals a running ``declare -g`` set aside back in place
    for one arithmetic evaluation or the writes it made, and return the
    call that reaches the globals again, keeping what those writes gave
    the locals.

    Args:
        session (SessionState): shell session state.
    """
    reached = [
        (name, session.vars.get(name)) for name, _, _ in session._reached
    ]
    for name, _, running in session._reached:
        _place(session, name, running)

    def again() -> None:
        session._reached = [
            (name, outer, session.vars.get(name))
            for name, outer, _ in session._reached
        ]
        for name, var in reached:
            _place(session, name, var)

    return again


def outlive_call(session: SessionState, name: str) -> None:
    """Let a temporary-environment variable outlive its call.

    bash keeps a name that ``x=1 f`` put in front of a function once
    something inside runs ``export x`` or ``readonly x``: x still holds
    its value after f returns, where otherwise the caller's comes back.

    Args:
        session (SessionState): the session.
        name (str): variable name.
    """
    frame = _shadowing_frame(session, name)
    if isinstance(frame, TempEnv):
        del frame[name]


def in_call_env(session: SessionState, name: str) -> bool:
    """Whether the running function's call assigned ``name`` in front.

    ``x=1 f`` puts ``x`` in f's temporary environment, which sits right
    under f's own frame of locals.

    Args:
        session (SessionState): the session.
        name (str): variable name.
    """
    frames = session._local_frames
    return (
        len(frames) > 1
        and isinstance(frames[-2], TempEnv)
        and name in frames[-2]
    )


def positional_params(
    session: SessionState, call_stack: CallStack | None
) -> list[str]:
    """The positional parameters in scope.

    Inside a function they are the function's own, even when it was
    called with none: bash's ``f`` run bare sees ``$#`` as 0, never its
    caller's count. Outside every function they are the shell's.

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
    """Replace the positional parameters in scope.

    ``set --`` and ``shift`` inside a function change the function's
    own and leave the caller's alone, as bash's do.

    Args:
        session (SessionState): shell session state.
        call_stack (CallStack | None): function-call scope, if any.
        values (list[str]): the new parameters.
    """
    if call_stack is not None and call_stack.depth > 1:
        call_stack.set_positional(values)
    else:
        session.positional_args = values


def shadow_local(
    session: SessionState, local_vars: dict[str, ShellVar | None], name: str
) -> None:
    """Record the caller's record before a ``local`` shadows it, once
    per frame.

    ``RANDOM`` parks its generator marker too: a local ``RANDOM`` is an
    ordinary variable for the function's extent (``local RANDOM=5; echo
    $RANDOM`` prints 5, and ``local RANDOM=(7)`` leaves the caller's
    generator alone), and ``restore_locals`` hands the marker back.

    Args:
        session (SessionState): the session the function runs in.
        local_vars (dict[str, ShellVar | None]): the running frame.
        name (str): the variable being declared local.
    """
    if name in local_vars:
        return
    local_vars[name] = session.vars.get(name)
    if name == RANDOM:
        session._local_random.append(session._random_seed)
        session._random_seed = RANDOM_UNSET


def restore_locals(
    session: SessionState, local_vars: dict[str, ShellVar | None]
) -> None:
    """Put a returning function's shadowed records back.

    Deliberate divergence: bash reseeds the global generator when a
    local ``RANDOM`` is popped (``RANDOM=42; f(){ local RANDOM; }; f;
    echo $RANDOM`` prints 11074 where 17772 was next); mirage resumes
    the caller's sequence where it left off.

    Args:
        session (SessionState): the session the function ran in.
        local_vars (dict[str, ShellVar | None]): the frame being popped.
    """
    for key, old in local_vars.items():
        if old is None:
            session.vars.pop(key, None)
        else:
            session.vars[key] = old
    if RANDOM in local_vars:
        session._random_seed = session._local_random.pop()


def seed_var(session: SessionState, name: str, value: ShellValue) -> None:
    """Write a variable without consulting the gate.

    Two kinds of caller. One is seeding a session before it is handed
    out: the embedder populating an environment, a test arranging
    state. `visible_arrays` already names this case ("the embedder can
    seed session.arrays before narrowing"). The other is the shell
    writing its own bookkeeping -- ``$PWD``/``$OLDPWD`` after a ``cd``,
    ``BASH_REMATCH`` after a ``[[ =~ ]]`` -- which are the shell's to
    maintain, not the session's to admit, and which a ``pre_session``
    rule refusing them could only break. (A ``for`` loop's variable is
    not one of these: bash leaves it holding its last value, so the
    loop never writes it back.)

    A variable the *line* named goes through `SessionView.set` instead,
    which is the whole point of the store being read-only from outside.
    One caller is neither, and is called out here rather than left to
    be discovered: `execute_command` lands a prefix assignment
    (``FOO=bar cmd``) through this entry point. That is not a way around the
    gate. The same site asks ``ensure_var_visible`` and then
    ``pre_session``, with the value, before it seeds anything, because
    a prefix assignment is a session write like any other and the form
    exports the name for the command. A policy refusal there takes the
    whole statement; a readonly name is refused alone, as bash does,
    and the command runs without it.

    Args:
        session (SessionState): the session being seeded.
        name (str): variable name.
        value (ShellValue): the value to store.
    """
    existing = session.vars.get(name)
    session.vars[name] = (
        ShellVar(value) if existing is None else with_value(existing, value)
    )
    note_random_kind(session, name, value)


def set_attr(
    session: SessionState, name: str, attr: VarAttr | None, on: bool = True
) -> None:
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
        session (SessionState): the session being written.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name and change nothing.
        on (bool): set it, or clear it.
    """
    existing = session.vars.get(name, ShellVar())
    session.vars[name] = (
        existing if attr is None else with_attr(existing, attr, on)
    )


async def mark_var(
    session: SessionState,
    policies: Policies | None,
    name: str,
    attr: VarAttr | None,
    on: bool = True,
    follow_ref: bool = True,
) -> None:
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
        session (SessionState): the session being written.
        policies (Policies | None): admission policies the mark clears.
        name (str): variable name.
        attr (VarAttr | None): the attribute to change, None to declare
            the name and change nothing.
        on (bool): set it, or clear it.
        follow_ref (bool): mark what a ``declare -n`` reference points
            at, as ``readonly r`` and ``export r`` do; ``declare -rn r``
            marks the reference itself and passes False.

    Raises:
        PolicyDenied: the name is hidden for this session, or a
            pre_session policy refused the mark.
    """
    # The nameref attribute itself is the one mark that belongs to the
    # reference's own record, on and off.
    if follow_ref and attr is not VarAttr.NAMEREF:
        name = deref(session, name) or name
    ensure_var_visible(session, name)
    await pre_session_gate(
        policies,
        SessionContext(
            plane="env",
            verb="set",
            key=name,
            value=None,
            session_id=session.session_id,
        ),
    )
    set_attr(session, name, attr, on)


def session_profile(session: SessionState) -> str | None:
    """The name of the profile the session runs under, None when none.

    Args:
        session (SessionState): the session to read.
    """
    return session.profile


def session_view(
    session: SessionState,
    policies: Policies | None = None,
    *,
    diagnostics: list[str | bytes] | None = None,
) -> SessionView:
    """The session plane's view: seven facts bound to one session.

    The one constructor every tier uses — builtins, the command
    dispatcher, a bare unit test — so the gate cannot be skipped by
    picking a different entry point. The view is the whole capability: it
    carries no handle back to the raw session.

    Args:
        session (SessionState): the session the view fronts.
        policies (Policies | None): admission policies writes clear;
            None gates nothing (a view constructed outside a
            workspace).
        diagnostics (list[str | bytes] | None): the evaluator's warning sink.
    """
    return SessionView(
        get=functools.partial(env_get, session),
        snapshot=functools.partial(env_snapshot, session),
        set=functools.partial(
            set_var, session, policies, diagnostics=diagnostics
        ),
        unset=functools.partial(unset_var, session, policies),
        mark=functools.partial(mark_var, session, policies),
        is_readonly=functools.partial(env_is_readonly, session),
        profile=functools.partial(session_profile, session),
    )
