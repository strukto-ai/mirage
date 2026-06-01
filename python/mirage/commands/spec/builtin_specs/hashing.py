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
    'md5':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    'diff':
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-w"),
            Option(short="-b"),
            Option(short="-e"),
            Option(short="-u"),
            Option(short="-q"),
            Option(short="-r"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'base64':
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-D"),
            Option(short="-w", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'sha256sum':
    CommandSpec(
        options=(Option(short="-c"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'xxd':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-p"),
            Option(short="-l", value_kind=OperandKind.TEXT),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-g", value_kind=OperandKind.TEXT),
            Option(short="-u"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'patch':
    CommandSpec(
        options=(
            Option(short="-p", value_kind=OperandKind.TEXT),
            Option(short="-R"),
            Option(short="-i", value_kind=OperandKind.PATH),
            Option(short="-N"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'cmp':
    CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-s"),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-b"),
            Option(short="-i", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'iconv':
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-c"),
            Option(short="-o", value_kind=OperandKind.PATH),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
