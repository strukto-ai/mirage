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

from collections.abc import Iterable

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.constants import SHOPT_DEFAULTS
from mirage.shell.helpers import get_text
from mirage.shell.types import TSNodeLike
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.alias.constants import (
    ALIAS_USAGE,
    BAD_NAME_CHARS,
    FIRST_WORD,
    UNALIAS_USAGE,
)
from mirage.workspace.executor.builtins.alias.types import AliasMark
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.shared import (
    fail,
    finish,
    ok,
    result,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState


async def handle_alias(
    args: list[str],
    session: SessionState,
    mark: AliasMark,
) -> Result:
    """Define or print aliases.

    `alias` alone (or `-p`) prints every definition as a re-readable
    `alias NAME='VALUE'` line, sorted by name; `NAME=VALUE` defines,
    `NAME` prints that one or says `not found` (exit 1, the others
    still answered); a name holding a metacharacter is `invalid alias
    name`, exit 1. Any option but `-p` is exit 2 with the usage line.

    Args:
        args (list[str]): the words after `alias`.
        session (SessionState): shell session state.
        mark (AliasMark): the read this definition sits in: bash
            expands aliases as it reads, so the commands of that read
            still see the value from before it.
    """
    scan = scan_options(args, "p")
    if scan.bad is not None:
        return fail(
            "alias",
            f"bash: alias: {scan.bad}: invalid option\n{ALIAS_USAGE}\n",
            2,
        )
    operands = scan.operands
    lines: list[str] = []
    errors: list[str] = []
    if not operands or "p" in scan.letters:
        lines.extend(
            f"alias {name}={single_quote(session.aliases[name])}"
            for name in sorted(session.aliases)
        )
    for word in operands:
        name, eq, value = word.partition("=")
        if eq:
            if not name or any(c in BAD_NAME_CHARS for c in name):
                # bash quotes the whole word for an empty name (`alias
                # =x` is `=x: not found`, oddly) and the name otherwise.
                if not name:
                    errors.append(f"bash: alias: {word}: not found")
                else:
                    errors.append(f"bash: alias: `{name}': invalid alias name")
                continue
            _changing(session, name, mark)
            session.aliases[name] = value
            continue
        if any(c in BAD_NAME_CHARS for c in name):
            errors.append(f"bash: alias: `{name}': invalid alias name")
            continue
        if name in session.aliases:
            lines.append(f"alias {name}={single_quote(session.aliases[name])}")
        else:
            errors.append(f"bash: alias: {name}: not found")
    return result(
        "alias",
        encode_text("".join(f"{line}\n" for line in lines)) if lines else None,
        1 if errors else 0,
        "".join(f"{error}\n" for error in errors),
    )


async def handle_unalias(
    args: list[str],
    session: SessionState,
    mark: AliasMark,
) -> Result:
    """Remove aliases: the named ones, or all of them under `-a`.

    A name that is not an alias is `not found`, exit 1, and the others
    are still removed; no operand and no `-a` is the usage line, exit 2.

    Args:
        args (list[str]): the words after `unalias`.
        session (SessionState): shell session state.
        mark (AliasMark): the read the removal sits in, whose commands
            still see the aliases it removes.
    """
    scan = scan_options(args, "a")
    if scan.bad is not None:
        return fail(
            "unalias",
            f"bash: unalias: {scan.bad}: invalid option\n{UNALIAS_USAGE}\n",
            2,
        )
    operands = scan.operands
    if "a" in scan.letters:
        for name in session.aliases:
            _changing(session, name, mark)
        session.aliases.clear()
        return ok("unalias")
    if not operands:
        return fail("unalias", f"{UNALIAS_USAGE}\n", 2)
    errors: list[str] = []
    for name in operands:
        if name in session.aliases:
            _changing(session, name, mark)
            del session.aliases[name]
        else:
            errors.append(f"bash: unalias: {name}: not found\n")
    return finish("unalias", errors)


def _changing(session: SessionState, name: str, mark: AliasMark) -> None:
    """Keep the value ``name`` had as the read at ``mark`` began, the
    first time that read changes it, for the commands it read
    (``_read_value``). Every read keeps its own, so a nested one
    (``eval``) leaves the outer read's alone.

    Args:
        session (SessionState): shell session state.
        name (str): the alias being defined or removed.
        mark (AliasMark): the read changing it.
    """
    began = session._alias_marks.setdefault(mark, {})
    began.setdefault(name, session.aliases.get(name))


def _read_value(
    session: SessionState, name: str, mark: AliasMark
) -> str | None:
    began = session._alias_marks.get(mark, {})
    return began[name] if name in began else session.aliases.get(name)


def _expanding(session: SessionState, mark: AliasMark) -> bool:
    began = session._expand_aliases_marks.get(mark)
    if began is not None:
        return began
    return bool(
        session.shopts.get("expand_aliases", SHOPT_DEFAULTS["expand_aliases"])
    )


def note_expanding(session: SessionState, mark: AliasMark) -> None:
    """Keep ``expand_aliases`` as the read at ``mark`` found it, before a
    ``shopt`` in that read changes it: the commands of that read were
    expanded, or not, already.

    Args:
        session (SessionState): shell session state.
        mark (AliasMark): the read running ``shopt``.
    """
    session._expand_aliases_marks.setdefault(mark, _expanding(session, mark))


def _guards(
    session: SessionState, node: TSNodeLike
) -> tuple[frozenset[str], ...]:
    """The aliases in progress at each byte of ``node``: its slice of the
    rewritten tree holding it, or the guards another tree inherits."""
    scope = session._alias_expansion
    if scope is None:
        return (frozenset(),) * len(node.text or b"")
    root = node
    while root.parent is not None:
        root = root.parent
    if root.id == scope.root:
        return scope.owners[node.start_byte : node.end_byte]
    return (scope.names,) * len(node.text or b"")


def alias_value(
    session: SessionState,
    name: str,
    mark: AliasMark,
    blocked: frozenset[str],
) -> str | None:
    """The alias text a command word expands to, or None.

    bash expands aliases as it reads a command, so the word sees the
    aliases, and ``expand_aliases``, as the read at ``mark`` found them:
    one the same read defines, removes or turns off has not changed yet.
    None when they are not being expanded (``expand_aliases`` off, bash's
    default outside an interactive shell), when the word is no alias, or
    when it is guarded (bash does not expand a word inserted by the
    alias being expanded). In a function's body the aliases are the ones
    its definition saw (``alias_view``).

    Args:
        session (SessionState): shell session state.
        name (str): the command word.
        mark (AliasMark): the read of the use.
        blocked (frozenset[str]): guards at this word.
    """
    if name in blocked:
        return None
    view = session._alias_view
    if view is not None:
        return view.get(name)
    return (
        _read_value(session, name, mark) if _expanding(session, mark) else None
    )


def expanding_aliases(session: SessionState) -> frozenset[str]:
    """The alias names a command word would expand as right now.

    bash checks a word where a command starts for an alias before it
    checks for a reserved word, so one of these names is a command there
    even when it is spelled ``fi`` or ``do``.

    Args:
        session (SessionState): shell session state.
    """
    scope = session._alias_expansion
    blocked = scope.names if scope is not None else frozenset()
    view = session._alias_view
    if view is not None:
        return frozenset(view) - blocked
    if not session.shopts.get(
        "expand_aliases", SHOPT_DEFAULTS["expand_aliases"]
    ):
        return frozenset()
    return frozenset(session.aliases) - blocked


def alias_view(
    session: SessionState, node: TSNodeLike, mark: AliasMark
) -> dict[str, str]:
    """The aliases a function defined by ``node`` keeps for its body.

    bash expands a function's aliases as it reads the definition, so the
    body runs them as they were then, whatever is defined or removed
    later: the aliases a use in the read at ``mark`` would expand, none
    while ``expand_aliases`` is off, and inside another function's body
    that body's own, less any alias being expanded where the definition
    stands. What is read later (``eval``, ``source``, a trap action,
    ``$( )``) reads the aliases as they are then.

    Args:
        session (SessionState): shell session state.
        node (TSNodeLike): the definition.
        mark (AliasMark): the read of the definition.
    """
    view = session._alias_view
    names: Iterable[str] = (
        view
        if view is not None
        else set(session.aliases).union(session._alias_marks.get(mark, {}))
    )
    blocked = _guards(session, node)[0]
    return {
        name: value
        for name in names
        if (value := alias_value(session, name, mark, blocked)) is not None
    }


def alias_command_text(
    session: SessionState,
    node: TSNodeLike,
    head: TSNodeLike,
    mark: AliasMark,
) -> tuple[str, tuple[frozenset[str], ...]] | None:
    """Replace alias words, preserving the rest of the command and its guards.

    Each insertion inherits the replaced word's guards and adds its name.
    A trailing blank checks the next caller word through the same loop.

    Args:
        session (SessionState): shell session state.
        node (TSNodeLike): the full command, including assignments.
        head (TSNodeLike): its unquoted command word.
        mark (AliasMark): the parse and row of the use.
    """
    source = node.text or b""
    inherited = _guards(session, node)
    at, end = (
        head.start_byte - node.start_byte,
        head.end_byte - node.start_byte,
    )
    name = get_text(head)
    seen: set[str] = set()
    parts: list[bytes] = []
    owners: list[frozenset[str]] = []
    cursor = 0
    while name not in seen:
        blocked = inherited[at]
        value = alias_value(session, name, mark, blocked)
        if value is None:
            break
        seen.add(name)
        inserted = encode_text(value)
        parts.extend((source[cursor:at], inserted))
        owners.extend(inherited[cursor:at])
        owners.extend((blocked | {name},) * len(inserted))
        cursor = end
        if not value.endswith((" ", "\t")):
            break
        rest = decode_text(source[cursor:])
        match = FIRST_WORD.search(rest)
        if match is None:
            break
        name = match.group(0)
        at = cursor + len(encode_text(rest[: match.start()]))
        end = at + len(encode_text(name))
    if not seen:
        return None
    parts.append(source[cursor:])
    owners.extend(inherited[cursor:])
    return decode_text(b"".join(parts)), tuple(owners)


def alias_mark(session: SessionState, row: int) -> AliasMark:
    """The read a command at ``row`` of the running parse belongs to
    (``read_row``).

    Args:
        session (SessionState): shell session state.
        row (int): the command's read row within its parse.
    """
    return (session._parse_current, session._parse_row + row)


async def alias_builtin(call: BuiltinCall) -> Result:
    """The ``alias`` arm.

    Args:
        call (BuiltinCall): the invocation; its row marks where the
            definition was made.
    """
    session = call.context.session
    return await handle_alias(
        list(call.argv.args), session, alias_mark(session, call.row)
    )


async def unalias_builtin(call: BuiltinCall) -> Result:
    """The ``unalias`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    session = call.context.session
    return await handle_unalias(
        list(call.argv.args), session, alias_mark(session, call.row)
    )
