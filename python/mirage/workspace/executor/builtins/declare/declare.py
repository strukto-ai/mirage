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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.array import build_assoc_literal, build_indexed_literal
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.variable import ShellValue, VarAttr, attr_letters
from mirage.utils.hidden import var_hidden
from mirage.workspace.executor.builtins.declare.constants import (
    ANSI_C_ESCAPES, BARE_KEY_RE, SUBSCRIPT_RE)
from mirage.workspace.executor.builtins.shared import (arith_refusal,
                                                       is_valid_name,
                                                       readonly_refusal,
                                                       refusal)
from mirage.workspace.session import Session
from mirage.workspace.session.state import (conversion_scalar, set_attr,
                                            shadow_local, subscript_index)
from mirage.workspace.types import ExecutionNode


async def premark(view: SessionView, name: str,
                  shaping: frozenset[VarAttr]) -> None:
    """Put a declaration's value-shaping attributes on a name before its
    value stores.

    The door coerces on write by reading the record's attributes, so
    for the declaration's *own* value to coerce (``declare -i n=3+4``
    stores ``7``), the attribute has to be there first. Gated through
    ``view.mark`` like every other mark, and a no-op with nothing to
    shape, so a plain ``declare X=1`` costs no extra gate call.

    Args:
        view (SessionView): the session plane's gated door.
        name (str): the variable being declared.
        shaping (frozenset[VarAttr]): the ``-i -l -u`` attributes set.
    """
    for attr in shaping:
        await view.mark(name, attr, True)


async def store_staged_arrays(
    cmd: str,
    session: Session,
    view: SessionView,
    arrays: list[tuple[str, bool, list[str]]],
    mark: VarAttr | None = None,
    on: bool = True,
    fatal: bool = False,
    stored: list[str] | None = None,
    assoc: bool = False,
    errors: list[str] | None = None,
    shaping: frozenset[VarAttr] = frozenset(),
    global_scope: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """Store a declaration's array literals through the session door.

    The builtin owns the store; readonly is the shell's rule, checked
    per name before the door, and the door's gate covers the policy
    half. Names are processed in order, so an earlier operand stays
    stored when a later one refuses, as bash does. A readonly refusal
    of an array literal is a variable-assignment error in GNU, not a
    builtin failure: for `export`/`readonly` (and `declare` at top
    level) the rest of the line is abandoned, while `local` and a
    function-scoped `declare` refuse in the builtin's voice and the
    body keeps running (pinned on bash 5.2, debian:stable-slim).

    Args:
        cmd (str): builtin name for refusal rendering.
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]]): staged
            ``(name, append, items)`` literals from the declaration.
        mark (VarAttr | None): the attribute the declaring keyword puts
            on each stored name -- READONLY for ``readonly``, EXPORT for
            ``export``. An attribute rather than a bool because both
            keywords stage array literals through here and hardcoding
            one of them silently dropped the other: ``export ARR=(a b)``
            stored the array and never marked it, so GNU's
            ``declare -ax`` came out ``declare -a``.
        on (bool): the direction of that mark. ``export -n ARR=(b)``
            stores the array and takes the attribute *off*, and the
            store keeps whatever the name already carried, so leaving
            the mark unapplied left an exported array exported.
        fatal (bool): render a readonly refusal as the fatal
            assignment error instead of a builtin failure.
        stored (list[str] | None): filled with each name that actually
            stored, in order. A declaration keeps its valid operands
            when a sibling refuses, so the caller cannot read "what was
            written" off the aggregate exit status.
        assoc (bool): the declaration carried ``-A``, so every literal
            builds an associative map. Without it a name that already
            holds one still builds a map, since a plain
            ``m+=([k]=v)`` keeps the variable's own kind.
        errors (list[str] | None): filled with bash-voiced refusal
            lines for the plain words a keyed associative literal
            cannot take; the caller folds them into its exit status,
            because GNU stores the valid elements and still fails the
            builtin.
        shaping (frozenset[VarAttr]): the value-shaping attributes to
            put on each name before its literal stores.
        global_scope (bool): the declaration carried ``-g``, so no
            local snapshot is taken for the names.

    Returns:
        The refusal result, or None when every literal stored.

    Raises:
        ExitSignal: a readonly refusal under ``fatal``.
    """
    for name, append, items in arrays:
        if view.is_readonly(name):
            if fatal:
                err = f"bash: {name}: readonly variable\n".encode()
                raise ExitSignal(1, stderr=err, contained_code=1)
            return readonly_refusal(cmd, name)
        note_local_array(session, name)
        try:
            await premark(view, name, shaping)
        except PolicyDenied as exc:
            return refusal(cmd, exc)
        base: ShellValue
        # One try around the literal and the write: a subscript in the
        # literal may assign (`([x=2]=v)`), and that lands through the
        # same door.
        try:
            if assoc or name in session.assocs:
                built, bad_words = build_assoc_literal(
                    session.assocs.get(name), items, append)
                if errors is not None:
                    errors.extend(
                        f"bash: {name}: '{word}': must use subscript "
                        "when assigning associative array"
                        for word in bad_words)
                base = built
            else:
                held = session.arrays.get(name)
                if append and held is None:
                    scalar = conversion_scalar(session, name)
                    held = None if scalar is None else [scalar]
                base = await build_indexed_literal(
                    held, items, append,
                    functools.partial(subscript_index, session, view=view))
            if global_scope:
                await write_global(session, view, name, base)
            else:
                await view.set(name, base)
        except PolicyDenied as exc:
            return refusal(cmd, exc)
        except ArithError as exc:
            return arith_refusal(cmd, exc)
        if stored is not None:
            stored.append(name)
        if mark is not None:
            # Ungated on purpose: the `view.set` immediately above put
            # this same name through the gate, so re-asking would show a
            # policy two writes for one operand.
            set_attr(session, name, mark, on)
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
    args: list[str],
    allowed: frozenset[str],
) -> tuple[set[str], list[str], str | None]:
    """Split leading ``-xyz`` flag clusters from declaration operands.

    Returns:
        ``(flags, operands, bad)`` where ``bad`` is the first illegal
        option character, or ``None`` when every flag is allowed.
    """
    flags: set[str] = set()
    i = 0
    while i < len(args):
        tok = args[i]
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
    name = word.partition("=")[0]
    if is_valid_name(name):
        return None
    subscript = SUBSCRIPT_RE.fullmatch(name)
    quoted = name if subscript else word
    return f"bash: {cmd}: `{quoted}': not a valid identifier"


