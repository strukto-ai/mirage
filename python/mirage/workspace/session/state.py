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
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import replace

from mirage.ops.types import SessionView
from mirage.policy import Policies, PolicyDenied, pre_session_gate
from mirage.policy.types import SessionContext
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (ShellArray, array_extent, array_get, array_has,
                                array_values, array_with, make_array)
from mirage.shell.constants import (PIPESTATUS, RANDOM, RANDOM_MODULUS,
                                    RANDOM_UNSET)
from mirage.shell.errors import ArithError
from mirage.shell.types import ArithWrite, ElementOps
from mirage.shell.variable import (ShellValue, ShellVar, VarAttr, coerce_value,
                                   detach, with_attr, with_value)
from mirage.utils.hidden import var_hidden
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.rng import draw
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
        if name == PIPESTATUS:
            return [str(code) for code in self._session.pipe_status]
        var = self._session.vars[name]
        if not isinstance(var.value, list):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        # PIPESTATUS answers a lookup (and so `in`, which Mapping derives
        # from the lookup) and never lists: bash's `declare -p PIPESTATUS`
        # is `not found`, and an assignment to it is ignored, which this
        # view honors by answering the session's record before the store.
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
                  elements: ElementOps | None = None,
                  read_var: Callable[[str], str | None] | None = None,
                  wrote_var: Callable[[str, str], None] | None = None) -> int:
    """Resolve an indexed subscript in arithmetic context.

    bash evaluates indexed subscripts as arithmetic (``a[i+1]``); an
    unresolvable expression indexes element 0, mirroring bash's
    unset-name-is-zero arithmetic rule.

    Args:
        subscript (str): the raw subscript text.
        env (Mapping[str, str]): environment for name resolution.
        elements (ElementOps | None): element callbacks, so a nested
            reference (``a[b[0]]``) resolves too.
        read_var (Callable[[str], str | None] | None): dynamic reads,
            the same ones the enclosing expression makes, so
            ``a[RANDOM]`` draws.
        wrote_var (Callable[[str, str], None] | None): told of the
            subscript's assignments, as the enclosing expression is.
    """
    try:
        return int(subscript.strip())
    except ValueError:
        pass
    try:
        return evaluate_arith(subscript,
                              env,
                              elements=elements,
                              read_var=read_var,
                              wrote_var=wrote_var).value
    except ArithError:
        return 0


def _written_value(session: Session, write: ArithWrite) -> ShellValue:
    """The whole variable one arithmetic write produces.

    A scalar is itself; an element is the array it lands in, the way
    ``assign_element`` lands one, so a refusal never leaves a write
    half-applied.

    Args:
        session (Session): the session the write reads.
        write (ArithWrite): the assignment.
    """
    if write.key is None:
        return write.value
    assoc = visible_assocs(session).get(write.name)
    if assoc is not None:
        return {**assoc, write.key: write.value}
    arr = visible_arrays(session).get(write.name)
    return array_with(arr if arr is not None else make_array([]),
                      int(write.key), write.value)


