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

from mirage.commands.spec.types import CommandSpec, Operand, Option

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
            Option(short="-L"),
            # Accepted no-op like grep --color (#471).
            Option(long="--color", type="str", value_optional=True),
        ),
        rest=Operand(type="path"),
    ),
    'stat':
    CommandSpec(
        options=(
            Option(short="-c", type="str"),
            Option(short="-f", type="str"),
            Option(short="-L"),
        ),
        rest=Operand(type="path"),
    ),
    'pwd':
    CommandSpec(
        options=(
            Option(short="-P"),
            Option(short="-L"),
        ),
        rest=Operand(type="str"),
    ),
    'find':
    CommandSpec(
        options=(
            Option(short="-name", type="str", multiple=True),
            Option(short="-type", type="str", multiple=True),
            Option(short="-maxdepth", type="str", multiple=True),
            Option(short="-size", type="str", multiple=True),
            Option(short="-mtime", type="str", multiple=True),
            Option(short="-iname", type="str", multiple=True),
            Option(short="-path", type="str", multiple=True),
            Option(short="-mindepth", type="str", multiple=True),
            Option(short="-printf", type="str", multiple=True),
            Option(short="-newer", type="str", multiple=True),
            Option(short="-newermt", type="str", multiple=True),
            # `-exec CMD ARGS... ;` is consumed by the expression parser,
            # never by this spec: the classifier keeps its words as text
            # (`exec_spans`), and there is no argparse shape for an
            # option whose argument is a program.
            # GNU find's link policy: -P (no follow) is the default, -H
            # follows only the start point, -L follows everything.
            Option(short="-P"),
            Option(short="-H"),
            Option(short="-L"),
            Option(short="-print"),
            Option(short="-print0"),
            Option(short="-delete"),
            Option(short="-depth"),
            Option(short="-prune"),
            Option(short="-ls"),
            Option(short="-empty"),
            Option(short="-o"),
            Option(short="-or"),
            Option(short="-a"),
            Option(short="-and"),
            Option(short="-not"),
        ),
        rest=Operand(type="path"),
        # `!` is GNU's negation, spelled without a leading dash, so the
        # rest slot's PATH kind would read it as a start point. It joins
        # the parens here rather than becoming an Option: an option is
        # matched by spelling and `-not` already covers that half, while
        # these three are grammar the expression parser consumes.
        ignore_tokens=frozenset({"(", ")", "!"}),
    ),
    'tree':
    CommandSpec(
        options=(
            Option(short="-a"),
            Option(short="-L", type="str"),
            Option(short="-I", type="str"),
            Option(short="-d"),
            Option(short="-P", type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'du':
    CommandSpec(
        options=(
            Option(short="-h"),
            Option(short="-s"),
            Option(short="-a"),
            Option(short="-d", long="--max-depth", type="str"),
            Option(short="-c"),
            Option(short="-L"),
            Option(short="-P"),
            Option(short="-S", long="--separate-dirs"),
        ),
        rest=Operand(type="path"),
    ),
    'df':
    CommandSpec(
        options=(
            Option(short="-h"),
            Option(short="-H"),
            Option(short="-k"),
            Option(short="-i"),
            Option(short="-a"),
            Option(short="-T"),
            Option(short="-P"),
            Option(short="-B", type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'file':
    CommandSpec(
        options=(
            Option(short="-b"),
            Option(short="-i"),
            Option(short="-L"),
            Option(short="-h"),
        ),
        rest=Operand(type="path"),
    ),
}
