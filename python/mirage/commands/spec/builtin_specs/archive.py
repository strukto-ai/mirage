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
            # -h archives what a symlink points at instead of the link.
            Option(short="-h"),
            Option(short="-f", type="path"),
            # Every occurrence is kept, in order: GNU chdirs at each
            # one and fails at the first it cannot enter, so the
            # planner has to see them all, not just the last.
            Option(short="-C", type="path", multiple=True),
            Option(long="--strip-components", type="str"),
            Option(long="--exclude", type="str"),
        ),
        rest=Operand(type="path"),
        # `tar xzf a.tgz` is the spelling everyone types.
        old_option_style=True,
        # -C is a chdir for the operands after it, not a flag the command
        # reads once: `tar -cf a.tar -C d x` archives d/x as `x`.
        operand_base="-C",
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
            # -y stores a symlink as a symlink; without it zip archives
            # what the link points at, which is tar's -h inverted.
            Option(short="-y"),
            # Info-ZIP reads -x as a variadic list of patterns; mirage
            # takes one per occurrence, since its spec has no variadic
            # option value and `-x a -x b` says the same thing.
            Option(short="-x", type="str", multiple=True),
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