def identifier_failure(
        cmd: str, errors: list[str]
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render the refusals collected while declaring names.

    One line per bad operand, exit 1, and the good operands on the same
    line are already stored: GNU reports each and keeps going, so
    ``export GOOD=1 1BAD=x GOOD2=2`` exports both good names.

    Args:
        cmd (str): builtin name for the node.
        errors (list[str]): the refusal lines, in operand order.
    """
    err = ("\n".join(errors) + "\n").encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


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
    parts = " ".join(f"[{assoc_key_text(k)}]={bash_declare_quote(amap[k])}"
                     for k in sorted(amap))
    return f"=({parts} )"


def declare_line(session: Session, name: str) -> str | None:
    """The ``declare -p`` line for one name, or None when it has none.

    The attribute cluster is `attr_letters`, which is why this renders
    `declare -rx` and `declare -ar` without a table of its own: the
    record already knows its own letters and their print order. bash
    spells an empty cluster ``--``, and that spelling is the caller's
    because only a `declare` line needs it.

    A hidden name answers None, the same way `env_is_readonly` answers
    False for one: reporting it as declared would leak it.

    Args:
        session (Session): shell session state.
        name (str): the variable to render.

    Returns:
        str | None: the rendered line, or None when unset and
        unattributed, hidden, or absent.
    """
    if var_hidden(session.hidden_vars, name):
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
            f"[{i}]={bash_declare_quote(v)}" for i, v in enumerate(var.value)
            if v is not None
        ]
        return f"{head} {name}=({' '.join(parts)})"
    if isinstance(var.value, dict):
        return f"{head} {name}{assoc_body(var.value)}"
    return f"{head} {name}={bash_declare_quote(var.value)}"


async def handle_declare_print(
    names: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``declare -p``: render declarations for names, or for all.

    With names, they print in the order given and a name that does not
    exist is reported on stderr without stopping the rest, exiting 1 at
    the end -- GNU prints the names it knows and refuses only the ones
    it does not. Bare ``declare -p`` lists every visible name sorted.

    Args:
        names (list[str]): the names to render, empty for all.
        session (Session): shell session state.
    """
    targets = names or sorted(session.vars)
    lines: list[str] = []
    errors: list[str] = []
    for name in targets:
        line = declare_line(session, name)
        if line is None:
            errors.append(f"bash: declare: {name}: not found")
        else:
            lines.append(line)
    out = (("\n".join(lines) + "\n") if lines else "").encode()
    code = 1 if errors else 0
    if not errors:
        return out, IOResult(), ExecutionNode(command="declare", exit_code=0)
    err = ("\n".join(errors) + "\n").encode()
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="declare",
                                                    exit_code=code,
                                                    stderr=err)


