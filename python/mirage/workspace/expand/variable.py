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

import os
from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass

import tree_sitter

from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (ShellArray, array_extent, array_get, array_has,
                                array_indices, array_slice, array_values)
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import RANDOM
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import get_text
from mirage.shell.types import ArithWrite, ElementOps
from mirage.shell.types import NodeType as NT
from mirage.utils.fnmatch import fnmatch
from mirage.utils.glob_walk import escape_glob
from mirage.workspace.session import (Session, ensure_var_visible,
                                      visible_arrays, visible_env)
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.shell_dirs import home_dir
from mirage.workspace.session.state import (RandomReader, nameref_target,
                                            next_random, random_reader,
                                            session_elements, subscript_index,
                                            visible_assocs)

ExpandChild = Callable[[tree_sitter.Node], Awaitable[str]]

_PARAM_OPS = frozenset({
    ":-", "-", ":+", "+", ":?", "?", ":=", "=", "#", "##", "%", "%%", "/",
    "//", "/#", "/%", ":", "^", "^^", ",", ",,", "!"
})

_REPLACE_OPS = frozenset({"/", "//", "/#", "/%"})

_STRIP_OPS = frozenset({"#", "##", "%", "%%"})

_CASE_OPS = frozenset({"^", "^^", ",", ",,"})

# Ops whose first operand is a glob pattern that must keep its literal
# spelling (no unescaping) while still expanding nested $-expansions.
_PATTERN_OPS = _REPLACE_OPS | _STRIP_OPS | _CASE_OPS

# Ops on a "${a[@]...}" splat that act per element, so a quoted splat
# still splits into one word per element; every other op acts on the
# space-joined value and stays a single word.
_MULTIWORD_AT_OPS = frozenset({":"}) | _STRIP_OPS | _REPLACE_OPS | _CASE_OPS

_LITERAL_ARG_TYPES = frozenset({NT.WORD, NT.NUMBER, "regex"})

# Quote-carrying operand nodes: in pattern position their value matches
# literally, exactly as a quoted case pattern does.
_QUOTED_ARG_TYPES = frozenset(
    {NT.STRING, NT.RAW_STRING, NT.ANSI_C_STRING, NT.TRANSLATED_STRING})

# Operators that handle unset themselves, so `set -u` must not fire
# on the lookup that feeds them.
_UNSET_GUARD_OPS = frozenset({"-", ":-", "+", ":+", "=", ":=", "?", ":?"})


def _unbound(var: str) -> ExitSignal:
    # GNU: fatal at top level with status 127; a containing
    # subshell/pipeline segment reports 1 (same shape as ${var:?}).
    return ExitSignal(127,
                      stderr=f"bash: {var}: unbound variable\n".encode(),
                      contained_code=1)


def guard_expansion_write(session: Session, *names: str) -> None:
    """Refuse expansion-time writes that name hidden variables.

    ``${X:=d}`` and ``$((X=5))`` land on the raw session env rather
    than the async session door, so the hidden half of that door
    (``ensure_var_visible``) is applied here, and the refusal takes the
    fatal expansion-error shape ``${var:?}`` uses.

    Args:
        session (Session): shell session the write would land on.
        *names (str): the variable names about to be written.

    Raises:
        ExitSignal: a name is hidden; the line dies with status 1.
    """
    for name in names:
        try:
            ensure_var_visible(session, name)
        except PolicyDenied as exc:
            raise ExitSignal(1,
                             stderr=f"bash: {exc.strerror}\n".encode(),
                             contained_code=1) from exc


def _write_refusal(exc: PolicyDenied | ArithError) -> ExitSignal:
    """The line's death for a refused expansion-time write.

    The gate's own reason, or the ``-i`` coercion refusing the text;
    status 1, the shape ``${var:?}`` uses.

    Args:
        exc (PolicyDenied | ArithError): the refusal.
    """
    why = exc.strerror if isinstance(exc, PolicyDenied) else str(exc)
    return ExitSignal(1, stderr=f"bash: {why}\n".encode(), contained_code=1)


async def _expansion_index(session: Session, view: SessionView | None,
                           subscript: str) -> int:
    """``subscript_index`` in the expansion's voice.

    The subscript's assignments land as the index resolves
    (``${a[x=3]}`` leaves x at 3, ``${a[RANDOM=42]}`` seeds), and a
    refused one dies the way ``expansion_write``'s does.

    Args:
        session (Session): the session the subscript reads.
        view (SessionView | None): the gated door; None outside a
            workspace.
        subscript (str): the raw subscript text.
    """
    try:
        return await subscript_index(session, subscript, view)
    except (PolicyDenied, ArithError) as exc:
        raise _write_refusal(exc) from exc


async def land_arith_writes(session: Session, view: SessionView | None,
                            writes: tuple[ArithWrite,
                                          ...], reader: RandomReader) -> None:
    """Land an arithmetic expansion's assignments and settle its draws.

    Each write goes through ``expansion_write`` in evaluation order; then
    the ``RANDOM`` reader replays the draws the expression made after it
    seeded the generator, now that the door holds the seed. One door for
    a completed expression and for one that failed partway, since bash
    binds each assignment as it is made.

    Args:
        session (Session): the shell session.
        view (SessionView | None): the gated door; None outside a
            workspace.
        writes (tuple[ArithWrite, ...]): the assignments, in order.
        reader (RandomReader): the expression's ``RANDOM`` reader.
    """
    for write in writes:
        await expansion_write(session, view, write.name, write.key,
                              write.value)
    reader.settle()


