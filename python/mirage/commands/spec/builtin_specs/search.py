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
    "grep": CommandSpec(
        arguments=(
            Argument("-r", action="store_true"),
            Argument("-R", action="store_true"),
            Argument("-i", action="store_true"),
            Argument("-I", action="store_true"),
            Argument("-v", action="store_true"),
            Argument("-n", action="store_true"),
            Argument("--binary-files"),
            Argument("-c", action="store_true"),
            Argument("-l", action="store_true"),
            Argument("-L", "--files-without-match", action="store_true"),
            Argument("-w", action="store_true"),
            Argument("-x", "--line-regexp", action="store_true"),
            Argument("-F", action="store_true"),
            Argument("-E", action="store_true"),
            # -G asks for the basic expressions grep already reads by
            # default; with -E, -F and -P it is one of the four matchers,
            # two different ones being refused.
            Argument("-G", action="store_true"),
            Argument("-P", "--perl-regexp", action="store_true"),
            # -E's and -G's long spellings, one option to GNU; mirage keeps
            # the short dests the matcher check reads next to these.
            Argument("--extended-regexp", action="store_true"),
            Argument("--basic-regexp", action="store_true"),
            Argument("-o", action="store_true"),
            Argument("-q", action="store_true"),
            Argument("-s", "--no-messages", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-h", action="store_true"),
            Argument("-m"),
            Argument("-A"),
            Argument("-B"),
            Argument("-C"),
            Argument("-e", action="append"),
            Argument("-f", "--file", type="path", action="append"),
            Argument("-a", "--text", action="store_true"),
            Argument("-b", "--byte-offset", action="store_true"),
            Argument("--include", action="append"),
            Argument("--exclude", action="append"),
            Argument("--exclude-dir", action="append"),
            # Accepted no-ops: output is never a tty, so plain output is
            # exactly what GNU produces with --color=auto (#471).
            Argument("--color", nargs="?", attached_only=True),
            Argument("--colour", nargs="?", attached_only=True),
            Argument("--line-buffered", action="store_true"),
            Argument("text", nargs="?", metavar="", provided_by=("-e", "-f")),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "search": CommandSpec(
        arguments=(
            Argument("--method"),
            Argument("--top-k"),
            Argument("--threshold"),
            Argument("text", nargs="?", metavar=""),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "rg": CommandSpec(
        # ripgrep's parser (lexopt) takes a long flag only as spelled.
        allow_abbrev=False,
        arguments=(
            Argument("-e", "--regexp", action="append"),
            Argument("-f", "--file", type="path", action="append"),
            Argument("-i", "--ignore-case", action="store_true"),
            Argument("-s", "--case-sensitive", action="store_true"),
            Argument("-S", "--smart-case", action="store_true"),
            Argument("-v", "--invert-match", action="store_true"),
            Argument("--no-invert-match", action="store_true"),
            Argument("-w", "--word-regexp", action="store_true"),
            Argument("-x", "--line-regexp", action="store_true"),
            Argument("-F", "--fixed-strings", action="store_true"),
            Argument("--no-fixed-strings", action="store_true"),
            Argument("-m", "--max-count"),
            Argument("--stop-on-nonmatch", action="store_true"),
            Argument("-n", "--line-number", action="store_true"),
            Argument("-N", "--no-line-number", action="store_true"),
            Argument("-b", "--byte-offset", action="store_true"),
            Argument("--no-byte-offset", action="store_true"),
            Argument("--column", action="store_true"),
            Argument("--no-column", action="store_true"),
            Argument("--vimgrep", action="store_true"),
            Argument("-o", "--only-matching", action="store_true"),
            Argument("-r", "--replace"),
            Argument("--trim", action="store_true"),
            Argument("--no-trim", action="store_true"),
            Argument("-M", "--max-columns"),
            Argument("--max-columns-preview", action="store_true"),
            Argument("--no-max-columns-preview", action="store_true"),
            Argument("-0", "--null", action="store_true"),
            Argument("--null-data", action="store_true"),
            Argument("--path-separator"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("-c", "--count", action="store_true"),
            Argument("--count-matches", action="store_true"),
            Argument("--include-zero", action="store_true"),
            Argument("--no-include-zero", action="store_true"),
            Argument("-l", "--files-with-matches", action="store_true"),
            # ripgrep spells this long only: its -L is --follow.
            Argument("--files-without-match", action="store_true"),
            Argument("--files", action="store_true"),
            Argument("--type-list", action="store_true"),
            Argument("-H", "--with-filename", action="store_true"),
            Argument("-I", "--no-filename", action="store_true"),
            Argument("--heading", action="store_true"),
            Argument("--no-heading", action="store_true"),
            Argument("-A", "--after-context"),
            Argument("-B", "--before-context"),
            Argument("-C", "--context"),
            Argument("--passthru", action="store_true"),
            # ripgrep's second name for --passthru (LONG_SYNONYMS).
            Argument("--passthrough", action="store_true"),
            Argument("--context-separator"),
            Argument("--no-context-separator", action="store_true"),
            Argument("--field-match-separator"),
            Argument("--field-context-separator"),
            Argument("-g", "--glob", action="append"),
            Argument("--iglob", action="append"),
            Argument("--glob-case-insensitive", action="store_true"),
            Argument("--no-glob-case-insensitive", action="store_true"),
            Argument("-t", "--type", action="append"),
            Argument("-T", "--type-not", action="append"),
            Argument("--type-add", action="append"),
            Argument("--type-clear", action="append"),
            Argument("-.", "--hidden", action="store_true"),
            Argument("--no-hidden", action="store_true"),
            Argument("-u", "--unrestricted", action="count"),
            Argument("-d", "--max-depth"),
            Argument("--max-filesize"),
            # -L follows a link the walk meets; one named on the line is
            # followed either way (ripgrep 14.1.1).
            Argument("-L", "--follow", action="store_true"),
            # A mount is mirage's filesystem boundary: this keeps the walk
            # out of every mount below the one it starts in.
            Argument("--one-file-system", action="store_true"),
            Argument("--no-one-file-system", action="store_true"),
            # mirage searches a binary file's bytes as text either way;
            # these lift the walk's binary-extension skip.
            Argument("-a", "--text", action="store_true"),
            Argument("--no-text", action="store_true"),
            Argument("--binary", action="store_true"),
            Argument("--no-binary", action="store_true"),
            Argument("--sort"),
            Argument("--sortr"),
            Argument("--sort-files", action="store_true"),
            Argument("--no-sort-files", action="store_true"),
            Argument("--no-messages", action="store_true"),
            Argument("--messages", action="store_true"),
            # Accepted no-ops: mirage reads no ignore files and no config
            # file, runs one search at a time, and never writes to a tty,
            # so its output is already what these ask for; the negations
            # restore defaults of features it does not have.
            Argument("--no-ignore", action="store_true"),
            Argument("--ignore", action="store_true"),
            Argument("--no-ignore-dot", action="store_true"),
            Argument("--ignore-dot", action="store_true"),
            Argument("--no-ignore-exclude", action="store_true"),
            Argument("--ignore-exclude", action="store_true"),
            Argument("--no-ignore-files", action="store_true"),
            Argument("--ignore-files", action="store_true"),
            Argument("--no-ignore-global", action="store_true"),
            Argument("--ignore-global", action="store_true"),
            Argument("--no-ignore-messages", action="store_true"),
            Argument("--ignore-messages", action="store_true"),
            Argument("--no-ignore-parent", action="store_true"),
            Argument("--ignore-parent", action="store_true"),
            Argument("--no-ignore-vcs", action="store_true"),
            Argument("--ignore-vcs", action="store_true"),
            Argument("--no-require-git", action="store_true"),
            Argument("--require-git", action="store_true"),
            Argument("--ignore-file-case-insensitive", action="store_true"),
            Argument("--no-ignore-file-case-insensitive", action="store_true"),
            Argument("--no-config", action="store_true"),
            Argument("-j", "--threads"),
            Argument("--line-buffered", action="store_true"),
            Argument("--no-line-buffered", action="store_true"),
            Argument("--block-buffered", action="store_true"),
            Argument("--no-block-buffered", action="store_true"),
            Argument("--mmap", action="store_true"),
            Argument("--no-mmap", action="store_true"),
            # -L's negation, the last of the two winning.
            Argument("--no-follow", action="store_true"),
            Argument("--no-stats", action="store_true"),
            Argument("--no-crlf", action="store_true"),
            Argument("--no-multiline", action="store_true"),
            Argument("--no-multiline-dotall", action="store_true"),
            Argument("-P", "--pcre2", action="store_true"),
            Argument("--no-pcre2", action="store_true"),
            Argument("--engine"),
            Argument("--no-json", action="store_true"),
            Argument("--no-search-zip", action="store_true"),
            Argument("--no-encoding", action="store_true"),
            Argument("--no-pre", action="store_true"),
            Argument("--unicode", action="store_true"),
            Argument("--no-unicode", action="store_true"),
            Argument("--pcre2-unicode", action="store_true"),
            Argument("--no-pcre2-unicode", action="store_true"),
            Argument("--auto-hybrid-regex", action="store_true"),
            Argument("--no-auto-hybrid-regex", action="store_true"),
            # Accepted no-op like grep --color (#471), with ripgrep's
            # required value.
            Argument("--color"),
            # --files and --type-list search nothing, so the first operand is
            # a path rather than the pattern.
            Argument(
                "text",
                nargs="?",
                metavar="",
                provided_by=("-e", "-f", "--files", "--type-list"),
            ),
            Argument("paths", type="path", nargs="*", metavar=""),
        ),
    ),
    "sed": CommandSpec(
        arguments=(
            Argument("-i", action="store_true"),
            # -e takes a script and may repeat; the pieces compile in order.
            Argument("-e", action="append"),
            # -f reads the script from a file and may repeat (like grep -f);
            # its value is a PATH so it routes and is read from the mount.
            Argument("-f", type="path", action="append"),
            Argument("-n", action="store_true"),
            Argument("-E", action="store_true"),
            Argument("-r", action="store_true"),
            # -l N sets the `l` command's line length (GNU atoi: 0 never
            # folds).
            Argument("-l", "--line-length"),
            Argument("-s", "--separate", action="store_true"),
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
            Argument("text", nargs="?", metavar="", provided_by=("-e", "-f")),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "jq": CommandSpec(
        # jq's main.c compares each long option with strcmp, so `--nul` is
        # no --null-input (jq 1.8.2: `jq: Unknown option --nul`).
        allow_abbrev=False,
        arguments=(
            Argument(
                "-n",
                "--null-input",
                action="store_true",
                help="Use null as the single input value",
            ),
            Argument(
                "-R",
                "--raw-input",
                action="store_true",
                help="Read each line as a string instead of JSON",
            ),
            Argument(
                "-s",
                "--slurp",
                action="store_true",
                help="Read all inputs into one array",
            ),
            Argument(
                "-c",
                "--compact-output",
                action="store_true",
                help="Compact instead of pretty-printed output",
            ),
            Argument(
                "-r",
                "--raw-output",
                action="store_true",
                help="Output strings without quotes or escapes",
            ),
            Argument(
                "--raw-output0",
                action="store_true",
                help="Implies -r and writes NUL after each output",
            ),
            Argument(
                "-j",
                "--join-output",
                action="store_true",
                help="Implies -r and writes no trailing newline",
            ),
            Argument(
                "-a",
                "--ascii-output",
                action="store_true",
                help="Escape non-ASCII characters in output",
            ),
            Argument(
                "-S",
                "--sort-keys",
                action="store_true",
                help="Sort object keys on output",
            ),
            Argument(
                "-e",
                "--exit-status",
                action="store_true",
                help="Set the exit status from the last output",
            ),
            Argument("--tab", action="store_true", help="Indent with tabs"),
            # jq words its own refusal of a width it cannot read.
            Argument("--indent", help="Indent with n spaces (max 7)"),
            Argument(
                "-M",
                "--monochrome-output",
                action="store_true",
                help="Disable colored output (already the default)",
            ),
            Argument(
                "--unbuffered",
                action="store_true",
                help="Accepted for compatibility; output is one buffer",
            ),
            Argument(
                "-f",
                "--from-file",
                type="path",
                help="Read the filter from a file",
            ),
            Argument(
                "--stream",
                action="store_true",
                help="Read each input as its [path, leaf] events",
            ),
            Argument(
                "--seq",
                action="store_true",
                help="Read and write RS-delimited JSON text sequences",
            ),
            Argument(
                "--arg",
                action="extend",
                nargs=2,
                help="Set $name to a string value",
            ),
            Argument(
                "--argjson",
                action="extend",
                nargs=2,
                help="Set $name to a JSON value",
            ),
            Argument(
                "--rawfile",
                type="path",
                action="extend",
                nargs=2,
                value_types=("str", "path"),
                help="Set $name to a file's contents",
            ),
            Argument(
                "--slurpfile",
                type="path",
                action="extend",
                nargs=2,
                value_types=("str", "path"),
                help="Set $name to a file's documents, as an array",
            ),
            Argument(
                "--args",
                action="store_true",
                help="Read the remaining operands as positional string values",
            ),
            Argument(
                "--jsonargs",
                action="store_true",
                help="Read the remaining operands as positional JSON values",
            ),
            Argument(
                "-h",
                "--help",
                action="store_true",
                help="Show this help and exit",
            ),
            # jq answers -h and -V inside its option loop, where they are
            # typed (OWN_OPTION_LOOP), so it declares both.
            Argument(
                "-V",
                "--version",
                action="store_true",
                help="Show version information and exit",
            ),
            # Without provided_by, `jq -f prog.jq data.json` would take
            # data.json as the filter and never read it as a file.
            Argument("text", nargs="?", metavar="", provided_by=("-f",)),
            # --args and --jsonargs turn the operands typed after them into
            # $ARGS.positional, so those stop being input files
            # (IN_ORDER_OPERANDS).
            Argument(
                "paths",
                type="path",
                nargs="*",
                metavar="",
                text_when=("--args", "--jsonargs"),
            ),
        ),
    ),
    "awk": CommandSpec(
        arguments=(
            Argument("-F"),
            Argument("-v", action="append"),
            Argument("-f", type="path", action="append"),
            Argument("text", nargs="?", metavar="", provided_by=("-f",)),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "strings": CommandSpec(
        arguments=(
            Argument("-n"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "zgrep": CommandSpec(
        arguments=(
            Argument("-i", action="store_true"),
            Argument("-b", "--byte-offset", action="store_true"),
            Argument("-c", action="store_true"),
            Argument("-l", action="store_true"),
            Argument("-L", "--files-without-match", action="store_true"),
            Argument("-n", action="store_true"),
            Argument("-v", action="store_true"),
            Argument("-e", action="append"),
            Argument("-f", type="path", action="append"),
            Argument("-E", action="store_true"),
            Argument("-G", action="store_true"),
            Argument("-F", action="store_true"),
            Argument("-P", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-h", action="store_true"),
            Argument("-m"),
            Argument("-o", action="store_true"),
            Argument("-q", action="store_true"),
            # An accepted no-op: zgrep hands -s to grep, which reads a
            # pipe and has no file to complain about, and gzip's own
            # lines are gzip's (gzip 1.13).
            Argument("-s", action="store_true"),
            Argument("-w", action="store_true"),
            Argument("-x", "--line-regexp", action="store_true"),
            Argument("text", nargs="?", metavar="", provided_by=("-e", "-f")),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
