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
    PATHS_OPERAND,
    TEXT_OPERAND,
    TEXTS_OPERAND,
)
from mirage.commands.spec.types import Argument, CommandSpec

_LESS_ARGUMENTS = (
    Argument("-a", "--search-skip-screen", action="store_true"),
    Argument("-A", "--SEARCH-SKIP-SCREEN", action="store_true"),
    Argument("-B", "--auto-buffers", action="store_true"),
    Argument("-c", "--clear-screen", action="store_true"),
    Argument("-C", action="store_true"),
    Argument("-d", "--dumb", action="store_true"),
    Argument("-e", "--quit-at-eof", action="store_true"),
    Argument("-E", "--QUIT-AT-EOF", action="store_true"),
    Argument("-f", "--force", action="store_true"),
    Argument("-F", "--quit-if-one-screen", action="store_true"),
    Argument("-g", "--hilite-search", action="store_true"),
    Argument("-G", "--HILITE-SEARCH", action="store_true"),
    Argument("-i", "--ignore-case", action="store_true"),
    Argument("-I", "--IGNORE-CASE", action="store_true"),
    Argument("-J", "--status-column", action="store_true"),
    Argument("-K", "--quit-on-intr", action="store_true"),
    Argument("-L", "--no-lessopen", action="store_true"),
    Argument("-m", "--long-prompt", action="store_true"),
    Argument("-M", "--LONG-PROMPT", action="store_true"),
    Argument("-n", "--line-numbers", action="store_true"),
    Argument("-N", "--LINE-NUMBERS", action="store_true"),
    Argument("-r", "--raw-control-chars", action="store_true"),
    Argument("-R", "--RAW-CONTROL-CHARS", action="store_true"),
    Argument("-s", "--squeeze-blank-lines", action="store_true"),
    Argument("-S", "--chop-long-lines", action="store_true"),
    Argument("-u", "--underline-special", action="store_true"),
    Argument("-U", "--UNDERLINE-SPECIAL", action="store_true"),
    Argument("-w", "--hilite-unread", action="store_true"),
    Argument("-W", "--HILITE-UNREAD", action="store_true"),
    Argument("-X", "--no-init", action="store_true"),
    Argument("-~", "--tilde", action="store_true"),
    Argument("-q", "--quiet", "--silent", action="store_true"),
    Argument("-Q", "--QUIET", "--SILENT", action="store_true"),
    Argument("-b", "--buffers"),
    Argument("-D", "--color"),
    Argument("-h", "--max-back-scroll"),
    Argument("-j", "--jump-target"),
    Argument("-k", "--lesskey-file"),
    Argument("-o", "--log-file"),
    Argument("-O", "--LOG-FILE"),
    Argument("-p", "--pattern"),
    Argument("-P", "--prompt"),
    Argument("-t", "--tag"),
    Argument("-T", "--tag-file"),
    Argument("-x", "--tabs"),
    Argument("-y", "--max-forw-scroll"),
    Argument("-z", "--window"),
    Argument("-#", "--shift"),
    Argument('-"', "--quotes"),
    Argument("--exit-follow-on-close", action="store_true"),
    Argument("--file-size", action="store_true"),
    Argument("--follow-name", action="store_true"),
    Argument("--incsearch", action="store_true"),
    Argument("--mouse", action="store_true"),
    Argument("--no-histdups", action="store_true"),
    Argument("--no-keypad", action="store_true"),
    Argument("--no-number-headers", action="store_true"),
    Argument("--no-search-header-columns", action="store_true"),
    Argument("--no-search-header-lines", action="store_true"),
    Argument("--no-search-headers", action="store_true"),
    Argument("--no-vbell", action="store_true"),
    Argument("--redraw-on-quit", action="store_true"),
    Argument("--save-marks", action="store_true"),
    Argument("--show-preproc-errors", action="store_true"),
    Argument("--status-line", action="store_true"),
    Argument("--use-backslash", action="store_true"),
    Argument("--use-color", action="store_true"),
    Argument("--wordwrap", action="store_true"),
    Argument("--header"),
    Argument("--intr"),
    Argument("--lesskey-context"),
    Argument("--lesskey-src"),
    Argument("--line-num-width"),
    Argument("--match-shift"),
    Argument("--proc-backspace"),
    Argument("--PROC-BACKSPACE"),
    Argument("--proc-return"),
    Argument("--PROC-RETURN"),
    Argument("--proc-tab"),
    Argument("--PROC-TAB"),
    Argument("--rscroll"),
    Argument("--search-options"),
    Argument("--status-col-width"),
    Argument("--wheel-lines"),
    PATHS_OPERAND,
)

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
            PATHS_OPERAND,
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
            PATHS_OPERAND,
        )
    ),
    "tail": CommandSpec(
        arguments=(
            Argument("-n", "--lines", numeric_shorthand=True),
            Argument("-c", "--bytes"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("--silent", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-z", "--zero-terminated", action="store_true"),
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
            Argument("--pid"),
            Argument("--max-unchanged-stats"),
            PATHS_OPERAND,
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
            PATHS_OPERAND,
        )
    ),
    "tac": CommandSpec(
        arguments=(
            Argument("-b", "--before", action="store_true"),
            Argument("-r", "--regex", action="store_true"),
            Argument("-s", "--separator"),
            PATHS_OPERAND,
        )
    ),
    "column": CommandSpec(
        arguments=(
            Argument("-t", "--table", action="store_true"),
            Argument("-s", "--separator"),
            Argument("-o", "--output-separator"),
            Argument("-c", "--output-width"),
            Argument("-x", "--fillrows", action="store_true"),
            Argument("-J", "--json", action="store_true"),
            Argument("-n", "--table-name"),
            Argument("-N", "--table-columns"),
            Argument("-C", "--table-column", action="append"),
            Argument("-O", "--table-order"),
            Argument("-l", "--table-columns-limit"),
            Argument("-R", "--table-right"),
            Argument("-H", "--table-hide"),
            Argument("-T", "--table-truncate"),
            Argument("-W", "--table-wrap"),
            Argument("-E", "--table-noextreme"),
            Argument("-d", "--table-noheadings", action="store_true"),
            Argument("-m", "--table-maxout", action="store_true"),
            Argument("-e", "--table-header-repeat", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "fold": CommandSpec(
        arguments=(
            Argument("-w", "--width"),
            Argument("-s", "--spaces", action="store_true"),
            Argument("-b", "--bytes", action="store_true"),
            Argument("-c", "--characters", action="store_true"),
            PATHS_OPERAND,
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
            PATHS_OPERAND,
        )
    ),
    "rev": CommandSpec(
        arguments=(
            Argument("-0", "--zero", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "expand": CommandSpec(
        arguments=(
            Argument("-t", "--tabs", action="append"),
            Argument("-i", "--initial", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "unexpand": CommandSpec(
        arguments=(
            Argument("-t", "--tabs", action="append"),
            Argument("-a", "--all", action="store_true"),
            Argument("--first-only", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "look": CommandSpec(
        arguments=(
            Argument("-f", "--ignore-case", action="store_true"),
            Argument("-d", "--alphanum", action="store_true"),
            Argument("-t", "--terminate"),
            TEXT_OPERAND,
            PATH2_OPERAND,
        )
    ),
    # GNU names the option as typed when it refuses its value (`invalid
    # -j argument`, `invalid --skip-bytes argument`), so each spelling of
    # one is its own entry. Each traditional letter adds a type.
    "od": CommandSpec(
        arguments=(
            Argument("-A", "--address-radix"),
            Argument("-j"),
            Argument("--skip-bytes"),
            Argument("-N"),
            Argument("--read-bytes"),
            Argument("-S"),
            Argument("--strings", nargs="?", attached_only=True),
            Argument("-t", "--format", action="append"),
            Argument("-v", "--output-duplicates", action="store_true"),
            Argument("-w", nargs="?", attached_only=True),
            Argument("--width", nargs="?", attached_only=True),
            Argument("--endian"),
            Argument("--traditional", action="store_true"),
            *(
                Argument(f"-{letter}", action="store_true")
                for letter in "abcdfhilosxBDeFHILOX"
            ),
            PATHS_OPERAND,
        )
    ),
    "colrm": CommandSpec(
        description="Remove columns from a file read on standard input.",
        arguments=(TEXTS_OPERAND,),
    ),
    "less": CommandSpec(
        description="Print files, for a reader with no terminal.",
        arguments=_LESS_ARGUMENTS,
    ),
    "more": CommandSpec(
        description="Print files, for a reader with no terminal.",
        arguments=(
            Argument("-d", "--silent", action="store_true"),
            Argument("-l", "--logical", action="store_true"),
            Argument("-e", "--exit-on-eof", action="store_true"),
            Argument("-f", "--no-pause", action="store_true"),
            Argument("-p", "--print-over", action="store_true"),
            Argument("-c", "--clean-print", action="store_true"),
            Argument("-s", "--squeeze", action="store_true"),
            Argument("-u", "--plain", action="store_true"),
            Argument("-n", "--lines", numeric_shorthand=True),
            PATHS_OPERAND,
        ),
    ),
    "zless": CommandSpec(
        description="Print compressed files, for a reader with no terminal.",
        arguments=_LESS_ARGUMENTS,
    ),
    "zmore": CommandSpec(
        description="Print compressed files, for a reader with no terminal.",
        arguments=(PATHS_OPERAND,),
    ),
}
