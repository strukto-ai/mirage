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

from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec.builtins import is_builtin_grammar, registered_spec
from mirage.commands.spec.constants import (
    HELP_OPTION,
    STANDARD_AFTER_SCAN,
    STANDARD_BEFORE_SCAN,
    VERSION_OPTION,
)
from mirage.commands.spec.help import render_help
from mirage.commands.spec.parser import ParsedArgs, parse_command
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import CommandSpec
from mirage.version import __version__


def version_line(name: str) -> bytes:
    """The ``--version`` answer of a command.

    Args:
        name (str): The command name as invoked.
    """
    return f"{name} (Mirage) {__version__}\n".encode()


def help_page(name: str, spec: CommandSpec) -> bytes:
    """The ``--help`` page of a command.

    The page lists ``--help`` and ``--version`` as well. Only the
    builtin itself gets GNU's synopsis line; a mount command that
    borrows the name keeps the line its own spec renders.

    Args:
        name (str): The command name as invoked.
        spec (CommandSpec): The command's grammar, as declared or as
            registered.
    """
    synopsis = SYNOPSES.get(name) if is_builtin_grammar(name, spec) else None
    return render_help(
        name, registered_spec(name, spec), synopsis=synopsis
    ).encode()


def has_injected_help(spec: CommandSpec | None) -> bool:
    """Whether the registration answers ``--help`` for this spec.

    Args:
        spec (CommandSpec | None): The registered spec.
    """
    return spec is not None and any(o is HELP_OPTION for o in spec.arguments)


def has_injected_version(spec: CommandSpec | None) -> bool:
    """Whether the registration answers ``--version`` for this spec.

    Args:
        spec (CommandSpec | None): The registered spec.
    """
    return spec is not None and any(
        o is VERSION_OPTION for o in spec.arguments
    )


def _parse(name: str, spec: CommandSpec, words: list[str]) -> ParsedArgs:
    return parse_command(spec, words, ROOT_CWD.virtual, name)


def _has_option_error(parsed: ParsedArgs) -> bool:
    return bool(
        parsed.option_error_kinds or parsed.old_option_needs_value is not None
    )


def _position(
    name: str, spec: CommandSpec, argv: list[str], option: str
) -> int | None:
    """The index of the first word the parser reads as *option*.

    Parsing growing prefixes of the line, instead of looking for the
    spelling, leaves ``--``, a remainder operand and an option's value
    to the parser: ``sort -o --version --version`` writes to a file
    named ``--version`` and answers the second one.

    Args:
        name (str): The command name as invoked.
        spec (CommandSpec): The registered spec.
        argv (list[str]): The words after the command name.
        option (str): ``--help`` or ``--version``.
    """
    for index in range(len(argv)):
        if option in _parse(name, spec, argv[: index + 1]).typed_dests:
            return index
    return None


def standard_request(
    name: str, spec: CommandSpec | None, argv: list[str]
) -> bytes | None:
    """The ``--help`` page or version line that *argv* asks for.

    The executor asks before routing, since neither answer belongs to
    a backend: ``rm --version /ro/x`` must not meet the read-only
    refusal, and ``mv --help /ram/a /disk/b`` must not move the file.
    The rules are GNU's getopt loop (coreutils 9.7):

    - the standard option the parser reaches first answers, so
      ``cat --help --version`` prints the help page;
    - an option error ahead of it wins, so ``cat --bogus --version``
      is a usage error, while ``cat --version --bogus`` prints the
      version;
    - a word counts only if the parser reads it as the option, so
      ``grep -e --version`` searches for ``--version``.

    Builtins in STANDARD_BEFORE_SCAN answer ahead of every option, and
    those in STANDARD_AFTER_SCAN only when the whole line parses.

    Args:
        name (str): The command name as invoked.
        spec (CommandSpec | None): The command's registered spec.
        argv (list[str]): The words after the command name.

    Returns:
        bytes | None: The answer, or None to run the command as usual.
    """
    if spec is None:
        return None
    offered = []
    if has_injected_help(spec):
        offered.append("--help")
    if has_injected_version(spec):
        offered.append("--version")
    if not offered:
        return None
    whole = _parse(name, spec, argv)
    reached: list[tuple[int, str]] = []
    for option in offered:
        if option not in whole.typed_dests:
            continue
        position = _position(name, spec, argv, option)
        if position is not None:
            reached.append((position, option))
    if not reached:
        return None
    position, option = min(reached)
    builtin = is_builtin_grammar(name, spec)
    if not (builtin and name in STANDARD_BEFORE_SCAN):
        if _has_option_error(_parse(name, spec, argv[:position])):
            return None
        if (
            builtin
            and name in STANDARD_AFTER_SCAN
            and _has_option_error(whole)
        ):
            return None
    return help_page(name, spec) if option == "--help" else version_line(name)


__all__ = [
    "has_injected_help",
    "has_injected_version",
    "help_page",
    "standard_request",
    "version_line",
]
