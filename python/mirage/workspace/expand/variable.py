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

from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.policy import PolicyDenied
from mirage.shell.array import (
    ShellArray,
    array_extent,
    array_get,
    array_has,
    array_indices,
    array_slice,
    array_values,
)
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import RANDOM
from mirage.shell.errors import (
    ArithError,
    BadSubstitution,
    DiscardSignal,
    ExitSignal,
    ReadonlyError,
    UnboundVariable,
    named,
)
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import get_text, source_parts
from mirage.shell.parameter import bad_substitution, scan_parameter
from mirage.shell.types import ArithWrite, TSNodeLike
from mirage.shell.types import NodeType as NT
from mirage.utils.fnmatch import fnmatch
from mirage.utils.glob_walk import escape_glob, mark_globs
from mirage.utils.path import expand_tilde
from mirage.view.types import SessionView
from mirage.workspace.expand.constants import OPERAND_DQUOTE_ESCAPES
from mirage.workspace.expand.fields import (
    chunks_text,
    ifs_joiner,
    splat_chunks,
    value_piece,
)
from mirage.workspace.expand.substring import substring_operands
from mirage.workspace.expand.types import Chunk, Piece
from mirage.workspace.session import (
    SessionState,
    ensure_var_visible,
    visible_arrays,
    visible_env,
)
from mirage.workspace.session.elements import assign_element, landed_arith
from mirage.workspace.session.shell_dirs import home_dir
from mirage.workspace.session.state import (
    RandomReader,
    nameref_target,
    next_random,
    positional_params,
    subscript_index,
    visible_assocs,
)

ExpandChild = Callable[[TSNodeLike, bool], Awaitable[list[Chunk]]]

_PARAM_OPS = frozenset(
    {
        ":-",
        "-",
        ":+",
        "+",
        ":?",
        "?",
        ":=",
        "=",
        "#",
        "##",
        "%",
        "%%",
        "/",
        "//",
        "/#",
        "/%",
        ":",
        "^",
        "^^",
        ",",
        ",,",
        "!",
    }
)

_REPLACE_OPS = frozenset({"/", "//", "/#", "/%"})

_STRIP_OPS = frozenset({"#", "##", "%", "%%"})

_CASE_OPS = frozenset({"^", "^^", ",", ",,"})

# Ops whose first operand is a glob pattern that must keep its literal
# spelling (no unescaping) while still expanding nested $-expansions.
_PATTERN_OPS = _REPLACE_OPS | _STRIP_OPS | _CASE_OPS

_LITERAL_ARG_TYPES = frozenset({NT.WORD, NT.NUMBER, "regex"})

# Quote-carrying operand nodes: in pattern position their value matches
# literally, exactly as a quoted case pattern does.
_QUOTED_ARG_TYPES = frozenset(
    {NT.STRING, NT.RAW_STRING, NT.ANSI_C_STRING, NT.TRANSLATED_STRING}
)

# Operators that handle unset themselves, so `set -u` must not fire
# on the lookup that feeds them.
_UNSET_GUARD_OPS = frozenset({"-", ":-", "+", ":+", "=", ":=", "?", ":?"})


def guard_expansion_write(session: SessionState, *names: str) -> None:
    """Refuse expansion-time writes that name hidden variables.

    ``${X:=d}`` and ``$((X=5))`` land on the raw session env rather
    than the async session view, so the hidden half of the session view
    (``ensure_var_visible``) is applied here, and the refusal takes the
    fatal expansion-error shape ``${var:?}`` uses.

    Args:
        session (SessionState): shell session the write would land on.
        *names (str): the variable names about to be written.

    Raises:
        ExitSignal: a name is hidden; the line dies with status 1.
    """
    for name in names:
        try:
            ensure_var_visible(session, name)
        except PolicyDenied as exc:
            raise DiscardSignal(
                encode_text(f"bash: {exc.strerror}\n")
            ) from exc


def _write_refusal(exc: PolicyDenied | ArithError) -> ExitSignal:
    """The line's death for a refused expansion-time write.

    The gate's own reason discards the line, as a readonly name's does,
    and so does the ``-i`` coercion refusing the text, as ``n=1+`` does.

    Args:
        exc (PolicyDenied | ArithError): the refusal.
    """
    if isinstance(exc, PolicyDenied):
        return DiscardSignal(encode_text(f"bash: {exc.strerror}\n"))
    return exc.signal(fatal=True)


async def _expansion_index(
    session: SessionState, view: SessionView | None, subscript: str
) -> int:
    """``subscript_index`` in the expansion's voice.

    The subscript's assignments land as the index resolves
    (``${a[x=3]}`` leaves x at 3, ``${a[RANDOM=42]}`` seeds), and a
    refused one dies the way ``expansion_write``'s does.

    Args:
        session (SessionState): the session the subscript reads.
        view (SessionView | None): the gated session view; None outside a
            workspace.
        subscript (str): the raw subscript text.
    """
    try:
        return await subscript_index(session, subscript, view)
    except (PolicyDenied, ArithError) as exc:
        raise _write_refusal(exc) from exc


async def land_arith_writes(
    session: SessionState,
    view: SessionView | None,
    writes: tuple[ArithWrite, ...],
    reader: RandomReader,
) -> None:
    """Land an arithmetic expansion's assignments and settle its draws.

    Each write goes through ``expansion_write`` in evaluation order; then
    the ``RANDOM`` reader replays the draws the expression made after it
    seeded the generator, now that the session view holds the seed. One entry
    point for a completed expression and for one that failed partway, since
    bash binds each assignment as it is made.

    Args:
        session (SessionState): the shell session.
        view (SessionView | None): the gated session view; None outside a
            workspace.
        writes (tuple[ArithWrite, ...]): the assignments, in order.
        reader (RandomReader): the expression's ``RANDOM`` reader.
    """
    try:
        for write in writes:
            await expansion_write(
                session, view, write.name, write.key, write.value
            )
    finally:
        reader.settle()


