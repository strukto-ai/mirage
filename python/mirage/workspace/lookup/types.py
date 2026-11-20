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

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto
from typing import TYPE_CHECKING, ClassVar, Literal, TypeAlias

if TYPE_CHECKING:
    from mirage.runtime.types import RuntimeIdentity
    from mirage.workspace.cli.types import CLIInstall


class Consumer(Enum):
    """The layer that consumes a command: a command belongs to the layer
    whose state it mutates.

    The verdict drives both the dispatch branch and the word policy:
    SESSION / NAMESPACE / FUNCTION words are shell-resolved (bash
    contract: programs receive matches, never patterns); MOUNT words
    keep glob patterns intact for backend pushdown; UNKNOWN words are
    never resolved (the command fails, backend I/O for it is waste).
    """

    SESSION = auto()
    NAMESPACE = auto()
    FUNCTION = auto()
    CLI = auto()
    MOUNT = auto()
    EXTERNAL = auto()
    UNKNOWN = auto()


@dataclass(frozen=True, slots=True)
class ExternalTarget:
    runtime: RuntimeIdentity | None
    kind: ClassVar[Consumer] = Consumer.EXTERNAL


@dataclass(frozen=True, slots=True)
class FunctionTarget:
    body: str
    kind: ClassVar[Consumer] = Consumer.FUNCTION


@dataclass(frozen=True, slots=True)
class CliTarget:
    install: CLIInstall
    kind: ClassVar[Consumer] = Consumer.CLI


CommandTarget: TypeAlias = (
    ExternalTarget
    | FunctionTarget
    | CliTarget
    | Literal[
        Consumer.SESSION, Consumer.NAMESPACE, Consumer.MOUNT, Consumer.UNKNOWN
    ]
)


# CLI rides with the shell consumers for word policy: an installed CLI
# is a program, and bash hands programs glob matches, never patterns.
SHELL_CONSUMERS = frozenset(
    {
        Consumer.SESSION,
        Consumer.NAMESPACE,
        Consumer.FUNCTION,
        Consumer.CLI,
        Consumer.EXTERNAL,
    }
)


class WordPolicy(Enum):
    """How a command's words are resolved, derived from its consumer.

    SHELL: the shell resolves globs before the command runs and spec
    hints are ignored; bash expands `echo /data/*.txt` no matter what
    echo does with its arguments. NAMESPACE and FUNCTION consumers get
    the same treatment (programs receive matches, never patterns).

    MOUNT: the command's spec classifies words (TEXT stays literal,
    PATH resolves) and glob PathSpecs stay intact for backend pushdown.
    UNKNOWN names also land here: nothing resolves their words, the
    command fails before any backend I/O.
    """

    SHELL = auto()
    MOUNT = auto()


def word_policy(consumer: Consumer) -> WordPolicy:
    """Map a consumer to its word policy.

    Args:
        consumer (Consumer): the layer that consumes the command.
    """
    if consumer in SHELL_CONSUMERS:
        return WordPolicy.SHELL
    return WordPolicy.MOUNT


@dataclass(frozen=True)
class WrapperOptions:
    """A program-running wrapper's option grammar and its answers.

    Args:
        values (tuple[str, ...]): options that take a value.
        flags (tuple[str, ...]): options that take none.
        stops (tuple[str, ...]): options after which it runs no program.
        status (int): its exit status for a bad option.
        missing (str): its stderr for a program it cannot run, ``{}``
            the program's name.
    """

    values: tuple[str, ...]
    flags: tuple[str, ...]
    stops: tuple[str, ...]
    status: int
    missing: str


@dataclass(frozen=True, slots=True)
class WrapperAnswer:
    """What a wrapper with no program for Mirage to run comes to.

    Args:
        exit_code (int): its status.
        stdout (str): what it prints.
        stderr (str): what it reports.
        runs_from (int | None): where the words it runs start, which
            then go through the shell.
    """

    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    runs_from: int | None = None


class ProgramLookup(Enum):
    """What a command asks about a program it names: ``PROGRAM_LOOKUPS``
    marks each command and option that asks one.

    PATH prints the program's file (``which perl``, ``type -P perl``,
    ``command -v perl``). KIND says what the name is (``type perl``,
    ``type -t perl``, ``command -V perl``). EXISTS checks that the
    program can run before running it, so a missing one gets the
    command's own error (``timeout 5 perl``, ``xargs perl``,
    ``exec perl``).

    Whatever would run the name on the line answers. Mirage answers a
    name it runs itself (``grep``, a CLI, a builtin, a function), with
    its file under ``/usr/bin``. Any other name is asked of the one
    machine that would run it: a machine that takes the name by name,
    else the first that takes ``@external``, as the line places it.
    That machine runs the command the agent typed (``which perl``; a
    ``type`` or ``command`` in its bash, whose builtins they are) and
    its answer is printed. With no machine to run the name, it is not
    found and no machine is asked. A path the machine prints is kept
    where Mirage shows that same path as that machine's own file; any
    other becomes the name's ``/usr/bin`` file, which runs the name on
    that machine all the same, so ``$(which NAME)`` runs what ``NAME``
    runs.
    """

    PATH = "path"
    KIND = "kind"
    EXISTS = "exists"


@dataclass(frozen=True, slots=True)
class MachineAnswer:
    """What the machine that runs a name answered a lookup of it.

    Args:
        found (bool): the machine found the name.
        lines (tuple[str, ...]): what it printed, a line each, with a
            path Mirage does not show at that same path already turned
            into the name's ``/usr/bin`` file.
    """

    found: bool
    lines: tuple[str, ...] = ()
