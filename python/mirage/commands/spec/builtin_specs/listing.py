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
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "stat": CommandSpec(
        arguments=(
            Argument("-c", "--format"),
            Argument("-f", "--file-system", action="store_true"),
            Argument("-L", "--dereference", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "pwd": CommandSpec(
        arguments=(
            Argument("-P", action="store_true"),
            Argument("-L", action="store_true"),
            Argument("texts", nargs="*", metavar=""),
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
            # `-exec CMD ARGS... ;` is consumed by the expression parser,
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
            Argument("-o", action="store_true"),
            Argument("-or", action="store_true"),
            Argument("-a", action="store_true"),
            Argument("-and", action="store_true"),
            Argument("-not", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
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
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "du": CommandSpec(
        arguments=(
            Argument("-h", action="store_true"),
            Argument("-s", action="store_true"),
            Argument("-a", action="store_true"),
            Argument("-d", "--max-depth"),
            Argument("-c", action="store_true"),
            Argument("-L", action="store_true"),
            Argument("-P", action="store_true"),
            Argument("-S", "--separate-dirs", action="store_true"),
            Argument("-x", "--one-file-system", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "df": CommandSpec(
        arguments=(
            Argument("-h", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-k", action="store_true"),
            Argument("-i", action="store_true"),
            Argument("-a", action="store_true"),
            Argument("-T", action="store_true"),
            Argument("-P", action="store_true"),
            Argument("-B"),
            Argument("paths", type="path", nargs="*", metavar=""),
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
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "file": CommandSpec(
        arguments=(
            Argument("-b", action="store_true"),
            Argument("-i", action="store_true"),
            Argument("-L", action="store_true"),
            Argument("-h", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
