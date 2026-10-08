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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
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
from mirage.workspace.executor.builtins.shared import fail
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_alias(
    args: list[str],
    session: SessionState,
    mark: AliasMark,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Define or print aliases.

    `alias` alone (or `-p`) prints every definition as a re-readable
    `alias NAME='VALUE'` line, sorted by name; `NAME=VALUE` defines,
    `NAME` prints that one or says `not found` (exit 1, the others
    still answered); a name holding a metacharacter is `invalid alias
    name`, exit 1. Any option but `-p` is exit 2 with the usage line.

    Args:
        args (list[str]): the words after `alias`.
        session (SessionState): shell session state.
        mark (AliasMark): the parse and row this definition sits on,
            which is what decides whether a later use on the same line
            sees it (bash expands aliases as it reads a line, so a use
            on the defining line does not).
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
            session.aliases[name] = value
            session._alias_marks[name] = mark
            continue
        if any(c in BAD_NAME_CHARS for c in name):
            errors.append(f"bash: alias: `{name}': invalid alias name")
            continue
        if name in session.aliases:
            lines.append(f"alias {name}={single_quote(session.aliases[name])}")
        else:
            errors.append(f"bash: alias: {name}: not found")
    out = encode_text("\n".join(lines) + "\n") if lines else None
    err = encode_text("\n".join(errors) + "\n") if errors else None
    code = 1 if errors else 0
    return (
        out,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command="alias", exit_code=code, stderr=err or b""),
    )


async def handle_unalias(
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Remove aliases: the named ones, or all of them under `-a`.

    A name that is not an alias is `not found`, exit 1, and the others
    are still removed; no operand and no `-a` is the usage line, exit 2.

    Args:
        args (list[str]): the words after `unalias`.
        session (SessionState): shell session state.
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
        session.aliases.clear()
        session._alias_marks.clear()
        return None, IOResult(), ExecutionNode(command="unalias", exit_code=0)
    if not operands:
        return fail("unalias", f"{UNALIAS_USAGE}\n", 2)
    errors: list[str] = []
    for name in operands:
        if name in session.aliases:
            del session.aliases[name]
            session._alias_marks.pop(name, None)
        else:
            errors.append(f"bash: unalias: {name}: not found")
    err = encode_text("\n".join(errors) + "\n") if errors else None
    code = 1 if errors else 0
    return (
        None,
        IOResult(exit_code=code, stderr=err or b""),
        ExecutionNode(command="unalias", exit_code=code, stderr=err or b""),
    )


def alias_value(
    session: SessionState,
    name: str,
    mark: AliasMark,
    blocked: frozenset[str] | None = None,
) -> str | None:
    """The alias text a command word expands to, or None.

    None when aliases are not being expanded (`shopt -s expand_aliases`
    is off, bash's default outside an interactive shell), when the word
    is not an alias, when it is the alias being expanded (bash does not
    expand a word identical to an alias being expanded a second time),
    or when it was defined on the very parse and row that uses it.

    Args:
        session (SessionState): shell session state.
        name (str): the command word.
        mark (AliasMark): the parse and row of the use.
        blocked (frozenset[str] | None): guards at this word; absent,
            guards inherited by a separately parsed line.
    """
    if not session.shopts.get(
        "expand_aliases", SHOPT_DEFAULTS["expand_aliases"]
    ):
        return None
    if blocked is None:
        scope = session._alias_expansion
        blocked = scope.names if scope is not None else frozenset()
    value = session.aliases.get(name)
    if value is None or name in blocked:
        return None
    if session._alias_marks.get(name) == mark:
        return None
    return value


def expanding_aliases(session: SessionState) -> frozenset[str]:
    """The alias names a command word would expand as right now.

    bash checks a word where a command starts for an alias before it
    checks for a reserved word, so one of these names is a command there
    even when it is spelled ``fi`` or ``do``.

    Args:
        session (SessionState): shell session state.
    """
    if not session.shopts.get(
        "expand_aliases", SHOPT_DEFAULTS["expand_aliases"]
    ):
        return frozenset()
    scope = session._alias_expansion
    blocked = scope.names if scope is not None else frozenset()
    return frozenset(session.aliases) - blocked


def alias_owners(
    session: SessionState,
    node: TSNodeLike,
    start: int,
    end: int,
) -> tuple[frozenset[str], ...]:
    """Aliases in progress at the node's source bytes.

    Args:
        session (SessionState): active expansion, if any.
        node (TSNodeLike): identifies the tree the offsets belong to.
        start (int): first parsed byte.
        end (int): exclusive last parsed byte.
    """
    scope = session._alias_expansion
    if scope is None:
        return (frozenset(),) * (end - start)
    root = node
    while root.parent is not None:
        root = root.parent
    if root.id != scope.root:
        return (scope.names,) * (end - start)
    return scope.owners[start:end]


def alias_command_text(
    session: SessionState,
    node: TSNodeLike,
    rest: str,
    mark: AliasMark,
) -> tuple[str, tuple[frozenset[str], ...]] | None:
    """Rewrite an alias and retain who owns each byte of the result.

    Inserted text inherits the replaced word's guards and adds its own.
    Retained text keeps its guards, so neither a nested rewrite nor a
    trailing-blank chain extends an alias into the caller's words.

    Args:
        session (SessionState): shell session state.
        node (TSNodeLike): the command's head word.
        rest (str): parsed source after the head word.
        mark (AliasMark): the parse and row of the use.
    """
    name = get_text(node)
    blocked = alias_owners(
        session, node, node.start_byte, node.start_byte + 1
    )[0]
    value = alias_value(session, name, mark, blocked)
    if value is None:
        return None
    seen = {name}
    out = value
    owners = (blocked | {name},) * len(encode_text(value))
    at = node.end_byte
    while out.endswith((" ", "\t")):
        stripped = rest.lstrip()
        match = FIRST_WORD.match(stripped)
        if match is None or match.group(0) in seen:
            break
        word_at = at + len(encode_text(rest[: len(rest) - len(stripped)]))
        blocked = alias_owners(session, node, word_at, word_at + 1)[0]
        name = match.group(0)
        nxt = alias_value(session, name, mark, blocked)
        if nxt is None:
            break
        seen.add(name)
        out += nxt
        owners += (blocked | {name},) * len(encode_text(nxt))
        rest = stripped[match.end() :]
        at = word_at + len(encode_text(name))
    tail = rest.strip()
    if not tail:
        return out, owners
    at += len(encode_text(rest[: len(rest) - len(rest.lstrip())]))
    return out + " " + tail, owners + (frozenset(),) + alias_owners(
        session, node, at, at + len(encode_text(tail))
    )


async def alias_builtin(call: BuiltinCall) -> Result:
    """The ``alias`` arm.

    Args:
        call (BuiltinCall): the invocation; its row marks where the
            definition was made.
    """
    return await handle_alias(
        list(call.argv.args),
        call.context.session,
        (
            call.context.session._parse_current,
            call.context.session._parse_row + call.row,
        ),
    )


async def unalias_builtin(call: BuiltinCall) -> Result:
    """The ``unalias`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_unalias(list(call.argv.args), call.context.session)
