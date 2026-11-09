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

from mirage.commands.spec.constants import (
    PATH2_OPERAND,
    PATH_OPERAND,
    PATHS_OPERAND,
)
from mirage.commands.spec.types import Argument, CommandSpec

CHECKSUM = CommandSpec(
    arguments=(
        Argument("-c", "--check", action="store_true"),
        Argument("-b", "--binary", action="store_true"),
        Argument("--tag", action="store_true"),
        Argument("-t", "--text", action="store_true"),
        Argument("-w", "--warn", action="store_true"),
        Argument("-z", "--zero", action="store_true"),
        Argument("--status", action="store_true"),
        Argument("--ignore-missing", action="store_true"),
        Argument("--strict", action="store_true"),
        Argument("--quiet", action="store_true"),
        PATHS_OPERAND,
    )
)

B2SUM = CommandSpec(
    arguments=(Argument("-l", "--length"), *CHECKSUM.arguments)
)

SPECS: dict[str, CommandSpec] = {
    "md5": CommandSpec(arguments=(PATHS_OPERAND,)),
    "diff": CommandSpec(
        arguments=(
            Argument("-i", "--ignore-case", action="store_true"),
            Argument("-w", "--ignore-all-space", action="store_true"),
            Argument("-b", "--ignore-space-change", action="store_true"),
            Argument("-E", "--ignore-tab-expansion", action="store_true"),
            Argument("-Z", "--ignore-trailing-space", action="store_true"),
            Argument("-B", "--ignore-blank-lines", action="store_true"),
            Argument("-I", "--ignore-matching-lines", action="append"),
            Argument("--strip-trailing-cr", action="store_true"),
            Argument("--speed-large-files", action="store_true"),
            Argument("--horizon-lines", action="append"),
            Argument("-a", "--text", action="store_true"),
            # The output styles; two different ones are refused.
            Argument("--normal", action="store_true"),
            Argument("-e", "--ed", action="store_true"),
            Argument("-n", "--rcs", action="store_true"),
            Argument("-c", action="store_true"),
            Argument("-C"),
            Argument("--context", nargs="?", attached_only=True),
            Argument("-u", action="store_true"),
            Argument("-U"),
            Argument("--unified", nargs="?", attached_only=True),
            Argument("-y", "--side-by-side", action="store_true"),
            Argument("-W", "--width"),
            Argument("--left-column", action="store_true"),
            Argument("--suppress-common-lines", action="store_true"),
            Argument("-p", "--show-c-function", action="store_true"),
            Argument("-F", "--show-function-line", action="append"),
            Argument("-t", "--expand-tabs", action="store_true"),
            Argument("-T", "--initial-tab", action="store_true"),
            Argument("-L", "--label", action="append"),
            Argument("--color", nargs="?", attached_only=True),
            Argument("-q", "--brief", action="store_true"),
            Argument("-r", "--recursive", action="store_true"),
            Argument("-N", "--new-file", action="store_true"),
            Argument("--unidirectional-new-file", action="store_true"),
            Argument("-x", "--exclude", action="append"),
            Argument("-X", "--exclude-from", type="path", action="append"),
            Argument("-s", "--report-identical-files", action="store_true"),
            PATH_OPERAND,
            PATH2_OPERAND,
        )
    ),
    "base64": CommandSpec(
        arguments=(
            Argument("-d", "--decode", action="store_true"),
            Argument("-D", action="store_true"),
            Argument("-w", "--wrap"),
            Argument("-i", "--ignore-garbage", action="store_true"),
            PATH_OPERAND,
        )
    ),
    "md5sum": CHECKSUM,
    "b2sum": B2SUM,
    "sha1sum": CHECKSUM,
    "sha224sum": CHECKSUM,
    "sha256sum": CHECKSUM,
    "sha384sum": CHECKSUM,
    "sha512sum": CHECKSUM,
    # xxd spells its long names with one dash, each beside its letter.
    "xxd": CommandSpec(
        arguments=(
            Argument("-r", "-revert", action="store_true"),
            Argument(
                "-p", "-ps", "-postscript", "-plain", action="store_true"
            ),
            Argument("-l", "-len"),
            Argument("-c", "-cols"),
            Argument("-s", "-seek"),
            Argument("-g", "-groupsize"),
            Argument("-u", "-uppercase", action="store_true"),
            Argument("-a", "-autoskip", action="store_true"),
            Argument("-b", "-bits", action="store_true"),
            Argument("-C", action="store_true"),
            Argument("-d", "-decimal", action="store_true"),
            Argument("-E", "-EBCDIC", action="store_true"),
            Argument("-e", action="store_true"),
            Argument("-i", "-include", action="store_true"),
            Argument("-n", "-name"),
            Argument("-o", "-offset"),
            PATH_OPERAND,
            PATH2_OPERAND,
        )
    ),
    "patch": CommandSpec(
        arguments=(
            Argument("-p"),
            Argument("-R", action="store_true"),
            Argument("-i", type="path"),
            Argument("-N", action="store_true"),
            # Each -d changes directory from where the one before left it,
            # before anything is read, the operands and -i included.
            Argument("-d", "--directory", action="append"),
            Argument("--dry-run", action="store_true"),
            Argument("-b", "--backup", action="store_true"),
            Argument("-z", "--suffix"),
            Argument("-B", "--prefix"),
            Argument("-V", "--version-control"),
            Argument("-o", "--output"),
            Argument("-r", "--reject-file"),
            Argument("-s", "--silent", "--quiet", action="store_true"),
            Argument("-f", "--force", action="store_true"),
            Argument("-t", "--batch", action="store_true"),
            Argument("-l", "--ignore-whitespace", action="store_true"),
            Argument("-F", "--fuzz"),
            Argument("-E", "--remove-empty-files", action="store_true"),
            Argument("-u", "--unified", action="store_true"),
            Argument("--verbose", action="store_true"),
            PATH_OPERAND,
            PATH2_OPERAND,
        )
    ),
    "cmp": CommandSpec(
        arguments=(
            Argument("-l", "--verbose", action="store_true"),
            Argument("-s", "--quiet", action="store_true"),
            Argument("--silent", action="store_true"),
            Argument("-n", "--bytes"),
            Argument("-b", "--print-bytes", action="store_true"),
            Argument("-i", "--ignore-initial"),
            # FILE1 [FILE2 [SKIP1 [SKIP2]]]: the skips are byte counts, read
            # as -i reads its own (diffutils 3.10).
            PATH_OPERAND,
            PATH2_OPERAND,
            Argument("text3", nargs="?", metavar=""),
            Argument("text4", nargs="?", metavar=""),
        )
    ),
    "iconv": CommandSpec(
        arguments=(
            Argument("-f", "--from-code"),
            Argument("-t", "--to-code"),
            Argument("-c", action="store_true"),
            Argument("-o", "--output", type="path"),
            Argument("-l", "--list", action="store_true"),
            Argument("-s", "--silent", action="store_true"),
            PATHS_OPERAND,
        )
    ),
}

CMP = SPECS["cmp"]
DIFF = SPECS["diff"]
SPECS["zcmp"] = CMP
SPECS["zdiff"] = DIFF