async def expansion_write(session: Session, view: SessionView | None,
                          name: str, key: str | None, value: str) -> None:
    """One expansion-time write, through the session plane's door.

    ``${X:=d}``, ``${a[i]:=d}`` and ``$((X=5))`` are assignments the
    shell performs while expanding a word rather than while running a
    command, and they used to land on the raw session env. That made
    a ``pre_session`` rule one ``${X:=d}`` away from irrelevant: a
    deployment refusing ``AWS_*`` still had ``${AWS_PROFILE:=prod}``
    write it. They go through the door now, so one rule covers every
    spelling.

    Without a door (a unit test outside a workspace) the write lands
    directly, with the hidden half still applied: skipping that would
    let the write-back clobber a value the host's wiring reads.

    The element mechanics are ``assign_element``'s: a bare name over an
    array takes the write at element 0 and keeps its other elements
    (``a=(1 2 3)`` then ``$((a=5))`` leaves ``5 2 3``), an associative
    one writes the literal key ``"0"``, and a subscripted target
    arrives with its key already canonical.

    Args:
        session (Session): shell session the write lands on.
        view (SessionView | None): the session plane's gated door,
            None outside a workspace.
        name (str): the variable being written.
        key (str | None): the canonical subscript, None for a bare
            name.
        value (str): the value to store.

    Raises:
        ExitSignal: the name is hidden, a pre_session rule refused the
            write, the subscript is bad, or the name carries ``-i``
            and the text does not evaluate; either way the line dies
            with status 1, the shape ``${var:?}`` uses.
        ReadonlyVariableError: the name is readonly, the same refusal
            a plain assignment raises through the door.
    """
    guard_expansion_write(session, name)
    try:
        status = await assign_element(session, view, name, key, value)
    except (PolicyDenied, ArithError) as exc:
        raise _write_refusal(exc) from exc
    if status == "readonly":
        raise ReadonlyVariableError(name)
    if status != "ok":
        raise ExitSignal(1,
                         stderr=(f"bash: {name}[{key}]: "
                                 "bad array subscript\n").encode(),
                         contained_code=1)


def _lookup_var(var: str,
                session: Session,
                call_stack: CallStack | None,
                strict: bool = True) -> str:
    """Resolve one variable name to its value.

    Args:
        var (str): variable name (plain name, digit, or special).
        session (Session): shell session (env, arrays, positionals).
        call_stack (CallStack | None): function-call scope, if any.
        strict (bool): honor ``set -u`` — an unset plain name or
            positional raises; the defaulting operators (``:-`` family)
            pass False because they handle unset themselves. Specials
            (``@ * # ? $ ! 0``) never raise, matching bash >= 4.4.
    """
    env = visible_env(session)
    last_exit_code = session.last_exit_code
    positional = getattr(session, "positional_args", None)
    nounset = strict and bool(session.shell_options.get("nounset"))
    if var in ("@", "*"):
        if call_stack and call_stack.get_all_positional():
            return " ".join(call_stack.get_all_positional())
        if positional:
            return " ".join(positional)
        return ""
    if var == "#":
        if call_stack and call_stack.get_all_positional():
            return str(call_stack.get_positional_count())
        if positional:
            return str(len(positional))
        return "0"
    if var == "?":
        return str(last_exit_code)
    if var == "$":
        return str(os.getpid())
    if var == "!":
        # Deliberate divergence from bash: jobs are identified by job
        # table id, not OS pid, so $! yields the id `wait`/`kill` accept.
        last_job = session.last_bg_job_id
        return str(last_job) if last_job is not None else ""
    if var.isdigit():
        idx = int(var)
        if idx == 0:
            return session.argv0
        if call_stack and call_stack.get_positional(idx):
            return call_stack.get_positional(idx)
        if positional and 0 < idx <= len(positional):
            return positional[idx - 1]
        if nounset:
            raise _unbound(var)
        return ""
    if call_stack:
        local_val = call_stack.get_local(var)
        if local_val is not None:
            return local_val
    if var == RANDOM:
        drawn = next_random(session, env.get(RANDOM))
        if drawn is not None:
            return str(drawn)
    arrays = visible_arrays(session)
    if var in arrays:
        return array_get(arrays[var], 0)
    assocs = visible_assocs(session)
    if var in assocs:
        # `$m` on an associative array is `${m["0"]}`, the literal key.
        return assocs[var].get("0", "")
    # `$PWD` is deliberately absent here: `cd` writes it into the env like
    # any exported variable, so it can be assigned, unset and printed by
    # `env`, exactly as bash allows. Resolving it here instead would make
    # `PWD=/x` and `unset PWD` silently do nothing.
    if var == "HOME":
        return home_dir(session) or ""
    if var not in env:
        if nounset:
            raise _unbound(var)
        return ""
    return env[var]


@dataclass(frozen=True, slots=True)
class _BraceParse:
    """Structural pieces of one ``${...}`` expansion.

    ``subscript`` is the raw text between the brackets and serves the
    literal checks (``@``/``*``) and the arithmetic path, which wants
    the unexpanded spelling; ``subscript_nodes`` are the tree-sitter
    children behind it, which the associative path expands properly
    (``${m[$k]}``, ``${m["a b"]}``) since a key is a word, not an
    expression.
    """
    var_name: str | None
    subscript: str | None
    length_op: bool
    indirect_op: bool
    op: str | None
    groups: tuple[tuple[tree_sitter.Node, ...], ...]
    subscript_nodes: tuple[tree_sitter.Node, ...] = ()


