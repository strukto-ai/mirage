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
    'cat':
    CommandSpec(
        options=(
            Option(short="-n", long="--number"),
            Option(short="-b", long="--number-nonblank"),
            Option(short="-E", long="--show-ends"),
            Option(short="-T", long="--show-tabs"),
            Option(short="-v", long="--show-nonprinting"),
            Option(short="-e"),
            Option(short="-t"),
            Option(short="-A", long="--show-all"),
            Option(short="-s", long="--squeeze-blank"),
            Option(short="-u"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'head':
    CommandSpec(
        options=(
            Option(short="-n",
                   long="--lines",
                   value_kind=OperandKind.TEXT,
                   numeric_shorthand=True),
            Option(short="-c", long="--bytes", value_kind=OperandKind.TEXT),
            Option(short="-q", long="--quiet"),
            Option(long="--silent"),
            Option(short="-v", long="--verbose"),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'tail':
    CommandSpec(
        options=(
            Option(short="-n",
                   value_kind=OperandKind.TEXT,
                   numeric_shorthand=True),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-q"),
            Option(short="-v"),
            Option(short="-f", long="--follow"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'nl':
    CommandSpec(
        options=(
            Option(short="-b",
                   long="--body-numbering",
                   value_kind=OperandKind.TEXT),
            Option(short="-d",
                   long="--section-delimiter",
                   value_kind=OperandKind.TEXT),
            Option(short="-f",
                   long="--footer-numbering",
                   value_kind=OperandKind.TEXT),
            Option(short="-h",
                   long="--header-numbering",
                   value_kind=OperandKind.TEXT),
            Option(short="-l",
                   long="--join-blank-lines",
                   value_kind=OperandKind.TEXT),
            Option(short="-n",
                   long="--number-format",
                   value_kind=OperandKind.TEXT),
            Option(short="-p", long="--no-renumber"),
            Option(short="-v",
                   long="--starting-line-number",
                   value_kind=OperandKind.TEXT),
            Option(short="-i",
                   long="--line-increment",
                   value_kind=OperandKind.TEXT),
            Option(short="-w",
                   long="--number-width",
                   value_kind=OperandKind.TEXT),
            Option(short="-s",
                   long="--number-separator",
                   value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'tac':
    CommandSpec(
        options=(
            Option(short="-b", long="--before"),
            Option(short="-r", long="--regex"),
            Option(short="-s", long="--separator",
                   value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'column':
    CommandSpec(
        options=(
            Option(short="-t"),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-o", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'fold':
    CommandSpec(
        options=(
            Option(short="-w", long="--width", value_kind=OperandKind.TEXT),
            Option(short="-s", long="--spaces"),
            Option(short="-b", long="--bytes"),
            Option(short="-c", long="--characters"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'fmt':
    CommandSpec(
        options=(
            Option(short="-w", long="--width", value_kind=OperandKind.TEXT),
            Option(short="-g", long="--goal", value_kind=OperandKind.TEXT),
            Option(short="-c", long="--crown-margin"),
            Option(short="-p", long="--prefix", value_kind=OperandKind.TEXT),
            Option(short="-s", long="--split-only"),
            Option(short="-t", long="--tagged-paragraph"),
            Option(short="-u", long="--uniform-spacing"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'rev':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    'expand':
    CommandSpec(
        options=(
            Option(short="-t", long="--tabs", value_kind=OperandKind.TEXT),
            Option(short="-i", long="--initial"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'unexpand':
    CommandSpec(
        options=(
            Option(short="-t", long="--tabs", value_kind=OperandKind.TEXT),
            Option(short="-a", long="--all"),
            Option(long="--first-only"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'look':
    CommandSpec(
        options=(Option(short="-f"), ),
        positional=(
            Operand(kind=OperandKind.TEXT),
            Operand(kind=OperandKind.PATH),
        ),
    ),
    'od':
    CommandSpec(
        options=(
            Option(short="-A",
                   long="--address-radix",
                   value_kind=OperandKind.TEXT),
            Option(short="-j",
                   long="--skip-bytes",
                   value_kind=OperandKind.TEXT),
            Option(short="-N",
                   long="--read-bytes",
                   value_kind=OperandKind.TEXT),
            Option(short="-t",
                   long="--format",
                   value_kind=OperandKind.TEXT,
                   repeatable=True),
        ),
        positional=(Operand(kind=OperandKind.PATH), ),
    ),
}
