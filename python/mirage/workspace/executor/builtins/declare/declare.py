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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.policy import PolicyDenied
from mirage.shell.array import (
    array_get,
    array_set,
    build_assoc_literal,
    build_indexed_literal,
)
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ArithError, DiscardSignal
from mirage.shell.printer import stored_function_text
from mirage.shell.variable import (
    ShellValue,
    ShellVar,
    VarAttr,
    VarKind,
    appended,
    attr_letters,
)
from mirage.utils.hidden import var_hidden
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.declare.constants import (
    ANSI_C_ESCAPES,
    BARE_KEY_RE,
    LISTED_ATTRIBUTES,
    SUBSCRIPT_RE,
    VISIBLE_SCOPE_BUILTINS,
)
from mirage.workspace.executor.builtins.declare.types import (
    AttrMarks,
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.shared import (
    arith_refusal,
    is_valid_name,
    readonly_line,
    refusal,
    require_view,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    conversion_scalar,
    deref,
    in_call_env,
    outlive_call,
    set_attr,
    shadow_local,
    subscript_index,
)
from mirage.workspace.types import ExecutionNode


async def premark(
    view: SessionView, name: str, shaping: AttrMarks, follow_ref: bool = True
) -> None:
    """Put a declaration's value-shaping marks on a name before its
    value stores.

    The door coerces on write by reading the record's attributes, so
    for the declaration's *own* value to coerce (``declare -i n=3+4``
    stores ``7``), the attribute has to be there first; a ``+`` letter
    comes off first too, so ``declare -i N=5; declare +i N+=x`` stores
    ``5x``. Gated through ``view.mark`` like every other mark, and a
    no-op with nothing to shape, so a plain ``declare X=1`` costs no
    extra gate call.

    Args:
        view (SessionView): the session plane's gated door.
        name (str): the variable being declared.
        shaping (AttrMarks): the ``-i -l -u`` / ``+i +l +u`` marks.
        follow_ref (bool): the write follows a reference; a ``-n``
            declaration shapes the reference itself.
    """
    for attr, on in shaping:
        await view.mark(name, attr, on, follow_ref)


def declared_kind(flags: set[str] | frozenset[str]) -> VarKind | None:
    """The array kind a declaration's ``-a`` / ``-A`` asks for, ``-A``
    winning when both are given (bash's ``export -aA B=(1)`` builds a
    map), or None for neither.

    Args:
        flags (set[str] | frozenset[str]): the declaration's letters.
    """
    if "A" in flags:
        return VarKind.ASSOC
    if "a" in flags:
        return VarKind.INDEXED
    return None


def held_value(session: SessionState, name: str) -> ShellValue | None:
    """The value a declaration's ``NAME=...`` lands on: the variable a
    ``declare -n`` reference names.

    Args:
        session (SessionState): shell session state.
        name (str): the declared name.
    """
    var = session.vars.get(deref(session, name))
    return None if var is None else var.value


def local_attrs(var: ShellVar | None, inherit: bool) -> frozenset[VarAttr]:
    """The attributes a new local takes from the variable it shadows:
    the export mark alone (``local I=2+3`` over ``declare -i I`` stores
    ``2+3``), or with ``-I`` every one but a reference, as bash's
    ``local -I`` keeps ``-i`` and drops ``-n``.

    Args:
        var (ShellVar | None): the shadowed record.
        inherit (bool): the declaration carried ``-I``.
    """
    if var is None:
        return frozenset()
    if inherit:
        return var.attrs - {VarAttr.NAMEREF}
    return var.attrs & {VarAttr.EXPORT}


def start_local(session: SessionState, name: str, inherit: bool) -> None:
    """Reset a name the running function just shadowed to what a new
    local starts as: unset, with the attributes ``local_attrs`` keeps,
    or under ``-I`` the shadowed value too, so ``local -I A=new`` over
    ``A=(old keep)`` writes element 0 of ``(old keep)``.

    This is the scope's own bookkeeping, not a session write: the
    caller's record is the frame's to put back on return, so no policy
    is asked to delete it. The local's value lands later through the
    gated door, which judges that write.

    Args:
        session (SessionState): shell session state.
        name (str): the name a ``shadow_local`` just recorded.
        inherit (bool): the declaration carried ``-I``.
    """
    var = session.vars.pop(name, None)
    kept = local_attrs(var, inherit)
    if var is not None and (kept or inherit):
        session.vars[name] = ShellVar(var.value if inherit else None, kept)


def kind_conflict(held: ShellValue | None, kind: VarKind | None) -> str | None:
    """bash's refusal when a declared array kind meets a value of the
    other kind, or None when they agree.

    Args:
        held (ShellValue | None): the value the declaration lands on.
        kind (VarKind | None): the kind ``-a`` / ``-A`` asked for.
    """
    if kind is VarKind.ASSOC and isinstance(held, list):
        return "cannot convert indexed to associative array"
    if kind is VarKind.INDEXED and isinstance(held, dict):
        return "cannot convert associative to indexed array"
    return None


def scalar_value(
    held: ShellValue | None,
    value: str,
    kind: VarKind | None,
    append: bool = False,
    integer: bool = False,
) -> tuple[ShellValue, frozenset[int | str] | None]:
    """What a declaration's ``NAME=value`` stores, and the elements it
    assigns (``coerce_value``).

    An array keeps its kind and takes the value at element 0 (key
    ``"0"`` in a map), as a plain ``NAME=value`` does, leaving the other
    elements as stored; otherwise ``-A`` makes the map ``([0]=value)``
    and ``-a`` the one-element array, a held scalar converting to that
    element first, and with neither the value stays a scalar.
    ``NAME+=value`` appends to what that slot holds (``S=x; declare -a
    S+=y`` gives ``([0]="xy")``), and on an integer adds (``appended``).

    Args:
        held (ShellValue | None): the value the declaration lands on.
        value (str): the assigned text.
        kind (VarKind | None): the kind ``-a`` / ``-A`` asked for.
        append (bool): the operand was ``NAME+=value``.
        integer (bool): the variable carries ``-i``.
    """
    scalar = held if isinstance(held, str) else None
    if isinstance(held, dict) or kind is VarKind.ASSOC:
        amap = dict(held) if isinstance(held, dict) else {}
        if scalar is not None:
            amap["0"] = scalar
        amap["0"] = (
            appended(amap.get("0", ""), value, integer) if append else value
        )
        return amap, frozenset({"0"})
    if isinstance(held, list) or kind is VarKind.INDEXED:
        arr = list(held) if isinstance(held, list) else []
        if scalar is not None:
            arr.append(scalar)
        array_set(
            arr,
            0,
            appended(array_get(arr, 0), value, integer) if append else value,
        )
        return arr, frozenset({0})
    return (appended(scalar or "", value, integer) if append else value), None


def kind_listed(session: SessionState, name: str, flags: set[str]) -> bool:
    """Whether a listing's ``-a`` / ``-A`` keep ``name``: ``-a`` lists
    only indexed arrays, ``-A`` only associative ones, both nothing.

    Args:
        session (SessionState): shell session state.
        name (str): the variable listed.
        flags (set[str]): the listing's option letters.
    """
    if "a" in flags and name not in session.arrays:
        return False
    return "A" not in flags or name in session.assocs


async def mark_written(
    session: SessionState,
    view: SessionView,
    name: str,
    checked: str,
    attr: VarAttr,
    on: bool = True,
    follow_ref: bool = True,
) -> None:
    """Put ``attr`` on the variable a write to ``name`` landed on.

    The write's gate covered ``checked``, the target before it, so the
    mark rides on that decision; a write that re-aimed an unset
    ``declare -n`` reference (``declare -n r; export r=X``) landed on a
    target no gate has seen, so that mark goes through the gated door,
    as does the reference mark itself (``+n``), which belongs to the
    reference's own record.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        name (str): the name written.
        checked (str): what ``name`` resolved to before the write.
        attr (VarAttr): the attribute to set or clear.
        on (bool): set rather than clear.
        follow_ref (bool): the write followed a reference (a
            ``declare -n`` declaration writes the reference itself).
    """
    follows = follow_ref and attr is not VarAttr.NAMEREF
    target = deref(session, name) if follows else name
    if target == checked:
        set_attr(session, target, attr, on)
    else:
        await view.mark(name, attr, on, follow_ref)


async def stamp_marks(
    session: SessionState,
    view: SessionView,
    name: str,
    checked: str | None,
    marks: AttrMarks,
    follow_ref: bool = True,
) -> None:
    """Put a declaration's attribute marks on what one operand landed
    on, as soon as it lands: ``declare -r R=1 R=2`` refuses the second
    write, and under ``-g`` the global record takes them.

    A written operand's marks ride on its write's gate
    (``mark_written``); a bare one wrote nothing, so each mark goes
    through the gated door.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        name (str): the operand's name.
        checked (str | None): what ``name`` resolved to before its
            write, None for a bare operand.
        marks (AttrMarks): each attribute and
            whether it goes on or off, in order.
        follow_ref (bool): mark a reference's target, not the reference.
    """
    for attr, on in marks:
        if checked is None:
            await view.mark(name, attr, on, follow_ref)
        else:
            await mark_written(
                session, view, name, checked, attr, on, follow_ref
            )


async def drop_reference(
    session: SessionState, view: SessionView, name: str
) -> None:
    """Take the mark off an unaimed ``declare -n`` reference a declared
    array kind is about to land on, silently, as bash's
    ``export -a ref=v`` does (an undeclared array warns at the door).

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        name (str): the declared name.
    """
    target = deref(session, name)
    var = session.vars.get(target)
    if var is not None and VarAttr.NAMEREF in var.attrs:
        await view.mark(target, VarAttr.NAMEREF, False)


def visible_record(session: SessionState, name: str) -> ShellVar | None:
    """A name's own record, None when unset or hidden: a hidden name
    reads as unset, so no refusal can quote or describe its value.

    Args:
        session (SessionState): shell session state.
        name (str): the variable name.
    """
    if var_hidden(session.visibility, name):
        return None
    return session.vars.get(name)


def plus_refusal(
    cmd: str, session: SessionState, view: SessionView, name: str, plus: str
) -> str | None:
    """The line a ``+letter`` earns on one operand, if any.

    Two letters cannot be taken off. ``+r`` on a readonly name is
    ``declare: R: readonly variable`` and the name stays frozen, as is
    ``+n`` on a frozen reference; ``+a``
    / ``+A`` on an array is ``cannot destroy array variables in this
    way``, since the kind is what the value is, not a mark. Either skips
    that operand's value and marks, and the others still declare
    (pinned on 5.2.37).

    Args:
        cmd (str): the builtin's spelling, for the diagnostic.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        name (str): the operand's name.
        plus (str): the declaration's ``+`` letters.
    """
    var = visible_record(session, name)
    value = None if var is None else var.value
    reference = var is not None and VarAttr.NAMEREF in var.attrs
    if ("r" in plus and view.is_readonly(name)) or (
        "n" in plus and reference and view.is_readonly(name, False)
    ):
        return readonly_line(cmd, name)
    if ("a" in plus and isinstance(value, list)) or (
        "A" in plus and isinstance(value, dict)
    ):
        return (
            f"bash: {cmd}: {name}: cannot destroy array variables in this way"
        )
    return None


async def store_staged_arrays(
    cmd: str,
    session: SessionState,
    view: SessionView,
    operands: list[DeclarationOperand],
    errors: list[str],
    warnings: list[str],
    fatal: bool = False,
    stored: dict[int, str] | None = None,
    kind: VarKind | None = None,
    shaping: AttrMarks = (),
    global_scope: bool = False,
    inherit: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """Store a declaration's array literals through the session door,
    the first of bash's two passes over a declaration.

    bash stores every literal before it runs any other operand, then
    goes through all of them in order, assigning the plain values and
    marking each name, a literal's included, at its own place: so
    ``declare -r R=1 R=(2)`` stores ``(2)``, writes 1 over element 0 and
    freezes ``R``, and a fatal literal leaves every other operand
    undone (pinned on 5.2.37). Only the value-shaping attributes go on
    before a literal stores (``shaping``); the caller's second pass puts
    the rest on the literals ``stored`` reports, against the target each
    write's gate cleared, so an operand that re-aims a reference in
    between cannot carry a mark past the gate.

    The builtin owns the store; readonly is the shell's rule, checked
    per name before the door, and the door's gate covers the policy
    half. Names are processed in order, so an earlier operand stays
    stored when a later one refuses, as bash does. A readonly refusal
    of an array literal is a variable-assignment error in GNU, not a
    builtin failure: for `export`/`readonly` (and `declare` at top
    level) the rest of the line is abandoned, while `local` and a
    function-scoped `declare` refuse in the builtin's voice and the
    body keeps running (pinned on bash 5.2, debian:stable-slim).

    Inside a function, ``declare`` and ``local`` make each name local,
    starting as ``start_local`` leaves it; ``export`` and ``readonly``
    (``VISIBLE_SCOPE_BUILTINS``) assign the variable already visible, so
    ``f() { export A=(1); }`` leaves ``A`` set after ``f`` returns.

    Args:
        cmd (str): builtin name for refusal rendering and scoping.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        operands (list[DeclarationOperand]): the declaration's operands
            in order; the staged literals among them store.
        errors (list[str]): filled with bash-voiced refusal lines for a
            readonly name or a kind conflict outside ``fatal``; the
            caller folds them into its exit status.
        warnings (list[str]): filled with ``must use subscript`` lines
            for the plain words a keyed associative literal cannot take;
            GNU stores the valid elements and the status stays 0.
        fatal (bool): render a readonly refusal or a kind conflict as
            the fatal assignment error instead of a builtin failure.
        stored (dict[int, str] | None): filled with the position of
            each literal that stored and the variable its write landed
            on. A declaration keeps its valid operands when a sibling
            refuses, so the caller cannot read "what was written" off the
            aggregate exit status.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared. ``-A``
            builds every literal as an associative map; without it a
            name that already holds one still builds a map, since a
            plain ``m+=([k]=v)`` keeps the variable's own kind. A kind
            that meets a variable of the other kind is bash's
            ``cannot convert`` assignment error.
        shaping (AttrMarks): the value-shaping marks to put on or take
            off each name before its literal stores.
        global_scope (bool): the declaration carried ``-g``, so no
            local is started for the names, and a readonly name refuses
            a literal fatally even inside a function (a kind conflict
            there does not).
        inherit (bool): the declaration carried ``-I``, so a new local
            starts from the value it shadows.

    Returns:
        The refusal result, or None when every literal stored.

    Raises:
        DiscardSignal: a readonly refusal or kind conflict under
            ``fatal``.
    """
    scoped = not global_scope and cmd not in VISIBLE_SCOPE_BUILTINS
    local_vars = session._local_vars if scoped else None
    for position, operand in enumerate(operands):
        if isinstance(operand, str):
            continue
        name, append, items = operand
        if view.is_readonly(name):
            if fatal or global_scope:
                raise DiscardSignal(
                    encode_text(f"bash: {name}: readonly variable\n")
                )
            errors.append(readonly_line(cmd, name))
            continue
        fresh = local_vars is not None and name not in local_vars
        if local_vars is not None:
            shadow_local(session, local_vars, name)
        if fresh and not in_call_env(session, name):
            start_local(session, name, inherit)
        held = None if fresh and not inherit else held_value(session, name)
        conflict = kind_conflict(held, kind)
        if conflict is not None:
            if fatal:
                raise DiscardSignal(encode_text(f"bash: {name}: {conflict}\n"))
            errors.append(f"bash: {cmd}: {name}: {conflict}")
            continue
        try:
            await premark(view, name, shaping)
            if kind is not None:
                await drop_reference(session, view, name)
        except PolicyDenied as exc:
            return refusal(cmd, exc)
        base: ShellValue
        checked = deref(session, name)
        # One try around the literal and the write: a subscript in the
        # literal may assign (`([x=2]=v)`), and that lands through the
        # same door.
        try:
            if kind is VarKind.ASSOC or name in session.assocs:
                built, bad_words = build_assoc_literal(
                    session.assocs.get(name), items, append
                )
                warnings.extend(
                    f"bash: {name}: '{word}': must use subscript "
                    "when assigning associative array"
                    for word in bad_words
                )
                base = built
            else:
                indexed = session.arrays.get(name)
                if append and indexed is None:
                    scalar = conversion_scalar(session, name)
                    indexed = None if scalar is None else [scalar]
                base = await build_indexed_literal(
                    indexed,
                    items,
                    append,
                    functools.partial(subscript_index, session, view=view),
                )
            await view.set(name, base)
        except PolicyDenied as exc:
            return refusal(cmd, exc)
        except ArithError as exc:
            return arith_refusal(cmd, exc)
        if stored is not None:
            stored[position] = checked
    return None


def is_control(ch: str) -> bool:
    return ord(ch) < 0x20 or ord(ch) == 0x7F


def bash_declare_quote(value: str) -> str:
    """Quote a value the way bash ``declare -p`` / ``export -p`` does.

    A value holding any control character takes the ``$'...'`` form, with
    the named escapes bash uses (``\\a \\b \\t \\n \\v \\f \\r``, and
    ``\\E`` for escape) and three-digit octal for the rest; ``"``, ``$``
    and backtick need no escaping there because ``$'...'`` does not
    expand. Everything else is double-quoted with escapes for ``\\``,
    ``"``, ``$`` and backtick. Non-ASCII printable text stays literal,
    which is what bash emits in a UTF-8 locale.

    Args:
        value (str): the variable value to serialize.

    Returns:
        str: the quoted value, ready to follow ``declare -x NAME=``.
    """
    parts: list[str] = []
    if any(is_control(ch) for ch in value):
        for ch in value:
            escape = ANSI_C_ESCAPES.get(ch)
            if escape is not None:
                parts.append(escape)
            elif is_control(ch):
                parts.append(f"\\{ord(ch):03o}")
            else:
                parts.append(ch)
        return "$'" + "".join(parts) + "'"
    for ch in value:
        if ch in '\\"$`':
            parts.append("\\" + ch)
        else:
            parts.append(ch)
    return '"' + "".join(parts) + '"'


def split_decl_flags(
    args: list[DeclarationOperand],
    allowed: frozenset[str],
) -> tuple[set[str], list[DeclarationOperand], str | None]:
    """Split leading ``-xyz`` flag clusters from declaration operands.

    Returns:
        ``(flags, operands, bad)`` where ``bad`` is the first illegal
        option character, or ``None`` when every flag is allowed.
    """
    flags: set[str] = set()
    i = 0
    while i < len(args):
        tok = args[i]
        if not isinstance(tok, str):
            break
        if tok == "--":
            i += 1
            break
        if tok.startswith("-") and len(tok) > 1 and tok != "-":
            body = tok[1:]
            illegal = next((c for c in body if c not in allowed), None)
            if illegal is not None:
                return flags, args[i:], illegal
            flags.update(body)
            i += 1
            continue
        break
    return flags, args[i:], None


def operand_parts(word: str) -> tuple[str, bool, str | None]:
    """A declaration operand as its name, whether it appends, and its
    value, None for a bare name: ``X+=y`` appends ``y`` to ``X``.

    Args:
        word (str): the operand as typed.
    """
    name, eq, value = word.partition("=")
    if not eq:
        return word, False, None
    return name.removesuffix("+"), name.endswith("+"), value


def identifier_refusal(cmd: str, word: str) -> str | None:
    """GNU's ``not a valid identifier`` line for one declaration operand.

    A declaration builtin refuses a name it cannot declare rather than
    storing it: ``export 1BAD=x`` used to land a variable that ``$1BAD``
    can never name back (bash reads that as ``$1`` then ``BAD``) and
    then shipped it to every child environment.

    Which text GNU quotes depends on why the word failed, and both
    spellings are pinned. A word that is not a valid assignment at all
    is echoed whole (``export: `1BAD=x'``); a word whose target parses
    but is not a plain name -- an array element -- is echoed as just
    that target (``export: `arr[0]'``), since the value it would have
    taken is not what is wrong with it.

    Args:
        cmd (str): the builtin's name, for the diagnostic.
        word (str): the operand as typed, ``NAME`` or ``NAME=value``.

    Returns:
        str | None: the refusal line, or None when the name is legal.
    """
    name = operand_parts(word)[0]
    if is_valid_name(name):
        return None
    subscript = SUBSCRIPT_RE.fullmatch(name)
    quoted = name if subscript else word
    return f"bash: {cmd}: `{quoted}': not a valid identifier"


def declaration_result(
    cmd: str, errors: list[str], warnings: list[str] | None = None
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """A declaration's answer once every operand ran.

    Each warning, then each refusal, one line apiece, and exit 1 when an
    operand refused; an empty refusal fails without a word, as bash's
    do for a reference given ``-i``. The good operands on the same line
    are already stored: GNU reports each and keeps going, so ``export
    GOOD=1 1BAD=x GOOD2=2`` exports both good names. A warning alone
    (``must use subscript``) leaves the status 0.

    Args:
        cmd (str): builtin name for the node.
        errors (list[str]): the refusal lines, in operand order.
        warnings (list[str] | None): lines that print without failing.
    """
    lines = [*(warnings or []), *(line for line in errors if line)]
    code = 1 if errors else 0
    if not lines:
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command=cmd, exit_code=code),
        )
    err = encode_text("\n".join(lines) + "\n")
    return (
        None,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd, exit_code=code, stderr=err),
    )