def _group_separator(op: str | None) -> str | None:
    if op in _REPLACE_OPS:
        return "/"
    if op == ":":
        return ":"
    return None


def _parse_braces(node: tree_sitter.Node) -> _BraceParse:
    var_name = None
    subscript = None
    subscript_nodes: tuple[tree_sitter.Node, ...] = ()
    length_op = False
    indirect_op = False
    op = None
    groups: list[list[tree_sitter.Node]] = []
    seen_var = False
    for c in node.children:
        if c.type == "${" or c.type == "}":
            continue
        if c.type == "#" and not seen_var:
            length_op = True
            continue
        if c.type == "!" and not seen_var:
            indirect_op = True
            continue
        if c.type in (NT.VARIABLE_NAME,
                      NT.SPECIAL_VARIABLE_NAME) and not seen_var:
            var_name = get_text(c)
            seen_var = True
            continue
        if c.type == "subscript" and not seen_var:
            sub_nodes: list[tree_sitter.Node] = []
            for sc in c.named_children:
                if sc.type == NT.VARIABLE_NAME and var_name is None:
                    var_name = get_text(sc)
                else:
                    sub_nodes.append(sc)
            subscript_nodes = tuple(sub_nodes)
            if var_name is not None:
                # The raw slice, not the first child's text: a subscript
                # holding several words (`${m[two words]}`) or a quoted
                # key keeps its whole spelling this way.
                sub_text = get_text(c)
                subscript = sub_text[len(var_name) + 1:-1]
            seen_var = True
            continue
        if c.type in _PARAM_OPS and op is None:
            op = get_text(c)
            groups.append([])
            continue
        if op is not None and not c.is_named and c.type == _group_separator(
                op):
            groups.append([])
            continue
        if op is not None:
            groups[-1].append(c)
    return _BraceParse(var_name=var_name,
                       subscript=subscript,
                       length_op=length_op,
                       indirect_op=indirect_op,
                       op=op,
                       groups=tuple(tuple(g) for g in groups),
                       subscript_nodes=subscript_nodes)


def _escaped_find(text: str, start: int, quote: str) -> int:
    """Index of the next unescaped ``quote``, -1 when it never closes.

    Args:
        text (str): the token being scanned.
        start (int): first index inside the quotes.
        quote (str): the closing character.
    """
    i = start
    n = len(text)
    while i < n:
        if text[i] == "\\" and i + 1 < n:
            i += 2
            continue
        if text[i] == quote:
            return i
        i += 1
    return -1


def _ref_end(text: str, start: int) -> tuple[str, int] | None:
    """A ``$name``/``${name}`` reference starting after the ``$``.

    Args:
        text (str): the token being scanned.
        start (int): index of the character after ``$``.

    Returns:
        The name and the index past the reference, or None when the
        ``$`` starts no reference and stays literal.
    """
    n = len(text)
    j = start
    braced = j < n and text[j] == "{"
    if braced:
        j += 1
    k = j
    while k < n and (text[k].isalnum() or text[k] == "_"):
        k += 1
    name = text[j:k]
    if not name:
        return None
    if braced:
        if k >= n or text[k] != "}":
            return None
        k += 1
    return name, k


def _dquoted_pattern(inner: str, session: Session,
                     call_stack: CallStack | None) -> str:
    """A double-quoted pattern segment: everything in it is literal.

    Args:
        inner (str): the text between the double quotes.
        session (Session): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
    """
    out: list[str] = []
    i = 0
    n = len(inner)
    while i < n:
        ch = inner[i]
        if ch == "\\" and i + 1 < n and inner[i + 1] in '$`"\\':
            out.append(escape_glob(inner[i + 1]))
            i += 2
            continue
        if ch == "$" and i + 1 < n:
            ref = _ref_end(inner, i + 1)
            if ref is not None:
                name, nxt = ref
                out.append(escape_glob(_lookup_var(name, session, call_stack)))
                i = nxt
                continue
        out.append(escape_glob(ch))
        i += 1
    return "".join(out)


