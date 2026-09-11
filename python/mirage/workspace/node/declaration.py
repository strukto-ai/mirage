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

from typing import Any, Callable

from mirage.io import IOResult
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_declaration_keyword, get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import VarAttr
from mirage.workspace.expand import expand_node
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import expand_array_items
from mirage.workspace.session import Session
from mirage.workspace.session.state import (conversion_scalar,
                                            ensure_var_visible, seed_var,
                                            session_view, set_attr)
from mirage.workspace.types import ExecutionNode

from mirage.workspace.executor.builtins import (  # isort: skip
    handle_declare_functions, handle_declare_print, handle_export,
    handle_local, handle_readonly, note_local_array)


def _merge_conversion_errors(
    result: tuple[Any, IOResult, ExecutionNode],
    errors: list[str],
) -> tuple[Any, IOResult, ExecutionNode]:
    """Fold kind-conversion refusals into a declaration's result.

    GNU reports `cannot convert indexed to associative array` per
    refused name on stderr and fails the builtin with 1 while the other
    operands still declare, so the refusals ride the handler's own
    result rather than replacing it.

    Args:
        result (tuple): the handler's (stream, io, node) answer.
        errors (list[str]): the refusal lines, in operand order.
    """
    if not errors:
        return result
    stream, io, node = result
    extra = ("\n".join(errors) + "\n").encode()
    prior = io.stderr if isinstance(io.stderr, bytes) else b""
    merged = prior + extra
    new_io = IOResult(exit_code=1,
                      stderr=merged,
                      reads=io.reads,
                      writes=io.writes,
                      cache=io.cache)
    new_node = ExecutionNode(command=node.command, exit_code=1, stderr=merged)
    return stream, new_io, new_node


# Every letter GNU's `declare` accepts, so a typo refuses with the usage
# line instead of being silently dropped. `-a`/`-A` are kinds, not
# attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
# /`-I` are modes the handlers read. `-n` stores the reference and every
# reader and writer resolves through it (`deref` in `session/state`).
_DECLARE_LETTERS = frozenset("aAfFgiIlnprtux")
_DECLARE_USAGE = (
    "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] "
    "or declare -p [-aAfFilnrtux] [name ...]")
# The stored attributes a `-letter` / `+letter` toggles.
_ATTR_LETTERS = {
    "i": VarAttr.INTEGER,
    "l": VarAttr.LOWER,
    "u": VarAttr.UPPER,
    "n": VarAttr.NAMEREF,
    "t": VarAttr.TRACE,
    "x": VarAttr.EXPORT,
    "r": VarAttr.READONLY,
}


