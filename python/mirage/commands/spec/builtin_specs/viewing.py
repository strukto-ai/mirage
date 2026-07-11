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
            Option(short="-n"),
            Option(short="-E"),
            Option(short="-T"),
            Option(short="-v"),
            Option(short="-e"),
            Option(short="-t"),
            Option(short="-A"),
            Option(short="-s"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'head':
    CommandSpec(
        options=(
            Option(short="-n",
                   value_kind=OperandKind.TEXT,
                   numeric_shorthand=True),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-q"),
            Option(short="-v"),
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
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-d", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-i", value_kind=OperandKind.TEXT),
            Option(short="-w", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'tac':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
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
            Option(short="-w", value_kind=OperandKind.TEXT),
            Option(short="-s"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'fmt':
    CommandSpec(
        options=(Option(short="-w", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'rev':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    'expand':
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-i"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'unexpand':
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-a"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'look':
    CommandSpec(
        options=(Option(short="-f"), ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
