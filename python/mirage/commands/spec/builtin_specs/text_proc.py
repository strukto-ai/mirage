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
    'wc':
    CommandSpec(
        options=(
            Option(short="-l", long="--lines"),
            Option(short="-w", long="--words"),
            Option(short="-c", long="--bytes"),
            Option(short="-m", long="--chars"),
            Option(short="-L", long="--max-line-length"),
            Option(long="--total", type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'sort':
    CommandSpec(
        options=(
            Option(short="-r", long="--reverse"),
            Option(short="-n", long="--numeric-sort"),
            Option(short="-u", long="--unique"),
            Option(short="-f", long="--ignore-case"),
            Option(short="-k", long="--key", type="str", multiple=True),
            Option(short="-t", long="--field-separator", type="str"),
            Option(short="-h", long="--human-numeric-sort"),
            Option(short="-V", long="--version-sort"),
            Option(short="-s", long="--stable"),
            Option(short="-M", long="--month-sort"),
            Option(short="-b", long="--ignore-leading-blanks"),
            Option(short="-c"),
            Option(long="--check", type="str", value_optional=True),
            Option(short="-d", long="--dictionary-order"),
            Option(short="-g", long="--general-numeric-sort"),
            Option(short="-i", long="--ignore-nonprinting"),
            Option(short="-m", long="--merge"),
            Option(short="-o", long="--output", type="path"),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(type="path"),
    ),
    'uniq':
    CommandSpec(
        options=(
            Option(short="-c", long="--count"),
            Option(short="-d", long="--repeated"),
            Option(short="-D"),
            Option(long="--all-repeated", type="str", value_optional=True),
            Option(long="--group", type="str", value_optional=True),
            Option(short="-u", long="--unique"),
            Option(short="-f", long="--skip-fields", type="str"),
            Option(short="-s", long="--skip-chars", type="str"),
            Option(short="-i", long="--ignore-case"),
            Option(short="-w", long="--check-chars", type="str"),
            Option(short="-z", long="--zero-terminated"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    'cut':
    CommandSpec(
        options=(
            Option(short="-f", long="--fields", type="str"),
            Option(short="-F", type="str"),
            Option(short="-d", long="--delimiter", type="str"),
            Option(short="-c", long="--characters", type="str"),
            Option(short="-b", long="--bytes", type="str"),
            Option(short="-n", long="--no-partial"),
            Option(long="--complement"),
            Option(short="-s", long="--only-delimited"),
            Option(short="-O", type="str"),
            Option(long="--output-delimiter", type="str"),
            Option(short="-w"),
            Option(long="--whitespace-delimited",
                   type="str",
                   value_optional=True),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(type="path"),
    ),
    'echo':
    CommandSpec(
        options=(Option(short="-n"), Option(short="-e")),
        rest=Operand(type="str"),
    ),
    'tee':
    CommandSpec(
        options=(
            Option(short="-a", long="--append"),
            Option(short="-i", long="--ignore-interrupts"),
            Option(short="-p"),
            Option(long="--output-error",
                   type="str",
                   value_optional=True,
                   choices=("warn", "warn-nopipe", "exit", "exit-nopipe")),
        ),
        rest=Operand(type="path"),
    ),
    'tr':
    CommandSpec(
        options=(
            Option(short="-d", long="--delete"),
            Option(short="-s", long="--squeeze-repeats"),
            Option(short="-c", long="--complement"),
            Option(short="-C"),
            Option(short="-t", long="--truncate-set1"),
        ),
        positional=(
            Operand(type="str"),
            Operand(type="str"),
        ),
    ),
    'paste':
    CommandSpec(
        options=(
            Option(short="-d", long="--delimiters", type="str"),
            Option(short="-s", long="--serial"),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(type="path"),
    ),
    'printf':
    CommandSpec(
        positional=(Operand(type="str"), ),
        rest=Operand(type="str"),
    ),
    'seq':
    CommandSpec(
        description="Print a sequence of numbers.",
        options=(
            Option(
                short="-s",
                type="str",
                description=("Use the given string as separator "
                             "between numbers."),
            ),
            Option(short="-w",
                   description="Pad numbers with zeros to equal width."),
            Option(
                short="-f",
                type="str",
                description=("Format each number with a printf-style "
                             "format string."),
            ),
        ),
        positional=(
            Operand(type="str"),
            Operand(type="str"),
            Operand(type="str"),
        ),
    ),
    'split':
    CommandSpec(
        options=(
            Option(short="-l", long="--lines", type="str"),
            Option(short="-b", long="--bytes", type="str"),
            Option(short="-n", long="--number", type="str"),
            Option(short="-d",
                   long="--numeric-suffixes",
                   type="str",
                   value_optional=True),
            Option(short="-x",
                   long="--hex-suffixes",
                   type="str",
                   value_optional=True),
            Option(short="-a", long="--suffix-length", type="str"),
            Option(long="--additional-suffix", type="str"),
            Option(short="-t", long="--separator", type="str"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    'shuf':
    CommandSpec(
        options=(
            Option(short="-n", long="--head-count", type="str"),
            Option(short="-e", long="--echo"),
            Option(short="-z", long="--zero-terminated"),
            Option(short="-r", long="--repeat"),
            Option(short="-i", long="--input-range", type="str"),
            Option(short="-o", long="--output", type="path"),
        ),
        rest=Operand(type="path"),
    ),
    'comm':
    CommandSpec(
        options=(
            Option(short="-1"),
            Option(short="-2"),
            Option(short="-3"),
            Option(long="--check-order"),
            Option(long="--nocheck-order"),
            Option(long="--output-delimiter", type="str"),
            Option(long="--total"),
            Option(short="-z", long="--zero-terminated"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    'csplit':
    CommandSpec(
        options=(
            Option(short="-f", long="--prefix", type="path"),
            Option(short="-n", long="--digits", type="str"),
            Option(short="-b", long="--suffix-format", type="str"),
            Option(short="-k", long="--keep-files"),
            Option(short="-s", long="--quiet"),
            Option(long="--silent"),
            Option(long="--suppress-matched"),
            Option(short="-z", long="--elide-empty-files"),
        ),
        positional=(Operand(type="path"), ),
        rest=Operand(type="str"),
    ),
    'tsort':
    CommandSpec(positional=(Operand(type="path"), )),
    'join':
    CommandSpec(
        options=(
            Option(short="-t", type="str"),
            Option(short="-1", type="str"),
            Option(short="-2", type="str"),
            Option(short="-a", type="str"),
            Option(short="-v", type="str"),
            Option(short="-e", type="str"),
            Option(short="-o", type="str"),
            Option(short="-i", long="--ignore-case"),
            Option(short="-j", type="str"),
            Option(short="-z", long="--zero-terminated"),
            Option(long="--check-order"),
            Option(long="--nocheck-order"),
            Option(long="--header"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    'numfmt':
    CommandSpec(
        options=(
            Option(long="--to", type="str"),
            Option(long="--from", type="str"),
            Option(long="--suffix", type="str"),
            Option(long="--grouping"),
        ),
        rest=Operand(type="str"),
    ),
}