async def expansion_write(
    session: SessionState,
    view: SessionView | None,
    name: str,
    key: str | None,
    value: str,
    contained: int = 1,
) -> None:
    """One expansion-time write, through the session view.

    ``${X:=d}``, ``${a[i]:=d}`` and ``$((X=5))`` are assignments the
    shell performs while expanding a word rather than while running a
    command, and they used to land on the raw session env. That made
    a ``pre_session`` rule one ``${X:=d}`` away from irrelevant: a
    deployment refusing ``AWS_*`` still had ``${AWS_PROFILE:=prod}``
    write it. They go through the session view now, so one rule covers every
    spelling.

    Without a session view (a unit test outside a workspace) the write lands
    directly, with the hidden half still applied: skipping that would
    let the write-back clobber a value the host's wiring reads.

    The element mechanics are ``assign_element``'s: a bare name over an
    array takes the write at element 0 and keeps its other elements
    (``a=(1 2 3)`` then ``$((a=5))`` leaves ``5 2 3``), an associative
    one writes the literal key ``"0"``, and a subscripted target
    arrives with its key already canonical.

    Args:
        session (SessionState): shell session the write lands on.
        view (SessionView | None): the gated session view,
            None outside a workspace.
        name (str): the variable being written.
        key (str | None): the canonical subscript, None for a bare
            name.
        value (str): the value to store.
        contained (int): the status a readonly name ends a ``( )``
            subshell with (``DiscardSignal``).

    Raises:
        ExitSignal: the name is hidden, a pre_session rule refused the
            write, the subscript is bad, or the name carries ``-i``
            and the text does not evaluate; either way the line dies
            with status 1, the shape ``${var:?}`` uses. A readonly name
            discards the line too.
    """
    guard_expansion_write(session, name)
    try:
        status = await assign_element(session, view, name, key, value)
    except (PolicyDenied, ArithError) as exc:
        raise _write_refusal(exc) from exc
    if status == "readonly":
        raise DiscardSignal(
            encode_text(f"bash: {name}: readonly variable\n"),
            contained_code=contained,
        )
    if status != "ok":
        raise DiscardSignal(
            encode_text(f"bash: {name}[{key}]: bad array subscript\n")
        )


def _lookup_var(
    var: str,
    session: SessionState,
    call_stack: CallStack | None,
    strict: bool = True,
) -> str:
    """Resolve one variable name to its value.

    Args:
        var (str): variable name (plain name, digit, or special).
        session (SessionState): shell session (env, arrays, positionals).
        call_stack (CallStack | None): function-call scope, if any.
        strict (bool): honor ``set -u`` — an unset plain name or
            positional raises; the defaulting operators (``:-`` family)
            pass False because they handle unset themselves. Specials
            (``@ * # ? $ ! 0``) never raise, matching bash >= 4.4.
    """
    env = visible_env(session)
    last_exit_code = session.last_exit_code
    positional = positional_params(session, call_stack)
    nounset = strict and bool(session.shell_options.get("nounset"))
    if var in ("@", "*"):
        # Read where nothing splits: `$@` joins on a space and `$*` on
        # the first character of IFS, as `v=$*` stores them.
        joiner = (
            " " if var == "@" else ifs_joiner(ifs_value(session, call_stack))
        )
        return joiner.join(positional)
    if var == "#":
        return str(len(positional))
    if var == "?":
        return str(last_exit_code)
    if var == "$":
        return str(session.shell_pid or session.process_id or 0)
    if var == "!":
        last_job = session.last_bg_job_id
        return str(last_job) if last_job is not None else ""
    if var.isdigit():
        idx = int(var)
        if idx == 0:
            return session.argv0
        if idx <= len(positional):
            return positional[idx - 1]
        if nounset:
            raise UnboundVariable(var)
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
            raise UnboundVariable(var)
        return ""
    return env[var]


