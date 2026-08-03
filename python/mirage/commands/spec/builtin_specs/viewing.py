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

from mirage.commands.spec.types import (CommandSpec, Operand, ValueType,
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
        rest=Operand(type="path"),
    ),
    'head':
    CommandSpec(
        options=(
            Option(short="-n",
                   long="--lines",
                   type="str",
                   numeric_shorthand=True),
            Option(short="-c", long="--bytes", type="str"),
            Option(short="-q", long="--quiet"),
            Option(long="--silent"),
            Option(short="-v", long="--verbose"),
            Option(short="-z", long="--zero-terminated"),
        ),
        rest=Operand(type="path"),
    ),
    'tail':
    CommandSpec(
        options=(
            Option(short="-n",
                   type="str",
                   numeric_shorthand=True),
            Option(short="-c", type="str"),
            Option(short="-q"),
            Option(short="-v"),
            Option(short="-f", long="--follow"),
        ),
        rest=Operand(type="path"),
    ),
    'nl':
    CommandSpec(
        options=(
            Option(short="-b",
                   long="--body-numbering",
                   type="str"),
            Option(short="-d",
                   long="--section-delimiter",
                   type="str"),
            Option(short="-f",
                   long="--footer-numbering",
                   type="str"),
            Option(short="-h",
                   long="--header-numbering",
                   type="str"),
            Option(short="-l",
                   long="--join-blank-lines",
                   type="str"),
            Option(short="-n",
                   long="--number-format",
                   type="str"),
            Option(short="-p", long="--no-renumber"),
            Option(short="-v",
                   long="--starting-line-number",
                   type="str"),
            Option(short="-i",
                   long="--line-increment",
                   type="str"),
            Option(short="-w",
                   long="--number-width",
                   type="str"),
            Option(short="-s",
                   long="--number-separator",
                   type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'tac':
    CommandSpec(
        options=(
            Option(short="-b", long="--before"),
            Option(short="-r", long="--regex"),
            Option(short="-s", long="--separator",
                   type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'column':
    CommandSpec(
        options=(
            Option(short="-t"),
            Option(short="-s", type="str"),
            Option(short="-o", type="str"),
        ),
        rest=Operand(type="path"),
    ),
    'fold':
    CommandSpec(
        options=(
            Option(short="-w", long="--width", type="str"),
            Option(short="-s", long="--spaces"),
            Option(short="-b", long="--bytes"),
            Option(short="-c", long="--characters"),
        ),
        rest=Operand(type="path"),
    ),
    'fmt':
    CommandSpec(
        options=(
            Option(short="-w", long="--width", type="str"),
            Option(short="-g", long="--goal", type="str"),
            Option(short="-c", long="--crown-margin"),
            Option(short="-p", long="--prefix", type="str"),
            Option(short="-s", long="--split-only"),
            Option(short="-t", long="--tagged-paragraph"),
            Option(short="-u", long="--uniform-spacing"),
        ),
        rest=Operand(type="path"),
    ),
    'rev':
    CommandSpec(rest=Operand(type="path")),
    'expand':
    CommandSpec(
        options=(
            Option(short="-t", long="--tabs", type="str"),
            Option(short="-i", long="--initial"),
        ),
        rest=Operand(type="path"),
    ),
    'unexpand':
    CommandSpec(
        options=(
            Option(short="-t", long="--tabs", type="str"),
            Option(short="-a", long="--all"),
            Option(long="--first-only"),
        ),
        rest=Operand(type="path"),
    ),
    'look':
    CommandSpec(
        options=(Option(short="-f"), ),
        positional=(
            Operand(type="str"),
            Operand(type="path"),
        ),
    ),
    'od':
    CommandSpec(
        options=(
            Option(short="-A",
                   long="--address-radix",
                   type="str"),
            Option(short="-j",
                   long="--skip-bytes",
                   type="str"),
            Option(short="-N",
                   long="--read-bytes",
                   type="str"),
            Option(short="-t",
                   long="--format",
                   type="str",
                   multiple=True),
        ),
        rest=Operand(type="path"),
    ),
}
