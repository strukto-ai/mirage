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

from collections.abc import Mapping

from mirage.shell.types import (
    BuiltinGroup,
    BuiltinTier,
    NodeType,
    ShellBuiltin,
)

# How deep the shell may re-enter itself: function calls, sourced files, `eval`
# lines and nested shells (`bash -c`, a script) together. bash limits none of
# them unless FUNCNEST names a limit on functions; mirage serves every session
# from one process, where `f(){ echo $(f); }; f` or a file sourcing itself
# would take the memory they all share, so a re-entry this deep is refused, and
# FUNCNEST may only lower the limit on functions. Python's stack holds a body
# nesting three compound commands (about 30 frames a level) this deep.
NESTING_MAX = 32

# What the shell calls itself when no script is running, bash's "bash".
# A nested `bash`/`sh` overrides it through SessionState.script_name, and
# `SessionState.argv0` is the one place the two are folded together.
SHELL_ARGV0 = "mirage"

# The one directory PATH names, bash's default PATH for a shell that
# starts without one: every program a session can run has a file here
# (the /usr/bin view mount), which is the path which, type and
# command -v report.
BIN_PREFIX = "/usr/bin"

# The IFS a shell starts with, what an unset IFS splits on, and the
# characters of any IFS that count as its whitespace.
IFS_DEFAULT = " \t\n"

# What bash says when fork(2) fails with EAGAIN, as at `ulimit -u`: the
# forking shell abandons the rest of its line with status 254 (bash 5.2,
# pinned in debian:stable-slim), and a subshell dying of it reports 254
# to its parent. A session's `processes.max` is the cap here. bash first
# retries with backoff, printing `fork: retry:`; the refusal here is
# immediate.
FORK_FAILED = b"bash: fork: Resource temporarily unavailable\n"
FORK_FAILED_STATUS = 254

# The statuses a command ends with when it did not run its course, as
# bash and coreutils report them: GNU timeout's 124 (also a line past its
# timeout budget), 126 for a command found but refused (not executable, a
# policy deny, a runtime that would not take it, an argument list too
# long), 127 for one not found, and 128 + the signal for an interrupt
# (SIGINT) or a write to a closed pipe (SIGPIPE).
TIMEOUT_STATUS = 124
CANNOT_EXECUTE_STATUS = 126
NOT_FOUND_STATUS = 127
INTERRUPTED_STATUS = 130
SIGPIPE_STATUS = 141

# The descriptors the shell models: stdin, stdout and stderr, and no
# table above them. A redirect naming any other number is refused
# before it does anything (`shell/descriptors.py`), because the old
# fall-through aliased fd 3 onto stdout and `exec 3>&-` closed the
# session's stdout. FD_BOTH is `Redirect.fd` for `&>`; FD_CLOSE is
# `Redirect.target` for `>&-`.
FD_STDIN = 0
FD_STDOUT = 1
FD_STDERR = 2
FD_BOTH = -1
FD_CLOSE = -1

# Builtins that read and write no file of their own, so a write
# redirect on one can wait for their output: nothing they do can see a
# target emptied early. `printf -v` assigns a variable instead, and is
# opened first like any other command (`redirect.py`).
OUTPUT_ONLY_BUILTINS = frozenset({"echo", "printf", "true", "false", ":"})

# The dynamic variables the shell answers itself: PIPESTATUS reads the
# session's record of the last pipeline (`SessionState.pipe_status`) and
# FUNCNAME the frames on the call stack (`SessionState.function_names`),
# neither held in the variable store, and BASH_LINENO the line each was
# called from, which no unset ends; RANDOM steps mirage-rs's generator,
# which stores each draw on the name; LINENO is the running command's
# line and BASHPID the process running it.
PIPESTATUS = "PIPESTATUS"
FUNCNAME = "FUNCNAME"
BASH_LINENO = "BASH_LINENO"
RANDOM = "RANDOM"
LINENO = "LINENO"
BASHPID = "BASHPID"
PPID = "PPID"

# Node types whose failure never triggers `set -e` by shape alone.
# Lists are NOT exempt: bash exits when the command after the final
# `&&`/`||` fails; short-circuit failures set SessionState.errexit_immune
# instead, so the executor loops skip only those.
ERREXIT_EXEMPT_TYPES = frozenset(
    {
        NodeType.NEGATED_COMMAND,
    }
)