def _positional_set(
    name: str, session: SessionState, call_stack: CallStack | None
) -> bool:
    """Whether ``name`` is a positional parameter the current count reaches.

    Args:
        name (str): the parameter name.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if not name.isdigit():
        return False
    idx = int(name)
    return idx == 0 or idx <= len(positional_params(session, call_stack))


def ifs_value(
    session: SessionState, call_stack: CallStack | None
) -> str | None:
    """The IFS in scope, a function's ``local IFS`` first.

    Args:
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.

    Returns:
        str | None: the value, None when IFS is unset, which splits the
        way the default does.
    """
    if call_stack:
        local = call_stack.get_local("IFS")
        if local is not None:
            return local
    return visible_env(session).get("IFS")


def parameter_chunks(
    name: str,
    session: SessionState,
    call_stack: CallStack | None,
    quoted: bool,
) -> list[Chunk]:
    """One ``$name`` reference as pieces of the word it stands in.

    ``$@`` is one field per positional parameter, quoted or not, and so
    is an unquoted ``$*``; inside double quotes ``$*`` is the parameters
    joined on the first character of IFS.

    Args:
        name (str): the parameter's name.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
        quoted (bool): whether the reference sits inside double quotes.
    """
    if name not in ("@", "*"):
        return [value_piece(_lookup_var(name, session, call_stack), quoted)]
    params = positional_params(session, call_stack)
    joiner = " " if name == "@" else ifs_joiner(ifs_value(session, call_stack))
    if name == "*" and quoted:
        return [value_piece(joiner.join(params), True)]
    return splat_chunks(params, joiner, quoted)


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
    groups: tuple[tuple[str | TSNodeLike, ...], ...]
    subscript_nodes: tuple[TSNodeLike, ...] = ()


def _group_separator(op: str | None) -> str | None:
    if op in _REPLACE_OPS:
        return "/"
    if op == ":":
        return ":"
    return None


def _parse_braces(node: TSNodeLike) -> _BraceParse:
    var_name = None
    subscript = None
    subscript_nodes: tuple[TSNodeLike, ...] = ()
    length_op = False
    indirect_op = False
    op = None
    groups: list[list[str | TSNodeLike]] = []
    seen_var = False
    for c in source_parts(node):
        if isinstance(c, str):
            if op is not None:
                groups[-1].append(c)
            continue
        if c.type == "${" or c.type == "}":
            continue
        if c.type == "#" and not seen_var:
            length_op = True
            continue
        if c.type == "!" and not seen_var:
            indirect_op = True
            continue
        if (
            c.type in (NT.VARIABLE_NAME, NT.SPECIAL_VARIABLE_NAME)
            and not seen_var
        ):
            var_name = get_text(c)
            seen_var = True
            continue
        if c.type == "subscript" and not seen_var:
            sub_nodes: list[TSNodeLike] = []
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
                subscript = sub_text[len(var_name) + 1 : -1]
            seen_var = True
            continue
        if c.type in _PARAM_OPS and op is None:
            op = get_text(c)
            groups.append([])
            continue
        if (
            op is not None
            and not c.is_named
            and c.type == _group_separator(op)
        ):
            groups.append([])
            continue
        if op is not None:
            groups[-1].append(c)
    if length_op and var_name is None:
        # A `#` naming nothing after it is the parameter itself: `${#}`
        # is the count and `${!#}` the last positional parameter.
        var_name, length_op = "#", False
    return _BraceParse(
        var_name=var_name,
        subscript=subscript,
        length_op=length_op,
        indirect_op=indirect_op,
        op=op,
        groups=tuple(tuple(g) for g in groups),
        subscript_nodes=subscript_nodes,
    )


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


def _dquoted_pattern(
    inner: str, session: SessionState, call_stack: CallStack | None
) -> str:
    """A double-quoted pattern segment: everything in it is literal.

    Args:
        inner (str): the text between the double quotes.
        session (SessionState): shell session for name resolution.
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
            ref = scan_parameter(inner, i)
            if ref is not None:
                name, nxt = ref
                out.append(escape_glob(_lookup_var(name, session, call_stack)))
                i = nxt
                continue
        out.append(escape_glob(ch))
        i += 1
    return "".join(out)


def _pattern_text(
    text: str, session: SessionState, call_stack: CallStack | None
) -> str:
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
        session (SessionState): shell session for name resolution.
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
        if ch == "'":
            end = text.find("'", i + 1)
            if end != -1:
                out.append(escape_glob(text[i + 1 : end]))
                i = end + 1
                continue
        if ch == '"':
            end = _escaped_find(text, i + 1, '"')
            if end != -1:
                out.append(
                    _dquoted_pattern(text[i + 1 : end], session, call_stack)
                )
                i = end + 1
                continue
        if ch == "$" and i + 1 < n:
            if text[i + 1] == "'":
                end = _escaped_find(text, i + 2, "'")
                if end != -1:
                    out.append(escape_glob(decode_ansi_c(text[i + 2 : end])))
                    i = end + 1
                    continue
            ref = scan_parameter(text, i)
            if ref is not None:
                name, nxt = ref
                out.append(_lookup_var(name, session, call_stack))
                i = nxt
                continue
        out.append(ch)
        i += 1
    return "".join(out)


async def _child_text(expand_child: ExpandChild, node: TSNodeLike) -> str:
    """A nested node's text where nothing splits, glob marks removed.

    Args:
        expand_child (ExpandChild): nested-node expander.
        node (TSNodeLike): the node to expand.
    """
    return chunks_text(await expand_child(node, False))


async def _pattern_operand(
    node: TSNodeLike,
    expand_child: ExpandChild,
    session: SessionState,
    call_stack: CallStack | None,
) -> str:
    if node.type == NT.CONCATENATION:
        return await _pattern_group(
            tuple(source_parts(node)), expand_child, session, call_stack
        )
    if node.type in _QUOTED_ARG_TYPES:
        # Quoted pattern text matches literally, the same rule case
        # patterns follow: the value, inner expansions included, is
        # escaped so its glob characters match themselves.
        return escape_glob(await _child_text(expand_child, node))
    if node.type in _LITERAL_ARG_TYPES:
        return _pattern_text(get_text(node), session, call_stack)
    return await _child_text(expand_child, node)


async def _pattern_group(
    parts: tuple[str | TSNodeLike, ...],
    expand_child: ExpandChild,
    session: SessionState,
    call_stack: CallStack | None,
) -> str:
    """Expand one pattern operand, the source text between its nodes included.

    That text is only ever the scanner's extras: blanks, a line
    continuation, which vanishes, and an escaped blank, which is the
    blank as in an unquoted word.

    Args:
        parts (tuple[str | TSNodeLike, ...]): the operand's source parts.
        expand_child (ExpandChild): nested-node expander.
        session (SessionState): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
    """
    pieces: list[str] = []
    for part in parts:
        if isinstance(part, str):
            pieces.append(part.replace("\\\n", "").replace("\\", ""))
        else:
            pieces.append(
                await _pattern_operand(part, expand_child, session, call_stack)
            )
    return "".join(pieces)


