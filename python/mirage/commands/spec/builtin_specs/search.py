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
    'grep':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-i"),
            Option(short="-I"),
            Option(short="-v"),
            Option(short="-n"),
            Option(long="--binary-files", type="str"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-L", long="--files-without-match"),
            Option(short="-w"),
            Option(short="-F"),
            Option(short="-E"),
            # -G asks for the basic expressions grep already reads by
            # default, so it is accepted and changes nothing.
            Option(short="-G"),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", type="str"),
            Option(short="-A", type="str"),
            Option(short="-B", type="str"),
            Option(short="-C", type="str"),
            Option(short="-e", type="str", multiple=True),
            Option(short="-f", long="--file", type="path", multiple=True),
            Option(short="-a", long="--text"),
            Option(short="-b", long="--byte-offset"),
            Option(long="--include", type="str", multiple=True),
            Option(long="--exclude", type="str", multiple=True),
            Option(long="--exclude-dir", type="str", multiple=True),
            # Accepted no-ops: output is never a tty, so plain output is
            # exactly what GNU produces with --color=auto (#471).
            Option(long="--color", type="str", value_optional=True),
            Option(long="--colour", type="str", value_optional=True),
            Option(long="--line-buffered"),
        ),
        positional=(Operand(type="str", provided_by=("-e", "-f")), ),
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
            Option(short="-e", long="--regexp", type="str", multiple=True),
            Option(short="-f", long="--file", type="path", multiple=True),
            Option(short="-i", long="--ignore-case"),
            Option(short="-s", long="--case-sensitive"),
            Option(short="-S", long="--smart-case"),
            Option(short="-v", long="--invert-match"),
            Option(long="--no-invert-match"),
            Option(short="-w", long="--word-regexp"),
            Option(short="-x", long="--line-regexp"),
            Option(short="-F", long="--fixed-strings"),
            Option(long="--no-fixed-strings"),
            Option(short="-m", long="--max-count", type="str"),
            Option(long="--stop-on-nonmatch"),
            Option(short="-n", long="--line-number"),
            Option(short="-N", long="--no-line-number"),
            Option(short="-b", long="--byte-offset"),
            Option(long="--no-byte-offset"),
            Option(long="--column"),
            Option(long="--no-column"),
            Option(long="--vimgrep"),
            Option(short="-o", long="--only-matching"),
            Option(short="-r", long="--replace", type="str"),
            Option(long="--trim"),
            Option(long="--no-trim"),
            Option(short="-M", long="--max-columns", type="str"),
            Option(long="--max-columns-preview"),
            Option(long="--no-max-columns-preview"),
            Option(short="-0", long="--null"),
            Option(long="--null-data"),
            Option(long="--path-separator", type="str"),
            Option(short="-q", long="--quiet"),
            Option(short="-c", long="--count"),
            Option(long="--count-matches"),
            Option(long="--include-zero"),
            Option(long="--no-include-zero"),
            Option(short="-l", long="--files-with-matches"),
            # ripgrep spells this long only: its -L is --follow.
            Option(long="--files-without-match"),
            Option(long="--files"),
            Option(long="--type-list"),
            Option(short="-H", long="--with-filename"),
            Option(short="-I", long="--no-filename"),
            Option(long="--heading"),
            Option(long="--no-heading"),
            Option(short="-A", long="--after-context", type="str"),
            Option(short="-B", long="--before-context", type="str"),
            Option(short="-C", long="--context", type="str"),
            Option(long="--passthru"),
            # ripgrep's second name for --passthru (LONG_SYNONYMS).
            Option(long="--passthrough"),
            Option(long="--context-separator", type="str"),
            Option(long="--no-context-separator"),
            Option(long="--field-match-separator", type="str"),
            Option(long="--field-context-separator", type="str"),
            Option(short="-g", long="--glob", type="str", multiple=True),
            Option(long="--iglob", type="str", multiple=True),
            Option(long="--glob-case-insensitive"),
            Option(long="--no-glob-case-insensitive"),
            Option(short="-t", long="--type", type="str", multiple=True),
            Option(short="-T", long="--type-not", type="str", multiple=True),
            Option(long="--type-add", type="str", multiple=True),
            Option(long="--type-clear", type="str", multiple=True),
            Option(short="-.", long="--hidden"),
            Option(long="--no-hidden"),
            Option(short="-u", long="--unrestricted", count=True),
            Option(short="-d", long="--max-depth", type="str"),
            Option(long="--max-filesize", type="str"),
            # A mount is mirage's filesystem boundary: this keeps the walk
            # out of every mount below the one it starts in.
            Option(long="--one-file-system"),
            Option(long="--no-one-file-system"),
            # mirage searches a binary file's bytes as text either way;
            # these lift the walk's binary-extension skip.
            Option(short="-a", long="--text"),
            Option(long="--no-text"),
            Option(long="--binary"),
            Option(long="--no-binary"),
            Option(long="--sort", type="str"),
            Option(long="--sortr", type="str"),
            Option(long="--sort-files"),
            Option(long="--no-sort-files"),
            Option(long="--no-messages"),
            Option(long="--messages"),
            # Accepted no-ops: mirage reads no ignore files and no config
            # file, runs one search at a time, never follows a link while
            # walking, and never writes to a tty, so its output is already
            # what these ask for; the negations restore defaults of
            # features it does not have.
            Option(long="--no-ignore"),
            Option(long="--ignore"),
            Option(long="--no-ignore-dot"),
            Option(long="--ignore-dot"),
            Option(long="--no-ignore-exclude"),
            Option(long="--ignore-exclude"),
            Option(long="--no-ignore-files"),
            Option(long="--ignore-files"),
            Option(long="--no-ignore-global"),
            Option(long="--ignore-global"),
            Option(long="--no-ignore-messages"),
            Option(long="--ignore-messages"),
            Option(long="--no-ignore-parent"),
            Option(long="--ignore-parent"),
            Option(long="--no-ignore-vcs"),
            Option(long="--ignore-vcs"),
            Option(long="--no-require-git"),
            Option(long="--require-git"),
            Option(long="--ignore-file-case-insensitive"),
            Option(long="--no-ignore-file-case-insensitive"),
            Option(long="--no-config"),
            Option(short="-j", long="--threads", type="str"),
            Option(long="--line-buffered"),
            Option(long="--no-line-buffered"),
            Option(long="--block-buffered"),
            Option(long="--no-block-buffered"),
            Option(long="--mmap"),
            Option(long="--no-mmap"),
            Option(long="--no-follow"),
            Option(long="--no-stats"),
            Option(long="--no-crlf"),
            Option(long="--no-multiline"),
            Option(long="--no-multiline-dotall"),
            Option(long="--no-pcre2"),
            Option(long="--no-json"),
            Option(long="--no-search-zip"),
            Option(long="--no-encoding"),
            Option(long="--no-pre"),
            Option(long="--unicode"),
            Option(long="--pcre2-unicode"),
            Option(long="--no-pcre2-unicode"),
            Option(long="--no-auto-hybrid-regex"),
            # Accepted no-op like grep --color (#471), with ripgrep's
            # required value.
            Option(long="--color", type="str"),
        ),
        # --files and --type-list search nothing, so the first operand is
        # a path rather than the pattern.
        positional=(Operand(type="str",
                            provided_by=("-e", "-f", "--files",
                                         "--type-list")), ),
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
        positional=(Operand(type="str", provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
    'jq':
    CommandSpec(
        options=(
            Option(short="-n",
                   long="--null-input",
                   description="Use null as the single input value"),
            Option(short="-R",
                   long="--raw-input",
                   description="Read each line as a string instead of JSON"),
            Option(short="-s",
                   long="--slurp",
                   description="Read all inputs into one array"),
            Option(short="-c",
                   long="--compact-output",
                   description="Compact instead of pretty-printed output"),
            Option(short="-r",
                   long="--raw-output",
                   description="Output strings without quotes or escapes"),
            Option(long="--raw-output0",
                   description="Implies -r and writes NUL after each output"),
            Option(short="-j",
                   long="--join-output",
                   description="Implies -r and writes no trailing newline"),
            Option(short="-a",
                   long="--ascii-output",
                   description="Escape non-ASCII characters in output"),
            Option(short="-S",
                   long="--sort-keys",
                   description="Sort object keys on output"),
            Option(short="-e",
                   long="--exit-status",
                   description="Set the exit status from the last output"),
            Option(long="--tab", description="Indent with tabs"),
            Option(long="--indent",
                   type="int",
                   description="Indent with n spaces (max 7)"),
            Option(short="-M",
                   long="--monochrome-output",
                   description="Disable colored output (already the default)"),
            Option(long="--unbuffered",
                   description="Accepted for compatibility; output is one "
                   "buffer"),
            Option(short="-f",
                   long="--from-file",
                   type="path",
                   description="Read the filter from a file"),
            Option(long="--stream",
                   description="Read each input as its [path, leaf] events"),
            Option(long="--seq",
                   description="Read and write RS-delimited JSON text "
                   "sequences"),
            Option(long="--arg",
                   type="str",
                   pair=True,
                   description="Set $name to a string value"),
            Option(long="--argjson",
                   type="str",
                   pair=True,
                   description="Set $name to a JSON value"),
            Option(long="--rawfile",
                   type="path",
                   pair=True,
                   description="Set $name to a file's contents"),
            Option(long="--slurpfile",
                   type="path",
                   pair=True,
                   description="Set $name to a file's documents, as an "
                   "array"),
            Option(long="--args",
                   description="Read the remaining operands as positional "
                   "string values"),
            Option(long="--jsonargs",
                   description="Read the remaining operands as positional "
                   "JSON values"),
            Option(short="-h",
                   long="--help",
                   description="Show this help and exit"),
        ),
        # Without provided_by, `jq -f prog.jq data.json` would take
        # data.json as the filter and never read it as a file.
        positional=(Operand(type="str", provided_by=("-f", )), ),
        # --args and --jsonargs turn the operands after the program into
        # $ARGS.positional, so they stop being input files.
        rest=Operand(type="path", text_when=("--args", "--jsonargs")),
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
            Option(short="-b", long="--byte-offset"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-L", long="--files-without-match"),
            Option(short="-n"),
            Option(short="-v"),
            Option(short="-e", type="str", multiple=True),
            Option(short="-f", type="path", multiple=True),
            Option(short="-E"),
            Option(short="-G"),
            Option(short="-F"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", type="str"),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-w"),
        ),
        positional=(Operand(type="str", provided_by=("-e", "-f")), ),
        rest=Operand(type="path"),
    ),
}