# Statements whose failure the ERR trap does not answer again: a group,
# `if`, a loop and `case` ran it for their own failing command already,
# and an `&&`/`||` list for its right command. A subshell and a function
# call are answered, since the trap is hidden inside them unless `set -E`
# (pinned against bash 5.2.37).
ERR_TRAP_EXEMPT_TYPES = ERREXIT_EXEMPT_TYPES | {
    NodeType.LIST,
    NodeType.COMPOUND_STATEMENT,
    NodeType.IF_STATEMENT,
    NodeType.WHILE_STATEMENT,
    NodeType.FOR_STATEMENT,
    NodeType.C_STYLE_FOR_STATEMENT,
    NodeType.CASE_STATEMENT,
}

# Every letter bash's `set` accepts, mapped to the `-o` name it is a
# synonym for. The full table is here rather than only the letters
# mirage acts on, because a letter left out is silently dropped: `set -C`
# read as "no such option, ignore" is exactly the silent-accept the
# fail-loud rule exists to stop, and it made noclobber unreachable by its
# own letter while `set -o noclobber` worked.
SET_FLAG_TO_OPTION = {
    "a": "allexport",
    "b": "notify",
    "e": "errexit",
    "f": "noglob",
    "h": "hashall",
    "k": "keyword",
    "m": "monitor",
    "n": "noexec",
    "p": "privileged",
    "t": "onecmd",
    "u": "nounset",
    "v": "verbose",
    "x": "xtrace",
    "B": "braceexpand",
    "C": "noclobber",
    "E": "errtrace",
    "H": "histexpand",
    "P": "physical",
    "T": "functrace",
}

# Every name GNU's `set -o` accepts, pinned from `set -o` on
# debian:stable-slim. mirage acts on a few and stores the rest, mirroring
# how a cluster letter naming no option is kept rather than refused. A
# name absent from here is the one thing bash rejects outright, and it
# rejects it with exit 2 -- which is what keeps a silently-ignored
# `set -o physical` from looking supported.
SET_OPTION_NAMES = frozenset(
    {
        "allexport",
        "braceexpand",
        "emacs",
        "errexit",
        "errtrace",
        "functrace",
        "hashall",
        "histexpand",
        "history",
        "ignoreeof",
        "interactive-comments",
        "keyword",
        "monitor",
        "noclobber",
        "noexec",
        "noglob",
        "nolog",
        "notify",
        "nounset",
        "onecmd",
        "physical",
        "pipefail",
        "posix",
        "privileged",
        "verbose",
        "vi",
        "xtrace",
    }
)

# Every name GNU's `shopt` accepts and what it reads as before anything
# sets it, pinned from `bash -c shopt` on debian:stable-slim (5.2.37), in
# the order bash lists them (which is alphabetical except that
# `assoc_expand_once` follows `autocd`). Kept apart from SET_OPTION_NAMES
# because bash keeps two vocabularies: `set -o` and `shopt`, with
# `shopt -o` as the one bridge. mirage acts on the glob ones and on
# `expand_aliases`, and stores the rest so a listing prints every option
# bash knows and `shopt -q` answers the same way it would there.
SHOPT_DEFAULTS: dict[str, bool] = {
    "autocd": False,
    "assoc_expand_once": False,
    "cdable_vars": False,
    "cdspell": False,
    "checkhash": False,
    "checkjobs": False,
    "checkwinsize": True,
    "cmdhist": True,
    "compat31": False,
    "compat32": False,
    "compat40": False,
    "compat41": False,
    "compat42": False,
    "compat43": False,
    "compat44": False,
    "complete_fullquote": True,
    "direxpand": False,
    "dirspell": False,
    "dotglob": False,
    "execfail": False,
    "expand_aliases": False,
    "extdebug": False,
    "extglob": False,
    "extquote": True,
    "failglob": False,
    "force_fignore": True,
    "globasciiranges": True,
    "globskipdots": True,
    "globstar": False,
    "gnu_errfmt": False,
    "histappend": False,
    "histreedit": False,
    "histverify": False,
    "hostcomplete": True,
    "huponexit": False,
    "inherit_errexit": False,
    "interactive_comments": True,
    "lastpipe": False,
    "lithist": False,
    "localvar_inherit": False,
    "localvar_unset": False,
    "login_shell": False,
    "mailwarn": False,
    "no_empty_cmd_completion": False,
    "nocaseglob": False,
    "nocasematch": False,
    "noexpand_translation": False,
    "nullglob": False,
    "patsub_replacement": True,
    "progcomp": True,
    "progcomp_alias": False,
    "promptvars": True,
    "restricted_shell": False,
    "shift_verbose": False,
    "sourcepath": True,
    "varredir_close": False,
    "xpg_echo": False,
}