def _operand_literal(
    text: str,
    quoted: bool,
    session: SessionState,
    call_stack: CallStack | None,
    home: str | None,
) -> list[Chunk]:
    """Literal operand text as pieces; the rules are ``_word_chunks``'.

    Args:
        text (str): the literal text as typed.
        quoted (bool): whether the expansion sits inside double quotes.
        session (SessionState): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
        home (str | None): what a leading ``~`` names, None where no
            tilde prefix can stand.
    """
    if not quoted and home is not None and not any(c in text for c in "\\$"):
        tilde = expand_tilde(text, home)
        if tilde != text:
            return [Piece(tilde)]
    out: list[Chunk] = []
    run: list[str] = []

    def flush() -> None:
        if run:
            literal = "".join(run)
            out.append(value_piece(literal, quoted))
            run.clear()

    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            escaped = text[index + 1]
            index += 2
            if escaped == "\n":
                continue
            if not quoted:
                flush()
                out.append(Piece(mark_globs(escaped)))
            elif escaped in OPERAND_DQUOTE_ESCAPES:
                run.append(escaped)
            else:
                run.append(char + escaped)
            continue
        ref = scan_parameter(text, index) if char == "$" else None
        if ref is not None:
            flush()
            out.extend(parameter_chunks(ref[0], session, call_stack, quoted))
            index = ref[1]
            continue
        run.append(char)
        index += 1
    flush()
    return out


def _flat_parts(
    parts: tuple[str | TSNodeLike, ...],
) -> Iterator[str | TSNodeLike]:
    """An operand word's source parts, concatenations opened up.

    Args:
        parts (tuple[str | TSNodeLike, ...]): the word's source parts.
    """
    for part in parts:
        if not isinstance(part, str) and part.type == NT.CONCATENATION:
            yield from _flat_parts(tuple(source_parts(part)))
        else:
            yield part


def _unescape_all(text: str) -> str:
    """Text whose every backslash quotes the character after it.

    Args:
        text (str): the text as typed.
    """
    out: list[str] = []
    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text):
            if text[index + 1] != "\n":
                out.append(text[index + 1])
            index += 2
            continue
        out.append(text[index])
        index += 1
    return "".join(out)


async def _nested_string(
    node: TSNodeLike, expand_child: ExpandChild
) -> list[Chunk]:
    """A double-quoted string inside the word of a quoted expansion.

    bash reads the inner pair as leaving the outer quotes, so a
    backslash there quotes any character, as in an unquoted word
    (``"${u:-"a\\ b"}"`` is ``a b``); the text is quoted all the same, a
    single quote and a glob character literal and nothing splitting.

    Args:
        node (TSNodeLike): the nested string node.
        expand_child (ExpandChild): nested-node expander.
    """
    out: list[Chunk] = [Piece("")]
    inside = get_text(node)[1:-1]
    for part in source_parts(node):
        if isinstance(part, str) or part.type == NT.STRING_CONTENT:
            text = part if isinstance(part, str) else get_text(part)
        elif part.type == NT.DQUOTE:
            text = get_text(part)[:-1]
        else:
            out.extend(await named(inside, expand_child(part, True)))
            continue
        out.append(Piece(mark_globs(_unescape_all(text))))
    return out


async def _word_chunks(
    parts: tuple[str | TSNodeLike, ...],
    expand_child: ExpandChild,
    quoted: bool,
    session: SessionState,
    call_stack: CallStack | None,
) -> list[Chunk]:
    """Expand an operator's word to pieces of the word it stands in.

    Inside double quotes the word follows double-quote rules: a
    backslash escapes only ``$ ` " \\ }`` and a newline, a single-quoted
    string is literal text, quotes and all, and nothing splits.
    Unquoted, an escaped character and a quoted string are quoted text,
    which never splits, while the word's literal text and its
    expansions split the way the expansion's value would. The literal
    text runs between nodes are read whole, source text between nodes
    included, since the grammar can split one escape across two of
    them (``\\\\`` arrives as a gap and a word); ``$*``, ``$#`` and the
    other special parameters arrive as literal text too, which the
    grammar leaves unlexed inside an operand.

    Args:
        parts (tuple[str | TSNodeLike, ...]): the word's source parts.
        expand_child (ExpandChild): nested-node expander.
        quoted (bool): whether the expansion sits inside double quotes.
        session (SessionState): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
    """
    home = home_dir(session)
    out: list[Chunk] = []
    literal: list[str] = []
    for part in _flat_parts(parts):
        if isinstance(part, str) or part.type in _LITERAL_ARG_TYPES:
            literal.append(part if isinstance(part, str) else get_text(part))
            continue
        out.extend(
            _operand_literal(
                "".join(literal),
                quoted,
                session,
                call_stack,
                None if out else home,
            )
        )
        literal.clear()
        if quoted and part.type == NT.RAW_STRING:
            out.append(Piece(mark_globs(get_text(part))))
        elif quoted and part.type == NT.STRING:
            out.extend(await _nested_string(part, expand_child))
        else:
            out.extend(await expand_child(part, quoted))
    out.extend(
        _operand_literal(
            "".join(literal),
            quoted,
            session,
            call_stack,
            None if out else home,
        )
    )
    return out