def handle_declare_functions(
    cmd: str,
    session: Session,
    flags: set[str],
    names: list[str],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the function half of ``declare``: ``-f`` / ``-F`` / ``-rf``.

    ``-F NAME`` prints the name; ``-f NAME`` prints ``declare -f NAME``
    where GNU prints the reformatted body (mirage carries no
    pretty-printer, so the name row is the deliberate stand-in, the
    same shape ``-F`` and ``readonly -f`` list in). A missing name is
    exit 1 with no message. With ``-r`` the named functions freeze, as
    ``readonly -f`` does. With no names, ``-F`` lists every function
    and ``-f`` lists them the same way.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (Session): shell session state.
        flags (set[str]): the declaration's collected flag letters.
        names (list[str]): the function names, empty to list all.
    """
    if "r" in flags:
        return readonly_functions(session, names)
    targets = names or sorted(session.functions)
    lines: list[str] = []
    missing = False
    for name in targets:
        if name not in session.functions:
            missing = True
            continue
        if "F" in flags:
            lines.append(name if names else f"declare -f {name}")
        else:
            lines.append(f"declare -f {name}")
    out = (("\n".join(lines) + "\n") if lines else "").encode()
    code = 1 if missing else 0
    return out, IOResult(exit_code=code), ExecutionNode(command=cmd,
                                                        exit_code=code)


def readonly_functions(
        session: Session,
        names: list[str]) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``readonly -f``: freeze the named functions, or list the frozen.

    Args:
        session (Session): shell session state.
        names (list[str]): the function names, empty to list.
    """
    if not names:
        lines = [
            f"declare -fr {name}"
            for name in sorted(session.readonly_functions)
            if name in session.functions
        ]
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    errors: list[str] = []
    for name in names:
        if name not in session.functions:
            errors.append(f"bash: readonly: {name}: not a function")
            continue
        session.readonly_functions.add(name)
    if errors:
        err = ("\n".join(errors) + "\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="readonly",
                                                         exit_code=1,
                                                         stderr=err)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)


def note_local_array(session: Session, name: str) -> bool:
    """Record the caller's array before a function shadows ``name``.

    ``local -a`` / ``declare -a`` inside a function shadow the caller's
    array, so the old value (or its absence) has to be remembered for the
    teardown in ``execute_command``.

    Args:
        session (Session): shell session state.
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
        return (f"mirage: {cmd}: {target}: name reference to an array "
                "element is not supported")
    if not is_valid_name(target):
        return (f"bash: {cmd}: `{target}': invalid variable name for name "
                "reference")
    if target == name:
        return (f"bash: {cmd}: {name}: nameref variable self references "
                "not allowed")
    return None


async def write_global(
    session: Session,
    view: SessionView,
    key: str,
    value: ShellValue,
) -> None:
    """Store a `declare -g` value on the global record.

    Outside a function, or for a name no function on the call path has
    shadowed, that is an ordinary write. Otherwise the running locals
    live in `session.vars` and the global record is what the
    *outermost* shadowing frame saved, so the write goes through the
    door with the two swapped for its duration: the gate sees an
    ordinary write, and the local comes back untouched, which is what
    GNU shows (`local G=5; declare -g G=1` leaves `$G` at 5 in the
    function and 1 outside, and a nested `declare -g` reaches past the
    caller's local too).

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        key (str): the variable.
        value (ShellValue): the value.
    """
    outer = next((frame for frame in session._local_frames if key in frame),
                 None)
    if outer is None:
        await view.set(key, value)
        return
    shadowing = session.vars.get(key)
    saved = outer[key]
    if saved is None:
        session.vars.pop(key, None)
    else:
        session.vars[key] = saved
    try:
        await view.set(key, value)
        outer[key] = session.vars.get(key)
    finally:
        if shadowing is None:
            session.vars.pop(key, None)
        else:
            session.vars[key] = shadowing