def _pattern_text(text: str, session: Session,
                  call_stack: CallStack | None) -> str:
    """Render an opaque pattern token with bash quoting semantics.

    Pattern operands (``${f%$ext}``, ``${v#x"a*"}``) arrive as opaque
    ``regex`` nodes tree-sitter does not parse further, but bash still
    honors quoting inside them: quoted segments (single, double, or
    ANSI-C) match literally, a backslash binds the next character, an
    unquoted ``$``-reference splices a live pattern while a
    double-quoted one splices literal text, and every other character -
    glob syntax included - stays live. Literal text is spelled in
    one-character classes because fnmatch has no escape character.

    Args:
        text (str): the raw pattern text.
        session (Session): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if not any(c in text for c in "$\\'\""):
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            out.append(escape_glob(text[i + 1]))
            i += 2
            continue
        if ch == "\'":
            end = text.find("\'", i + 1)
            if end != -1:
                out.append(escape_glob(text[i + 1:end]))
                i = end + 1
                continue
        if ch == '"':
            end = _escaped_find(text, i + 1, '"')
            if end != -1:
                out.append(
                    _dquoted_pattern(text[i + 1:end], session, call_stack))
                i = end + 1
                continue
        if ch == "$" and i + 1 < n:
            if text[i + 1] == "\'":
                end = _escaped_find(text, i + 2, "\'")
                if end != -1:
                    out.append(escape_glob(decode_ansi_c(text[i + 2:end])))
                    i = end + 1
                    continue
            ref = _ref_end(text, i + 1)
            if ref is not None:
                name, nxt = ref
                out.append(_lookup_var(name, session, call_stack))
                i = nxt
                continue
        out.append(ch)
        i += 1
    return "".join(out)


async def _expand_operand(node: tree_sitter.Node, expand_child: ExpandChild,
                          pattern_mode: bool, session: Session,
                          call_stack: CallStack | None) -> str:
    if node.type == NT.CONCATENATION:
        return await _expand_group(tuple(node.children), expand_child,
                                   pattern_mode, session, call_stack)
    if pattern_mode and node.type in _QUOTED_ARG_TYPES:
        # Quoted pattern text matches literally, the same rule case
        # patterns follow: the value, inner expansions included, is
        # escaped so its glob characters match themselves.
        return escape_glob(await expand_child(node))
    if pattern_mode and node.type in _LITERAL_ARG_TYPES:
        return _pattern_text(get_text(node), session, call_stack)
    return await expand_child(node)


async def _expand_group(nodes: tuple[tree_sitter.Node, ...],
                        expand_child: ExpandChild, pattern_mode: bool,
                        session: Session, call_stack: CallStack | None) -> str:
    """Expand adjacent operand nodes, preserving inter-node whitespace.

    ``${x:?custom msg}`` carries its message as sibling nodes whose gap
    (the space) exists only in the source bytes; stitch gaps back from
    byte offsets so multi-word operands round-trip.
    """
    pieces: list[str] = []
    prev = None
    for c in nodes:
        if prev is not None and c.start_byte > prev.end_byte:
            gap = c.start_byte - prev.end_byte
            pieces.append(" " * gap)
        pieces.append(await _expand_operand(c, expand_child, pattern_mode,
                                            session, call_stack))
        prev = c
    return "".join(pieces)


def _glob_strip(value: str, pattern: str, greedy: bool, prefix: bool) -> str:
    if not pattern:
        return value
    if prefix:
        candidates = [
            i for i in range(len(value) + 1) if fnmatch(value[:i], pattern)
        ]
        if not candidates:
            return value
        i = max(candidates) if greedy else min(candidates)
        return value[i:]
    candidates = [
        i for i in range(len(value) + 1) if fnmatch(value[i:], pattern)
    ]
    if not candidates:
        return value
    i = min(candidates) if greedy else max(candidates)
    return value[:i]


def _glob_replace(value: str, pattern: str, replacement: str,
                  replace_all: bool, anchor: str | None) -> str:
    """Bash ``${var/pat/rep}``: pattern is a glob, longest match wins.

    Args:
        value (str): the variable's value.
        pattern (str): glob pattern (may be empty: value unchanged).
        replacement (str): replacement text.
        replace_all (bool): ``//`` — replace every match.
        anchor (str | None): ``#`` (prefix) or ``%`` (suffix) or None.
    """
    if not pattern:
        return value
    if anchor == "#":
        for j in range(len(value), -1, -1):
            if fnmatch(value[:j], pattern):
                return replacement + value[j:]
        return value
    if anchor == "%":
        for i in range(len(value) + 1):
            if fnmatch(value[i:], pattern):
                return value[:i] + replacement
        return value
    if not value:
        return replacement if fnmatch("", pattern) else value
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        match_end = -1
        for j in range(n, i - 1, -1):
            if fnmatch(value[i:j], pattern):
                match_end = j
                break
        if match_end <= i:
            # No match here (or an empty one, which bash skips over).
            out.append(value[i])
            i += 1
            continue
        out.append(replacement)
        i = match_end
        if not replace_all:
            out.append(value[i:])
            return "".join(out)
    return "".join(out)


def _case_mod(op: str, val: str, pattern: str) -> str:
    if not val:
        return val
    chars = list(val)
    scope = range(len(chars)) if op in ("^^", ",,") else range(1)
    for i in scope:
        ch = chars[i]
        if pattern and not fnmatch(ch, pattern):
            continue
        chars[i] = ch.upper() if op in ("^", "^^") else ch.lower()
    return "".join(chars)


class _PendingEnv(Mapping[str, str]):
    """The visible env with an expansion's pending scalar writes laid over.

    A view, not a merged dict: the visible env is itself a view whose
    ``__getitem__`` refuses a name it cannot serve (a name reference to
    an array), so spreading it into a dict raised where the evaluator's
    own ``get`` merely skips the name.

    Args:
        pending (Mapping[str, str]): the writes made so far.
        base (Mapping[str, str]): the session's visible env.
    """

    __slots__ = ("_pending", "_base")

    def __init__(self, pending: Mapping[str, str], base: Mapping[str,
                                                                 str]) -> None:
        self._pending = pending
        self._base = base

    def __getitem__(self, name: str) -> str:
        value = self._pending.get(name)
        return value if value is not None else self._base[name]

    def __iter__(self) -> Iterator[str]:
        seen = set(self._pending)
        yield from self._pending
        for name in self._base:
            if name not in seen:
                yield name

    def __len__(self) -> int:
        return len(set(self._pending) | set(self._base))


class _ArithOperand:
    """The arithmetic operands of one expansion, evaluated in one record.

    A substring offset, a length and a slice bound are arithmetic
    (``${v:1+1}``, ``${a[@]:i:n}``), so each may assign and seed. bash
    binds an assignment as it makes it, so the second operand sees the
    first's (``${v:x=1:y=x+1}`` leaves y at 2) and draws from a
    ``RANDOM`` the first seeded; the writes themselves land through the
    door once the word has expanded (``land_arith_writes``), so a
    refusal never leaves the word half-applied. Element references
    resolve through the session, so an operand may name one
    (``${v:a[0]}``).

    Args:
        session (Session): the session the operands read.
    """

    __slots__ = ("session", "reader", "writes", "ref", "_pending",
                 "_pending_elems")

    def __init__(self, session: Session) -> None:
        self.session = session
        self.reader = random_reader(session)
        self.writes: list[ArithWrite] = []
        # The reference the operands belong to (`v`, `a[@]`), which
        # bash names ahead of a failing operand.
        self.ref = ""
        self._pending: dict[str, str] = {}
        self._pending_elems: dict[tuple[str, str], str] = {}

    def _elements(self) -> ElementOps:
        """The session's element callbacks, the pending element writes
        laid over their reads, so ``${v:(a[0]=2):(a[0])}`` reads the 2
        the first operand assigned."""
        inner = session_elements(self.session, self.reader)
        pending = self._pending_elems

        def read(name: str,
                 key: str,
                 _inner: ElementOps = inner) -> str | None:
            value = pending.get((name, key))
            return value if value is not None else _inner.read(name, key)

        return ElementOps(resolve=inner.resolve,
                          read=read,
                          is_assoc=inner.is_assoc)

    def value(self, text: str) -> int:
        """The operand's value.

        An operand that does not evaluate ends the line, as bash's does
        (``${v:1/0}`` is ``v: 1/0: division by 0``), once what it
        assigned before failing is recorded for the door.

        Args:
            text (str): the raw operand text.

        Raises:
            ExitSignal: the operand does not evaluate.
        """
        try:
            return int(text.strip())
        except ValueError:
            pass
        env = _PendingEnv(self._pending, visible_env(self.session))
        try:
            result = evaluate_arith(text,
                                    env,
                                    elements=self._elements(),
                                    read_var=self.reader.read,
                                    wrote_var=self.reader.wrote)
        except ArithError as exc:
            self._record(exc.writes)
            raise ExitSignal(1,
                             stderr=(f"bash: {self.ref}: {text.strip()}: "
                                     f"{exc}\n").encode(),
                             contained_code=1) from exc
        self._record(result.writes)
        return result.value

    def _record(self, writes: tuple[ArithWrite, ...]) -> None:
        self.writes.extend(writes)
        for write in writes:
            if write.key is None:
                self._pending[write.name] = write.value
            else:
                self._pending_elems[(write.name, write.key)] = write.value


def _substring(val: str, groups: list[str], operand: _ArithOperand) -> str:
    if not groups:
        return val
    offset = operand.value(groups[0])
    length = operand.value(groups[1]) if len(groups) > 1 else None
    if offset < 0:
        offset = max(0, len(val) + offset)
    if length is None:
        return val[offset:]
    if length < 0:
        return val[offset:max(offset, len(val) + length)]
    return val[offset:offset + length]


_SUBSCRIPT_LITERAL_TYPES = frozenset({NT.WORD, NT.NUMBER, NT.ERROR})

# The operators whose word bash expands only once the parameter's state
# selects it (a default, an alternate, an assignment, a message).
_LAZY_OPS = frozenset({"?", ":?", "=", ":=", ":-", "-", ":+", "+"})


async def _operator_word(p: _BraceParse, expand_child: ExpandChild,
                         session: Session,
                         call_stack: CallStack | None) -> str:
    """The word of a conditional operator, expanded now that it is needed.

    Args:
        p (_BraceParse): the parsed expansion.
        expand_child (ExpandChild): nested-node expander.
        session (Session): shell session.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if not p.groups:
        return ""
    return await _expand_group(p.groups[0], expand_child, False, session,
                               call_stack)