# What each option reads as before anything sets it, pinned from
# `bash -c 'set -o'` on debian:stable-slim (5.2.37). Only three are on,
# and all three are on for a non-interactive shell too, so this is the
# table `set -o` prints rather than an interactive shell's.
SET_OPTION_DEFAULTS: dict[str, bool] = {
    name: name in ("braceexpand", "hashall", "interactive-comments")
    for name in sorted(SET_OPTION_NAMES)
}

GROUP_TIER: Mapping[BuiltinGroup, BuiltinTier] = {
    BuiltinGroup.WORKING_DIRECTORY: BuiltinTier.GRAMMAR,
    BuiltinGroup.VARIABLES: BuiltinTier.GRAMMAR,
    BuiltinGroup.SHELL_STATE: BuiltinTier.GRAMMAR,
    BuiltinGroup.CONDITIONS: BuiltinTier.GRAMMAR,
    BuiltinGroup.OUTPUT: BuiltinTier.GRAMMAR,
    BuiltinGroup.RUNNING_LINES: BuiltinTier.GRAMMAR,
    BuiltinGroup.NAME_LOOKUP: BuiltinTier.GRAMMAR,
    BuiltinGroup.CONTROL_FLOW: BuiltinTier.GRAMMAR,
    BuiltinGroup.ENVIRONMENT: BuiltinTier.TOOL,
    BuiltinGroup.MANUALS_AND_HISTORY: BuiltinTier.TOOL,
    BuiltinGroup.JOB_CONTROL: BuiltinTier.TOOL,
    BuiltinGroup.CLOCK: BuiltinTier.TOOL,
    BuiltinGroup.NESTED_SHELLS: BuiltinTier.TOOL,
    BuiltinGroup.INTERPRETERS: BuiltinTier.TOOL,
    BuiltinGroup.COMMAND_RUNNERS: BuiltinTier.TOOL,
}

# One row per ShellBuiltin. tests/shell/test_types.py pins that the rows
# cover the enum, that every group is used, and that the tier sets below
# are the rows' partition, so a new member has to be filed here on
# purpose.
BUILTIN_GROUP: Mapping[ShellBuiltin, BuiltinGroup] = {
    ShellBuiltin.PWD: BuiltinGroup.WORKING_DIRECTORY,
    ShellBuiltin.CD: BuiltinGroup.WORKING_DIRECTORY,
    ShellBuiltin.EXPORT: BuiltinGroup.VARIABLES,
    ShellBuiltin.UNSET: BuiltinGroup.VARIABLES,
    ShellBuiltin.LOCAL: BuiltinGroup.VARIABLES,
    ShellBuiltin.DECLARE: BuiltinGroup.VARIABLES,
    ShellBuiltin.TYPESET: BuiltinGroup.VARIABLES,
    ShellBuiltin.READONLY: BuiltinGroup.VARIABLES,
    ShellBuiltin.SET: BuiltinGroup.VARIABLES,
    ShellBuiltin.READ: BuiltinGroup.VARIABLES,
    ShellBuiltin.MAPFILE: BuiltinGroup.VARIABLES,
    ShellBuiltin.READARRAY: BuiltinGroup.VARIABLES,
    ShellBuiltin.SHIFT: BuiltinGroup.VARIABLES,
    ShellBuiltin.GETOPTS: BuiltinGroup.VARIABLES,
    ShellBuiltin.LET: BuiltinGroup.VARIABLES,
    ShellBuiltin.TRAP: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.SHOPT: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.UMASK: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.ALIAS: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.UNALIAS: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.EXEC: BuiltinGroup.SHELL_STATE,
    ShellBuiltin.TEST: BuiltinGroup.CONDITIONS,
    ShellBuiltin.BRACKET: BuiltinGroup.CONDITIONS,
    ShellBuiltin.DOUBLE_BRACKET: BuiltinGroup.CONDITIONS,
    ShellBuiltin.ECHO: BuiltinGroup.OUTPUT,
    ShellBuiltin.PRINTF: BuiltinGroup.OUTPUT,
    ShellBuiltin.SOURCE: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.DOT: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.EVAL: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.COMMAND: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.BUILTIN: BuiltinGroup.RUNNING_LINES,
    ShellBuiltin.TYPE: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.WHICH: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.HELP: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.TRUE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.FALSE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.COLON: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.BREAK: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.CONTINUE: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.RETURN: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.EXIT: BuiltinGroup.CONTROL_FLOW,
    ShellBuiltin.PRINTENV: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.ENV: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.WHOAMI: BuiltinGroup.ENVIRONMENT,
    ShellBuiltin.MAN: BuiltinGroup.MANUALS_AND_HISTORY,
    ShellBuiltin.HISTORY: BuiltinGroup.MANUALS_AND_HISTORY,
    ShellBuiltin.WAIT: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.KILL: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.JOBS: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.DISOWN: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.PS: BuiltinGroup.JOB_CONTROL,
    ShellBuiltin.SLEEP: BuiltinGroup.CLOCK,
    ShellBuiltin.BASH: BuiltinGroup.NESTED_SHELLS,
    ShellBuiltin.SH: BuiltinGroup.NESTED_SHELLS,
    ShellBuiltin.PYTHON: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.PYTHON3: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.NODE: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.JS: BuiltinGroup.INTERPRETERS,
    ShellBuiltin.XARGS: BuiltinGroup.COMMAND_RUNNERS,
    ShellBuiltin.TIMEOUT: BuiltinGroup.COMMAND_RUNNERS,
}