def assoc_key_text(key: str) -> str:
    """One associative key as ``declare -p`` spells it.

    Bare when every character is one GNU leaves unquoted (pinned by a
    character sweep on 5.2.37: alphanumerics and the punctuation
    ``_ % + , - . / : = @ ~``), quoted like a value otherwise. A key
    that *is* ``@`` or ``*`` quotes even though the character is bare
    mid-key, since the bare spelling would read back as a splat.

    Args:
        key (str): the key to render.
    """
    if key not in ("@", "*") and BARE_KEY_RE.fullmatch(key):
        return key
    return bash_declare_quote(key)


def assoc_body(amap: dict[str, str]) -> str:
    """The ``=(...)`` tail of an associative ``declare`` line.

    Sorted keys (mirage's pinned order, where GNU prints hash order)
    and GNU's trailing space before the closing paren, which an empty
    map does not carry: ``m=([a]="1" )`` but ``m=()``.

    Args:
        amap (dict[str, str]): the associative array.
    """
    if not amap:
        return "=()"
    parts = " ".join(
        f"[{assoc_key_text(k)}]={bash_declare_quote(amap[k])}"
        for k in sorted(amap)
    )
    return f"=({parts} )"


def declare_line(session: SessionState, name: str) -> str | None:
    """The ``declare -p`` line for one name, or None when it has none.

    The attribute cluster is `attr_letters`, which is why this renders
    `declare -rx` and `declare -ar` without a table of its own: the
    record already knows its own letters and their print order. bash
    spells an empty cluster ``--``, and that spelling is the caller's
    because only a `declare` line needs it.

    A hidden name answers None, the same way `env_is_readonly` answers
    False for one: reporting it as declared would leak it.

    Args:
        session (SessionState): shell session state.
        name (str): the variable to render.

    Returns:
        str | None: the rendered line, or None when unset and
        unattributed, hidden, or absent.
    """
    if var_hidden(session.visibility, name):
        return None
    var = session.vars.get(name)
    if var is None:
        return None
    letters = attr_letters(var)
    head = f"declare -{letters}" if letters else "declare --"
    if var.value is None:
        return f"{head} {name}"
    if isinstance(var.value, list):
        parts = [
            f"[{i}]={bash_declare_quote(v)}"
            for i, v in enumerate(var.value)
            if v is not None
        ]
        return f"{head} {name}=({' '.join(parts)})"
    if isinstance(var.value, dict):
        return f"{head} {name}{assoc_body(var.value)}"
    return f"{head} {name}={bash_declare_quote(var.value)}"