def _glob_strip(
    value: str, pattern: str, greedy: bool, prefix: bool, extglob: bool = False
) -> str:
    if not pattern:
        return value
    indices = (
        range(len(value), -1, -1)
        if greedy == prefix
        else range(len(value) + 1)
    )
    for i in indices:
        candidate = value[:i] if prefix else value[i:]
        if fnmatch(candidate, pattern, extglob=extglob):
            return value[i:] if prefix else value[:i]
    return value


def _glob_replace(
    value: str,
    pattern: str,
    replacement: str,
    replace_all: bool,
    anchor: str | None,
    extglob: bool = False,
) -> str:
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
            if fnmatch(value[:j], pattern, extglob=extglob):
                return replacement + value[j:]
        return value
    if anchor == "%":
        for i in range(len(value) + 1):
            if fnmatch(value[i:], pattern, extglob=extglob):
                return value[:i] + replacement
        return value
    if not value:
        return replacement if fnmatch("", pattern, extglob=extglob) else value
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        match_end = -1
        for j in range(n, i - 1, -1):
            if fnmatch(value[i:j], pattern, extglob=extglob):
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


def _case_mod(op: str, val: str, pattern: str, extglob: bool = False) -> str:
    if not val:
        return val
    chars = list(val)
    scope = range(len(chars)) if op in ("^^", ",,") else range(1)
    for i in scope:
        ch = chars[i]
        if pattern and not fnmatch(ch, pattern, extglob=extglob):
            continue
        chars[i] = ch.upper() if op in ("^", "^^") else ch.lower()
    return "".join(chars)


class _ArithOperand:
    """Evaluate and apply one substring bound before expanding the next.

    Args:
        session (SessionState): the session the bound reads and writes.
        view (SessionView | None): the gated session view for arithmetic
            writes.
    """

    def __init__(
        self, session: SessionState, view: SessionView | None = None
    ) -> None:
        self.session = session
        self.view = view
        self.ref = ""

    async def value(self, text: str) -> int:
        """Evaluate a bound and land its writes, including before failure.

        Args:
            text (str): the expanded arithmetic expression.
        """
        nounset = bool(self.session.shell_options.get("nounset"))
        try:
            return await landed_arith(
                self.session, self.view, text, land_arith_writes, nounset
            )
        except ReadonlyError as exc:
            raise exc.signal() from exc
        except ArithError as exc:
            raise exc.signal(self.ref) from exc


async def _slice_bounds(
    node: TSNodeLike,
    expand_child: ExpandChild,
    operand: _ArithOperand,
    extent: int,
    allow_end: bool = False,
) -> tuple[int, int | None] | None:
    """Expand and evaluate bounds left to right, stopping at an invalid offset.

    Args:
        node (TSNodeLike): substring expansion.
        expand_child (ExpandChild): nested word evaluator.
        operand (_ArithOperand): arithmetic evaluator and session write entry
            point.
        extent (int): scalar length or array index extent.
        allow_end (bool): scalar slices may start exactly at the end.
    """
    values: list[int] = []
    async for text in substring_operands(
        node, partial(_child_text, expand_child)
    ):
        value = await operand.value(text)
        if not values:
            if value < 0:
                value += extent
            if (
                value < 0
                or value > extent
                or (value == extent and not allow_end)
            ):
                return None
        values.append(value)
    return values[0], values[1] if len(values) > 1 else None


async def _substring(
    val: str,
    node: TSNodeLike,
    expand_child: ExpandChild,
    operand: _ArithOperand,
) -> str:
    bounds = await _slice_bounds(node, expand_child, operand, len(val), True)
    if bounds is None:
        return ""
    offset, length = bounds
    if length is None:
        return val[offset:]
    if length < 0:
        return val[offset : max(offset, len(val) + length)]
    return val[offset : offset + length]


_SUBSCRIPT_LITERAL_TYPES = frozenset({NT.WORD, NT.NUMBER, NT.ERROR})

# The operators whose word bash expands only once the parameter's state
# selects it (a default, an alternate, an assignment, a message).
_LAZY_OPS = frozenset({"?", ":?", "=", ":=", ":-", "-", ":+", "+"})


