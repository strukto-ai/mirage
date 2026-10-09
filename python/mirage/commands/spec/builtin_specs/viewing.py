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

SPECS: dict[str, CommandSpec] = {
    "cat": CommandSpec(
        arguments=(
            Argument("-b", "--number-nonblank", action="store_true"),
            Argument("-n", "--number", action="store_true"),
            Argument("-s", "--squeeze-blank", action="store_true"),
            Argument("-v", "--show-nonprinting", action="store_true"),
            Argument("-E", "--show-ends", action="store_true"),
            Argument("-e", action="store_true"),
            Argument("-t", action="store_true"),
            Argument("-T", "--show-tabs", action="store_true"),
            Argument("-A", "--show-all", action="store_true"),
            Argument("-u", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "head": CommandSpec(
        arguments=(
            Argument("-n", "--lines", numeric_shorthand=True),
            Argument("-c", "--bytes"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("--silent", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "tail": CommandSpec(
        arguments=(
            Argument("-n", numeric_shorthand=True),
            Argument("-c"),
            Argument("-q", action="store_true"),
            Argument("-v", action="store_true"),
            # GNU: -f never takes an argument; only --follow= carries the
            # descriptor/name choice, so the short stays clusterable.
            Argument(
                "-f",
                "--follow",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument("-F", action="store_true"),
            Argument("--retry", action="store_true"),
            Argument("-s", "--sleep-interval"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "nl": CommandSpec(
        arguments=(
            Argument("-b", "--body-numbering", action="append"),
            Argument("-v", "--starting-line-number", action="append"),
            Argument("-f", "--footer-numbering", action="append"),
            Argument("-h", "--header-numbering", action="append"),
            Argument("-l", "--join-blank-lines", action="append"),
            Argument("-p", "--no-renumber", action="store_true"),
            Argument("-s", "--number-separator"),
            Argument("-d", "--section-delimiter"),
            Argument("-i", "--line-increment", action="append"),
            Argument("-w", "--number-width", action="append"),
            Argument("-n", "--number-format", action="append"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "tac": CommandSpec(
        arguments=(
            Argument("-b", "--before", action="store_true"),
            Argument("-r", "--regex", action="store_true"),
            Argument("-s", "--separator"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "column": CommandSpec(
        arguments=(
            Argument("-t", action="store_true"),
            Argument("-s"),
            Argument("-o"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "fold": CommandSpec(
        arguments=(
            Argument("-w", "--width"),
            Argument("-s", "--spaces", action="store_true"),
            Argument("-b", "--bytes", action="store_true"),
            Argument("-c", "--characters", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "fmt": CommandSpec(
        arguments=(
            Argument("-w", "--width"),
            Argument("-g", "--goal"),
            Argument("-c", "--crown-margin", action="store_true"),
            Argument("-p", "--prefix"),
            Argument("-s", "--split-only", action="store_true"),
            Argument("-t", "--tagged-paragraph", action="store_true"),
            Argument("-u", "--uniform-spacing", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "rev": CommandSpec(
        arguments=(Argument("paths", type="path", nargs="*", metavar=""),)
    ),
    "expand": CommandSpec(
        arguments=(
            Argument("-t", "--tabs", action="append"),
            Argument("-i", "--initial", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "unexpand": CommandSpec(
        arguments=(
            Argument("-t", "--tabs"),
            Argument("-a", "--all", action="store_true"),
            Argument("--first-only", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "look": CommandSpec(
        arguments=(
            Argument("-f", action="store_true"),
            Argument("text", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "od": CommandSpec(
        arguments=(
            Argument("-A", "--address-radix"),
            Argument("-j", "--skip-bytes"),
            Argument("-N", "--read-bytes"),
            Argument("-t", "--format", action="append"),
            Argument("-c", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
