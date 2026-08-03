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
            Option(short="-m", type="str"),
            Option(short="-A", type="str"),
            Option(short="-B", type="str"),
            Option(short="-C", type="str"),
            Option(short="-e", type="str", multiple=True),
            Option(short="-f", type="path", multiple=True),
            # Accepted no-ops: output is never a tty, so plain output is
            # exactly what GNU produces with --color=auto (#471).
            Option(long="--color",
                   type="str",
                   value_optional=True),
            Option(long="--colour",
                   type="str",
                   value_optional=True),
            Option(long="--line-buffered"),
        ),
        positional=(Operand(type="str",
                            provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
    'search':
    CommandSpec(
        options=(
            Option(long="--method", type="str"),
            Option(long="--top-k", type="str"),
            Option(long="--threshold", type="str"),
        ),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
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
            Option(short="-H"),
            Option(short="-I"),
            Option(short="-e", type="str", multiple=True),
            Option(short="-f", type="path", multiple=True),
            Option(short="-m", type="str"),
            Option(short="-A", type="str"),
            Option(short="-B", type="str"),
            Option(short="-C", type="str"),
            Option(long="--hidden"),
            Option(long="--type", type="str"),
            Option(long="--glob", type="str"),
            # Accepted no-op like grep --color (#471).
            Option(long="--color",
                   type="str",
                   value_optional=True),
        ),
        positional=(Operand(type="str",
                            provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
    'sed':
    CommandSpec(
        options=(
            Option(short="-i"),
            # -e takes a script and may repeat; joined with newlines.
            Option(short="-e", type="str", multiple=True),
            # -f reads the script from a file and may repeat (like grep -f);
            # its value is a PATH so it routes and is read from the mount.
            Option(short="-f", type="path", multiple=True),
            Option(short="-n"),
            Option(short="-E"),
            Option(short="-r"),
        ),
        # provided_by lists the flags that can supply this positional slot's
        # value; when any is present the parser skips the slot so the next
        # word is not mis-grabbed. For sed the first operand is the script
        # (TEXT), but only when neither -e nor -f gave one (GNU: "if no -e or
        # -f, the first non-option argument is the script"). Examples:
        #   sed 's/a/b/' f.txt        -> 's/a/b/' is the script; f.txt a file
        #   sed -e 's/a/b/' f.txt     -> -e is the script; f.txt reflows to
        #                                a file path in rest (slot skipped)
        #   sed -f prog.sed f.txt     -> prog.sed is the script; f.txt a file
        # Without provided_by, the -e/-f forms would mislabel f.txt as the
        # script (TEXT) and never read it as a file.
        positional=(Operand(type="str",
                            provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
    'jq':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-c"),
            Option(short="-s"),
        ),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
    ),
    'awk':
    CommandSpec(
        options=(
            Option(short="-F", type="str"),
            Option(short="-v", type="str", multiple=True),
            Option(short="-f", type="path", multiple=True),
        ),
        positional=(Operand(type="str", provided_by=("-f", )), ),
        rest=Operand(type="path"),
    ),
    'strings':
    CommandSpec(
        options=(Option(short="-n", type="str"), ),
        rest=Operand(type="path"),
    ),
    'zgrep':
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-n"),
            Option(short="-v"),
            Option(short="-e", type="str", multiple=True),
            Option(short="-f", type="path", multiple=True),
            Option(short="-E"),
            Option(short="-F"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", type="str"),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-w"),
        ),
        positional=(Operand(type="str",
                            provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
}