async def subscript_index(session: Session,
                          subscript: str,
                          view: SessionView | None = None) -> int:
    """An indexed subscript resolved outside an arithmetic expression:
    ``${a[i]}``, ``a[i]=v``, ``unset 'a[i]'``, ``[[ -v a[i] ]]``.

    The subscript is arithmetic, so it may assign (``a[x=3]``) and seed
    (``a[RANDOM=42]``), and bash binds those as it evaluates them. Each
    lands through the door once the index is known, then the ``RANDOM``
    reader replays the draws made after the seed. A subscript that
    fails to evaluate lands what it assigned before failing and then
    raises, the subscript text leading the message, since bash aborts
    the line on it (``${a[1/0]}`` is ``1/0: division by 0``) rather
    than reading element 0.

    Args:
        session (Session): the session the subscript reads.
        subscript (str): the raw subscript text.
        view (SessionView | None): the gated door the assignments land
            through; None lands them ungated, outside a workspace.

    Raises:
        PolicyDenied: the door refused an assignment.
        ReadonlyVariableError: an assignment named a readonly variable.
        ArithError: the subscript does not evaluate, or an assigned name
            carries ``-i`` and the value does not evaluate.
    """
    try:
        return int(subscript.strip())
    except ValueError:
        pass
    reader = random_reader(session)
    error: ArithError | None = None
    idx = 0
    try:
        result = evaluate_arith(subscript,
                                visible_env(session),
                                elements=session_elements(session, reader),
                                read_var=reader.read,
                                wrote_var=reader.wrote)
        idx, writes = result.value, result.writes
    except ArithError as exc:
        error, writes = exc, exc.writes
    for write in writes:
        value = _written_value(session, write)
        if view is not None:
            await view.set(write.name, value)
        else:
            await set_var(session, None, write.name, value)
    reader.settle()
    if error is not None:
        raise ArithError(f"{subscript.strip()}: {error}") from error
    return idx


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

    __slots__ = ("_session", "_reader")

    def __init__(self,
                 session: Session,
                 reader: "RandomReader | None" = None) -> None:
        self._session = session
        self._reader = reader

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
        reader = self._reader
        idx = element_index(subscript, env,
                            session_elements(self._session, reader),
                            reader.read if reader is not None else None,
                            reader.wrote if reader is not None else None)
        if idx < 0:
            arr = visible_arrays(self._session).get(name)
            if arr is not None:
                idx += array_extent(arr)
            elif env_get(self._session, name) is not None:
                idx += 1
            if idx < 0:
                raise ArithError(f"{name}[{subscript}]: bad array subscript")
        return str(idx)

    def is_assoc(self, name: str) -> bool:
        """Whether the name holds an associative array.

        Args:
            name (str): the array variable's name.
        """
        return name in visible_assocs(self._session)

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


def session_elements(session: Session,
                     reader: "RandomReader | None" = None) -> ElementOps:
    """Element callbacks bound to one session, for ``evaluate_arith``.

    Args:
        session (Session): the session references resolve against.
        reader (RandomReader | None): the expression's ``RANDOM``
            reader, so a subscript draws from the same generator as the
            expression around it; None where nothing draws.
    """
    bound = _SessionElements(session, reader)
    return ElementOps(resolve=bound.resolve,
                      read=bound.read,
                      is_assoc=bound.is_assoc)


def seed_from(word: str, session: Session) -> int:
    """Evaluate a host-supplied seed; invalid arithmetic propagates.

    Read without the generator on offer: a host word naming ``RANDOM``
    would otherwise draw, and the draw reseed, without end.

    Args:
        word (str): the seed expression.
        session (Session): the session the expression reads.
    """
    value = evaluate_arith(word,
                           visible_env(session),
                           elements=session_elements(session)).value
    return value % RANDOM_MODULUS


def next_random(session: Session, stored: str | None) -> int | None:
    """Draw from the session generator, or None after RANDOM is unset.

    Shell assignments validate and seed at the session door. A host-seeded
    variable is consumed here on its first read. The last draw is separate
    from the stored word because a reseed resets repeat suppression to zero.

    Args:
        session (Session): generator and variable state.
        stored (str | None): the visible RANDOM value.
    """
    if session._random_seed == RANDOM_UNSET or (
            stored is None and session._random_seed is not None):
        return None
    seed = (seed_from(stored, session)
            if stored is not None and stored != session._random_seed else None)
    if seed is not None:
        state = seed
        last = 0
    elif session._random_state is None:
        state = time.time_ns() % RANDOM_MODULUS
        last = 0
    else:
        state = session._random_state
        last = session._random_last
    state, value = draw(state, last)
    session._random_state = state
    session._random_last = value
    word = str(value)
    existing = session.vars.get(RANDOM)
    session.vars[RANDOM] = (replace(existing, value=word)
                            if existing is not None else ShellVar(word))
    session._random_seed = word
    return value


