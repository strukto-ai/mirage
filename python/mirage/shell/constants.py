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

import re
from collections.abc import Mapping

from mirage.shell.types import (BuiltinGroup, BuiltinTier, NodeType,
                                ShellBuiltin)

# Bash arithmetic tokens: integer literals (base#value/decimal/hex/
# octal), variable names, then operators longest-first so `<<=` never
# lexes as `<<` + `=`.
ARITH_TOKEN = re.compile(
    r"""
    (?P<num>\d+\#[0-9a-zA-Z@_]+|0[xX][0-9a-fA-F]+|\d+)
  | (?P<name>[A-Za-z_]\w*)
  | (?P<op><<=|>>=|\*\*|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\|
       |\+=|-=|\*=|/=|%=|&=|\^=|\|=
       |[-+*/%<>=!~&|^?:(),])
  | (?P<ws>\s+)
  | (?P<bad>.)
""", re.VERBOSE)

ARITH_NAME = re.compile(r"[A-Za-z_]\w*")

# An element reference token the tokenizer stitched: the name adjacent
# to a bracket-matched subscript, whose interior is resolved by the
# element callbacks rather than the tokenizer (an associative key can
# hold characters no arithmetic token may).
ARITH_ELEM = re.compile(r"([A-Za-z_]\w*)\[(.*)\]\Z", re.DOTALL)

ARITH_ASSIGN_OPS = frozenset(
    {"=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="})

# 64-bit wrap like bash (intmax_t arithmetic).
ARITH_WRAP = 1 << 64
ARITH_SIGN = 1 << 63

# Recursion budget for variables holding expressions (`x="1+2"; $((x))`),
# mirroring bash's expression recursion limit.
ARITH_MAX_DEPTH = 16

# What the shell calls itself when no script is running, bash's "bash".
# A nested `bash`/`sh` overrides it through Session.script_name, and
# `Session.argv0` is the one place the two are folded together.
SHELL_ARGV0 = "mirage"

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
SHELL_FDS = frozenset({FD_STDIN, FD_STDOUT, FD_STDERR})

# The two dynamic variables the shell answers itself: PIPESTATUS reads
# the session's record of the last pipeline (`Session.pipe_status`) and
# RANDOM steps a generator (`session/rng.py`). Neither lives in the
# variable store.
PIPESTATUS = "PIPESTATUS"
RANDOM = "RANDOM"
# bash 5.2's generator (lib/sh/random.c): a Park-Miller minimal-standard
# step through Schrage's method, the value folding the state's two
# halves and keeping 15 bits, and a draw that never repeats the value
# before it. A seed is the assigned integer truncated to 32 bits, and a
# zero state steps from ZERO_SEED. Identical in both languages, so
# `RANDOM=42` is the same sequence everywhere, and bash's.
RANDOM_A = 16807
RANDOM_Q = 127773
RANDOM_R = 2836
RANDOM_M = 0x7FFFFFFF
RANDOM_ZERO_SEED = 123459876
RANDOM_MODULUS = 1 << 32
RANDOM_MAX = 32767
# What `Session._random_seed` holds once `unset RANDOM` has stripped the
# name of its meaning: no generated word is ever empty.
RANDOM_UNSET = ""

# Node types whose failure never triggers `set -e` by shape alone.
# Lists are NOT exempt: bash exits when the command after the final
# `&&`/`||` fails; short-circuit failures set Session.errexit_immune
# instead, so the executor loops skip only those.
ERREXIT_EXEMPT_TYPES = frozenset({
    NodeType.NEGATED_COMMAND,
})

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
SET_OPTION_NAMES = frozenset({
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
})

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

# `shopt` names mirage refuses to turn on rather than store: `extglob`
# changes what the *parser* accepts (`!(a).txt` is a pattern, not a
# subshell), and mirage's grammar has no such mode, so a stored `on`
# would promise a syntax that still fails to parse. Refusing is the
# honest answer until the parser learns it.
SHOPT_UNSUPPORTED = frozenset({"extglob"})

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
    ShellBuiltin.TYPE: BuiltinGroup.NAME_LOOKUP,
    ShellBuiltin.WHICH: BuiltinGroup.NAME_LOOKUP,
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
    ShellBuiltin.FG: BuiltinGroup.JOB_CONTROL,
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

GRAMMAR_BUILTINS: frozenset[ShellBuiltin] = frozenset(
    b for b, g in BUILTIN_GROUP.items()
    if GROUP_TIER[g] is BuiltinTier.GRAMMAR)

TOOL_BUILTINS: frozenset[ShellBuiltin] = frozenset(
    b for b, g in BUILTIN_GROUP.items() if GROUP_TIER[g] is BuiltinTier.TOOL)
