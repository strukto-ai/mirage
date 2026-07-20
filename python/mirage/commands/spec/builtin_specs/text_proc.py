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
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-c"),
            Option(short="-m"),
            Option(short="-L"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'sort':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-n"),
            Option(short="-u"),
            Option(short="-f"),
            Option(short="-k", value_kind=OperandKind.TEXT),
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-h"),
            Option(short="-V"),
            Option(short="-s"),
            Option(short="-M"),
            Option(short="-b"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'uniq':
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-d"),
            Option(short="-u"),
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-i"),
            Option(short="-w", value_kind=OperandKind.TEXT),
        ),
        positional=(
            Operand(kind=OperandKind.PATH),
            Operand(kind=OperandKind.PATH),
        ),
    ),
    'cut':
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-d", value_kind=OperandKind.TEXT),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(long="--complement"),
            Option(short="-z"),
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
        options=(Option(short="-a"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'tr':
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-s"),
            Option(short="-c"),
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
