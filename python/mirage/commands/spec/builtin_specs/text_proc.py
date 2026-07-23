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
    'wc':
    CommandSpec(
        options=(
            Option(short="-l", long="--lines"),
            Option(short="-w", long="--words"),
            Option(short="-c", long="--bytes"),
            Option(short="-m", long="--chars"),
            Option(short="-L", long="--max-line-length"),
            Option(long="--total", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'sort':
    CommandSpec(
        options=(
            Option(short="-r", long="--reverse"),
            Option(short="-n", long="--numeric-sort"),
            Option(short="-u", long="--unique"),
            Option(short="-f", long="--ignore-case"),
            Option(short="-k",
                   long="--key",
                   value_kind=OperandKind.TEXT,
                   repeatable=True),
            Option(short="-t",
                   long="--field-separator",
                   value_kind=OperandKind.TEXT),
            Option(short="-h", long="--human-numeric-sort"),
            Option(short="-V", long="--version-sort"),
            Option(short="-s", long="--stable"),
            Option(short="-M", long="--month-sort"),
            Option(short="-b", long="--ignore-leading-blanks"),
            Option(short="-c"),
            Option(long="--check",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
            Option(short="-d", long="--dictionary-order"),
            Option(short="-g", long="--general-numeric-sort"),
            Option(short="-i", long="--ignore-nonprinting"),
            Option(short="-m", long="--merge"),
            Option(short="-o", long="--output", value_kind=OperandKind.PATH),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'uniq':
    CommandSpec(
        options=(
            Option(short="-c", long="--count"),
            Option(short="-d", long="--repeated"),
            Option(short="-D"),
            Option(long="--all-repeated",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
            Option(long="--group",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
            Option(short="-u", long="--unique"),
            Option(short="-f",
                   long="--skip-fields",
                   value_kind=OperandKind.TEXT),
            Option(short="-s",
                   long="--skip-chars",
                   value_kind=OperandKind.TEXT),
            Option(short="-i", long="--ignore-case"),
            Option(short="-w",
                   long="--check-chars",
                   value_kind=OperandKind.TEXT),
            Option(short="-z", long="--zero-terminated"),
        ),
        positional=(
            Operand(kind=OperandKind.PATH),
            Operand(kind=OperandKind.PATH),
        ),
    ),
    'cut':
    CommandSpec(
        options=(
            Option(short="-f", long="--fields", value_kind=OperandKind.TEXT),
            Option(short="-F", value_kind=OperandKind.TEXT),
            Option(short="-d", long="--delimiter",
                   value_kind=OperandKind.TEXT),
            Option(short="-c",
                   long="--characters",
                   value_kind=OperandKind.TEXT),
            Option(short="-b", long="--bytes", value_kind=OperandKind.TEXT),
            Option(short="-n", long="--no-partial"),
            Option(long="--complement"),
            Option(short="-s", long="--only-delimited"),
            Option(short="-O", value_kind=OperandKind.TEXT),
            Option(long="--output-delimiter", value_kind=OperandKind.TEXT),
            Option(short="-w"),
            Option(long="--whitespace-delimited",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'echo':
    CommandSpec(
        options=(Option(short="-n"), Option(short="-e")),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'tee':
    CommandSpec(
        options=(
            Option(short="-a", long="--append"),
            Option(short="-i", long="--ignore-interrupts"),
            Option(short="-p"),
            Option(long="--output-error",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'tr':
    CommandSpec(
        options=(
            Option(short="-d", long="--delete"),
            Option(short="-s", long="--squeeze-repeats"),
            Option(short="-c", long="--complement"),
            Option(short="-C"),
            Option(short="-t", long="--truncate-set1"),
        ),
        positional=(
            Operand(kind=OperandKind.TEXT),
            Operand(kind=OperandKind.TEXT),
        ),
    ),
    'paste':
    CommandSpec(
        options=(
            Option(short="-d", value_kind=OperandKind.TEXT),
            Option(short="-s"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'printf':
    CommandSpec(
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'seq':
    CommandSpec(
        description="Print a sequence of numbers.",
        options=(
            Option(
                short="-s",
                value_kind=OperandKind.TEXT,
                description=("Use the given string as separator "
                             "between numbers."),
            ),
            Option(short="-w",
                   description="Pad numbers with zeros to equal width."),
            Option(
                short="-f",
                value_kind=OperandKind.TEXT,
                description=("Format each number with a printf-style "
                             "format string."),
            ),
        ),
        positional=(
            Operand(kind=OperandKind.TEXT),
            Operand(kind=OperandKind.TEXT),
            Operand(kind=OperandKind.TEXT),
        ),
    ),
    'split':
    CommandSpec(
        options=(
            Option(short="-l", value_kind=OperandKind.TEXT),
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-d"),
            Option(short="-a", value_kind=OperandKind.TEXT),
        ),
        positional=(
            Operand(kind=OperandKind.PATH),
            Operand(kind=OperandKind.PATH),
        ),
    ),
    'shuf':
    CommandSpec(
        options=(
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-e"),
            Option(short="-z"),
            Option(short="-r"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'comm':
    CommandSpec(
        options=(
            Option(short="-1"),
            Option(short="-2"),
            Option(short="-3"),
            Option(long="--check-order"),
            Option(long="--nocheck-order"),
        ),
        positional=(
            Operand(kind=OperandKind.PATH),
            Operand(kind=OperandKind.PATH),
        ),
    ),
    'csplit':
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.PATH),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-k"),
            Option(short="-s"),
        ),
        positional=(Operand(kind=OperandKind.PATH), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'tsort':
    CommandSpec(positional=(Operand(kind=OperandKind.PATH), )),
    'join':
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-1", value_kind=OperandKind.TEXT),
            Option(short="-2", value_kind=OperandKind.TEXT),
            Option(short="-a", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-e", value_kind=OperandKind.TEXT),
            Option(short="-o", value_kind=OperandKind.TEXT),
        ),
        positional=(
            Operand(kind=OperandKind.PATH),
            Operand(kind=OperandKind.PATH),
        ),
    ),
}
