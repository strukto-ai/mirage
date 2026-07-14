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

from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)

SPECS: dict[str, CommandSpec] = {
    'python':
    CommandSpec(
        options=(Option(short="-c", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'python3':
    CommandSpec(
        options=(Option(short="-c", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'mktemp':
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-p", value_kind=OperandKind.TEXT),
            Option(short="-t"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
    ),
    'bc':
    CommandSpec(
        description="Arbitrary precision calculator language.",
        options=(
            Option(short="-l", description="Load the standard math library."),
            Option(short="-q", description="Suppress the welcome banner."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'expr':
    CommandSpec(
        description="Evaluate expressions.",
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'history':
    CommandSpec(
        description="Show command history for the session.",
        options=(
            Option(short="-c", description="Clear the command history."),
            Option(short="-d",
                   value_kind=OperandKind.TEXT,
                   description=("Delete the entry at the given position; "
                                "negative counts back from the end.")),
            Option(short="-s",
                   description=("Append the args to the history as a "
                                "single entry without executing them.")),
            Option(short="-p",
                   description="Print the args without storing them."),
            Option(short="-a", description="Accepted no-op (always synced)."),
            Option(short="-r", description="Accepted no-op (always synced)."),
            Option(short="-w", description="Accepted no-op (always synced)."),
            Option(short="-n", description="Accepted no-op (always synced)."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'date':
    CommandSpec(
        description="Print or set the system date and time.",
        options=(
            Option(
                short="-d",
                value_kind=OperandKind.TEXT,
                description=("Display the time described by the given "
                             "date string."),
            ),
            Option(short="-u",
                   description="Use Coordinated Universal Time (UTC)."),
            Option(short="-I", description="Output date in ISO 8601 format."),
            Option(short="-R",
                   description="Output date in RFC 5322 email format."),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
    ),
    'sleep':
    CommandSpec(
        description="Delay for a specified amount of time.",
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'bash':
    CommandSpec(
        description=("Run a command string through Mirage's shell. "
                     "Only `-c` is meaningful; other flags are accepted "
                     "and ignored. `bash` and `sh` are aliases."),
        options=(
            Option(
                short="-c",
                value_kind=OperandKind.TEXT,
                description=("Read commands from the next argument "
                             "and execute them."),
            ),
            Option(
                short="-s",
                description=("Read commands from stdin instead of "
                             "from an argument."),
            ),
            Option(short="-l",
                   description=("(Ignored) Login shell. Mirage does "
                                "not source profile files.")),
            Option(short="-i",
                   description=("(Ignored) Interactive flag. Mirage "
                                "shells are non-interactive.")),
            Option(short="-e", description="(Ignored) Exit on first error."),
            Option(short="-u",
                   description="(Ignored) Treat unset variables as errors."),
            Option(short="-x",
                   description="(Ignored) Print commands as they execute."),
            Option(long="--login", description="(Ignored) Login shell."),
            Option(long="--norc", description="(Ignored) Skip rc files."),
            Option(long="--noprofile",
                   description="(Ignored) Skip profile files."),
            Option(long="--posix",
                   description="(Ignored) POSIX-conformant mode."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
}