# The commands that start a shell of their own, a process whose own
# programs a signal it ignores still reaches.
NESTED_SHELLS: frozenset[ShellBuiltin] = frozenset(
    b for b, g in BUILTIN_GROUP.items() if g is BuiltinGroup.NESTED_SHELLS
)

# What every bash ignores, interactive or not: a QUIT stops the program a
# shell runs right now, never the shell.
SHELL_IGNORED_SIGNALS = frozenset({3})

# Linux's signal numbers by the names bash 5.2 gives them in `kill -l` and
# `trap -l` (debian:stable-slim). 32 and 33 have no name; 34 to 64 are the
# realtime range, named from its two ends.
SIGNALS: dict[int, str] = {
    1: "HUP",
    2: "INT",
    3: "QUIT",
    4: "ILL",
    5: "TRAP",
    6: "ABRT",
    7: "BUS",
    8: "FPE",
    9: "KILL",
    10: "USR1",
    11: "SEGV",
    12: "USR2",
    13: "PIPE",
    14: "ALRM",
    15: "TERM",
    16: "STKFLT",
    17: "CHLD",
    18: "CONT",
    19: "STOP",
    20: "TSTP",
    21: "TTIN",
    22: "TTOU",
    23: "URG",
    24: "XCPU",
    25: "XFSZ",
    26: "VTALRM",
    27: "PROF",
    28: "WINCH",
    29: "IO",
    30: "PWR",
    31: "SYS",
}

SIGRTMIN = 34
SIGRTMAX = 64

# How bash names a signal that ended a command in its report line
# (debian:stable-slim, bash 5.2), for each signal whose default ends a
# process; the realtime range is "Real-time signal" and its offset from
# RTMIN.
SIGNAL_DESCRIPTIONS: dict[int, str] = {
    1: "Hangup",
    2: "Interrupt",
    3: "Quit",
    4: "Illegal instruction",
    5: "Trace/breakpoint trap",
    6: "Aborted",
    7: "Bus error",
    8: "Floating point exception",
    9: "Killed",
    10: "User defined signal 1",
    11: "Segmentation fault",
    12: "User defined signal 2",
    13: "Broken pipe",
    14: "Alarm clock",
    15: "Terminated",
    16: "Stack fault",
    24: "CPU time limit exceeded",
    25: "File size limit exceeded",
    26: "Virtual timer expired",
    27: "Profiling timer expired",
    29: "I/O possible",
    30: "Power failure",
    31: "Bad system call",
}

# The signals no report names when they end a job's last process: INT and
# PIPE end it silently, TERM as "Terminated" alone in the foreground.
UNREPORTED_SIGNALS = frozenset({2, 13})
SIGTERM = 15
SIGKILL = 9
SIGCHLD = 17
SIGSTOP = 19
SIGCONT = 18

# Signals whose default action leaves a process running.
CONTINUE_SIGNALS = frozenset({0, SIGCHLD, 18, 23, 28})

# The job-control stops.
STOP_SIGNALS = frozenset({SIGSTOP, 20, 21, 22})