async def _expand_subscript_key(p: _BraceParse,
                                expand_child: ExpandChild) -> str:
    """The associative key one subscript spells.

    A purely literal subscript keeps its raw spelling, spaces included,
    which is what bash stores for ``m[ k ]``; anything carrying an
    expansion or quoting expands node by node (``${m[$k]}``,
    ``${m["a b"]}``) so substitution and quote removal land.

    Args:
        p (_BraceParse): the parsed expansion.
        expand_child (ExpandChild): nested-node expander.
    """
    nodes = p.subscript_nodes
    if not nodes or all(n.type in _SUBSCRIPT_LITERAL_TYPES for n in nodes):
        return p.subscript or ""
    parts = [await expand_child(n) for n in nodes]
    return "".join(parts)


def _value_op(op: str, val: str, groups: list[str],
              operand: _ArithOperand) -> str:
    if op in _STRIP_OPS:
        pattern = groups[0] if groups else ""
        return _glob_strip(val, pattern, op in ("##", "%%"), op in ("#", "##"))
    if op in _REPLACE_OPS:
        pattern = groups[0] if groups else ""
        replacement = groups[1] if len(groups) > 1 else ""
        anchor = op[1] if len(op) > 1 and op[1] in "#%" else None
        return _glob_replace(val, pattern, replacement, op == "//", anchor)
    if op in _CASE_OPS:
        return _case_mod(op, val, groups[0] if groups else "")
    if op == ":":
        return _substring(val, groups, operand)
    return val


