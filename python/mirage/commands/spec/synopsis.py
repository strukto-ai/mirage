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

# The first line of each program's own ``--help``, keyed by command
# name and bare of the ``Usage: `` prefix, which belongs to the renderer.
# GNU coreutils 9.7, grep 3.11, tar 1.35, gzip 1.13, Info-ZIP 3.0 on
# ``debian:stable-slim``; gunzip, zcat and zgrep are spelled by their own
# name rather than gzip's. A command absent here renders the synopsis
# synthesized from its slots.
SYNOPSES: dict[str, str] = {
    "base64": "base64 [OPTION]... [FILE]",
    "basename": "basename NAME [SUFFIX]",
    "cat": "cat [OPTION]... [FILE]...",
    "chgrp": "chgrp [OPTION]... GROUP FILE...",
    "chmod": "chmod [OPTION]... MODE[,MODE]... FILE...",
    "chown": "chown [OPTION]... [OWNER][:[GROUP]] FILE...",
    "cmp": "cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]",
    "comm": "comm [OPTION]... FILE1 FILE2",
    "cp": "cp [OPTION]... [-T] SOURCE DEST",
    "csplit": "csplit [OPTION]... FILE PATTERN...",
    "cut": "cut OPTION... [FILE]...",
    "date": "date [OPTION]... [+FORMAT]",
    "df": "df [OPTION]... [FILE]...",
    "diff": "diff [OPTION]... FILES",
    "dirname": "dirname [OPTION] NAME...",
    "du": "du [OPTION]... [FILE]...",
    "expand": "expand [OPTION]... [FILE]...",
    "expr": "expr EXPRESSION",
    "find":
    "find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]",
    "fmt": "fmt [-WIDTH] [OPTION]... [FILE]...",
    "fold": "fold [OPTION]... [FILE]...",
    "getfattr": "getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...",
    "grep": "grep [OPTION]... PATTERNS [FILE]...",
    "gunzip": "gunzip [OPTION]... [FILE]...",
    "gzip": "gzip [OPTION]... [FILE]...",
    "head": "head [OPTION]... [FILE]...",
    "iconv": "iconv [OPTION...] [FILE...]",
    "join": "join [OPTION]... FILE1 FILE2",
    "ln": "ln [OPTION]... [-T] TARGET LINK_NAME",
    "ls": "ls [OPTION]... [FILE]...",
    "md5sum": "md5sum [OPTION]... [FILE]...",
    "mkdir": "mkdir [OPTION]... DIRECTORY...",
    "mktemp": "mktemp [OPTION]... [TEMPLATE]",
    "mv": "mv [OPTION]... [-T] SOURCE DEST",
    "nl": "nl [OPTION]... [FILE]...",
    "numfmt": "numfmt [OPTION]... [NUMBER]...",
    "od": "od [OPTION]... [FILE]...",
    "paste": "paste [OPTION]... [FILE]...",
    "readlink": "readlink [OPTION]... FILE...",
    "realpath": "realpath [OPTION]... FILE...",
    "rm": "rm [OPTION]... [FILE]...",
    "rmdir": "rmdir [OPTION]... DIRECTORY...",
    "sed": "sed [OPTION]... {script-only-if-no-other-script} [input-file]...",
    "seq": "seq [OPTION]... LAST",
    "setfattr": "setfattr {-n name} [-v value] [-h] file...",
    "sha1sum": "sha1sum [OPTION]... [FILE]...",
    "sha256sum": "sha256sum [OPTION]... [FILE]...",
    "sha384sum": "sha384sum [OPTION]... [FILE]...",
    "sha512sum": "sha512sum [OPTION]... [FILE]...",
    "shuf": "shuf [OPTION]... [FILE]",
    "sleep": "sleep NUMBER[SUFFIX]...",
    "sort": "sort [OPTION]... [FILE]...",
    "split": "split [OPTION]... [FILE [PREFIX]]",
    "stat": "stat [OPTION]... FILE...",
    "tac": "tac [OPTION]... [FILE]...",
    "tail": "tail [OPTION]... [FILE]...",
    "tar": "tar [OPTION...] [FILE]...",
    "tee": "tee [OPTION]... [FILE]...",
    "touch": "touch [OPTION]... FILE...",
    "tr": "tr [OPTION]... STRING1 [STRING2]",
    "truncate": "truncate OPTION... FILE...",
    "tsort": "tsort [OPTION] [FILE]",
    "unexpand": "unexpand [OPTION]... [FILE]...",
    "uniq": "uniq [OPTION]... [INPUT [OUTPUT]]",
    "unlink": "unlink FILE",
    "wc": "wc [OPTION]... [FILE]...",
    "zcat": "zcat [OPTION]... [FILE]...",
    "zgrep": "zgrep [OPTION]... [-e] PATTERN [FILE]...",
}
