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
    'mkdir':
    CommandSpec(
        options=(Option(short="-p"), Option(short="-v")),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'touch':
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-r", value_kind=OperandKind.PATH),
            Option(short="-d", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'cp':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-a"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'mv':
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'rm':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-f"),
            Option(short="-v"),
            Option(short="-d"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'basename':
    CommandSpec(rest=Operand(kind=OperandKind.TEXT)),
    'dirname':
    CommandSpec(rest=Operand(kind=OperandKind.TEXT)),
    'realpath':
    CommandSpec(
        options=(
            Option(short="-e"),
            Option(short="-m"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'readlink':
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-e"),
            Option(short="-m"),
            Option(short="-n"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'ln':
    CommandSpec(
        options=(
            Option(short="-s"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