def note_random_kind(session: Session, name: str, value: ShellValue) -> None:
    """End ``RANDOM``'s special meaning when a non-string lands on it.

    bash's ``convert_var_to_array`` drops the dynamic value and the
    assign hook, so ``RANDOM=(1 2)``, ``declare -a RANDOM``,
    ``RANDOM[1]=5`` and ``RANDOM+=(3)`` all leave an ordinary array that
    ``$RANDOM`` reads element 0 of, for good, as ``unset RANDOM`` does.
    Every store door calls this, gated or not, since a host seeding an
    array onto the name means the same thing.

    Args:
        session (Session): the session the store landed in.
        name (str): the variable stored.
        value (ShellValue): what it now holds.
    """
    if name == RANDOM and not isinstance(value, str):
        session._random_seed = RANDOM_UNSET


def conversion_scalar(session: Session, name: str) -> str | None:
    """The scalar an array conversion keeps as element 0.

    bash's ``convert_var_to_array`` copies the variable's current value
    into element 0, and for a live ``RANDOM`` looking the name up is
    what draws: ``RANDOM[1]=5`` leaves ``[0]`` holding one draw and
    ``declare -a RANDOM`` one alone, after which the array is ordinary.

    Args:
        session (Session): the session the conversion happens in.
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
    still pending at the session door, which lands it gated after
    evaluation, so the evaluator tells the reader of each assignment as
    it is made (``wrote``), the reader seeds a scratch generator the way
    the door will and draws from that, and ``settle`` replays the draws
    on the session once the door has seeded it: the session ends where
    bash's does, seeded and advanced by every read since the last
    assignment, and the write still reaches the gate as the assignment
    it is. Each assignment restarts the scratch generator and the count,
    since the door lands only the last value written, and the draws are
    replayed only if the door did land it: an assignment the caller
    never applied leaves the session as it was.

    Lives beside the door rather than with the generator because the
    door needs it too: ``RANDOM=RANDOM`` draws once while the seed is
    evaluated, then seeds with the draw, as bash's ``assign_random``
    does through ``evalexp``.

    Args:
        session (Session): generator and visibility state.
    """

    def __init__(self, session: Session) -> None:
        self.session = session
        self.seeded: str | None = None
        self.state = 0
        self.last = 0
        self.draws = 0

    def _special(self, name: str) -> bool:
        session = self.session
        return (name == RANDOM and not var_hidden(session.hidden_vars, name)
                and session._random_seed != RANDOM_UNSET)

    def read(self, name: str) -> str | None:
        """The dynamic value of a name, None for a name that has none.

        Args:
            name (str): the variable the expression reads.
        """
        if not self._special(name):
            return None
        if self.seeded is None:
            value = next_random(self.session,
                                visible_env(self.session).get(name))
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
        door has seeded it with the value the expression assigned."""
        if self.seeded is None or self.session._random_seed != self.seeded:
            return
        for _ in range(self.draws):
            next_random(self.session, visible_env(self.session).get(RANDOM))
        self.draws = 0


def random_reader(session: Session) -> RandomReader:
    """Bind arithmetic ``$RANDOM`` reads to a session.

    Args:
        session (Session): generator and visibility state.
    """
    return RandomReader(session)


class _IntegerCoercion:
    """The `-i` coercion and the ``RANDOM`` seed, as one evaluation.

    The incoming text evaluates as arithmetic against the visible env,
    element references resolving through the session's resolver, so
    `n=x+1` sees `x` and `n=a[1]+1` the element; an unresolvable name
    is 0 (`n=abc` stores `0`), the arithmetic rule, not a refusal.
    ``RANDOM`` draws, as in every other arithmetic context, so `n=RANDOM`
    and a `RANDOM=RANDOM` seed both advance the generator. The
    assignments the expression makes are kept for the door to land
    (``_land_coercion``): bash binds `x` in `n='x=5'` and in
    `RANDOM='x=5'`, before the error too if the expression then fails.
    A malformed expression raises ArithError with the offending text
    leading, the way every caller voices it.

    Args:
        session (Session): the session the expression reads.
    """

    def __init__(self, session: Session) -> None:
        self.session = session
        self.reader = random_reader(session)
        self.writes: list[ArithWrite] = []

    def __call__(self, text: str) -> str:
        session = self.session
        try:
            result = evaluate_arith(text,
                                    visible_env(session),
                                    elements=session_elements(
                                        session, self.reader),
                                    read_var=self.reader.read,
                                    wrote_var=self.reader.wrote)
        except ArithError as exc:
            self.writes.extend(exc.writes)
            raise ArithError(f"{text}: {exc}") from exc
        self.writes.extend(result.writes)
        return str(result.value)


async def _land_coercion(session: Session, policies: Policies | None,
                         coercion: _IntegerCoercion) -> None:
    """Land the assignments a coercion made, each through the door, then
    settle its ``RANDOM`` draws.

    Args:
        session (Session): the shell session.
        policies (Policies | None): the session plane's gate.
        coercion (_IntegerCoercion): the evaluation that made the writes.
    """
    for write in coercion.writes:
        await set_var(session, policies, write.name,
                      _written_value(session, write))
    coercion.reader.settle()


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
    coercion = _IntegerCoercion(session)
    if existing is not None and existing.attrs:
        try:
            value = coerce_value(value, existing.attrs, coercion)
        except ArithError:
            # bash bound what the expression assigned before it failed
            # (`declare -i n; x='y=5,1/0'; n=x` leaves y at 5, and a
            # RANDOM seed in it seeds); they land, gated, before the
            # refusal reports.
            await _land_coercion(session, policies, coercion)
            raise
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
    if name == RANDOM and session._random_seed != RANDOM_UNSET and isinstance(
            value, str):
        try:
            seed = int(coercion(value)) % RANDOM_MODULUS
        except ArithError as exc:
            session._diagnostics.append(str(exc))
            await _land_coercion(session, policies, coercion)
            return
        session._random_state = seed
        session._random_seed = value
        session._random_last = 0
    note_random_kind(session, name, value)
    # The assignments the coercion or the seed made land now, gated
    # each, before the name they were made for.
    await _land_coercion(session, policies, coercion)
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
    if name == RANDOM:
        # bash: unsetting RANDOM strips its special meaning for good.
        session._random_seed = RANDOM_UNSET


def shadow_local(session: Session, local_vars: dict[str, ShellVar | None],
                 name: str) -> None:
    """Record the caller's record before a ``local`` shadows it, once
    per frame.

    ``RANDOM`` parks its generator marker too: a local ``RANDOM`` is an
    ordinary variable for the function's extent (``local RANDOM=5; echo
    $RANDOM`` prints 5, and ``local RANDOM=(7)`` leaves the caller's
    generator alone), and ``restore_locals`` hands the marker back.

    Args:
        session (Session): the session the function runs in.
        local_vars (dict[str, ShellVar | None]): the running frame.
        name (str): the variable being declared local.
    """
    if name in local_vars:
        return
    local_vars[name] = session.vars.get(name)
    if name == RANDOM:
        session._local_random.append(session._random_seed)
        session._random_seed = RANDOM_UNSET


def restore_locals(session: Session,
                   local_vars: dict[str, ShellVar | None]) -> None:
    """Put a returning function's shadowed records back.

    Deliberate divergence: bash reseeds the global generator when a
    local ``RANDOM`` is popped (``RANDOM=42; f(){ local RANDOM; }; f;
    echo $RANDOM`` prints 11074 where 17772 was next); mirage resumes
    the caller's sequence where it left off.

    Args:
        session (Session): the session the function ran in.
        local_vars (dict[str, ShellVar | None]): the frame being popped.
    """
    for key, old in local_vars.items():
        if old is None:
            session.vars.pop(key, None)
        else:
            session.vars[key] = old
    if RANDOM in local_vars:
        session._random_seed = session._local_random.pop()


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
    note_random_kind(session, name, value)


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


def session_profile(session: Session) -> str | None:
    """The name of the profile the session runs under, None when none.

    Args:
        session (Session): the session to read.
    """
    return session.profile


def session_view(session: Session,
                 policies: Policies | None = None) -> SessionView:
    """The session plane's view: seven facts bound to one session.

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
                       is_readonly=functools.partial(env_is_readonly, session),
                       profile=functools.partial(session_profile, session))