async def expand_braces(node: tree_sitter.Node,
                        session: Session,
                        call_stack: CallStack | None,
                        expand_child: ExpandChild,
                        view: SessionView | None = None) -> str:
    """Expand ${VAR}, ${VAR<op>...}, ${a[i]}, ${#a[@]}, etc.

    An offset, length or slice bound is arithmetic and may assign
    (``${v:x=1:y=2}``) or seed (``${v:RANDOM%10:1}``); those land
    through the door once the word has expanded, then the ``RANDOM``
    reader settles, so the line ends where bash's does.

    Args:
        node (tree_sitter.Node): the ``expansion`` tree-sitter node.
        session (Session): shell session (env, arrays, positionals).
        call_stack (CallStack | None): function-call scope, if any.
        expand_child (ExpandChild): callback that expands a nested node
            (dependency-injected to avoid a cycle with ``expand_node``).
        view (SessionView | None): the gated door the expansion's
            writes land through; None outside a workspace.
    """
    operand = _ArithOperand(session)
    try:
        value = await _expand_braces(node, session, call_stack, expand_child,
                                     view, operand)
    except ExitSignal:
        # bash bound what an operand assigned before the one that
        # failed; they land before the line dies.
        await land_arith_writes(session, view, tuple(operand.writes),
                                operand.reader)
        raise
    await land_arith_writes(session, view, tuple(operand.writes),
                            operand.reader)
    return value


