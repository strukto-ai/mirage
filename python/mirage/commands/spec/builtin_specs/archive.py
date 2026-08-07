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
            Option(short="-f", type="path"),
            Option(short="-C", type="path"),
            Option(long="--strip-components", type="str"),
            Option(long="--exclude", type="str"),
        ),
        rest=Operand(type="path"),
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
        rest=Operand(type="path"),
    ),
    'gunzip':
    CommandSpec(
        options=(
            Option(short="-k"),
            Option(short="-f"),
            Option(short="-c"),
            Option(short="-t"),
        ),
        rest=Operand(type="path"),
    ),
    'zip':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-j"),
            Option(short="-q"),
        ),
        rest=Operand(type="path"),
    ),
    'unzip':
    CommandSpec(
        options=(
            Option(short="-o"),
            Option(short="-l"),
            Option(short="-d", type="path"),
            Option(short="-q"),
            Option(short="-p"),
            Option(short="-t"),
        ),
        # The archive is the only path operand; everything after it is an
        # Info-ZIP member pattern matched against archive entry names,
        # never a filesystem path.
        positional=(Operand(type="path"), ),
        rest=Operand(type="str"),
    ),
    'zcat':
    CommandSpec(rest=Operand(type="path")),
}
