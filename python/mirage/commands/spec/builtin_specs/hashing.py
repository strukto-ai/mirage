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
        Argument("paths", type="path", nargs="*", metavar=""),
    )
)

SPECS: dict[str, CommandSpec] = {
    "md5": CommandSpec(
        arguments=(Argument("paths", type="path", nargs="*", metavar=""),)
    ),
    "diff": CommandSpec(
        arguments=(
            Argument("-i", action="store_true"),
            Argument("-w", action="store_true"),
            Argument("-b", action="store_true"),
            Argument("-e", action="store_true"),
            Argument("-u", action="store_true"),
            Argument("-U"),
            Argument("--unified", nargs="?", attached_only=True),
            Argument("-q", "--brief", action="store_true"),
            Argument("-r", "--recursive", action="store_true"),
            Argument("-N", "--new-file", action="store_true"),
            Argument("--unidirectional-new-file", action="store_true"),
            Argument("-x", "--exclude", action="append"),
            Argument("-X", "--exclude-from", type="path", action="append"),
            Argument("-s", "--report-identical-files", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "base64": CommandSpec(
        arguments=(
            Argument("-d", "--decode", action="store_true"),
            Argument("-D", action="store_true"),
            Argument("-w", "--wrap"),
            Argument("-i", "--ignore-garbage", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
        )
    ),
    "md5sum": CHECKSUM,
    "sha1sum": CHECKSUM,
    "sha256sum": CHECKSUM,
    "sha384sum": CHECKSUM,
    "sha512sum": CHECKSUM,
    "xxd": CommandSpec(
        arguments=(
            Argument("-r", action="store_true"),
            Argument("-p", action="store_true"),
            Argument("-l"),
            Argument("-c"),
            Argument("-s"),
            Argument("-g"),
            Argument("-u", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "patch": CommandSpec(
        arguments=(
            Argument("-p"),
            Argument("-R", action="store_true"),
            Argument("-i", type="path"),
            Argument("-N", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
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
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
            Argument("text3", nargs="?", metavar=""),
            Argument("text4", nargs="?", metavar=""),
        )
    ),
    "iconv": CommandSpec(
        arguments=(
            Argument("-f"),
            Argument("-t"),
            Argument("-c", action="store_true"),
            Argument("-o", type="path"),
            Argument("-l", "--list", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
