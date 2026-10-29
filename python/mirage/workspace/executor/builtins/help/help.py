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

from collections.abc import Sequence

from mirage.commands.builtin.utils.strtol import atoi
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.synopsis import SHELL_SYNOPSES
from mirage.commands.spec.types import CommandSpec
from mirage.policy.match import runs
from mirage.shell.bytes import encode_text
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.help.constants import (
    DEFAULT_COLUMNS,
    DESCRIPTION,
    GUIDE,
    MAX_CELL,
    MIN_COLUMNS,
    OPERAND_HELP,
    TEXT_WIDTH,
)
from mirage.workspace.executor.builtins.shared import (
    builtin_error,
    builtin_usage,
    result,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup.constants import BASH_BUILTINS
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import visible_env

_INDENT = "    "

# Every topic, in the order the listing and a pattern's matches show.
TOPICS = tuple(sorted(SHELL_SYNOPSES))


def paragraphs(text: str | None) -> tuple[str, ...]:
    """A spec's free text as paragraphs, split at its blank lines.

    Args:
        text (str | None): the description or epilog.
    """
    if not text:
        return ()
    return tuple(
        " ".join(part.split()) for part in text.split("\n\n") if part.strip()
    )


def summary(spec: CommandSpec) -> str:
    """The one line a spec's description opens with.

    Args:
        spec (CommandSpec): the spec.
    """
    return next(iter(paragraphs(spec.description)), "")


def option_rows(spec: CommandSpec) -> list[tuple[str, str]]:
    """Each option of a builtin, as its help lists it: the letter and the
    name of its value, and what it does.

    Args:
        spec (CommandSpec): the builtin's spec.
    """
    rows = []
    for opt in compile_spec(spec).options:
        label = opt.names[0]
        if opt.action not in ("store_true", "count") and opt.metavar:
            label += f" {opt.metavar}"
        rows.append((label, opt.help or ""))
    return rows


def _break_points(word: str) -> list[int]:
    """Where a word may break across lines: after a hyphen that follows a
    letter or digit, so ``read-only`` breaks and ``--all`` does not.

    Args:
        word (str): one word of the text.
    """
    return [
        i + 1
        for i in range(1, len(word) - 1)
        if word[i] == "-" and word[i - 1].isalnum()
    ]


def fill(text: str, width: int) -> list[str]:
    """Lay text out in lines of at most ``width`` characters.

    Words go on a line while they fit; a word that does not fit breaks
    after its last hyphen that still does, and a word longer than a
    line with nowhere to break runs past it. This is how a manual page
    fills text with justification and hyphenation off.

    Args:
        text (str): the paragraph.
        width (int): the longest line.
    """
    lines: list[str] = []
    line = ""
    for word in text.split():
        while word:
            room = width - len(line) - (1 if line else 0)
            if len(word) <= room:
                line = f"{line} {word}" if line else word
                break
            cut = max((p for p in _break_points(word) if p <= room), default=0)
            if cut:
                lines.append(f"{line} {word[:cut]}" if line else word[:cut])
                line, word = "", word[cut:]
            elif line:
                lines.append(line)
                line = ""
            else:
                line, word = word, ""
    if line:
        lines.append(line)
    return lines


def _indented(text: str) -> list[str]:
    """A paragraph of a topic's help, filled and indented.

    Args:
        text (str): the paragraph.
    """
    return [_INDENT + line for line in fill(text, TEXT_WIDTH - len(_INDENT))]


def _topic_body(spec: CommandSpec) -> list[str]:
    """A topic's help below its synopsis line: the summary, then the
    description, the options and the exit status, each set off by an
    indented blank line.

    Args:
        spec (CommandSpec): the topic's spec.
    """
    lead, *text = paragraphs(spec.description)
    lines = [_INDENT + lead]
    for paragraph in text:
        lines += [_INDENT, *_indented(paragraph)]
    rows = option_rows(spec)
    if rows:
        lines += [_INDENT, f"{_INDENT}Options:"]
        lines += [f"      {flag}\t{does}" for flag, does in rows]
    if spec.epilog:
        lines += [_INDENT, f"{_INDENT}Exit Status:", *_indented(spec.epilog)]
    return lines


def topic_help(name: str) -> str:
    """What ``help NAME`` and ``NAME --help`` print.

    Args:
        name (str): the topic.
    """
    lines = [
        f"{name}: {SHELL_SYNOPSES[name]}",
        *_topic_body(SHELL_SPECS[name]),
    ]
    return "\n".join(lines) + "\n"


def _manual(name: str) -> str:
    """What ``help -m NAME`` prints: the help laid out in a manual
    page's sections.

    Args:
        name (str): the topic.
    """
    spec = SHELL_SPECS[name]
    lines = [
        "NAME",
        f"{_INDENT}{name} - {summary(spec)}",
        "",
        "SYNOPSIS",
        _INDENT + SHELL_SYNOPSES[name],
        "",
        "DESCRIPTION",
        *_topic_body(spec),
        "",
        "SEE ALSO",
        f"{_INDENT}bash(1)",
        "",
        "IMPLEMENTATION",
        _INDENT + version_line("bash").decode().rstrip("\n"),
        "",
    ]
    return "\n".join(lines) + "\n"


def env_width(
    session: SessionState, names: Sequence[str], least: int, default: int
) -> int:
    """The width the first of ``names`` sets, read as C's ``atoi`` reads
    it, passing over one under ``least``; ``default`` when none sets one.

    Args:
        session (SessionState): the shell session.
        names (Sequence[str]): the variables, in the order they count.
        least (int): the narrowest width taken.
        default (int): the width when no variable gives one.
    """
    env = visible_env(session)
    for name in names:
        width = atoi(env.get(name, ""))
        if width >= least:
            return width
    return default


def disabled(name: str, session: SessionState) -> bool:
    """Whether the session may not run a builtin at all, which the
    listing marks with a star.

    Args:
        name (str): the topic.
        session (SessionState): the shell session.
    """
    return name in BASH_BUILTINS and not runs(name, session.commands)


def _cell(name: str, session: SessionState, room: int) -> str:
    """One entry of the listing: its mark and synopsis, cut with ``>``
    once the synopsis reaches ``room`` characters.

    Args:
        name (str): the topic.
        session (SessionState): the shell session.
        room (int): the characters the synopsis may take.
    """
    mark = "*" if disabled(name, session) else " "
    text = SHELL_SYNOPSES[name]
    if len(text) >= room:
        text = text[: max(room, 0)] + ">"
    return mark + text


def _listing(session: SessionState) -> str:
    """Every topic's synopsis in two columns, under the shell's name and
    a guide to the listing.

    Args:
        session (SessionState): the shell session.
    """
    columns = env_width(session, ("COLUMNS",), MIN_COLUMNS, DEFAULT_COLUMNS)
    width = min(columns // 2, MAX_CELL)
    rows = (len(TOPICS) + 1) // 2
    lines = [
        version_line("bash").decode().rstrip("\n"),
        DESCRIPTION,
        *GUIDE,
        "",
    ]
    for i in range(rows):
        left = _cell(TOPICS[i], session, width - 3)
        if i + rows < len(TOPICS):
            right = _cell(TOPICS[i + rows], session, width - 4)
            lines.append(left.ljust(width) + right)
        else:
            lines.append(left)
    return "\n".join(lines) + "\n"


def _globbed(pattern: str) -> bool:
    """Whether a pattern is a glob, which titles the output with the
    patterns asked for.

    Args:
        pattern (str): the pattern.
    """
    if "*" in pattern or "?" in pattern:
        return True
    start = pattern.find("[")
    return start >= 0 and "]" in pattern[start + 1 :]


def matching(pattern: str) -> list[str]:
    """The topics a pattern names: the one it spells exactly, else every
    one it begins or matches as a glob.

    Args:
        pattern (str): the pattern.
    """
    if pattern in SHELL_SYNOPSES:
        return [pattern]
    return [
        name
        for name in TOPICS
        if name.startswith(pattern) or fnmatch(name, pattern)
    ]


def flag_help(name: str) -> Result | None:
    """A builtin's answer to ``--help`` as its first word: its help, and
    status 2. None for a word that reads ``--help`` as an operand, and
    for any word that is no builtin.

    Args:
        name (str): the command name.
    """
    if (
        name not in SHELL_SYNOPSES
        or name not in BASH_BUILTINS
        or name in OPERAND_HELP
    ):
        return None
    return result(name, out=encode_text(topic_help(name)), exit_code=2)


async def help_builtin(call: BuiltinCall) -> Result:
    """The ``help`` arm: the listing, or what each pattern names.

    ``-d`` wins over ``-m`` and ``-m`` over ``-s``. A pattern that
    matches nothing is passed over; only when none matches is there an
    error, and it names the last.

    Args:
        call (BuiltinCall): the invocation.
    """
    session = call.context.session
    scan = scan_options(list(call.argv.args), "dms")
    if scan.bad is not None:
        message = builtin_error("help", f"{scan.bad}: invalid option")
        return result(
            "help",
            exit_code=2,
            stderr=message.decode() + builtin_usage("help"),
        )
    if not scan.operands:
        return result("help", out=encode_text(_listing(session)))
    mode = next((m for m in "dms" if m in scan.letters), None)
    out: list[str] = []
    if _globbed(scan.operands[0]):
        plural = "s" if len(scan.operands) > 1 else ""
        out.append(
            f"Shell commands matching keyword{plural} "
            f"`{', '.join(scan.operands)}'\n\n"
        )
    found = False
    for pattern in scan.operands:
        for name in matching(pattern):
            found = True
            if mode == "d":
                out.append(f"{name} - {summary(SHELL_SPECS[name])}\n")
            elif mode == "m":
                out.append(_manual(name))
            elif mode == "s":
                out.append(f"{name}: {SHELL_SYNOPSES[name]}\n")
            else:
                out.append(topic_help(name))
    if found:
        return result("help", out=encode_text("".join(out)))
    last = scan.operands[-1]
    message = builtin_error(
        "help",
        f"no help topics match `{last}'.  Try `help help' or "
        f"`man -k {last}' or `info {last}'.",
    )
    return result(
        "help",
        out=encode_text("".join(out)) or None,
        exit_code=1,
        stderr=message.decode(),
    )
