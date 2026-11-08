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

from mirage.commands.spec.constants import PATHS_OPERAND, TEXTS_OPERAND
from mirage.commands.spec.types import Argument, CommandSpec

SPECS: dict[str, CommandSpec] = {
    "ls": CommandSpec(
        arguments=(
            Argument("-l", action="store_true"),
            Argument("-b", "--escape", action="store_true"),
            Argument("-a", "--all", action="store_true"),
            Argument("-A", "--almost-all", action="store_true"),
            Argument("-h", "--human-readable", action="store_true"),
            Argument("-t", action="store_true"),
            Argument("-S", action="store_true"),
            Argument("-X", action="store_true"),
            Argument("-v", action="store_true"),
            Argument("-U", action="store_true"),
            Argument("--sort"),
            Argument("-c", action="store_true"),
            Argument("-u", action="store_true"),
            Argument("--time"),
            Argument("--time-style"),
            Argument("-r", "--reverse", action="store_true"),
            Argument("-1", action="store_true"),
            Argument("-C", action="store_true"),
            Argument("-x", action="store_true"),
            Argument("-m", action="store_true"),
            Argument("--format"),
            Argument("-w", "--width"),
            Argument("-T", "--tabsize"),
            Argument("-s", "--size", action="store_true"),
            Argument("-k", "--kibibytes", action="store_true"),
            Argument("--si", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-I", "--ignore", action="append"),
            Argument("--hide", action="append"),
            Argument("-B", "--ignore-backups", action="store_true"),
            Argument("-Q", "--quote-name", action="store_true"),
            Argument("-N", "--literal", action="store_true"),
            Argument("--quoting-style"),
            Argument("-q", "--hide-control-chars", action="store_true"),
            Argument("--show-control-chars", action="store_true"),
            Argument("--full-time", action="store_true"),
            Argument("-G", "--no-group", action="store_true"),
            Argument("-R", "--recursive", action="store_true"),
            Argument("-d", "--directory", action="store_true"),
            # -F classifies outright; only the long form takes GNU's WHEN.
            Argument(
                "-F",
                "--classify",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument("-p", action="store_true"),
            Argument("--file-type", action="store_true"),
            Argument("--indicator-style"),
            Argument("-L", "--dereference", action="store_true"),
            Argument("-H", "--dereference-command-line", action="store_true"),
            Argument(
                "--dereference-command-line-symlink-to-dir",
                action="store_true",
            ),
            Argument("-g", action="store_true"),
            Argument("-o", action="store_true"),
            Argument("-n", "--numeric-uid-gid", action="store_true"),
            Argument("-i", "--inode", action="store_true"),
            # Accepted no-op like grep --color (#471).
            Argument("--color", nargs="?", attached_only=True),
            Argument("--group-directories-first", action="store_true"),
            Argument("--block-size"),
            Argument("--hyperlink", nargs="?", attached_only=True),
            Argument("-Z", "--context", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "stat": CommandSpec(
        arguments=(
            Argument("-c", "--format"),
            Argument("--printf"),
            Argument("-f", "--file-system", action="store_true"),
            Argument("-L", "--dereference", action="store_true"),
            Argument("-t", "--terse", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "pwd": CommandSpec(
        arguments=(
            Argument("-P", action="store_true"),
            Argument("-L", action="store_true"),
            TEXTS_OPERAND,
        )
    ),
    "find": CommandSpec(
        # `!` is GNU's negation, spelled without a leading dash, so the
        # rest slot's PATH kind would read it as a start point. It joins
        # the parens here rather than becoming an option: an option is
        # matched by spelling and `-not` already covers that half, while
        # these three are grammar the expression parser consumes.
        ignore_tokens=frozenset({"(", ")", "!"}),
        arguments=(
            Argument("-name", action="append"),
            Argument("-type", action="append"),
            Argument("-maxdepth", action="append"),
            Argument("-size", action="append"),
            Argument("-mtime", action="append"),
            Argument("-iname", action="append"),
            Argument("-path", action="append"),
            Argument("-mindepth", action="append"),
            Argument("-printf", action="append"),
            Argument("-newer", action="append"),
            Argument("-newermt", action="append"),
            Argument("-ipath", action="append"),
            Argument("-wholename", action="append"),
            Argument("-iwholename", action="append"),
            Argument("-regex", action="append"),
            Argument("-iregex", action="append"),
            Argument("-regextype", action="append"),
            Argument("-lname", action="append"),
            Argument("-ilname", action="append"),
            Argument("-xtype", action="append"),
            Argument("-perm", action="append"),
            Argument("-links", action="append"),
            Argument("-atime", action="append"),
            Argument("-ctime", action="append"),
            Argument("-mmin", action="append"),
            Argument("-amin", action="append"),
            Argument("-cmin", action="append"),
            Argument("-user", action="append"),
            Argument("-group", action="append"),
            Argument("-uid", action="append"),
            Argument("-gid", action="append"),
            Argument("-fprint", action="append"),
            Argument("-fprint0", action="append"),
            Argument("-fprintf", action="extend", nargs=2),
            Argument("-files0-from", action="append"),
            # `-exec CMD ARGS... ;` (and `-execdir`) is consumed by the
            # expression parser,
            # never by this spec: the classifier keeps its words as text
            # (`exec_spans`), and there is no argparse shape for an
            # option whose argument is a program.
            # GNU find's link policy: -P (no follow) is the default, -H
            # follows only the start point, -L follows everything.
            Argument("-P", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-L", action="store_true"),
            Argument("-print", action="store_true"),
            Argument("-print0", action="store_true"),
            Argument("-delete", action="store_true"),
            Argument("-depth", action="store_true"),
            Argument("-xdev", action="store_true"),
            Argument("-mount", action="store_true"),
            Argument("-prune", action="store_true"),
            Argument("-ls", action="store_true"),
            Argument("-empty", action="store_true"),
            Argument("-quit", action="store_true"),
            Argument("-true", action="store_true"),
            Argument("-false", action="store_true"),
            Argument("-readable", action="store_true"),
            Argument("-writable", action="store_true"),
            Argument("-executable", action="store_true"),
            Argument("-nouser", action="store_true"),
            Argument("-nogroup", action="store_true"),
            Argument("-daystart", action="store_true"),
            Argument("-follow", action="store_true"),
            Argument("-o", action="store_true"),
            Argument("-or", action="store_true"),
            Argument("-a", action="store_true"),
            Argument("-and", action="store_true"),
            Argument("-not", action="store_true"),
            PATHS_OPERAND,
        ),
    ),
    "tree": CommandSpec(
        arguments=(
            Argument("-a", action="store_true"),
            Argument("-L"),
            Argument("-I"),
            Argument("-d", action="store_true"),
            Argument("-P"),
            Argument("-x", action="store_true"),
            PATHS_OPERAND,
        )
    ),
    "du": CommandSpec(
        arguments=(
            Argument("-h", "--human-readable", action="store_true"),
            Argument("-s", "--summarize", action="store_true"),
            Argument("-a", "--all", action="store_true"),
            Argument("-d", "--max-depth"),
            Argument("-c", "--total", action="store_true"),
            Argument("-L", "--dereference", action="store_true"),
            Argument("-P", "--no-dereference", action="store_true"),
            Argument("-S", "--separate-dirs", action="store_true"),
            Argument("-x", "--one-file-system", action="store_true"),
            Argument("-b", "--bytes", action="store_true"),
            Argument("--apparent-size", action="store_true"),
            Argument("-k", action="store_true"),
            Argument("-m", action="store_true"),
            Argument("-B", "--block-size"),
            Argument("--si", action="store_true"),
            Argument("--inodes", action="store_true"),
            Argument("-l", "--count-links", action="store_true"),
            Argument("-D", "--dereference-args", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-0", "--null", action="store_true"),
            Argument("--exclude", action="append"),
            Argument("-X", "--exclude-from", type="path", action="append"),
            # Two entries for one option, so a refused value is worded
            # with the spelling typed.
            Argument("-t"),
            Argument("--threshold"),
            Argument("--time", nargs="?", attached_only=True),
            Argument("--time-style"),
            PATHS_OPERAND,
        )
    ),
    "df": CommandSpec(
        arguments=(
            Argument("-h", "--human-readable", action="store_true"),
            Argument("-H", "--si", action="store_true"),
            Argument("-k", action="store_true"),
            Argument("-i", "--inodes", action="store_true"),
            Argument("-a", "--all", action="store_true"),
            Argument("-T", "--print-type", action="store_true"),
            Argument("-P", "--portability", action="store_true"),
            Argument("-B", "--block-size"),
            PATHS_OPERAND,
        )
    ),
    "mount": CommandSpec(
        description="Mount a filesystem.",
        arguments=(
            Argument(
                "-a",
                "--all",
                action="store_true",
                help="Mount all filesystems mentioned in fstab.",
            ),
            Argument(
                "-f",
                "--fake",
                action="store_true",
                help="Dry run; skip the mount(2) syscall.",
            ),
            Argument(
                "-l",
                "--show-labels",
                action="store_true",
                help="Show also filesystem labels.",
            ),
            Argument(
                "-n",
                "--no-mtab",
                action="store_true",
                help="Don't write to /etc/mtab.",
            ),
            Argument(
                "-o",
                "--options",
                help="Comma-separated list of mount options.",
            ),
            Argument(
                "-r",
                "--read-only",
                action="store_true",
                help="Mount the filesystem read-only.",
            ),
            Argument(
                "-t",
                "--types",
                help="Limit the set of filesystem types.",
            ),
            Argument(
                "-v",
                "--verbose",
                action="store_true",
                help="Say what is being done.",
            ),
            Argument(
                "-w",
                "--rw",
                action="store_true",
                help="Mount the filesystem read-write (default).",
            ),
            Argument(
                "-B",
                "--bind",
                action="store_true",
                help="Mount a subtree somewhere else.",
            ),
            Argument(
                "-M",
                "--move",
                action="store_true",
                help="Move a subtree to some other place.",
            ),
            Argument(
                "-R",
                "--rbind",
                action="store_true",
                help="Mount a subtree and all submounts somewhere else.",
            ),
            TEXTS_OPERAND,
        ),
    ),
    "file": CommandSpec(
        arguments=(
            Argument("-b", action="store_true"),
            Argument("-i", action="store_true"),
            Argument("-L", action="store_true"),
            Argument("-h", action="store_true"),
            PATHS_OPERAND,
        )
    ),
}
