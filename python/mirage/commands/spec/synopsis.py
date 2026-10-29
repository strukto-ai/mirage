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
# GNU coreutils 9.7, grep 3.11, tar 1.35, gzip 1.13, findutils 4.10,
# Info-ZIP 3.0, glibc 2.41, hostname 3.25, util-linux 2.41.5 and man-db
# 2.13 on ``debian:stable-slim``; gunzip, zcat and zgrep are spelled by
# their own name rather than gzip's. A command absent here renders the
# synopsis synthesized from its slots.
SYNOPSES: dict[str, str] = {
    "b2sum": "b2sum [OPTION]... [FILE]...",
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
    "find": "find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]",
    "fmt": "fmt [-WIDTH] [OPTION]... [FILE]...",
    "fold": "fold [OPTION]... [FILE]...",
    "getconf": "getconf [-v SPEC] VAR",
    "getfattr": "getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...",
    "grep": "grep [OPTION]... PATTERNS [FILE]...",
    "gunzip": "gunzip [OPTION]... [FILE]...",
    "gzip": "gzip [OPTION]... [FILE]...",
    "head": "head [OPTION]... [FILE]...",
    "hostname": "hostname [-b] {hostname|-F file}         set host name "
    "(from file)",
    "id": "id [OPTION]... [USER]...",
    "iconv": "iconv [OPTION...] [FILE...]",
    "join": "join [OPTION]... FILE1 FILE2",
    "ln": "ln [OPTION]... [-T] TARGET LINK_NAME",
    "ls": "ls [OPTION]... [FILE]...",
    "man": "man [OPTION...] [SECTION] PAGE...",
    "md5sum": "md5sum [OPTION]... [FILE]...",
    "mkdir": "mkdir [OPTION]... DIRECTORY...",
    "mktemp": "mktemp [OPTION]... [TEMPLATE]",
    "mount": "mount [-lhV]",
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
    "sha224sum": "sha224sum [OPTION]... [FILE]...",
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
    "timeout": "timeout [OPTION] DURATION COMMAND [ARG]...",
    "touch": "touch [OPTION]... FILE...",
    "tr": "tr [OPTION]... STRING1 [STRING2]",
    "truncate": "truncate OPTION... FILE...",
    "tsort": "tsort [OPTION] [FILE]",
    "uname": "uname [OPTION]...",
    "unexpand": "unexpand [OPTION]... [FILE]...",
    "uniq": "uniq [OPTION]... [INPUT [OUTPUT]]",
    "unlink": "unlink FILE",
    "wc": "wc [OPTION]... [FILE]...",
    "xargs": "xargs [OPTION]... COMMAND [INITIAL-ARGS]...",
    "zcat": "zcat [OPTION]... [FILE]...",
    "zgrep": "zgrep [OPTION]... [-e] PATTERN [FILE]...",
}

# The synopsis of each command the shell runs itself and of each compound
# command, as bash 5.2 spells it first in `help NAME` and last in a usage
# error, keyed by the name `help` lists it under. These names are the
# topics `help` knows; `pwd`, `echo` and `printf` are also programs, whose
# synopses are the ones above.
SHELL_SYNOPSES: dict[str, str] = {
    "(( ... ))": "(( expression ))",
    ".": ". filename [arguments]",
    ":": ":",
    "[": "[ arg... ]",
    "[[ ... ]]": "[[ expression ]]",
    "alias": "alias [-p] [name[=value] ... ]",
    "break": "break [n]",
    "case": "case WORD in [PATTERN [| PATTERN]...) COMMANDS ;;]... esac",
    "cd": "cd [-L|[-P [-e]] [-@]] [dir]",
    "command": "command [-pVv] command [arg ...]",
    "continue": "continue [n]",
    "declare": (
        "declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p "
        "[-aAfFilnrtux] [name ...]"
    ),
    "disown": "disown [-h] [-ar] [jobspec ... | pid ...]",
    "echo": "echo [-neE] [arg ...]",
    "eval": "eval [arg ...]",
    "exec": "exec [-cl] [-a name] [command [argument ...]] [redirection ...]",
    "exit": "exit [n]",
    "export": "export [-fn] [name[=value] ...] or export -p",
    "false": "false",
    "fg": "fg [job_spec]",
    "for": "for NAME [in WORDS ... ] ; do COMMANDS; done",
    "for ((": "for (( exp1; exp2; exp3 )); do COMMANDS; done",
    "function": "function name { COMMANDS ; } or name () { COMMANDS ; }",
    "getopts": "getopts optstring name [arg ...]",
    "help": "help [-dms] [pattern ...]",
    "history": (
        "history [-c] [-d offset] [n] or history -anrw [filename] or history "
        "-ps arg [arg...]"
    ),
    "if": (
        "if COMMANDS; then COMMANDS; [ elif COMMANDS; then COMMANDS; ]... [ "
        "else COMMANDS; ] fi"
    ),
    "jobs": "jobs [-lnprs] [jobspec ...] or jobs -x command [args]",
    "kill": (
        "kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill "
        "-l [sigspec]"
    ),
    "let": "let arg [arg ...]",
    "local": "local [option] name[=value] ...",
    "mapfile": (
        "mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] "
        "[-C callback] [-c quantum] [array]"
    ),
    "printf": "printf [-v var] format [arguments]",
    "pwd": "pwd [-LP]",
    "read": (
        "read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] "
        "[-p prompt] [-t timeout] [-u fd] [name ...]"
    ),
    "readarray": (
        "readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] "
        "[-C callback] [-c quantum] [array]"
    ),
    "readonly": "readonly [-aAf] [name[=value] ...] or readonly -p",
    "return": "return [n]",
    "select": "select NAME [in WORDS ... ;] do COMMANDS; done",
    "set": "set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]",
    "shift": "shift [n]",
    "shopt": "shopt [-pqsu] [-o] [optname ...]",
    "source": "source filename [arguments]",
    "test": "test [expr]",
    "time": "time [-p] pipeline",
    "trap": "trap [-lp] [[arg] signal_spec ...]",
    "true": "true",
    "type": "type [-afptP] name [name ...]",
    "typeset": (
        "typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p "
        "[-aAfFilnrtux] [name ...]"
    ),
    "umask": "umask [-p] [-S] [mode]",
    "unalias": "unalias [-a] name [name ...]",
    "unset": "unset [-f] [-v] [-n] [name ...]",
    "until": "until COMMANDS; do COMMANDS-2; done",
    "wait": "wait [-fn] [-p var] [id ...]",
    "while": "while COMMANDS; do COMMANDS-2; done",
    "{ ... }": "{ COMMANDS ; }",
}