async def _operator_word(
    p: _BraceParse,
    expand_child: ExpandChild,
    quoted: bool,
    session: SessionState,
    call_stack: CallStack | None,
) -> list[Chunk]:
    """The word of a conditional operator, expanded now that it is needed.

    Args:
        p (_BraceParse): the parsed expansion.
        expand_child (ExpandChild): nested-node expander.
        quoted (bool): whether the expansion sits inside double quotes.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if not p.groups:
        return []
    return await named(
        _source(p.groups[0]),
        _word_chunks(p.groups[0], expand_child, quoted, session, call_stack),
    )


def _source(parts: tuple[str | TSNodeLike, ...]) -> str:
    """An operand's text as written, the word a bad substitution names.

    Args:
        parts (tuple[str | TSNodeLike, ...]): the operand's source parts.
    """
    return "".join(
        part if isinstance(part, str) else get_text(part) for part in parts
    )


def _word_result(chunks: list[Chunk], quoted: bool) -> list[Chunk]:
    """An operator's word standing in for a splat.

    A quoted splat that selects its word yields that word even when it
    is empty: ``"${e[@]:-}"`` is one empty word where ``"${e[@]}"`` is
    none.

    Args:
        chunks (list[Chunk]): the word's pieces.
        quoted (bool): whether the expansion sits inside double quotes.
    """
    return [Piece(""), *chunks] if quoted else chunks


async def _unset_error(
    p: _BraceParse,
    expand_child: ExpandChild,
    session: SessionState,
    call_stack: CallStack | None,
) -> ExitSignal:
    """The death of a line whose ``${v:?word}`` found v unset or null.

    The word is the message, read with unquoted rules even inside double
    quotes, as bash reads it. GNU: fatal at top level with status 127; a
    containing subshell/pipeline segment reports 1. A subscripted
    reference is named whole: `bash: m[zz]: nope`.

    Args:
        p (_BraceParse): the parsed expansion.
        expand_child (ExpandChild): nested-node expander.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
    """
    message = chunks_text(
        await _operator_word(p, expand_child, False, session, call_stack)
    )
    if not message:
        message = (
            "parameter not set" if p.op == "?" else "parameter null or not set"
        )
    ref = p.var_name if p.subscript is None else f"{p.var_name}[{p.subscript}]"
    return ExitSignal(
        127, stderr=encode_text(f"bash: {ref}: {message}\n"), contained_code=1
    )


async def _expand_subscript_key(
    p: _BraceParse, expand_child: ExpandChild
) -> str:
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
    parts = [await _child_text(expand_child, n) for n in nodes]
    return "".join(parts)


def _value_op(
    op: str, val: str, groups: list[str], extglob: bool = False
) -> str:
    if op in _STRIP_OPS:
        pattern = groups[0] if groups else ""
        return _glob_strip(
            val, pattern, op in ("##", "%%"), op in ("#", "##"), extglob
        )
    if op in _REPLACE_OPS:
        pattern = groups[0] if groups else ""
        replacement = groups[1] if len(groups) > 1 else ""
        anchor = op[1] if len(op) > 1 and op[1] in "#%" else None
        return _glob_replace(
            val, pattern, replacement, op == "//", anchor, extglob
        )
    if op in _CASE_OPS:
        return _case_mod(op, val, groups[0] if groups else "", extglob)
    return val


async def expand_braces(
    node: TSNodeLike,
    session: SessionState,
    call_stack: CallStack | None,
    expand_child: ExpandChild,
    view: SessionView | None = None,
    quoted: bool = False,
) -> list[Chunk]:
    """Expand ${VAR}, ${VAR<op>...}, ${a[i]}, ${#a[@]}, etc. to pieces.

    An offset, length or slice bound is arithmetic and may assign
    (``${v:x=1:y=2}``) or seed (``${v:RANDOM%10:1}``); each bound lands
    through the session view before the next bound expands.

    Args:
        node (TSNodeLike): the ``expansion`` tree-sitter node.
        session (SessionState): shell session (env, arrays, positionals).
        call_stack (CallStack | None): function-call scope, if any.
        expand_child (ExpandChild): callback that expands a nested node
            (dependency-injected to avoid a cycle with ``expand_node``).
        view (SessionView | None): the gated session view the expansion's
            writes land through; None outside a workspace.
        quoted (bool): whether the expansion sits inside double quotes,
            which decides the rules an operator's word follows and the
            shape a ``$*``-style splat takes.
    """
    return await _expand_braces(
        node,
        session,
        call_stack,
        expand_child,
        view,
        _ArithOperand(session, view),
        quoted,
    )


async def _expand_braces(
    node: TSNodeLike,
    session: SessionState,
    call_stack: CallStack | None,
    expand_child: ExpandChild,
    view: SessionView | None,
    operand: _ArithOperand,
    quoted: bool,
) -> list[Chunk]:
    text = get_text(node).lstrip()
    if bad_substitution(text):
        raise BadSubstitution(text)
    p = _parse_braces(node)
    env = visible_env(session)
    arrays = visible_arrays(session)
    assocs = visible_assocs(session)
    operand.ref = (p.var_name or "") + (
        f"[{p.subscript}]" if p.subscript is not None else ""
    )

    # A conditional operator's word expands only if the parameter's
    # state selects it, as bash's does: `${RANDOM:-$RANDOM}` draws once
    # and `${x:-$(cmd)}` runs cmd only when x is unset. Every other
    # operator's words are needed whatever the value, and expand here:
    # the pattern as a pattern, the replacement with unquoted rules even
    # inside double quotes, as bash reads it.
    groups: list[str] = []
    if p.op != ":" and p.op not in _LAZY_OPS:
        for gi, group in enumerate(p.groups):
            if gi == 0 and p.op in _PATTERN_OPS:
                groups.append(
                    await named(
                        _source(group),
                        _pattern_group(
                            group, expand_child, session, call_stack
                        ),
                    )
                )
            else:
                groups.append(
                    chunks_text(
                        await named(
                            _source(group),
                            _word_chunks(
                                group, expand_child, False, session, call_stack
                            ),
                        )
                    )
                )

    splat = _splat_source(p, session, call_stack, env, arrays, assocs)
    if splat is not None:
        return await _expand_splat(
            p,
            splat[0],
            splat[1],
            node,
            expand_child,
            operand,
            session,
            call_stack,
            quoted,
            groups,
        )

    val = ""
    var_in_env = False
    # The subscript as `:=` would write it: the key itself for an
    # associative name, the resolved index for an indexed one, None
    # for a negative index past the front, which bash refuses to assign
    # through.
    write_key: str | None = None
    amap = assocs.get(p.var_name) if p.var_name is not None else None
    if p.subscript is not None and p.var_name is not None and amap is not None:
        # A key, not an expression: `${m[1+1]}` reads the key
        # "1+1", never element 2. An empty key reads as unset
        # (GNU warns "bad array subscript" on stderr and expands
        # empty; expansion has no warning channel, so the empty
        # answer stands alone).
        key = await named(p.subscript, _expand_subscript_key(p, expand_child))
        val = amap.get(key, "")
        var_in_env = key in amap
        write_key = key
    elif p.subscript is not None and p.var_name is not None:
        arr = arrays.get(p.var_name)
        if arr is None:
            # A scalar is element 0 of a one-element array, even when
            # empty: ${#x[@]} is 1 for x="" but 0 for an unset name.
            arr = [env[p.var_name]] if p.var_name in env else []
        # Expanded first (`${a[$k]}` resolves $k, `${a[i+1]}` stays
        # arithmetic), then evaluated as an index.
        sub_text = await named(
            p.subscript, _expand_subscript_key(p, expand_child)
        )
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
            # lookup; set-ness follows value presence, except that a
            # positional parameter is set whenever the count reaches it,
            # empty or not (`set -- ""` sets $1).
            val = _lookup_var(
                p.var_name,
                session,
                call_stack,
                strict=p.op not in _UNSET_GUARD_OPS,
            )
            var_in_env = val != "" or _positional_set(
                p.var_name, session, call_stack
            )

    # `set -u` refuses an element or key that holds nothing, named as
    # typed (`a[i]`, `m[$k]`), unless the operator handles unset itself;
    # a length is 0 (bash 5.2.37). A scalar's refusal is _lookup_var's.
    if (
        p.subscript is not None
        and not var_in_env
        and session.shell_options.get("nounset")
        and not p.length_op
        and not p.indirect_op
        and p.op not in _UNSET_GUARD_OPS
    ):
        raise UnboundVariable(f"{p.var_name}[{p.subscript}]")
    if p.indirect_op:
        # `${!r}` on a name reference is the target's *name*, not an
        # indirection through the value.
        target = (
            nameref_target(session, p.var_name)
            if p.var_name is not None
            else None
        )
        if target is None:
            target = _lookup_var(val, session, call_stack) if val else ""
        return [value_piece(target, quoted)]
    if p.length_op:
        return [value_piece(str(len(val)), quoted)]
    if p.op is None:
        return [value_piece(val, quoted)]
    if p.op in ("?", ":?"):
        triggered = (not var_in_env) if p.op == "?" else (not val)
        if not triggered:
            return [value_piece(val, quoted)]
        raise await _unset_error(p, expand_child, session, call_stack)
    if p.op in ("=", ":="):
        triggered = (not var_in_env) if p.op == "=" else (not val)
        if not triggered:
            return [value_piece(val, quoted)]
        default = chunks_text(
            await _operator_word(p, expand_child, quoted, session, call_stack)
        )
        # A refused default ends a `( )` subshell, or a forked compound
        # command, with 2, unless `set -e` ends it first with 1; a line
        # loop reads it as a discard.
        contained = (
            2
            if call_stack is not None
            and call_stack.paren
            and not session.shell_options.get("errexit")
            else 1
        )
        if p.var_name is not None and p.subscript is not None:
            # The default lands on the element the reference named,
            # never on element 0: `${m[k]:=v}` writes key k and
            # `${a[3]:=v}` writes index 3, as bash does. An index
            # before the front is refused in bash's words.
            if write_key is None:
                raise _bad_subscript(p)
            await expansion_write(
                session, view, p.var_name, write_key, default, contained
            )
        elif p.var_name is not None:
            if (
                call_stack is not None
                and call_stack.get_local(p.var_name) is not None
            ):
                call_stack.set_local(p.var_name, default)
            else:
                await expansion_write(
                    session, view, p.var_name, None, default, contained
                )
        return [value_piece(default, quoted)]
    if p.op in (":-", "-"):
        if val if p.op == ":-" else var_in_env:
            return [value_piece(val, quoted)]
        return await _operator_word(
            p, expand_child, quoted, session, call_stack
        )
    if p.op in (":+", "+"):
        if not (val if p.op == ":+" else var_in_env):
            return []
        return await _operator_word(
            p, expand_child, quoted, session, call_stack
        )
    if p.op == ":":
        # bash slices only a set parameter: an unset one expands empty
        # and its bounds are never evaluated, so `${a[i]:.2f}` is nothing
        # while a[i] is unset and an arithmetic error once it is set
        # (5.2.37).
        if not var_in_env:
            return [value_piece("", quoted)]
        return [
            value_piece(
                await _substring(val, node, expand_child, operand), quoted
            )
        ]
    return [
        value_piece(
            _value_op(p.op, val, groups, session.shopts.get("extglob", False)),
            quoted,
        )
    ]


def _bad_subscript(p: _BraceParse) -> DiscardSignal:
    """The refusal of a ``:=`` that names no single element.

    Args:
        p (_BraceParse): the parsed expansion.
    """
    return DiscardSignal(
        encode_text(
            f"bash: {p.var_name}[{p.subscript}]: bad array subscript\n"
        )
    )


def _splat_source(
    p: _BraceParse,
    session: SessionState,
    call_stack: CallStack | None,
    env: Mapping[str, str],
    arrays: Mapping[str, ShellArray],
    assocs: Mapping[str, dict[str, str]],
) -> tuple[ShellArray, list[str]] | None:
    """The elements a ``$@``/``$*``-style splat walks, and their keys.

    The positional parameters for ``${@...}`` and ``${*...}``, which a
    slice numbers from 1 so that index 0 is the shell's own name
    (``"${@:0}"`` yields it ahead of $1; pinned on bash 5.2.37, macOS
    bash 3.2 drops it). Every element of an array for ``${a[@]...}``
    and ``${a[*]...}``, holes left by ``unset a[i]`` included so a slice
    keeps its indices; an associative array walks its keys sorted,
    since bash's hash order is unpredictable and a deterministic answer
    beats reproducing noise. A scalar is element 0 of a one-element
    array. None for any other expansion.

    Args:
        p (_BraceParse): the parsed expansion.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
        env (Mapping[str, str]): the visible scalars.
        arrays (Mapping[str, ShellArray]): the visible indexed arrays.
        assocs (Mapping[str, dict[str, str]]): the visible associative
            arrays.
    """
    if p.subscript is None:
        if p.var_name not in ("@", "*"):
            return None
        params = positional_params(session, call_stack)
        keys = [str(i) for i in range(1, len(params) + 1)]
        if p.op == ":":
            return [session.argv0, *params], keys
        return list(params), keys
    if p.var_name is None or p.subscript not in ("@", "*"):
        return None
    amap = assocs.get(p.var_name)
    if amap is not None:
        keys = sorted(amap)
        return [amap[k] for k in keys], keys
    arr = arrays.get(p.var_name)
    if arr is None:
        arr = [env[p.var_name]] if p.var_name in env else []
    return arr, [str(i) for i in array_indices(arr)]


async def _expand_splat(
    p: _BraceParse,
    arr: ShellArray,
    keys: list[str],
    node: TSNodeLike,
    expand_child: ExpandChild,
    operand: _ArithOperand,
    session: SessionState,
    call_stack: CallStack | None,
    quoted: bool,
    groups: list[str],
) -> list[Chunk]:
    """Expand a splat: one field per element, whatever the operator.

    ``@`` keeps its elements apart inside double quotes too, and a
    quoted ``*`` joins them on IFS's first character. A slice, the
    per-element strip, replace and case operators and ``${!a[@]}``'s
    keys all stay a splat; ``${#a[@]}`` is the count. A conditional
    operator tests the elements as one: set when there is any, null
    when they join to nothing, a space joining ``@``'s as IFS joins
    ``*``'s, so ``("" "")`` is null for ``*`` alone under ``IFS=``.
    Unselected, ``:+`` yields no field over no elements and one empty
    field over empty ones, as bash does.

    Args:
        p (_BraceParse): the parsed expansion.
        arr (ShellArray): the elements, holes included.
        keys (list[str]): the elements' keys, in order.
        node (TSNodeLike): the expansion node, for slice bounds.
        expand_child (ExpandChild): nested-node expander.
        operand (_ArithOperand): arithmetic evaluator for slice bounds.
        session (SessionState): shell session.
        call_stack (CallStack | None): function-call scope, if any.
        quoted (bool): whether the expansion sits inside double quotes.
        groups (list[str]): the operator's expanded operands.
    """
    star = (p.subscript if p.subscript is not None else p.var_name) == "*"
    joiner = ifs_joiner(ifs_value(session, call_stack)) if star else " "
    values = array_values(arr)
    if p.length_op:
        return [value_piece(str(len(values)), quoted)]
    items = values
    if p.indirect_op:
        items = keys
    elif p.op == ":":
        # An array with no element is unset to a slice, as a scalar is:
        # empty, bounds unevaluated. The positional parameters always
        # evaluate theirs, since `$0` stands at their front.
        unset = p.subscript is not None and not values
        items = (
            []
            if unset
            else await _slice_array(arr, node, expand_child, operand)
        )
    elif p.op in _STRIP_OPS | _REPLACE_OPS | _CASE_OPS:
        items = [
            _value_op(p.op, el, groups, session.shopts.get("extglob", False))
            for el in values
        ]
    elif p.op in _UNSET_GUARD_OPS:
        triggered = (
            not values
            if p.op in ("-", "+", "=", "?")
            else not joiner.join(values)
        )
        if p.op in ("+", ":+"):
            if triggered:
                return splat_chunks([""], joiner, quoted) if values else []
            return _word_result(
                await _operator_word(
                    p, expand_child, quoted, session, call_stack
                ),
                quoted,
            )
        if triggered and p.op in ("-", ":-"):
            return _word_result(
                await _operator_word(
                    p, expand_child, quoted, session, call_stack
                ),
                quoted,
            )
        if triggered and p.op in ("?", ":?"):
            raise await _unset_error(p, expand_child, session, call_stack)
        if triggered and p.subscript is not None:
            raise _bad_subscript(p)
        if triggered:
            raise DiscardSignal(
                encode_text(
                    f"bash: ${p.var_name}: cannot assign in this way\n"
                )
            )
    if star and quoted:
        return [value_piece(joiner.join(items), True)]
    return splat_chunks(items, joiner, quoted)


async def _slice_array(
    arr: ShellArray,
    node: TSNodeLike,
    expand_child: ExpandChild,
    operand: _ArithOperand,
) -> list[str]:
    bounds = await _slice_bounds(
        node, expand_child, operand, array_extent(arr)
    )
    return [] if bounds is None else array_slice(arr, *bounds)


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


def is_at_splat(node: TSNodeLike) -> bool:
    """Whether an expansion is a ``$@``-style splat.

    Inside double quotes such a splat yields one field per element and
    no field at all when there is none: ``"$@"`` with no parameters is
    no word, where ``"$*"`` is one empty word. ``${#a[@]}`` is a count,
    so it is one word like any other.

    Args:
        node (TSNodeLike): a child of a double-quoted string.
    """
    if node.type == NT.SIMPLE_EXPANSION:
        return get_text(node).strip() == "$@"
    if node.type != NT.EXPANSION:
        return False
    p = _parse_braces(node)
    return _is_at_splat(p) and not p.length_op
