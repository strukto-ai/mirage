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
    'ls':
    CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-a"),
            Option(short="-A"),
            Option(short="-h"),
            Option(short="-t"),
            Option(short="-S"),
            Option(short="-r"),
            Option(short="-1"),
            Option(short="-R"),
            Option(short="-d"),
            Option(short="-F"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'stat':
    CommandSpec(
        options=(
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-f", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'pwd':
    CommandSpec(
        options=(
            Option(short="-P"),
            Option(short="-L"),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'find':
    CommandSpec(
        options=(
            Option(short="-name", value_kind=OperandKind.TEXT),
            Option(short="-type", value_kind=OperandKind.TEXT),
            Option(short="-maxdepth", value_kind=OperandKind.TEXT),
            Option(short="-size", value_kind=OperandKind.TEXT),
            Option(short="-mtime", value_kind=OperandKind.TEXT),
            Option(short="-iname", value_kind=OperandKind.TEXT),
            Option(short="-path", value_kind=OperandKind.TEXT),
            Option(short="-mindepth", value_kind=OperandKind.TEXT),
            Option(short="-print"),
            Option(short="-print0"),
            Option(short="-delete"),
            Option(short="-prune"),
            Option(short="-ls"),
            Option(short="-empty"),
            Option(short="-o"),
            Option(short="-or"),
            Option(short="-a"),
            Option(short="-and"),
            Option(short="-not"),
        ),
        rest=Operand(kind=OperandKind.PATH),
        ignore_tokens=frozenset({"(", ")"}),
    ),
    'tree':
    CommandSpec(
        options=(
            Option(short="-a"),
            Option(short="-L", value_kind=OperandKind.TEXT),
            Option(short="-I", value_kind=OperandKind.TEXT),
            Option(short="-d"),
            Option(short="-P", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'du':
    CommandSpec(
        options=(
            Option(short="-h"),
            Option(short="-s"),
            Option(short="-a"),
            Option(long="--max-depth", value_kind=OperandKind.TEXT),
            Option(short="-c"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'file':
    CommandSpec(
        options=(
            Option(short="-b"),
            Option(short="-i"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
