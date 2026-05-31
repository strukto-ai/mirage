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
    'tar':
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-x"),
            Option(short="-t"),
            Option(short="-z"),
            Option(short="-j"),
            Option(short="-J"),
            Option(short="-v"),
            Option(short="-f", value_kind=OperandKind.PATH),
            Option(short="-C", value_kind=OperandKind.PATH),
            Option(long="--strip-components", value_kind=OperandKind.TEXT),
            Option(long="--exclude", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'gzip':
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-k"),
            Option(short="-f"),
            Option(short="-c"),
            Option(short="-1"),
            Option(short="-2"),
            Option(short="-3"),
            Option(short="-4"),
            Option(short="-5"),
            Option(short="-6"),
            Option(short="-7"),
            Option(short="-8"),
            Option(short="-9"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'gunzip':
    CommandSpec(
        options=(
            Option(short="-k"),
            Option(short="-f"),
            Option(short="-c"),
            Option(short="-t"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'zip':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-j"),
            Option(short="-q"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'unzip':
    CommandSpec(
        options=(
            Option(short="-o"),
            Option(short="-l"),
            Option(short="-d", value_kind=OperandKind.PATH),
            Option(short="-q"),
            Option(short="-p"),
            Option(short="-t"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'zcat':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
}
