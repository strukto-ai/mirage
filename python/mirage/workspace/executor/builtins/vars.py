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

import re
import shlex
from collections.abc import Callable
from typing import Any

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.array import (array_append, array_extent, array_unset,
                                make_array)
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.options import parse_option_word
from mirage.shell.types import SET_OPTION_NAMES
from mirage.utils.hidden import var_hidden
from mirage.workspace.executor.builtins.text import _PRINTF_TARGET_RE
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.expand.variable import _array_index
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import (env_get, env_is_readonly,
                                            env_snapshot, session_view,
                                            visible_arrays, visible_env)
from mirage.workspace.types import ExecutionNode


def _view(session: Session, state: SessionView | None) -> SessionView:
    """The session view to write through.

    Production callers thread the workspace's gated view; a direct
    invocation (a unit test) gets an ungated one over the same session.

    Args:
        session (Session): shell session state.
        state (SessionView | None): the caller's view, if threaded.
    """
    return state if state is not None else session_view(session)


def _refusal(
        cmd: str, exc: PolicyDenied
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render a policy denial in the builtin's own voice.

    Args:
        cmd (str): builtin name for the node.
        exc (PolicyDenied): the gate's refusal.
    """
    err = f"{exc.strerror}\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


def _readonly_refusal(
        cmd: str,
        name: str) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Render the shell's own readonly refusal, checked before the door.

    Args:
        cmd (str): builtin name for the node.
        name (str): the frozen variable.
    """
    err = f"bash: {name}: readonly variable\n".encode()
    return None, IOResult(exit_code=1, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=1,
                                                                  stderr=err)


async def _store_staged_arrays(
    cmd: str,
    session: Session,
    view: SessionView,
    arrays: list[tuple[str, bool, list[str]]],
    mark: bool = False,
    fatal: bool = False,
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
        mark (bool): also mark each stored name readonly (the
            ``readonly`` keyword's half).
        fatal (bool): render a readonly refusal as the fatal
            assignment error instead of a builtin failure.

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
            return _readonly_refusal(cmd, name)
        note_local_array(session, name)
        if append:
            base = session.arrays.get(name)
            if base is None:
                scalar = session.env.get(name)
                base = [] if scalar is None else [scalar]
            else:
                base = list(base)
            array_append(base, items)
        else:
            base = make_array(items)
        try:
            await view.set(name, base)
        except PolicyDenied as exc:
            return _refusal(cmd, exc)
        if mark:
            session.readonly_vars.add(name)
    return None


_ENV_HELP_HINT = "Try 'env --help' for more information.\n"
_EXPORT_USAGE = "export: usage: export [-fn] [name[=value] ...] or export -p\n"
_READONLY_USAGE = (
    "readonly: usage: readonly [-aAf] [name[=value] ...] or readonly -p\n")
_EXPORT_FLAGS = frozenset("fnp")
_READONLY_FLAGS = frozenset("aAfp")
_ANSI_C_ESCAPES = {
    "\\": "\\\\",
    "'": "\\'",
    "\a": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\x1b": "\\E",
}


def _env_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    err = (message + "\n" + _ENV_HELP_HINT).encode()
    return None, IOResult(exit_code=125,
                          stderr=err), ExecutionNode(command="env",
                                                     exit_code=125,
                                                     stderr=err)


def _is_control(ch: str) -> bool:
    return ord(ch) < 0x20 or ord(ch) == 0x7F


def _bash_declare_quote(value: str) -> str:
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
    if any(_is_control(ch) for ch in value):
        for ch in value:
            escape = _ANSI_C_ESCAPES.get(ch)
            if escape is not None:
                parts.append(escape)
            elif _is_control(ch):
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


def _split_decl_flags(
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


def _export_lines(session: Session, flags: set[str]) -> list[str]:
    """Build sorted ``declare -x`` lines for every variable in the env.

    Mirage keeps shell variables in ``session.env`` and treats that map
    as the exported environment (``printenv`` / ``env`` already do), so
    ``export -p`` lists the same set. ``-f`` selects shell functions
    instead of variables; mirage tracks no export attribute on functions,
    so that form lists nothing, as bash does with none exported.

    Args:
        session (Session): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one ``declare -x`` line per selected name.
    """
    if "f" in flags:
        return []
    env = visible_env(session)
    lines: list[str] = []
    for name in sorted(env):
        lines.append(f"declare -x {name}={_bash_declare_quote(env[name])}")
    return lines


def _readonly_lines(session: Session, flags: set[str]) -> list[str]:
    """Build sorted ``declare -r`` / ``declare -ar`` readonly lines.

    ``-a`` narrows the listing to indexed arrays, the way bash does.
    ``-f`` selects functions and ``-A`` associative arrays, neither of
    which mirage carries a readonly attribute for, so those forms list
    nothing. Bare and ``-p`` list every readonly name.

    Args:
        session (Session): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per selected name.
    """
    if "f" in flags or "A" in flags:
        return []
    arrays_only = "a" in flags
    env = visible_env(session)
    lines: list[str] = []
    # env_is_readonly answers False for a hidden name, so a hidden
    # readonly never prints even its bare `declare -r NAME` row.
    for name in sorted(n for n in session.readonly_vars
                       if env_is_readonly(session, n)):
        arr = session.arrays.get(name)
        if arr is not None:
            parts = [
                f"[{i}]={_bash_declare_quote(v)}" for i, v in enumerate(arr)
                if v is not None
            ]
            lines.append(f"declare -ar {name}=({' '.join(parts)})")
            continue
        if arrays_only:
            continue
        if name in env:
            lines.append(f"declare -r {name}={_bash_declare_quote(env[name])}")
        else:
            lines.append(f"declare -r {name}")
    return lines


async def handle_export(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Export names, or print them (``export -p`` / bare ``export``).

    With no name operands, prints every entry in ``session.env`` as
    ``declare -x NAME="value"`` (bash's ``-p`` form). Invalid option
    characters fail with status 2 and the GNU usage line. Writes go
    through the session view, so readonly refusal and the pre_session
    policy gate fire here exactly as for any other writer.
    """
    flags, names, bad = _split_decl_flags(assignments, _EXPORT_FLAGS)
    if bad is not None:
        err = (f"bash: export: -{bad}: invalid option\n"
               f"{_EXPORT_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="export",
                                                         exit_code=2,
                                                         stderr=err)
    # -p with names is ignored for display; bare / -p alone print.
    if not names and not arrays:
        lines = _export_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="export", exit_code=0)
    # -f/-n accepted; name path matches prior export semantics.
    view = _view(session, state)
    if arrays:
        refused = await _store_staged_arrays("export",
                                             session,
                                             view,
                                             arrays,
                                             fatal=True)
        if refused is not None:
            return refused
    for assign in names:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return _readonly_refusal("export", key)
            try:
                await view.set(key, val)
            except PolicyDenied as exc:
                return _refusal("export", exc)
        elif (env_get(session, assign) is None
              and assign not in visible_arrays(session)):
            # `export NAME` with no value writes an empty entry, which
            # is still a session write; an existing name (scalar or
            # array) is only re-marked for export, so nothing is
            # written — a scalar write here would erase an array. The
            # membership reads are visible ones: a hidden name counts
            # as unset, so the write is attempted and the door refuses
            # it like the valued form.
            if view.is_readonly(assign):
                return _readonly_refusal("export", assign)
            try:
                await view.set(assign, "")
            except PolicyDenied as exc:
                return _refusal("export", exc)
    return None, IOResult(), ExecutionNode(command="export", exit_code=0)


async def handle_readonly(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    With no name operands, prints every readonly name as ``declare -r``
    (or ``declare -ar`` for arrays). Invalid options fail with status 2.
    """
    flags, names, bad = _split_decl_flags(assignments, _READONLY_FLAGS)
    if bad is not None:
        err = (f"bash: readonly: -{bad}: invalid option\n"
               f"{_READONLY_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="readonly",
                                                         exit_code=2,
                                                         stderr=err)
    if not names and not arrays:
        lines = _readonly_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    # -a/-A/-f accepted; array shape is applied by the declaration path.
    view = _view(session, state)
    if arrays:
        refused = await _store_staged_arrays("readonly",
                                             session,
                                             view,
                                             arrays,
                                             mark=True,
                                             fatal=True)
        if refused is not None:
            return refused
    for assign in names:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return _readonly_refusal("readonly", key)
            try:
                await view.set(key, val)
            except PolicyDenied as exc:
                return _refusal("readonly", exc)
            session.readonly_vars.add(key)
        else:
            session.readonly_vars.add(assign)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)


def _unset_variable(session: Session, name: str) -> None:
    """Clear what the env door does not own after a whole-variable unset.

    The scalar half is the view's (``unset`` popped it, or quietly kept
    it for a hidden name — a direct pop here would undo that refusal);
    this clears the array storage and the getopts residue. The array
    pop keeps a hidden name too: the embedder can seed
    ``session.arrays`` before narrowing, so a hidden array exists and
    is as much the host's to keep as the scalar the view protected.

    Args:
        session (Session): shell session state.
        name (str): a bare variable name (no subscript).
    """
    if not var_hidden(session.hidden_vars, name):
        session.arrays.pop(name, None)
    if name == "OPTIND":
        session._getopts_optind = None


async def _unset_element(session: Session, view: SessionView, base: str,
                         subscript: str) -> str:
    """Clear one array element, or a scalar addressed as ``base[0]``.

    Clearing an element keeps the indices of the elements after it, as
    bash does: it leaves a hole, which neither expands in ``${arr[@]}``
    nor counts toward ``${#arr[@]}`` but keeps ``${arr[i]}`` addressing
    the same values. A subscript on a scalar names element 0 only:
    ``x[0]`` unsets the scalar and any other subscript is an error. A
    subscript on a name that holds nothing at all is a silent no-op,
    but on an existing array a negative subscript still below zero
    after the extent is added is a bad-subscript error.

    The element mechanics are the builtin's own, but the landing write
    goes through the door: a scalar's element 0 is the whole unset,
    and an array's hole punch is computed on a copy and stored with
    ``view.set``, so a denial leaves the array untouched. Validation
    errors write nothing and so never ask.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        base (str): the variable name without the subscript.
        subscript (str): the subscript text between the brackets.

    Returns:
        str: ``"ok"``, ``"notarray"`` when a non-zero subscript was
            applied to a scalar, or ``"subscript"`` for a negative
            subscript outside an existing array.

    Raises:
        PolicyDenied: a pre_session policy refused the write.
    """
    arr = visible_arrays(session).get(base)
    if arr is None:
        # Visible reads on purpose: a hidden base answers the unset
        # branch's silent no-op instead of a denial that would leak
        # the name's existence.
        if env_get(session, base) is None:
            return "ok"
        if _array_index(subscript, visible_env(session)) != 0:
            return "notarray"
        await view.unset(base)
        return "ok"
    idx = _array_index(subscript, visible_env(session))
    if idx < 0:
        idx += array_extent(arr)
        if idx < 0:
            return "subscript"
    new_arr = list(arr)
    array_unset(new_arr, idx)
    await view.set(base, new_arr)
    return "ok"


async def handle_unset(
    args: list[str],
    session: Session,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Unset shell variables, arrays, or functions, with bash's flags.

    ``-v`` targets a variable only, ``-f`` a function only, and a bare
    name a variable if one exists or else a function. A ``name[idx]``
    operand clears one element; the readonly guard resolves it to the
    base name first, since that is what ``readonly`` records. ``-n``
    (unset a nameref itself) has no referent here — mirage has no
    nameref attribute — so it matches bash on a non-nameref name and
    leaves it untouched.

    Args:
        args (list[str]): option words followed by names to unset.
        session (Session): shell session state.
    """
    mode = "auto"
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if all(ch in "vfn" for ch in tok[1:]):
            if "f" in tok[1:]:
                mode = "f"
            elif "n" in tok[1:]:
                mode = "n"
            else:
                mode = "v"
            i += 1
            continue
        err = f"bash: unset: {tok}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="unset",
                                                         exit_code=2,
                                                         stderr=err)
    for name in args[i:]:
        if mode == "n":
            # No nameref attribute exists, so as in bash on a plain
            # variable this leaves the name untouched.
            continue
        if mode == "f":
            session.functions.pop(name, None)
            continue
        target = _PRINTF_TARGET_RE.match(name)
        subscript = target.group(2) if target is not None else None
        is_element = subscript is not None
        # `readonly arr` records the base name, so an `arr[i]` operand has
        # to be resolved before the guard, as bash does (which also names
        # the base, not the element, in the error).
        base = target.group(1) if target is not None else name
        if base in session.readonly_vars:
            err = (f"bash: unset: {base}: cannot unset: "
                   f"readonly variable\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        existed = is_element or name in session.env or name in session.arrays
        # Both spellings clear the pre_session gate for the base name:
        # the whole-variable unset through the view's env half, an
        # element unset inside _unset_element, so `unset 'X[0]'` cannot
        # sidestep a policy that vetoes `unset X`.
        try:
            if subscript is not None:
                status = await _unset_element(session, _view(session, state),
                                              base, subscript)
            else:
                await _view(session, state).unset(name)
                _unset_variable(session, name)
                status = "ok"
        except PolicyDenied as exc:
            return _refusal("unset", exc)
        if status != "ok":
            # bash names the base for "not an array variable" but prints
            # only the bracketed part for a bad subscript.
            detail = (f"unset: {base}: not an array variable"
                      if status == "notarray" else
                      f"unset: {name[len(base):]}: bad array subscript")
            err = f"bash: {detail}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        if mode == "auto" and not existed and name in session.functions:
            session.functions.pop(name, None)
    return None, IOResult(), ExecutionNode(command="unset", exit_code=0)


async def handle_printenv(
    name: str | None,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if name:
        val = visible_env(session).get(name)
        if val is None:
            return None, IOResult(exit_code=1), ExecutionNode(
                command="printenv", exit_code=1)
        out = f"{val}\n".encode()
    else:
        lines = [f"{k}={v}" for k, v in visible_env(session).items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
    return out, IOResult(), ExecutionNode(command="printenv", exit_code=0)


async def handle_env(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``env`` builtin (print environment or run a command).

    Usage: ``env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]``.
    With no command it prints the (optionally modified) environment in
    ``environ`` order, unsorted, terminated per entry by newline or NUL
    (``-0``). With a command it runs it under the modified environment,
    forwarding stdin, then restores the session environment. Missing
    commands fail like GNU with the shell's own exit 127.

    Args:
        execute_fn (Callable): shell evaluator for the inner command.
        args (list[str]): words after the ``env`` name.
        session (Session): shell session state.
        stdin (ByteSource | None): piped input forwarded to the command.
    """
    ignore_env = False
    null = False
    unset: list[str] = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok in ("-i", "--ignore-environment"):
            ignore_env = True
            i += 1
            continue
        if tok in ("-0", "--null"):
            null = True
            i += 1
            continue
        if tok == "-":
            # GNU: "a mere - implies -i".
            ignore_env = True
            i += 1
            continue
        if tok == "--unset":
            if i + 1 >= len(args):
                return _env_error("env: option '--unset' requires an argument")
            unset.append(args[i + 1])
            i += 2
            continue
        if tok.startswith("--unset="):
            unset.append(tok[len("--unset="):])
            i += 1
            continue
        if tok.startswith("--"):
            return _env_error(f"env: unrecognized option '{tok}'")
        if tok.startswith("-") and len(tok) > 1:
            j = 1
            consumed_next = False
            while j < len(tok):
                ch = tok[j]
                if ch == "i":
                    ignore_env = True
                elif ch == "0":
                    null = True
                elif ch == "u":
                    rest = tok[j + 1:]
                    if rest:
                        unset.append(rest)
                    elif i + 1 < len(args):
                        unset.append(args[i + 1])
                        consumed_next = True
                    else:
                        return _env_error(
                            "env: option requires an argument -- 'u'")
                    break
                else:
                    return _env_error(f"env: invalid option -- '{ch}'")
                j += 1
            i += 2 if consumed_next else 1
            continue
        break

    base = {} if ignore_env else env_snapshot(session)
    for name in unset:
        base.pop(name, None)
    while i < len(args) and "=" in args[i] and not args[i].startswith("="):
        key, _, value = args[i].partition("=")
        base[key] = value
        i += 1

    command = args[i:]
    if command and null:
        return _env_error("env: cannot specify --null (-0) with command")
    if not command:
        sep = "\0" if null else "\n"
        out = "".join(f"{k}={v}{sep}" for k, v in base.items()).encode()
        return out, IOResult(), ExecutionNode(command="env", exit_code=0)

    saved = session.env
    session.env = base
    try:
        io = await execute_fn(shlex.join(command),
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        session.env = saved
    return io.stdout, io, ExecutionNode(command="env", exit_code=io.exit_code)


async def handle_whoami(
        namespace: Namespace,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # GNU whoami reports the effective user and never consults $USER;
    # the workspace user (launch agent_id, shared via the namespace
    # store) is the effective identity here. With no claimed identity
    # it fails like GNU does for a uid with no passwd entry.
    if namespace.user is None:
        err = b"whoami: cannot find name for user ID\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="whoami",
                                                         exit_code=1,
                                                         stderr=err)
    out = f"{namespace.user}\n".encode()
    return out, IOResult(), ExecutionNode(command="whoami", exit_code=0)


async def handle_read(
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read one line into variables, with bash's option handling.

    Only -r is accepted (our read is already raw, so it is consumed
    with no effect); anything else errors like bash instead of being
    treated as a variable name.

    Args:
        args (list[str]): words after the command name.
        session (Session): shell session state.
        stdin (ByteSource | None): line source.
    """
    parse = parse_shell_options(SHELL_SPECS["read"], args)
    if parse.invalid is not None:
        token = (parse.invalid
                 if parse.invalid.startswith("--") else f"-{parse.invalid}")
        err = f"read: {token}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="read",
                                                         exit_code=2)
    variables = parse.operands or ["REPLY"]
    # A NEW stdin source replaces any leftover buffer (a previous
    # command's exhausted herestring/pipe must not shadow this one);
    # the SAME source object reuses the buffer so sequential reads
    # advance through its lines.
    if stdin is not None and (session._stdin_buffer is None
                              or session._stdin_source is not stdin):
        if isinstance(stdin, bytes):
            session._stdin_buffer = AsyncLineIterator(async_chain(stdin))
            session._stdin_source = stdin
        elif hasattr(stdin, "__aiter__"):
            session._stdin_buffer = AsyncLineIterator(stdin)
            session._stdin_source = stdin

    line_bytes: bytes | None = None
    if session._stdin_buffer is not None:
        line_bytes = await session._stdin_buffer.readline()

    view = _view(session, state)
    if line_bytes is None:
        for var in variables:
            if view.is_readonly(var):
                return _readonly_refusal("read", var)
            try:
                await view.set(var, "")
            except PolicyDenied as exc:
                return _refusal("read", exc)
        return None, IOResult(exit_code=1), ExecutionNode(command="read",
                                                          exit_code=1)

    line = line_bytes.decode(errors="replace").rstrip("\n")
    ifs = visible_env(session).get("IFS", " \t\n")
    if ifs == " \t\n":
        # GNU trims IFS whitespace from both ends before splitting.
        line = line.strip(" \t\n")
        parts = line.split(None, len(variables) - 1) if variables else []
    elif not ifs:
        parts = [line]
    else:
        ifs_ws = "".join(ch for ch in ifs if ch in " \t\n")
        if ifs_ws:
            line = line.strip(ifs_ws)
        n_splits = max(0, len(variables) - 1)
        chars = set(ifs)
        out: list[str] = []
        cur: list[str] = []
        for ch in line:
            if ch in chars and len(out) < n_splits:
                out.append("".join(cur))
                cur = []
                continue
            cur.append(ch)
        out.append("".join(cur))
        parts = out
    for i, var in enumerate(variables):
        if view.is_readonly(var):
            return _readonly_refusal("read", var)
        try:
            await view.set(var, parts[i] if i < len(parts) else "")
        except PolicyDenied as exc:
            return _refusal("read", exc)
    return None, IOResult(), ExecutionNode(command="read", exit_code=0)


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
    local_arrays = session._local_arrays
    if local_arrays is None:
        return False
    if name not in local_arrays:
        existing = session.arrays.get(name)
        local_arrays[name] = None if existing is None else list(existing)
    return True


async def handle_local(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    local_vars = getattr(session, "_local_vars", None)
    view = _view(session, state)
    if arrays:
        refused = await _store_staged_arrays("local",
                                             session,
                                             view,
                                             arrays,
                                             fatal=session._local_arrays
                                             is None)
        if refused is not None:
            return refused
    for assign in assignments:
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return _readonly_refusal("local", key)
            if local_vars is not None and key not in local_vars:
                local_vars[key] = session.env.get(key)
            try:
                await view.set(key, val)
            except PolicyDenied as exc:
                return _refusal("local", exc)
        else:
            if local_vars is not None and assign not in local_vars:
                local_vars[assign] = session.env.get(assign)
            if (env_get(session, assign) is None
                    and assign not in visible_arrays(session)):
                # A bare declaration of an existing array re-scopes it;
                # a scalar write here would erase it. Visible reads: a
                # hidden name counts as unset, so the write is
                # attempted and the door refuses it.
                if view.is_readonly(assign):
                    return _readonly_refusal("local", assign)
                try:
                    await view.set(assign, "")
                except PolicyDenied as exc:
                    return _refusal("local", exc)
    return None, IOResult(), ExecutionNode(command="local", exit_code=0)


async def handle_shift(
    args: list[str],
    call_stack: CallStack | None,
    session: Session | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Shift positional parameters, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the shift count.
        call_stack (CallStack | None): function-call positional frames.
        session (Session | None): shell session state.
    """
    if len(args) > 1:
        err = b"shift: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    if args and not _is_shift_count(args[0]):
        err = f"shift: {args[0]}: numeric argument required\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    n = int(args[0]) if args else 1
    shifted = False
    if call_stack is not None and call_stack.get_all_positional():
        call_stack.shift(n)
        shifted = True
    if not shifted and session is not None:
        pos = getattr(session, "positional_args", None)
        if pos is not None:
            session.positional_args = pos[n:]
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


def _is_shift_count(word: str) -> bool:
    body = word[1:] if word[:1] in ("-", "+") else word
    return body.isdigit()


async def handle_set(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        lines = [f"{k}={v}" for k, v in visible_env(session).items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
        return out, IOResult(), ExecutionNode(command="set", exit_code=0)
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            session.positional_args = args[i + 1:]
            return None, IOResult(), ExecutionNode(command="set", exit_code=0)
        word = parse_option_word(tok,
                                 args[i + 1] if i + 1 < len(args) else None)
        if word is None:
            session.positional_args = args[i:]
            break
        for option, enable in word.settings:
            # `-o` takes a name rather than a letter, and a name bash does
            # not have is the one thing it refuses: exit 2, and the
            # settings already applied stay applied while the rest of the
            # line is dropped. Without this a typo -- or an option mirage
            # has yet to wire, as `physical` once was -- reads as success.
            if option not in SET_OPTION_NAMES:
                err = f"set: {option}: invalid option name\n".encode()
                return None, IOResult(exit_code=2,
                                      stderr=err), ExecutionNode(command="set",
                                                                 exit_code=2,
                                                                 stderr=err)
            session.shell_options[option] = enable
        # A letter naming no option is ignored rather than refused: bash
        # has options mirage does not implement (`-a`, `-B`, `-H`), and
        # `set` is where a script turns those on without wanting to fail.
        # A nested shell answers the same leftovers differently, which is
        # why the grammar hands them back instead of deciding here.
        i += word.consumed
    return None, IOResult(), ExecutionNode(command="set", exit_code=0)


_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _is_valid_name(name: str) -> bool:
    return _IDENTIFIER_RE.fullmatch(name) is not None


async def _getopts_finish(
    session: Session,
    view: SessionView,
    name: str,
    opt_value: str,
    optarg: str | None,
    new_optind: int,
    new_pos: int,
    exit_code: int,
    stderr: bytes = b"",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The name is assigned last, exactly as bash does: OPTIND/OPTARG and
    # the hidden cursor still advance, but a bad destination fails the
    # write and turns the call into a status-1 error. Writes go through
    # the session view, so a pre_session policy or a readonly OPTARG /
    # OPTIND refuses here too.
    try:
        if not _is_valid_name(name):
            stderr = (f"bash: getopts: `{name}': "
                      f"not a valid identifier\n").encode()
            exit_code = 1
        elif name in session.readonly_vars:
            stderr = f"bash: {name}: readonly variable\n".encode()
            exit_code = 1
        else:
            await view.set(name, opt_value)
        if optarg is None:
            await view.unset("OPTARG")
        else:
            await view.set("OPTARG", optarg)
        await view.set("OPTIND", str(new_optind))
    except ReadonlyVariableError as exc:
        stderr = f"bash: {exc.name}: readonly variable\n".encode()
        exit_code = 1
    except PolicyDenied as exc:
        stderr = f"{exc.strerror}\n".encode()
        exit_code = 1
    session._getopts_pos = new_pos
    session._getopts_optind = new_optind
    io = IOResult(exit_code=exit_code, stderr=stderr)
    return None, io, ExecutionNode(command="getopts",
                                   exit_code=exit_code,
                                   stderr=stderr)


async def handle_getopts(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Parse one option per call, with bash's getopts semantics.

    Args:
        args (list[str]): words after `getopts`: the optstring, the name
            variable, then optional explicit arguments (the positional
            parameters are scanned when no explicit ones are given).
        session (Session): shell session; OPTIND/OPTARG live in its env
            and the hidden per-word scan offset in its getopts state.
        call_stack (CallStack | None): function-call positional frames;
            inside a shell function getopts scans the function's own
            positional parameters, matching bash.
    """
    if len(args) < 2:
        err = b"getopts: usage: getopts optstring name [arg]\n"
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="getopts",
                                                         exit_code=2,
                                                         stderr=err)
    view = _view(session, state)
    optstring = args[0]
    name = args[1]
    if len(args) > 2:
        params = args[2:]
    elif call_stack is not None and call_stack.get_all_positional():
        params = call_stack.get_all_positional()
    else:
        params = session.positional_args
    silent = optstring.startswith(":")
    verbose = not silent and session.env.get("OPTERR", "1") != "0"
    try:
        optind = int(session.env.get("OPTIND", "1"))
    except ValueError:
        optind = 1
    # Bash treats a nonpositive OPTIND as a restart at argument 1.
    restart = optind < 1
    if restart:
        optind = 1
    if restart or session._getopts_optind != optind:
        session._getopts_pos = 0
    pos = session._getopts_pos

    if optind > len(params):
        return await _getopts_finish(session, view, name, "?", None, optind, 0,
                                     1)
    word = params[optind - 1]
    # A stale cursor left past the end of the current word (a shorter or
    # reused argument) restarts the scan rather than indexing out of range.
    if pos >= len(word):
        pos = 0
    if pos == 0:
        if not word.startswith("-") or word == "-":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind, 0, 1)
        if word == "--":
            return await _getopts_finish(session, view, name, "?", None,
                                         optind + 1, 0, 1)
        pos = 1

    letter = word[pos]
    rest = word[pos + 1:]
    idx = optstring.find(letter)
    is_valid = letter != ":" and idx != -1
    takes_arg = (is_valid and idx + 1 < len(optstring)
                 and optstring[idx + 1] == ":")

    if not is_valid:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        if silent:
            return await _getopts_finish(session, view, name, "?", letter,
                                         after_optind, after_pos, 0)
        err = (f"bash: illegal option -- {letter}\n".encode()
               if verbose else b"")
        return await _getopts_finish(session, view, name, "?", None,
                                     after_optind, after_pos, 0, err)

    if not takes_arg:
        if rest:
            after_optind, after_pos = optind, pos + 1
        else:
            after_optind, after_pos = optind + 1, 0
        return await _getopts_finish(session, view, name, letter, None,
                                     after_optind, after_pos, 0)

    if rest:
        return await _getopts_finish(session, view, name, letter, rest,
                                     optind + 1, 0, 0)
    if optind < len(params):
        return await _getopts_finish(session, view, name, letter,
                                     params[optind], optind + 2, 0, 0)
    if silent:
        return await _getopts_finish(session, view, name, ":", letter,
                                     optind + 1, 0, 0)
    err = (f"bash: option requires an argument -- {letter}\n".encode()
           if verbose else b"")
    return await _getopts_finish(session, view, name, "?", None, optind + 1, 0,
                                 0, err)


async def handle_trap(
        session: Session,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return None, IOResult(), ExecutionNode(command="trap", exit_code=0)


async def handle_return(
    args: list[str],
    session: Session,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Return from a function or sourced script, with bash's checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the return status.
        session (Session): session whose last exit code is the default
            status and whose source depth marks sourced execution.
        call_stack (CallStack | None): active call stack; a pushed
            frame marks function execution.
    """
    in_function = call_stack is not None and call_stack.depth > 1
    if not in_function and session.source_depth == 0:
        # bash prints the diagnostic, sets $? to 2, and carries on with
        # the rest of the line.
        err = (b"return: can only `return' from a function "
               b"or sourced script\n")
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=2,
                                                         stderr=err)
    if args and not _is_shift_count(args[0]):
        # bash prints the error and the function returns 2.
        raise ReturnSignal(
            2,
            stderr=f"return: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        err = b"return: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=1,
                                                         stderr=err)
    # A bare return propagates the status of the last command executed.
    raise ReturnSignal(int(args[0]) % 256 if args else session.last_exit_code)


async def handle_exit(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Exit the shell, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the exit status.
        session (Session): session whose last exit code is the default
            status.
    """
    if args and not _is_shift_count(args[0]):
        # bash exits with 2 after the diagnostic.
        raise ExitSignal(
            2, stderr=f"exit: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        # bash refuses to exit and the command fails with 1.
        err = b"exit: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="exit",
                                                         exit_code=1,
                                                         stderr=err)
    code = int(args[0]) if args else session.last_exit_code
    raise ExitSignal(code % 256)