async def _expand_braces(node: tree_sitter.Node, session: Session,
                         call_stack: CallStack | None,
                         expand_child: ExpandChild, view: SessionView | None,
                         operand: _ArithOperand) -> str:
    p = _parse_braces(node)
    if any(c.type == "}" and c.is_missing for c in node.children):
        # tree-sitter-bash cannot parse a $-spelled substring offset
        # (${v:$o}, ${v:$o:n}): it truncates the expansion with a
        # zero-width `}` and reparses the tail as stray siblings. bash
        # accepts the form, so emitting the mis-parse would corrupt the
        # value silently; fail loudly instead. Spell it ${v:o} or
        # ${v:$((o))}.
        msg = f"bash: ${{{p.var_name or ''}}}: bad substitution\n"
        raise ExitSignal(2, stderr=msg.encode(), contained_code=2)
    env = visible_env(session)
    arrays = visible_arrays(session)
    assocs = visible_assocs(session)
    operand.ref = (p.var_name or "") + (f"[{p.subscript}]"
                                        if p.subscript is not None else "")

    # A conditional operator's word expands only if the parameter's
    # state selects it, as bash's does: `${RANDOM:-$RANDOM}` draws once
    # and `${x:-$(cmd)}` runs cmd only when x is unset. Every other
    # operator's words are needed whatever the value, and expand here.
    groups: list[str] = []
    if p.op not in _LAZY_OPS:
        for gi, group in enumerate(p.groups):
            pattern_mode = gi == 0 and p.op in _PATTERN_OPS
            groups.append(await
                          _expand_group(group, expand_child, pattern_mode,
                                        session, call_stack))

    val = ""
    var_in_env = False
    # The subscript as `:=` would write it: the key itself for an
    # associative name, the resolved index for an indexed one, None
    # for `[@]`/`[*]` and a negative index past the front, which bash
    # refuses to assign through.
    write_key: str | None = None
    amap = assocs.get(p.var_name) if p.var_name is not None else None
    if p.subscript is not None and p.var_name is not None and amap is not None:
        if p.subscript in ("@", "*"):
            # Sorted-key order everywhere an associative array is
            # walked: bash iterates its hash table, whose order is
            # unpredictable, and a deterministic answer beats
            # reproducing noise.
            values = [amap[k] for k in sorted(amap)]
            if p.indirect_op:
                return " ".join(sorted(amap))
            if p.length_op:
                return str(len(values))
            if p.op == ":":
                return " ".join(_slice_array(list(values), groups, operand))
            if p.op in _STRIP_OPS | _REPLACE_OPS | _CASE_OPS:
                return " ".join(
                    _value_op(p.op, el, groups, operand) for el in values)
            val = " ".join(values)
            var_in_env = bool(amap)
        else:
            # A key, not an expression: `${m[1+1]}` reads the key
            # "1+1", never element 2. An empty key reads as unset
            # (GNU warns "bad array subscript" on stderr and expands
            # empty; expansion has no warning channel, so the empty
            # answer stands alone).
            key = await _expand_subscript_key(p, expand_child)
            val = amap.get(key, "")
            var_in_env = key in amap
            write_key = key
    elif p.subscript is not None and p.var_name is not None:
        arr = arrays.get(p.var_name)
        if arr is None:
            # A scalar is element 0 of a one-element array, even when
            # empty: ${#x[@]} is 1 for x="" but 0 for an unset name.
            arr = [env[p.var_name]] if p.var_name in env else []
        var_in_env = p.var_name in arrays or p.var_name in env
        if p.subscript in ("@", "*"):
            # ${a[@]} and friends see only the assigned elements: a hole
            # left by `unset a[i]` (or skipped by a[9]=v) neither expands
            # nor counts, though it keeps the later indices in place.
            values = array_values(arr)
            if p.indirect_op:
                return " ".join(str(i) for i in array_indices(arr))
            if p.length_op:
                return str(len(values))
            if p.op == ":":
                sliced = _slice_array(arr, groups, operand)
                return " ".join(sliced)
            if p.op in _STRIP_OPS | _REPLACE_OPS | _CASE_OPS:
                return " ".join(
                    _value_op(p.op, el, groups, operand) for el in values)
            val = " ".join(values)
        else:
            # Expanded first (`${a[$k]}` resolves $k, `${a[i+1]}` stays
            # arithmetic), then evaluated as an index.
            sub_text = await _expand_subscript_key(p, expand_child)
            idx = await _expansion_index(session, view, sub_text)
            if idx < 0:
                idx += array_extent(arr)
            val = array_get(arr, idx)
            var_in_env = array_has(arr, idx)
            if idx >= 0:
                write_key = str(idx)
    elif p.var_name:
        if call_stack:
            local_val = call_stack.get_local(p.var_name)
            if local_val is not None:
                val = local_val
                var_in_env = True
        if not var_in_env and p.var_name in arrays:
            val = array_get(arrays[p.var_name], 0)
            var_in_env = True
        if not var_in_env and amap is not None:
            # A bare `$m` on an associative array is `${m["0"]}`, the
            # literal key, exactly as bash reads it.
            val = amap.get("0", "")
            var_in_env = "0" in amap
        if not var_in_env and p.var_name == RANDOM:
            # `${RANDOM}` draws as `$RANDOM` does: the env holds the
            # last word, which a read must not hand back unchanged.
            drawn = next_random(session, env.get(RANDOM))
            if drawn is not None:
                val = str(drawn)
                var_in_env = True
        if not var_in_env and p.var_name in env:
            val = env[p.var_name]
            var_in_env = True
        if not var_in_env:
            # Specials, positionals, PWD/HOME fall back to the shared
            # lookup; set-ness follows value presence.
            val = _lookup_var(p.var_name,
                              session,
                              call_stack,
                              strict=p.op not in _UNSET_GUARD_OPS)
            var_in_env = val != ""

    if p.indirect_op:
        # `${!r}` on a name reference is the target's *name*, not an
        # indirection through the value.
        target = (nameref_target(session, p.var_name)
                  if p.var_name is not None else None)
        if target is not None:
            return target
        return _lookup_var(val, session, call_stack) if val else ""
    if p.length_op:
        return str(len(val))
    if p.op is None:
        return val
    if p.op in ("?", ":?"):
        triggered = (not var_in_env) if p.op == "?" else (not val)
        if not triggered:
            return val
        message = await _operator_word(p, expand_child, session, call_stack)
        if not message:
            message = ("parameter not set"
                       if p.op == "?" else "parameter null or not set")
        # GNU: fatal at top level with status 127; a containing
        # subshell/pipeline segment reports 1. A subscripted reference
        # is named whole: `bash: m[zz]: nope`.
        ref = (p.var_name
               if p.subscript is None else f"{p.var_name}[{p.subscript}]")
        raise ExitSignal(127,
                         stderr=f"bash: {ref}: {message}\n".encode(),
                         contained_code=1)
    if p.op in ("=", ":="):
        triggered = (not var_in_env) if p.op == "=" else (not val)
        if not triggered:
            return val
        default = await _operator_word(p, expand_child, session, call_stack)
        if p.var_name is not None and p.subscript is not None:
            # The default lands on the element the reference named,
            # never on element 0: `${m[k]:=v}` writes key k and
            # `${a[3]:=v}` writes index 3, as bash does. `[@]`, `[*]`
            # and an index before the front are refused in bash's
            # words.
            if write_key is None:
                raise ExitSignal(1,
                                 stderr=(f"bash: {p.var_name}[{p.subscript}]"
                                         ": bad array subscript\n").encode(),
                                 contained_code=1)
            await expansion_write(session, view, p.var_name, write_key,
                                  default)
        elif p.var_name is not None:
            if (call_stack is not None
                    and call_stack.get_local(p.var_name) is not None):
                call_stack.set_local(p.var_name, default)
            else:
                await expansion_write(session, view, p.var_name, None, default)
        return default
    if p.op == ":-":
        if val:
            return val
        return await _operator_word(p, expand_child, session, call_stack)
    if p.op == "-":
        if var_in_env:
            return val
        return await _operator_word(p, expand_child, session, call_stack)
    if p.op == ":+":
        if not val:
            return ""
        return await _operator_word(p, expand_child, session, call_stack)
    if p.op == "+":
        if not var_in_env:
            return ""
        return await _operator_word(p, expand_child, session, call_stack)
    return _value_op(p.op, val, groups, operand)


def _slice_array(arr: ShellArray, groups: list[str],
                 operand: _ArithOperand) -> list[str]:
    """Resolve ``${a[@]:offset:length}`` against a shell array.

    Args:
        arr (ShellArray): the array being sliced.
        groups (list[str]): the raw offset and length words.
        operand (_ArithOperand): the expansion's arithmetic record.
    """
    if not groups:
        return array_values(arr)
    offset = operand.value(groups[0])
    length = operand.value(groups[1]) if len(groups) > 1 else None
    return array_slice(arr, offset, length)