def declaration_listed(
    session: SessionState, name: str, flags: set[str]
) -> bool:
    """Whether a no-name ``declare`` listing's letters keep ``name``:
    ``-a`` / ``-A`` narrow it to that array kind (``kind_listed``), and
    any of ``-i -l -n -r -t -u -x`` keeps a name carrying one of them.

    Args:
        session (SessionState): shell session state.
        name (str): the variable listed.
        flags (set[str]): the listing's option letters.
    """
    var = session.vars.get(name)
    if var is None or not kind_listed(session, name, flags):
        return False
    wanted = flags & LISTED_ATTRIBUTES
    return not wanted or bool(wanted & set(attr_letters(var)))


async def handle_declare_print(
    names: list[str],
    session: SessionState,
    flags: set[str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``declare -p``: render declarations for names, or for all.

    With names, they print in the order given and a name that does not
    exist is reported on stderr without stopping the rest, exiting 1 at
    the end -- GNU prints the names it knows and refuses only the ones
    it does not. Bare ``declare -p`` lists every visible name sorted,
    narrowed by the declaration's letters (``declaration_listed``).

    Args:
        names (list[str]): the names to render, empty for all.
        session (SessionState): shell session state.
        flags (set[str] | None): the declaration's option letters.
    """
    targets = names or sorted(
        name
        for name in session.vars
        if declaration_listed(session, name, flags or set())
    )
    lines: list[str] = []
    errors: list[str] = []
    for name in targets:
        line = declare_line(session, name)
        if line is None:
            errors.append(f"bash: declare: {name}: not found")
        else:
            lines.append(line)
    out = encode_text(("\n".join(lines) + "\n") if lines else "")
    code = 1 if errors else 0
    if not errors:
        return out, IOResult(), ExecutionNode(command="declare", exit_code=0)
    err = encode_text("\n".join(errors) + "\n")
    return (
        out,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command="declare", exit_code=code, stderr=err),
    )


def function_flags(session: SessionState, name: str) -> str:
    """The letters ``declare`` prints a function with: ``f``, then ``r``
    when ``readonly -f`` froze it and ``x`` when ``export -f`` marked it.

    Args:
        session (SessionState): shell session state.
        name (str): the function's name.
    """
    readonly = "r" if name in session.readonly_functions else ""
    exported = "x" if name in session.exported_functions else ""
    return f"f{readonly}{exported}"


def function_lines(
    session: SessionState, names: list[str], bodies: bool, marks: bool
) -> list[str]:
    """Print functions as ``declare`` lists them.

    A body prints as bash renders it (``stored_function_text``), followed
    with ``marks`` by a ``declare -fx NAME`` line when the function has
    an attribute; without bodies each function is its ``declare`` line,
    or its bare name.

    Args:
        session (SessionState): shell session state.
        names (list[str]): defined function names, in order.
        bodies (bool): print each body (``-f``) rather than a line.
        marks (bool): print the attribute line (``-p``, a listing).
    """
    lines: list[str] = []
    for name in names:
        flags = function_flags(session, name)
        if bodies:
            lines.append(stored_function_text(name, session.functions[name]))
            if marks and flags != "f":
                lines.append(f"declare -{flags} {name}")
        else:
            lines.append(f"declare -{flags} {name}" if marks else name)
    return lines


def handle_declare_functions(
    cmd: str,
    session: SessionState,
    flags: set[str],
    names: list[str],
    plus: frozenset[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the function half of ``declare``: ``-f`` / ``-F``.

    ``-p`` only prints, whatever attributes come with it: ``-F NAME``
    the attribute line, ``-f NAME`` the body and, for a function with an
    attribute, that line (``function_lines``); a missing name is
    ``not found``, exit 1. Without ``-p``, ``-r`` freezes the named
    functions as ``readonly -f`` does, ``-x`` marks them for export and
    ``+x`` takes the mark off, printing nothing; a ``+`` letter wins over
    its ``-`` twin, and ``+r`` refuses a frozen function, which then
    keeps every attribute (``readonly function``, exit 1); with no attribute
    ``-F NAME`` prints the name and ``-f NAME`` the body, and a missing
    name is exit 1 with no message. With no names every function lists
    as ``-p`` prints it; ``-r`` or ``-x`` narrows the list to the
    functions holding either attribute, and a ``+`` attribute does not.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        flags (set[str]): the declaration's collected flag letters.
        names (list[str]): the function names, empty to list all.
        plus (frozenset[str]): the attribute letters given with ``+``.
    """
    printing = "p" in flags
    wanted = flags & {"r", "x"}
    present = [name for name in names if name in session.functions]
    missing = [name for name in names if name not in session.functions]
    code = 1 if missing else 0
    if names and not printing and (wanted or plus & {"r", "x"}):
        frozen = [
            name
            for name in present
            if "r" in plus and name in session.readonly_functions
        ]
        for name in present:
            if name in frozen:
                continue
            if "r" in flags - plus:
                session.readonly_functions.add(name)
            if "x" in plus:
                session.exported_functions.discard(name)
            elif "x" in flags:
                session.exported_functions.add(name)
        code = 1 if missing or frozen else 0
        err = encode_text(
            "".join(
                f"bash: {cmd}: {name}: readonly function\n" for name in frozen
            )
        )
        return (
            None,
            IOResult(exit_code=code, stderr=err or None),
            ExecutionNode(command=cmd, exit_code=code, stderr=err),
        )
    if not names:
        present = [
            name
            for name in sorted(session.functions)
            if not wanted or wanted & set(function_flags(session, name))
        ]
    lines = function_lines(
        session, present, "F" not in flags, printing or not names
    )
    out = encode_text(("\n".join(lines) + "\n") if lines else "")
    err = (
        encode_text(
            "".join(f"bash: {cmd}: {name}: not found\n" for name in missing)
        )
        if printing
        else b""
    )
    return (
        out,
        IOResult(exit_code=code, stderr=err or None),
        ExecutionNode(command=cmd, exit_code=code, stderr=err),
    )


async def mark_functions(
    cmd: str,
    session: SessionState,
    marked: set[str],
    operands: list[DeclarationOperand],
    on: bool,
    state: SessionView | None = None,
    kind: VarKind | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``readonly -f`` or ``export -f``: mark functions, or list them.

    A name that is not a function is ``not a function``, exit 1, and the
    other operands are still marked (or, with ``on`` False, unmarked),
    in the order typed. An array literal (``export -f ARR=(a b)``)
    still stores first, with no attribute and its ``must use
    subscript`` warnings, and its name is then checked at its place, as
    bash assigns every literal before it looks for the functions. With
    no names the marked functions print as bodies, each followed by its
    ``declare`` line.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        marked (set[str]): the session's set of marked functions.
        operands (list[DeclarationOperand]): the function names and
            staged literals in order, empty to list.
        on (bool): set the mark rather than clear it.
        state (SessionView | None): the session plane's gated door, for
            the array literals.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if not all(isinstance(operand, str) for operand in operands):
        refused = await store_staged_arrays(
            cmd,
            session,
            require_view(state),
            operands,
            errors,
            warnings,
            fatal=True,
            kind=kind,
        )
        if refused is not None:
            return refused
    names = [o if isinstance(o, str) else o[0] for o in operands]
    if not names:
        listed = sorted(name for name in marked if name in session.functions)
        lines = function_lines(session, listed, True, True)
        out = encode_text(("\n".join(lines) + "\n") if lines else "")
        return out, IOResult(), ExecutionNode(command=cmd, exit_code=0)
    for name in names:
        if name not in session.functions:
            errors.append(f"bash: {cmd}: {name}: not a function")
        elif on:
            marked.add(name)
        else:
            marked.discard(name)
    return declaration_result(cmd, errors, warnings)


async def mark_variables(
    cmd: str,
    session: SessionState,
    view: SessionView,
    operands: list[DeclarationOperand],
    attr: VarAttr,
    on: bool,
    kind: VarKind | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``export`` or ``readonly`` over its operands: assign each
    value and put the keyword's mark on, or with ``on`` False take it
    off (``export -n``).

    bash's two passes (``store_staged_arrays``): every array literal
    stores first, then each operand in order is assigned and marked, a
    literal's name at its own place. So ``readonly R=1 R=2 X=3`` keeps
    1, refuses the second write and still sets ``X``, and ``readonly
    A=(1) A=(2)`` keeps ``(2)`` while a later ``A=3`` refuses.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        operands (list[DeclarationOperand]): the operands in order.
        attr (VarAttr): EXPORT or READONLY.
        on (bool): set the mark rather than clear it.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
    """
    errors: list[str] = []
    warnings: list[str] = []
    stored: dict[int, str] = {}
    refused = await store_staged_arrays(
        cmd,
        session,
        view,
        operands,
        errors,
        warnings,
        fatal=True,
        stored=stored,
        kind=kind,
    )
    try:
        for position, operand in enumerate(operands):
            if isinstance(operand, str):
                line = (
                    None
                    if refused is not None
                    else await _mark_operand(
                        cmd, session, view, operand, attr, on, kind
                    )
                )
                if line is not None:
                    errors.append(line)
            elif position in stored:
                # A literal is marked at its place, even when a policy
                # refused a later literal.
                await mark_written(
                    session, view, operand[0], stored[position], attr, on
                )
    except PolicyDenied as exc:
        return refusal(cmd, exc)
    except ArithError as exc:
        return arith_refusal(cmd, exc)
    if refused is not None:
        return refused
    return declaration_result(cmd, errors, warnings)


async def _mark_operand(
    cmd: str,
    session: SessionState,
    view: SessionView,
    word: str,
    attr: VarAttr,
    on: bool,
    kind: VarKind | None,
) -> str | None:
    """Assign and mark one ``export`` / ``readonly`` word.

    A value of the other array kind is refused and the name is still
    marked, as bash does. The bare form writes no value, so it marks
    through the plane's no-value door rather than inventing an empty
    string: on a new name that leaves it *unset* and marked, bash's own
    third state (``export Z`` prints ``declare -x Z`` and stays out of
    ``env``). Still gated, since marking is a session write: through
    ``set_attr`` a deployment refusing ``AWS_*`` saw ``readonly
    AWS_KEY`` exit 0 and freeze the name against every later write.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        word (str): the operand.
        attr (VarAttr): EXPORT or READONLY.
        on (bool): set the mark rather than clear it.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.

    Returns:
        The operand's refusal line, or None.

    Raises:
        PolicyDenied: the gate refused a write or a mark.
        ArithError: an ``-i`` value did not evaluate.
    """
    bad_name = identifier_refusal(cmd, word)
    if bad_name is not None:
        return bad_name
    key, append, val = operand_parts(word)
    if val is not None and view.is_readonly(key):
        return readonly_line(cmd, key)
    held = held_value(session, key) if val is not None else None
    conflict = kind_conflict(held, kind) if val is not None else None
    if val is not None and conflict is None:
        checked = deref(session, key)
        target = session.vars.get(checked)
        value, assigned = scalar_value(
            held,
            val,
            kind,
            append,
            target is not None and VarAttr.INTEGER in target.attrs,
        )
        if kind is not None:
            await drop_reference(session, view, key)
        await view.set(key, value, assigned=assigned)
        # Rides on the gate the `view.set` above passed, unless the
        # write re-aimed a reference (`mark_written`).
        await mark_written(session, view, key, checked, attr, on)
    else:
        await view.mark(key, attr, on)
    if on:
        outlive_call(session, key)
    return None if conflict is None else f"bash: {cmd}: {key}: {conflict}"


def note_local_array(session: SessionState, name: str) -> bool:
    """Record the caller's array before a function shadows ``name``.

    ``local -a`` / ``declare -a`` inside a function shadow the caller's
    array, so the old value (or its absence) has to be remembered for the
    teardown in ``execute_command``.

    Args:
        session (SessionState): shell session state.
        name (str): the array name being declared.

    Returns:
        bool: True when a function scope is active, so the caller should
            shadow rather than reuse whatever is already there.
    """
    local_vars = session._local_vars
    if local_vars is None:
        return False
    shadow_local(session, local_vars, name)
    return True


def nameref_refusal(cmd: str, name: str, target: str) -> str | None:
    """The line `declare -n NAME=TARGET` earns when TARGET is unusable.

    bash refuses a target that is not a variable name (`invalid variable
    name for name reference`) and a reference to itself (`nameref
    variable self references not allowed`). A target spelled as an
    array element (`a[1]`) is a name bash accepts and mirage does not:
    the reference resolver maps names to names, so it is refused in
    mirage's own voice rather than stored and half-honored.

    Args:
        cmd (str): the builtin's spelling, for the diagnostic.
        name (str): the reference being declared.
        target (str): the value it was given.
    """
    if SUBSCRIPT_RE.fullmatch(target) is not None:
        return (
            f"mirage: {cmd}: {target}: name reference to an array "
            "element is not supported"
        )
    if not is_valid_name(target):
        return (
            f"bash: {cmd}: `{target}': invalid variable name for name "
            "reference"
        )
    if target == name:
        return (
            f"bash: {cmd}: {name}: nameref variable self references "
            "not allowed"
        )
    return None


def reference_refusal(
    cmd: str, name: str, own: ShellVar | None, bare: bool
) -> str | None:
    """The line the name a ``declare -n`` operand lands on earns, ahead
    of its readonly mark (pinned on 5.2.37).

    An array cannot become a reference (``reference variable cannot be
    an array``). A given value was judged on its own
    (``nameref_refusal``); a bare ``declare -n NAME`` aims the name at
    the value it already holds, so that value has to name a variable,
    though here it may name NAME itself.

    Args:
        cmd (str): the builtin's spelling, for the diagnostic.
        name (str): the reference being declared.
        own (ShellVar | None): the record the operand lands on.
        bare (bool): the operand gave no value.
    """
    if own is not None and isinstance(own.value, (list, dict)):
        return f"bash: {cmd}: {name}: reference variable cannot be an array"
    if (
        not bare
        or own is None
        or not isinstance(own.value, str)
        or VarAttr.NAMEREF in own.attrs
        or own.value == name
    ):
        return None
    return nameref_refusal(cmd, name, own.value)
