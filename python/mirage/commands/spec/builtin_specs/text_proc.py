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
    "wc": CommandSpec(
        arguments=(
            Argument("-l", "--lines", action="store_true"),
            Argument("-w", "--words", action="store_true"),
            Argument("-c", "--bytes", action="store_true"),
            Argument("-m", "--chars", action="store_true"),
            Argument("-L", "--max-line-length", action="store_true"),
            Argument("--total"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "sort": CommandSpec(
        arguments=(
            Argument("-r", "--reverse", action="store_true"),
            Argument("-n", "--numeric-sort", action="store_true"),
            Argument("-u", "--unique", action="store_true"),
            Argument("-b", "--ignore-leading-blanks", action="store_true"),
            Argument("-k", "--key", action="append"),
            Argument("-t", "--field-separator"),
            Argument("-h", "--human-numeric-sort", action="store_true"),
            Argument("-V", "--version-sort", action="store_true"),
            Argument("-s", "--stable", action="store_true"),
            Argument("-m", "--merge", action="store_true"),
            Argument("-f", "--ignore-case", action="store_true"),
            Argument("-c", action="store_true"),
            Argument("-C", action="store_true"),
            Argument("--check", nargs="?", attached_only=True),
            Argument("-d", "--dictionary-order", action="store_true"),
            Argument("-g", "--general-numeric-sort", action="store_true"),
            Argument("-i", "--ignore-nonprinting", action="store_true"),
            Argument("-M", "--month-sort", action="store_true"),
            Argument("-o", "--output", type="path", action="append"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "uniq": CommandSpec(
        arguments=(
            Argument("-c", "--count", action="store_true"),
            Argument("-d", "--repeated", action="store_true"),
            Argument("-D", action="store_true"),
            Argument("--all-repeated", nargs="?", attached_only=True),
            Argument("--group", nargs="?", attached_only=True),
            Argument("-u", "--unique", action="store_true"),
            Argument("-f", "--skip-fields"),
            Argument("-s", "--skip-chars"),
            Argument("-i", "--ignore-case", action="store_true"),
            Argument("-w", "--check-chars"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "cut": CommandSpec(
        arguments=(
            Argument("-f", "--fields"),
            Argument("-F"),
            Argument("-d", "--delimiter"),
            Argument("-c", "--characters"),
            Argument("-b", "--bytes"),
            Argument("-n", "--no-partial", action="store_true"),
            Argument("--complement", action="store_true"),
            Argument("-s", "--only-delimited", action="store_true"),
            Argument("-O"),
            Argument("--output-delimiter"),
            Argument("-w", action="store_true"),
            Argument(
                "--whitespace-delimited",
                nargs="?",
                attached_only=True,
            ),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "echo": CommandSpec(
        arguments=(
            Argument("-n", action="store_true"),
            Argument("-e", action="store_true"),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    "tee": CommandSpec(
        arguments=(
            Argument("-a", "--append", action="store_true"),
            Argument("-i", "--ignore-interrupts", action="store_true"),
            Argument("-p", action="store_true"),
            Argument(
                "--output-error",
                nargs="?",
                attached_only=True,
                choices=("warn", "warn-nopipe", "exit", "exit-nopipe"),
            ),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "tr": CommandSpec(
        arguments=(
            Argument("-d", "--delete", action="store_true"),
            Argument("-s", "--squeeze-repeats", action="store_true"),
            Argument("-c", "--complement", action="store_true"),
            Argument("-C", action="store_true"),
            Argument("-t", "--truncate-set1", action="store_true"),
            Argument("text", nargs="?", metavar=""),
            Argument("text2", nargs="?", metavar=""),
        )
    ),
    "paste": CommandSpec(
        arguments=(
            Argument("-d", "--delimiters"),
            Argument("-s", "--serial", action="store_true"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "printf": CommandSpec(
        arguments=(
            Argument("text", nargs="?", metavar=""),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    "seq": CommandSpec(
        description="Print a sequence of numbers.",
        arguments=(
            Argument(
                "-s",
                "--separator",
                help="Use the given string as separator between numbers.",
            ),
            Argument(
                "-w",
                "--equal-width",
                action="store_true",
                help="Pad numbers with zeros to equal width.",
            ),
            Argument(
                "-f",
                "--format",
                help="Format each number with a printf-style format string.",
            ),
            Argument("text", nargs="?", metavar=""),
            Argument("text2", nargs="?", metavar=""),
            Argument("text3", nargs="?", metavar=""),
            # seq's getopt string starts with `+`, so its first operand ends
            # the options: `seq 1 -w 3` reads -w as LAST and refuses it as a
            # number (coreutils 9.7). A negative number does the same, which
            # NEGATIVE_NUMBER_OPERANDS covers.
            Argument("texts", nargs="REMAINDER", metavar=""),
        ),
    ),
    "split": CommandSpec(
        arguments=(
            # GNU's obsolete -NUM is a line count (DIGIT_OPTIONS reads
            # its digits inside a cluster too). One divergence: GNU adds
            # its `Try` hint when a zero count came as digits (`split
            # -0`) and not for `-l 0`, and the bag cannot tell the two
            # apart, so both refuse without it.
            Argument("-l", "--lines", numeric_shorthand=True),
            Argument("-b", "--bytes"),
            Argument("-n", "--number"),
            # GNU: -d/-x never take an argument; only --numeric-suffixes=
            # and --hex-suffixes= carry one, so `-d10` is -d and ten lines.
            Argument(
                "-d",
                "--numeric-suffixes",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument(
                "-x",
                "--hex-suffixes",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument("-a", "--suffix-length"),
            Argument("--additional-suffix"),
            Argument("-t", "--separator"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "shuf": CommandSpec(
        arguments=(
            Argument("-n", "--head-count", action="append"),
            Argument("-e", "--echo", action="store_true"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("-r", "--repeat", action="store_true"),
            Argument("-i", "--input-range", action="append"),
            Argument("-o", "--output", type="path", action="append"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "comm": CommandSpec(
        arguments=(
            Argument("-1", action="store_true"),
            Argument("-2", action="store_true"),
            Argument("-3", action="store_true"),
            Argument("--check-order", action="store_true"),
            Argument("--nocheck-order", action="store_true"),
            Argument("--output-delimiter"),
            Argument("--total", action="store_true"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "csplit": CommandSpec(
        arguments=(
            Argument("-f", "--prefix", type="path"),
            Argument("-n", "--digits"),
            Argument("--silent", action="store_true"),
            Argument("-k", "--keep-files", action="store_true"),
            Argument("-s", "--quiet", action="store_true"),
            Argument("-b", "--suffix-format"),
            Argument("--suppress-matched", action="store_true"),
            Argument("-z", "--elide-empty-files", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    "tsort": CommandSpec(
        arguments=(Argument("path", type="path", nargs="?", metavar=""),)
    ),
    "join": CommandSpec(
        arguments=(
            Argument("-t"),
            Argument("-1"),
            Argument("-2"),
            Argument("-a"),
            Argument("-v"),
            Argument("-e"),
            Argument("-o"),
            Argument("-i", "--ignore-case", action="store_true"),
            Argument("-j"),
            Argument("-z", "--zero-terminated", action="store_true"),
            Argument("--check-order", action="store_true"),
            Argument("--nocheck-order", action="store_true"),
            Argument("--header", action="store_true"),
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("path2", type="path", nargs="?", metavar=""),
        )
    ),
    "numfmt": CommandSpec(
        arguments=(
            # GNU's argmatch tables, in GNU's order: `--to=auto` is not
            # an output mode, and an unknown word answers with the
            # shared ARGMATCH refusal (coreutils 9.7).
            Argument("--to", choices=("none", "si", "iec", "iec-i")),
            Argument(
                "--from",
                choices=("none", "auto", "si", "iec", "iec-i"),
            ),
            Argument("--suffix"),
            Argument("--grouping", action="store_true"),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
}