def _is_at_splat(p: _BraceParse) -> bool:
    """Whether a parsed "${...}" splats one word per element.

    Two spellings mean the same thing: an ``@`` subscript on a name
    (``${a[@]}``) and the positional parameters themselves (``${@}``,
    which bash word-splits exactly like the bare ``$@``). ``${*}`` and
    ``${a[*]}`` are excluded because they join.

    Args:
        p (_BraceParse): the parsed brace expansion.
    """
    if p.subscript == "@":
        return True
    return p.subscript is None and p.var_name == "@"


def _positional_args(session: Session,
                     call_stack: CallStack | None) -> list[str]:
    """The positional parameters in scope, function args winning.

    Args:
        session (Session): shell session state.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if call_stack and call_stack.get_all_positional():
        return call_stack.get_all_positional()
    return getattr(session, "positional_args", None) or []


def is_multiword_at(node: tree_sitter.Node) -> bool:
    """Report whether a "${a[@]...}" splat word-splits when quoted.

    True for the ``@``-subscript forms bash keeps as one word per
    element: plain ``${a[@]}``, slice ``${a[@]:o:l}``, per-element
    strip/replace/case ops, and ``${!a[@]}`` indices. False for
    single-word forms (``${a[*]}``, ``${#a[@]}``, non-``@`` subscript,
    or a default/alternate op that acts on the joined value).

    Args:
        node (tree_sitter.Node): the ``expansion`` node.
    """
    if node.type == NT.SIMPLE_EXPANSION:
        # Bare "$@" is the positional splat. It word-splits exactly like
        # "${a[@]}" and stitches onto surrounding literals the same way,
        # so it takes the same path rather than a rule of its own.
        return get_text(node).strip() == "$@"
    if node.type != NT.EXPANSION:
        return False
    p = _parse_braces(node)
    if not _is_at_splat(p) or p.length_op:
        return False
    if p.indirect_op or p.op is None:
        return True
    return p.op in _MULTIWORD_AT_OPS


async def expand_array_at(node: tree_sitter.Node,
                          session: Session,
                          call_stack: CallStack | None,
                          expand_child: ExpandChild,
                          view: SessionView | None = None) -> list[str]:
    """Resolve a multi-word "${a[@]...}" splat to its word list.

    Only call when ``is_multiword_at`` is True; the caller word-splits
    (or stitches prefix/suffix onto) the returned words, matching bash's
    quoted-splat semantics. A slice bound is arithmetic and may assign
    (``${a[@]:x=1:y=x+1}``); those land through the door once the
    words are known, as ``expand_braces`` lands its own.

    Args:
        node (tree_sitter.Node): the ``expansion`` node.
        session (Session): shell session (arrays, env).
        call_stack (CallStack | None): function-call scope, if any.
        expand_child (ExpandChild): nested-node expander for op operands.
        view (SessionView | None): the gated door the slice's writes
            land through; None outside a workspace.
    """
    operand = _ArithOperand(session)
    try:
        words = await _expand_array_at(node, session, call_stack, expand_child,
                                       operand)
    except ExitSignal:
        await land_arith_writes(session, view, tuple(operand.writes),
                                operand.reader)
        raise
    await land_arith_writes(session, view, tuple(operand.writes),
                            operand.reader)
    return words


async def _expand_array_at(node: tree_sitter.Node, session: Session,
                           call_stack: CallStack | None,
                           expand_child: ExpandChild,
                           operand: _ArithOperand) -> list[str]:
    if node.type == NT.SIMPLE_EXPANSION:
        return _positional_args(session, call_stack)
    p = _parse_braces(node)
    arr: list[str | None] | None
    if p.subscript is None and p.var_name == "@":
        # "${@}" splats the positional parameters; every op below then
        # applies per element, which is what bash does for "${@/x/y}".
        # A slice is the exception: bash numbers the parameters from 1
        # there, so index 0 is the shell's own name and "${@:0}" yields
        # it ahead of $1. Pinned on bash 5.2.37; macOS bash 3.2 drops
        # it, so probe this one in docker, not locally.
        params: list[str | None] = [*_positional_args(session, call_stack)]
        arr = [session.argv0, *params] if p.op == ":" else params
    else:
        arrays = visible_arrays(session)
        arr = arrays.get(p.var_name) if p.var_name else None
        amap = (visible_assocs(session).get(p.var_name)
                if p.var_name and arr is None else None)
        if amap is not None:
            if p.indirect_op:
                # Sorted keys, the same deterministic order every other
                # walk of an associative array answers in.
                return sorted(amap)
            arr = [amap[k] for k in sorted(amap)]
    operand.ref = (p.var_name or "") + (f"[{p.subscript}]"
                                        if p.subscript is not None else "")
    env = visible_env(session)
    if arr is None:
        name = p.var_name or ""
        arr = [env[name]] if name in env else []
    if p.indirect_op:
        return [str(i) for i in array_indices(arr)]
    values = array_values(arr)
    if p.op is None:
        return values
    groups: list[str] = []
    for gi, group in enumerate(p.groups):
        pattern_mode = gi == 0 and p.op in _PATTERN_OPS
        groups.append(await _expand_group(group, expand_child, pattern_mode,
                                          session, call_stack))
    if p.op == ":":
        return _slice_array(arr, groups, operand)
    return [_value_op(p.op, el, groups, operand) for el in values]
