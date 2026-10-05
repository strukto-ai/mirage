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
    "md5": CommandSpec(rest=Operand(type="path")),
    "diff": CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-w"),
            Option(short="-b"),
            Option(short="-e"),
            Option(short="-u"),
            Option(short="-U", type="str"),
            Option(long="--unified", type="str", value_optional=True),
            Option(short="-q", long="--brief"),
            Option(short="-r", long="--recursive"),
            Option(short="-N", long="--new-file"),
            Option(long="--unidirectional-new-file"),
            Option(short="-x", long="--exclude", type="str", multiple=True),
            Option(
                short="-X", long="--exclude-from", type="path", multiple=True
            ),
            Option(short="-s", long="--report-identical-files"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    "base64": CommandSpec(
        options=(
            Option(short="-d", long="--decode"),
            Option(short="-D"),
            Option(short="-w", long="--wrap", type="str"),
            Option(short="-i", long="--ignore-garbage"),
        ),
        positional=(Operand(type="path"),),
    ),
    "md5sum": CommandSpec(
        options=(
            Option(short="-c", long="--check"),
            Option(short="-b", long="--binary"),
            Option(long="--tag"),
            Option(short="-t", long="--text"),
            Option(short="-w", long="--warn"),
            Option(short="-z", long="--zero"),
            Option(long="--status"),
            Option(long="--ignore-missing"),
            Option(long="--strict"),
            Option(long="--quiet"),
        ),
        rest=Operand(type="path"),
    ),
    "sha1sum": CommandSpec(
        options=(
            Option(short="-c", long="--check"),
            Option(short="-b", long="--binary"),
            Option(long="--tag"),
            Option(short="-t", long="--text"),
            Option(short="-w", long="--warn"),
            Option(short="-z", long="--zero"),
            Option(long="--status"),
            Option(long="--ignore-missing"),
            Option(long="--strict"),
            Option(long="--quiet"),
        ),
        rest=Operand(type="path"),
    ),
    "sha256sum": CommandSpec(
        options=(
            Option(short="-c", long="--check"),
            Option(short="-b", long="--binary"),
            Option(long="--tag"),
            Option(short="-t", long="--text"),
            Option(short="-w", long="--warn"),
            Option(short="-z", long="--zero"),
            Option(long="--status"),
            Option(long="--ignore-missing"),
            Option(long="--strict"),
            Option(long="--quiet"),
        ),
        rest=Operand(type="path"),
    ),
    "sha384sum": CommandSpec(
        options=(
            Option(short="-c", long="--check"),
            Option(short="-b", long="--binary"),
            Option(long="--tag"),
            Option(short="-t", long="--text"),
            Option(short="-w", long="--warn"),
            Option(short="-z", long="--zero"),
            Option(long="--status"),
            Option(long="--ignore-missing"),
            Option(long="--strict"),
            Option(long="--quiet"),
        ),
        rest=Operand(type="path"),
    ),
    "sha512sum": CommandSpec(
        options=(
            Option(short="-c", long="--check"),
            Option(short="-b", long="--binary"),
            Option(long="--tag"),
            Option(short="-t", long="--text"),
            Option(short="-w", long="--warn"),
            Option(short="-z", long="--zero"),
            Option(long="--status"),
            Option(long="--ignore-missing"),
            Option(long="--strict"),
            Option(long="--quiet"),
        ),
        rest=Operand(type="path"),
    ),
    "xxd": CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-p"),
            Option(short="-l", type="str"),
            Option(short="-c", type="str"),
            Option(short="-s", type="str"),
            Option(short="-g", type="str"),
            Option(short="-u"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    "patch": CommandSpec(
        options=(
            Option(short="-p", type="str"),
            Option(short="-R"),
            Option(short="-i", type="path"),
            Option(short="-N"),
        ),
        positional=(
            Operand(type="path"),
            Operand(type="path"),
        ),
    ),
    "cmp": CommandSpec(
        options=(
            Option(short="-l", long="--verbose"),
            Option(short="-s", long="--quiet"),
            Option(long="--silent"),
            Option(short="-n", long="--bytes", type="str"),
            Option(short="-b", long="--print-bytes"),
            Option(short="-i", long="--ignore-initial", type="str"),
        ),
        # FILE1 [FILE2 [SKIP1 [SKIP2]]]: the skips are byte counts, read
        # as -i reads its own (diffutils 3.10).
        positional=(
            Operand(type="path"),
            Operand(type="path"),
            Operand(type="str"),
            Operand(type="str"),
        ),
    ),
    "iconv": CommandSpec(
        options=(
            Option(short="-f", type="str"),
            Option(short="-t", type="str"),
            Option(short="-c"),
            Option(short="-o", type="path"),
        ),
        rest=Operand(type="path"),
    ),
}
