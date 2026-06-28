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
    'grep':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-i"),
            Option(short="-I"),
            Option(short="-v"),
            Option(short="-n"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-F"),
            Option(short="-E"),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-A", value_kind=OperandKind.TEXT),
            Option(short="-B", value_kind=OperandKind.TEXT),
            Option(short="-C", value_kind=OperandKind.TEXT),
            Option(short="-e", value_kind=OperandKind.TEXT, repeatable=True),
            Option(short="-f", value_kind=OperandKind.PATH, repeatable=True),
        ),
        positional=(Operand(kind=OperandKind.TEXT,
                            provided_by=("-e", "-f")), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'search':
    CommandSpec(
        options=(
            Option(long="--method", value_kind=OperandKind.TEXT),
            Option(long="--top-k", value_kind=OperandKind.TEXT),
            Option(long="--threshold", value_kind=OperandKind.TEXT),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'rg':
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-v"),
            Option(short="-n"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-F"),
            Option(short="-o"),
            Option(short="-e", value_kind=OperandKind.TEXT, repeatable=True),
            Option(short="-f", value_kind=OperandKind.PATH, repeatable=True),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-A", value_kind=OperandKind.TEXT),
            Option(short="-B", value_kind=OperandKind.TEXT),
            Option(short="-C", value_kind=OperandKind.TEXT),
            Option(long="--hidden"),
            Option(long="--type", value_kind=OperandKind.TEXT),
            Option(long="--glob", value_kind=OperandKind.TEXT),
        ),
        positional=(Operand(kind=OperandKind.TEXT,
                            provided_by=("-e", "-f")), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'sed':
    CommandSpec(
        options=(
            Option(short="-i"),
            # -e takes a script and may repeat; joined with newlines.
            Option(short="-e", value_kind=OperandKind.TEXT, repeatable=True),
            Option(short="-n"),
            Option(short="-E"),
            Option(short="-r"),
        ),
        positional=(Operand(kind=OperandKind.TEXT, provided_by=("-e", )), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'jq':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-c"),
            Option(short="-s"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'awk':
    CommandSpec(
        options=(
            Option(short="-F", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-f", value_kind=OperandKind.PATH),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'strings':
    CommandSpec(
        options=(Option(short="-n", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'zgrep':
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-n"),
            Option(short="-v"),
            Option(short="-e", value_kind=OperandKind.TEXT, repeatable=True),
            Option(short="-f", value_kind=OperandKind.PATH, repeatable=True),
            Option(short="-E"),
            Option(short="-F"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-w"),
        ),
        positional=(Operand(kind=OperandKind.TEXT,
                            provided_by=("-e", "-f")), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