def _declare_option_refusal(
    cmd: str,
    flag_chars: set[str],
    plus_chars: set[str],
    session: Session,
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """The refusal a `declare` family option cluster earns, if any.

    An unknown letter is GNU's `invalid option` plus the usage line,
    exit 2, and it wins over every other check because bash refuses
    the cluster before it looks at a single operand.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        flag_chars (set[str]): the `-` letters, `--` excluded.
        plus_chars (set[str]): the `+` letters.
        session (Session): shell session state (unused today, kept so
            a later check that reads it does not change the signature).
    """
    bad = next((c for c in sorted(flag_chars | plus_chars)
                if c not in _DECLARE_LETTERS), None)
    if bad is None:
        return None
    sign = "-" if bad in flag_chars else "+"
    err = (f"bash: {cmd}: {sign}{bad}: invalid option\n"
           f"{_DECLARE_USAGE}\n").encode()
    return None, IOResult(exit_code=2, stderr=err), ExecutionNode(command=cmd,
                                                                  exit_code=2,
                                                                  stderr=err)


async def _plus_refusals(
    cmd: str,
    session: Session,
    view: SessionView,
    plus_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """The per-name refusals a `+letter` earns after the operands are
    known.

    Two letters cannot be taken off. `+r` on a readonly name is
    `declare: R: readonly variable`, exit 1, and the name stays frozen.
    `+a` / `+A` on an array is `cannot destroy array variables in this
    way`, exit 1, since the kind is what the value is, not a mark. Both
    are pinned on 5.2.37 and neither stops the other operands from
    declaring; the first refusal is what the builtin reports.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        plus_chars (set[str]): the `+` letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
    """
    if not (plus_chars & {"r", "a", "A"}):
        return None
    names = [a.partition("=")[0] for a in assignments]
    names += [name for name, _, _ in staged or []]
    for name in names:
        if "r" in plus_chars and view.is_readonly(name):
            err = f"bash: {cmd}: {name}: readonly variable\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd,
                                                             exit_code=1,
                                                             stderr=err)
        if (("a" in plus_chars and name in session.arrays)
                or ("A" in plus_chars and name in session.assocs)):
            err = (f"bash: {cmd}: {name}: cannot destroy array variables "
                   "in this way\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=cmd,
                                                             exit_code=1,
                                                             stderr=err)
    return None


async def _stamp_attrs(
    session: Session,
    view: SessionView,
    flag_chars: set[str],
    plus_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
    stored: list[str],
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """Apply every `-attr` / `+attr` letter to the names a declaration
    stored, on top of the export stamp.

    The letters that shape a value (`-i -l -u`) are stored as
    attributes and applied by the door on every *later* write, which is
    GNU's rule: `v=MiXeD; declare -l v` keeps `MiXeD`, and the next
    `v=ABC` stores `abc`. So this stamps and never rewrites. `-l` and
    `-u` are exclusive: setting one clears the other, and a cluster
    naming both (`-lu`, `-ul`) sets neither, both pinned on 5.2.37.
    A `+` letter clears; `+r` is refused by the door as a readonly write
    would be, in the builtin's voice.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        flag_chars (set[str]): the `-` letters.
        plus_chars (set[str]): the `+` letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
        stored (list[str]): the names the handler actually stored.
    """
    refused = await _stamp_export(session, view, flag_chars, assignments,
                                  staged, stored)
    if refused is not None:
        return refused
    on_attrs = [
        _ATTR_LETTERS[c] for c in "ilunt"
        if c in flag_chars and c not in plus_chars
    ]
    if "l" in flag_chars and "u" in flag_chars:
        on_attrs = [
            a for a in on_attrs if a not in (VarAttr.LOWER, VarAttr.UPPER)
        ]
    # `+r` is refused earlier on a readonly name and a no-op otherwise,
    # so it is not an off toggle; every other stored letter clears.
    off_attrs = [_ATTR_LETTERS[c] for c in "iluntx" if c in plus_chars]
    if not on_attrs and not off_attrs:
        return None
    # Through the gated mark door for every name, covered or not: the
    # handler already cleared the gate for these names, so this is one
    # redundant policy call per attribute, and it keeps this stamp out
    # of the ungated-write allowlist that `set_attr` sites must justify.
    try:
        for name in stored:
            for attr in on_attrs:
                await view.mark(name, attr, True)
                # `-l` displaces `-u` and vice versa; the record keeps one.
                if attr == VarAttr.LOWER:
                    await view.mark(name, VarAttr.UPPER, False)
                elif attr == VarAttr.UPPER:
                    await view.mark(name, VarAttr.LOWER, False)
            for attr in off_attrs:
                await view.mark(name, attr, False)
    except PolicyDenied as exc:
        err = f"{exc.strerror}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="declare",
                                                         exit_code=1,
                                                         stderr=err)
    return None


async def _stamp_export(
    session: Session,
    view: SessionView,
    flag_chars: set[str],
    assignments: list[str],
    staged: list[tuple[str, bool, list[str]]] | None,
    stored: list[str],
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """Mark every name a `-x` declaration stored as exported.

    `declare -x NAME` marks an existing name without touching its value
    and `declare -x NAME=v` assigns then marks, so the stamp lands after
    the assignment either way. Staged array literals are stamped too,
    since an array is as exportable as a scalar: GNU answers
    `declare -x A=(a b)` with `declare -ax A=([0]="a" [1]="b")`, and
    reading only `assignments` left every `declare -x NAME=(...)`
    unmarked.

    Shared by the readonly and the plain declaration branch because
    `declare -rx X=1` goes down the readonly one and still owes the
    export attribute.

    Only the names the handler reports storing are marked, and marking
    is not gated on the aggregate status: a declaration keeps its valid
    operands when a sibling refuses, so `declare -x GOOD=1 1BAD=x` exits
    1 and still answers `declare -x GOOD="1"`. Reading the exit code
    instead left `GOOD` unexported.

    A name that carried a value went through `view.set`, so its mark
    rides on that decision; a bare name did not, and on an *existing*
    name the handler writes nothing at all, so the mark is the only
    session write there is and has to clear `pre_session` itself.
    Stamping it through `set_attr` let `declare -x AWS_TOKEN` export a
    host-seeded credential the deployment had refused.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        flag_chars (set[str]): the declaration's collected flag letters.
        assignments (list[str]): `NAME` / `NAME=value` operands.
        staged (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the same declaration.
        stored (list[str]): the names the handler actually stored.

    Returns:
        A refusal result when the gate denied a mark, else None.
    """
    if "x" not in flag_chars:
        return None
    covered = {a.partition("=")[0] for a in assignments if "=" in a}
    covered |= {name for name, _, _ in staged or []}
    for name in stored:
        if name in covered:
            set_attr(session, name, VarAttr.EXPORT)
            continue
        try:
            await view.mark(name, VarAttr.EXPORT, True)
        except PolicyDenied as exc:
            err = f"{exc.strerror}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="declare",
                                                             exit_code=1,
                                                             stderr=err)
    return None


async def execute_declaration(
    node: Any,
    session: Session,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
    view: SessionView,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute one declaration statement (export/local/declare/readonly).

    The executor only reads the operands: it expands them, sorts them
    into option letters, plain names and staged array literals, then
    hands the result to the builtin handler that owns the keyword. The
    attribute letters (`-x`, `-i`, `-l`) are stamped afterwards through
    the same gated door, so `declare -rx X=1` keeps both marks.

    Args:
        node (Any): the tree-sitter ``declaration_command`` node.
        session (Session): shell session state.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
        view (SessionView): the session plane's gated door, bound once
            for the line so a pre_session rule governs an
            expansion-time write exactly as it governs `X=d`.
    """
    keyword = get_declaration_keyword(node)
    assignments = []
    # Array literals are staged, not stored: `readonly -a a=(y)` on an
    # already-readonly name has to fail with the old value intact.
    staged: list[tuple[str, bool, list[str]]] = []
    # Option words are kept verbatim, in order, so `--` survives as an
    # end-of-options marker and the handlers can name the *first* bad
    # option letter the way bash does.
    flag_words: list[str] = []
    flag_chars: set[str] = set()
    plus_chars: set[str] = set()
    opts_done = False
    for child in node.named_children:
        if child.type == NT.VARIABLE_ASSIGNMENT:
            val_nodes = [
                c for c in child.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes and val_nodes[0].type == NT.ARRAY:
                key = get_text(child).partition("=")[0]
                items = await expand_array_items(val_nodes[0], session,
                                                 execute_fn, registry,
                                                 namespace, cs)
                staged.append(
                    (key.removesuffix("+"), key.endswith("+"), items))
                continue
            expanded = await expand_node(child,
                                         session,
                                         execute_fn,
                                         cs,
                                         view=view)
            assignments.append(expanded)
        elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                            NT.CONCATENATION, NT.WORD, NT.VARIABLE_NAME,
                            NT.STRING, NT.RAW_STRING, NT.ANSI_C_STRING,
                            NT.TRANSLATED_STRING):
            # A bare `readonly NAME` / `export NAME` operand parses as
            # a variable_name, not a word, and a quoted assignment
            # (`export 'FOO=bar'`) as a plain string operand.
            expanded = await expand_node(child,
                                         session,
                                         execute_fn,
                                         cs,
                                         view=view)
            if not expanded and child.type in (NT.SIMPLE_EXPANSION,
                                               NT.EXPANSION):
                # An *unquoted* expansion that came back empty is
                # removed by word splitting, so `export $UNSET` is a
                # bare `export` and prints the listing. A quoted one
                # is a real, empty operand: GNU answers both
                # `export ""` and `export "$UNSET"` with
                # ``export: `': not a valid identifier``, so it has
                # to reach the builtin rather than vanish here.
                continue
            if (not opts_done and expanded.startswith("-")
                    and len(expanded) > 1):
                flag_words.append(expanded)
                if expanded == "--":
                    opts_done = True
                else:
                    flag_chars.update(expanded[1:])
            elif (not opts_done and expanded.startswith("+")
                  and len(expanded) > 1
                  and keyword in (NT.LOCAL, "declare", "typeset")):
                # `+attr` turns an attribute off. Only the declare
                # family reads it: `export +x` and `readonly +r` are
                # `not a valid identifier` in GNU, so for those two
                # the word falls through as an operand and refuses
                # there.
                plus_chars.update(expanded[1:])
            else:
                assignments.append(expanded)
    cmd_word = "local" if keyword == NT.LOCAL else str(keyword)
    if keyword in (NT.LOCAL, "declare", "typeset"):
        refused = _declare_option_refusal(cmd_word, flag_chars, plus_chars,
                                          session)
        if refused is not None:
            return refused
    if (("f" in flag_chars or "F" in flag_chars)
            and keyword in (NT.LOCAL, "declare", "typeset")):
        # `-f`/`-F` select functions, not variables: `-rf` freezes,
        # `-f NAME` prints the body, `-F NAME` prints the name, and
        # a missing name is exit 1 without a word.
        return handle_declare_functions(cmd_word, session, flag_chars,
                                        assignments)
    is_readonly = keyword == "readonly" or "r" in flag_chars
    # `-l` and `-u` cannot both hold; a cluster naming both sets
    # neither (pinned: `declare -lu s=aBc` prints `declare -- s`).
    shaping = frozenset(_ATTR_LETTERS[c] for c in "ilu"
                        if c in flag_chars and c not in plus_chars)
    if VarAttr.LOWER in shaping and VarAttr.UPPER in shaping:
        shaping = shaping - {VarAttr.LOWER, VarAttr.UPPER}
    conversion_errors: list[str] = []
    if "A" in flag_chars or "a" in flag_chars:
        # `declare -a NAME` / `declare -A NAME` with no value declare
        # an empty array of that kind, so ${#NAME[@]} is 0 and an
        # element write leaves the other slots unassigned. GNU
        # refuses to convert between the two kinds and says so per
        # name while the rest of the operands still declare.
        want_assoc = "A" in flag_chars
        for bare in assignments:
            if "=" in bare:
                continue
            # Both branches below write array storage raw (the
            # top-level one migrates an existing scalar), so a
            # hidden name refuses like any assignment spelling
            # before either lands.
            try:
                ensure_var_visible(session, bare)
            except PolicyDenied as exc:
                err = f"{exc.strerror}\n".encode()
                raise ExitSignal(1, stderr=err, contained_code=1) from exc
            if want_assoc and bare in session.arrays:
                conversion_errors.append(
                    f"bash: {cmd_word}: {bare}: cannot convert indexed "
                    "to associative array")
                continue
            if not want_assoc and bare in session.assocs:
                conversion_errors.append(
                    f"bash: {cmd_word}: {bare}: cannot convert "
                    "associative to indexed array")
                continue
            if "g" not in flag_chars and note_local_array(session, bare):
                # Inside a function this shadows whatever the caller
                # had with a fresh empty array of the declared kind;
                # `-g` declares at global scope instead.
                seed_var(session, bare, {} if want_assoc else [])
            elif want_assoc and bare not in session.assocs:
                # At top level an existing scalar becomes the value
                # at the literal key "0" (GNU allows scalar-to-
                # associative conversion, unlike indexed).
                scalar = conversion_scalar(session, bare)
                seed_var(session, bare,
                         {} if scalar is None else {"0": scalar})
            elif not want_assoc and bare not in session.arrays:
                # At top level an existing scalar becomes element 0.
                scalar = conversion_scalar(session, bare)
                seed_var(session, bare, [] if scalar is None else [scalar])
    # Array literals travel as data: the handler stores them through
    # the session door and owns both refusal voices, so the executor
    # only expands and stages.
    if is_readonly:
        decl_view = session_view(session, namespace.registry.policies)
        stored: list[str] = []
        # Only the `readonly` keyword owns -p / illegal-option
        # handling; `declare -r` keeps names only.
        if keyword == "readonly":
            result = await handle_readonly(flag_words + assignments,
                                           session,
                                           decl_view,
                                           arrays=staged,
                                           stored=stored,
                                           assoc="A" in flag_chars,
                                           shaping=shaping)
        else:
            result = await handle_readonly(assignments,
                                           session,
                                           decl_view,
                                           arrays=staged,
                                           stored=stored,
                                           assoc="A" in flag_chars,
                                           shaping=shaping)
        # `declare -rx X=1` carries both attributes: GNU prints
        # `declare -rx X="1"`. Readonly answers first, so the export
        # stamp has to land here too, or `-r` silently ate the `-x`.
        refused = await _stamp_attrs(session, decl_view, flag_chars,
                                     plus_chars, assignments, staged, stored)
        if refused is not None:
            return refused
        return _merge_conversion_errors(result, conversion_errors)
    # declare/typeset scope like `local` inside a function (bash
    # semantics) and assign globally at top level, which is exactly
    # handle_local's fallback when no function scope is active.
    if keyword in (NT.LOCAL, "declare", "typeset"):
        # `-p` prints rather than declares, so it is answered before
        # the assignment path runs at all.
        if (("p" in flag_chars or "p" in plus_chars)
                and keyword in ("declare", "typeset")):
            return await handle_declare_print(assignments, session)
        decl_view = session_view(session, namespace.registry.policies)
        stored = []
        result = await handle_local(
            assignments,
            session,
            decl_view,
            arrays=staged,
            # `declare`/`typeset` share this handler but have to name
            # themselves in a diagnostic rather than say `local`.
            cmd=cmd_word,
            stored=stored,
            assoc="A" in flag_chars,
            shaping=shaping,
            nameref="n" in flag_chars and "n" not in plus_chars,
            global_scope="g" in flag_chars)
        plus_refused = await _plus_refusals(cmd_word, session, decl_view,
                                            plus_chars, assignments, staged)
        if plus_refused is not None:
            return plus_refused
        refused = await _stamp_attrs(session, decl_view, flag_chars,
                                     plus_chars, assignments, staged, stored)
        if refused is not None:
            return refused
        return _merge_conversion_errors(result, conversion_errors)
    # Pass export flags through so -p / bare print and bad options work.
    result = await handle_export(flag_words + assignments,
                                 session,
                                 session_view(session,
                                              namespace.registry.policies),
                                 arrays=staged)
    return _merge_conversion_errors(result, conversion_errors)
