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
    "ls": CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-b", long="--escape"),
            Option(short="-a", long="--all"),
            Option(short="-A", long="--almost-all"),
            Option(short="-h", long="--human-readable"),
            Option(short="-t"),
            Option(short="-S"),
            Option(short="-X"),
            Option(short="-v"),
            Option(short="-U"),
            Option(long="--sort", type="str"),
            Option(short="-c"),
            Option(short="-u"),
            Option(long="--time", type="str"),
            Option(long="--time-style", type="str"),
            Option(short="-r", long="--reverse"),
            Option(short="-1"),
            Option(short="-R", long="--recursive"),
            Option(short="-d", long="--directory"),
            # -F classifies outright; only the long form takes GNU's WHEN.
            Option(
                short="-F",
                long="--classify",
                type="str",
                value_optional=True,
                short_value=False,
            ),
            Option(short="-p"),
            Option(long="--file-type"),
            Option(long="--indicator-style", type="str"),
            Option(short="-L", long="--dereference"),
            Option(short="-H", long="--dereference-command-line"),
            Option(long="--dereference-command-line-symlink-to-dir"),
            Option(short="-g"),
            Option(short="-o"),
            Option(short="-n", long="--numeric-uid-gid"),
            Option(short="-i", long="--inode"),
            # Accepted no-op like grep --color (#471).
            Option(long="--color", type="str", value_optional=True),
            Option(long="--group-directories-first"),
            Option(long="--block-size", type="str"),
            Option(long="--hyperlink", type="str", value_optional=True),
            Option(short="-Z", long="--context"),
        ),
        rest=Operand(type="path"),
    ),
    "stat": CommandSpec(
        options=(
            Option(short="-c", long="--format", type="str"),
            Option(short="-f", long="--file-system"),
            Option(short="-L", long="--dereference"),
        ),
        rest=Operand(type="path"),
    ),
    "pwd": CommandSpec(
        options=(
            Option(short="-P"),
            Option(short="-L"),
        ),
        rest=Operand(type="str"),
    ),
    "find": CommandSpec(
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
            Option(short="-xdev"),
            Option(short="-mount"),
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
    "tree": CommandSpec(
        options=(
            Option(short="-a"),
            Option(short="-L", type="str"),
            Option(short="-I", type="str"),
            Option(short="-d"),
            Option(short="-P", type="str"),
            Option(short="-x"),
        ),
        rest=Operand(type="path"),
    ),
    "du": CommandSpec(
        options=(
            Option(short="-h"),
            Option(short="-s"),
            Option(short="-a"),
            Option(short="-d", long="--max-depth", type="str"),
            Option(short="-c"),
            Option(short="-L"),
            Option(short="-P"),
            Option(short="-S", long="--separate-dirs"),
            Option(short="-x", long="--one-file-system"),
        ),
        rest=Operand(type="path"),
    ),
    "df": CommandSpec(
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
    "file": CommandSpec(
        options=(
            Option(short="-b"),
            Option(short="-i"),
            Option(short="-L"),
            Option(short="-h"),
        ),
        rest=Operand(type="path"),
    ),
}
