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

from mirage.shell.constants import BIN_PREFIX
from mirage.shell.printer import stored_function_text
from mirage.workspace.executor.builtins.lookup.constants import DESCRIPTIONS
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.lookup import Consumer, lookup, lookup_all, program
from mirage.workspace.lookup.constants import BASH_BUILTINS, KEYWORDS
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState


def _kind(consumer: Consumer, name: str) -> NameKind:
    """The kind one layer reports a name as.

    A function is a function and one of bash's own builtins is a
    builtin; every other layer runs a program, whose file is the
    name's under ``/usr/bin``.

    Args:
        consumer (Consumer): the layer holding the name.
        name (str): the operand word.
    """
    if consumer is Consumer.FUNCTION:
        return NameKind.FUNCTION
    if consumer is Consumer.SESSION and name in BASH_BUILTINS:
        return NameKind.BUILTIN
    return NameKind.FILE


def classify(
    name: str, session: SessionState, registry: MountRegistry
) -> NameKind | None:
    """Classify the name as the layer that would run it, None if none does.

    A layer that would run a program reports one only where the name
    has a file (``program``): a word only the external fallback capture
    takes still runs, but is not found, as bash reports a name its
    ``command_not_found_handle`` would take.

    Args:
        name (str): the operand word.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    if name in session.aliases:
        return NameKind.ALIAS
    if name in KEYWORDS:
        return NameKind.KEYWORD
    consumer = lookup(name, session, registry)
    if consumer is Consumer.UNKNOWN:
        return None
    kind = _kind(consumer, name)
    if kind is NameKind.FILE and program(name, session, registry) is None:
        return None
    return kind


def classify_all(
    name: str, session: SessionState, registry: MountRegistry
) -> list[NameKind]:
    """Classify every layer holding the name, most-preferred first.

    A reserved word goes first and does not end the walk: bash prints
    both lines when a function shares a keyword's name (pinned:
    ``function time { :; }; type -a time`` prints the keyword line then
    the function line). mirage's parser is looser than bash's about
    reserved words as function names, so the shadow is reachable here
    for any of them, and hiding it would leave ``type -a`` claiming a
    keyword while the line runs the function.

    Duplicate kinds are dropped, since the kinds are coarser than the
    layers: a program both a mount and a CLI answer for is one file.
    A builtin that is a program too ends with that file's line, as
    bash's ``type -a echo`` does after its builtin line. A file is
    reported only where ``program`` finds one, so a layer the name
    runs from without a file (the external fallback, a mount command
    under a shell-only builtin) prints no line.

    Args:
        name (str): the operand word.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    # An alias is reported first and whether or not `expand_aliases`
    # is on, as bash does: `type` describes the definition, not
    # whether the parser is currently applying it.
    kinds: list[NameKind] = [NameKind.ALIAS] if name in session.aliases else []
    if name in KEYWORDS:
        kinds.append(NameKind.KEYWORD)
    has_file = program(name, session, registry) is not None
    for consumer in lookup_all(name, session, registry):
        kind = _kind(consumer, name)
        if kind is NameKind.FILE and not has_file:
            continue
        if kind not in kinds:
            kinds.append(kind)
    if NameKind.FILE not in kinds and has_file:
        kinds.append(NameKind.FILE)
    return kinds


def locations(
    name: str,
    session: SessionState,
    registry: MountRegistry,
    all_mode: bool,
    drop: NameKind | None = None,
) -> list[NameKind]:
    """The kinds to report for one name: hide a layer, then take the top.

    Hiding is a filter over the layer list, never an edit to the
    session, and it runs before the winner is picked. That order is
    what keeps the winner honest: ``type -f`` reports the layer under a
    shadowing function, where filtering afterwards would report nothing
    at all.

    Args:
        name (str): the operand word.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry.
        all_mode (bool): report every layer instead of the winner only.
        drop (NameKind | None): a layer this caller does not resolve.
    """
    kinds = classify_all(name, session, registry)
    if drop is not None:
        kinds = [kind for kind in kinds if kind is not drop]
    return kinds if all_mode else kinds[:1]


def program_file(name: str) -> str:
    """The path of a program's file, where PATH finds it.

    Args:
        name (str): the program name.
    """
    return f"{BIN_PREFIX}/{name}"


def describe(
    name: str, kind: NameKind, session: SessionState | None = None
) -> str:
    """Render the verbose line ``command -V`` and ``type`` print.

    A function's line is followed by its body as ``declare -f`` prints it.

    Args:
        name (str): the operand word.
        kind (NameKind): the classification.
        session (SessionState | None): shell session, needed to read an
            alias's value and a function's body; every other kind renders
            from the name alone.
    """
    if kind is NameKind.ALIAS and session is not None:
        return f"{name} is aliased to `{session.aliases[name]}'"
    if (
        kind is NameKind.FUNCTION
        and session is not None
        and name in session.functions
    ):
        return (
            f"{name} is a function\n"
            f"{stored_function_text(name, session.functions[name])}"
        )
    if kind is NameKind.FILE:
        return f"{name} is {program_file(name)}"
    return f"{name} is {DESCRIPTIONS[kind]}"
