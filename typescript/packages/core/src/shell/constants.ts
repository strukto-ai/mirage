// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { compareCodePoints } from '../utils/sort.ts'
import { BuiltinGroup, BuiltinTier, NodeType, ShellBuiltin } from './types.ts'

// Bash arithmetic tokens: integer literals (base#value/decimal/hex/
// octal), variable names, then operators longest-first so `<<=` never
// lexes as `<<` + `=`.
export const ARITH_TOKEN = new RegExp(
  [
    '(\\d+#[0-9a-zA-Z@_]+|0[xX][0-9a-fA-F]+|\\d+)',
    '([A-Za-z_]\\w*)',
    '(<<=|>>=|\\*\\*|\\+\\+|--|<<|>>|<=|>=|==|!=|&&|\\|\\||\\+=|-=|\\*=|/=|%=|&=|\\^=|\\|=|[-+*/%<>=!~&|^?:(),])',
    '(\\s+)',
    '(.)',
  ].join('|'),
  'g',
)

export const ARITH_NAME = /^[A-Za-z_]\w*$/

// An element reference token the tokenizer stitched: the name adjacent
// to a bracket-matched subscript, whose interior is resolved by the
// element callbacks rather than the tokenizer (an associative key can
// hold characters no arithmetic token may).
export const ARITH_ELEM = /^([A-Za-z_]\w*)\[([\s\S]*)\]$/

export const ARITH_ASSIGN_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
])

// Recursion budget for variables holding expressions (`x="1+2"; $((x))`),
// mirroring bash's expression recursion limit.
export const ARITH_MAX_DEPTH = 16

// The descriptors the shell models: stdin, stdout and stderr, and no
// table above them. A redirect naming any other number is refused before
// it does anything (`shell/descriptors.ts`), because the old fall-through
// aliased fd 3 onto stdout and `exec 3>&-` closed the session's stdout.
// FD_BOTH is `Redirect.fd` for `&>`; FD_CLOSE is `Redirect.target` for
// `>&-`.
export const FD_STDIN = 0
export const FD_STDOUT = 1
export const FD_STDERR = 2
export const FD_BOTH = -1
export const FD_CLOSE = -1
export const SHELL_FDS: ReadonlySet<number> = new Set([FD_STDIN, FD_STDOUT, FD_STDERR])

// The two dynamic variables the shell answers itself: PIPESTATUS reads the
// session's record of the last pipeline (`Session.pipeStatus`) and RANDOM
// steps a generator (`session/rng.ts`). Neither lives in the variable
// store.
export const PIPESTATUS = 'PIPESTATUS'
export const RANDOM = 'RANDOM'
// bash 5.2's generator (lib/sh/random.c): a Park-Miller minimal-standard
// step through Schrage's method, the value folding the state's two halves
// and keeping 15 bits, and a draw that never repeats the value before it.
// A seed is the assigned integer truncated to 32 bits, and a zero state
// steps from ZERO_SEED. Identical in both languages, so `RANDOM=42` is the
// same sequence everywhere, and bash's.
export const RANDOM_A = 16807
export const RANDOM_Q = 127773
export const RANDOM_R = 2836
export const RANDOM_M = 0x7fffffff
export const RANDOM_ZERO_SEED = 123459876
export const RANDOM_MODULUS = 2 ** 32
export const RANDOM_MAX = 32767
// What `Session.randomSeed` holds once `unset RANDOM` has stripped the name
// of its meaning: no generated word is ever empty.
export const RANDOM_UNSET = ''

// What the shell calls itself when no script is running, bash's "bash".
// A nested `bash`/`sh` overrides it through Session.scriptName, and
// `Session.argv0` is the one place the two are folded together.
export const SHELL_ARGV0 = 'mirage'

// Node types whose failure never triggers `set -e` by shape alone.
// Lists are NOT exempt: bash exits when the command after the final
// `&&`/`||` fails; short-circuit failures set Session.errexitImmune
// instead, so the executor loops skip only those.
export const ERREXIT_EXEMPT_TYPES: ReadonlySet<string> = new Set<string>([NodeType.NEGATED_COMMAND])

// Every letter bash's `set` accepts, mapped to the `-o` name it is a
// synonym for. The full table is here rather than only the letters
// mirage acts on, because a letter left out is silently dropped: `set -C`
// read as "no such option, ignore" is exactly the silent-accept the
// fail-loud rule exists to stop, and it made noclobber unreachable by its
// own letter while `set -o noclobber` worked.
export const SET_FLAG_TO_OPTION: Readonly<Record<string, string>> = Object.freeze({
  a: 'allexport',
  b: 'notify',
  e: 'errexit',
  f: 'noglob',
  h: 'hashall',
  k: 'keyword',
  m: 'monitor',
  n: 'noexec',
  p: 'privileged',
  t: 'onecmd',
  u: 'nounset',
  v: 'verbose',
  x: 'xtrace',
  B: 'braceexpand',
  C: 'noclobber',
  E: 'errtrace',
  H: 'histexpand',
  P: 'physical',
  T: 'functrace',
})

// Every name GNU's `set -o` accepts, pinned from `set -o` on
// debian:stable-slim. mirage acts on a few and stores the rest, mirroring
// how a cluster letter naming no option is kept rather than refused. A
// name absent from here is the one thing bash rejects outright, and it
// rejects it with exit 2 — which is what keeps a silently-ignored
// `set -o physical` from looking supported.
export const SET_OPTION_NAMES: ReadonlySet<string> = new Set([
  'allexport',
  'braceexpand',
  'emacs',
  'errexit',
  'errtrace',
  'functrace',
  'hashall',
  'histexpand',
  'history',
  'ignoreeof',
  'interactive-comments',
  'keyword',
  'monitor',
  'noclobber',
  'noexec',
  'noglob',
  'nolog',
  'notify',
  'nounset',
  'onecmd',
  'physical',
  'pipefail',
  'posix',
  'privileged',
  'verbose',
  'vi',
  'xtrace',
])

const DEFAULT_ON: ReadonlySet<string> = new Set(['braceexpand', 'hashall', 'interactive-comments'])

// What each option reads as before anything sets it, pinned from
// `bash -c 'set -o'` on debian:stable-slim (5.2.37). Only three are on,
// and all three are on for a non-interactive shell too, so this is the
// table `set -o` prints rather than an interactive shell's.
export const SET_OPTION_DEFAULTS: ReadonlyMap<string, boolean> = new Map(
  [...SET_OPTION_NAMES].sort(compareCodePoints).map((name) => [name, DEFAULT_ON.has(name)]),
)

// Every name GNU's `shopt` accepts and what it reads as before anything
// sets it, pinned from `bash -c shopt` on debian:stable-slim (5.2.37),
// in bash's own listing order. Kept apart from SET_OPTION_NAMES because
// bash keeps two vocabularies, `set -o` and `shopt`, with `shopt -o` as
// the one bridge.
export const SHOPT_DEFAULTS: ReadonlyMap<string, boolean> = new Map([
  ['autocd', false],
  ['assoc_expand_once', false],
  ['cdable_vars', false],
  ['cdspell', false],
  ['checkhash', false],
  ['checkjobs', false],
  ['checkwinsize', true],
  ['cmdhist', true],
  ['compat31', false],
  ['compat32', false],
  ['compat40', false],
  ['compat41', false],
  ['compat42', false],
  ['compat43', false],
  ['compat44', false],
  ['complete_fullquote', true],
  ['direxpand', false],
  ['dirspell', false],
  ['dotglob', false],
  ['execfail', false],
  ['expand_aliases', false],
  ['extdebug', false],
  ['extglob', false],
  ['extquote', true],
  ['failglob', false],
  ['force_fignore', true],
  ['globasciiranges', true],
  ['globskipdots', true],
  ['globstar', false],
  ['gnu_errfmt', false],
  ['histappend', false],
  ['histreedit', false],
  ['histverify', false],
  ['hostcomplete', true],
  ['huponexit', false],
  ['inherit_errexit', false],
  ['interactive_comments', true],
  ['lastpipe', false],
  ['lithist', false],
  ['localvar_inherit', false],
  ['localvar_unset', false],
  ['login_shell', false],
  ['mailwarn', false],
  ['no_empty_cmd_completion', false],
  ['nocaseglob', false],
  ['nocasematch', false],
  ['noexpand_translation', false],
  ['nullglob', false],
  ['patsub_replacement', true],
  ['progcomp', true],
  ['progcomp_alias', false],
  ['promptvars', true],
  ['restricted_shell', false],
  ['shift_verbose', false],
  ['sourcepath', true],
  ['varredir_close', false],
  ['xpg_echo', false],
])

// `shopt` names mirage refuses to turn on rather than store: `extglob`
// changes what the parser accepts, and mirage's grammar has no such
// mode, so a stored `on` would promise a syntax that still fails to
// parse. Refusing is the honest answer until the parser learns it.
export const SHOPT_UNSUPPORTED: ReadonlySet<string> = new Set(['extglob'])

export const GROUP_TIER: ReadonlyMap<BuiltinGroup, BuiltinTier> = new Map<
  BuiltinGroup,
  BuiltinTier
>([
  [BuiltinGroup.WORKING_DIRECTORY, BuiltinTier.GRAMMAR],
  [BuiltinGroup.VARIABLES, BuiltinTier.GRAMMAR],
  [BuiltinGroup.SHELL_STATE, BuiltinTier.GRAMMAR],
  [BuiltinGroup.CONDITIONS, BuiltinTier.GRAMMAR],
  [BuiltinGroup.OUTPUT, BuiltinTier.GRAMMAR],
  [BuiltinGroup.RUNNING_LINES, BuiltinTier.GRAMMAR],
  [BuiltinGroup.NAME_LOOKUP, BuiltinTier.GRAMMAR],
  [BuiltinGroup.CONTROL_FLOW, BuiltinTier.GRAMMAR],
  [BuiltinGroup.ENVIRONMENT, BuiltinTier.TOOL],
  [BuiltinGroup.MANUALS_AND_HISTORY, BuiltinTier.TOOL],
  [BuiltinGroup.JOB_CONTROL, BuiltinTier.TOOL],
  [BuiltinGroup.CLOCK, BuiltinTier.TOOL],
  [BuiltinGroup.NESTED_SHELLS, BuiltinTier.TOOL],
  [BuiltinGroup.INTERPRETERS, BuiltinTier.TOOL],
  [BuiltinGroup.COMMAND_RUNNERS, BuiltinTier.TOOL],
])

// One row per ShellBuiltin. shell/types.test.ts pins that the rows cover
// the enum, that every group is used, and that the tier sets below are
// the rows' partition, so a new member has to be filed here on purpose.
export const BUILTIN_GROUP: ReadonlyMap<ShellBuiltin, BuiltinGroup> = new Map<
  ShellBuiltin,
  BuiltinGroup
>([
  [ShellBuiltin.PWD, BuiltinGroup.WORKING_DIRECTORY],
  [ShellBuiltin.CD, BuiltinGroup.WORKING_DIRECTORY],
  [ShellBuiltin.EXPORT, BuiltinGroup.VARIABLES],
  [ShellBuiltin.UNSET, BuiltinGroup.VARIABLES],
  [ShellBuiltin.LOCAL, BuiltinGroup.VARIABLES],
  [ShellBuiltin.DECLARE, BuiltinGroup.VARIABLES],
  [ShellBuiltin.TYPESET, BuiltinGroup.VARIABLES],
  [ShellBuiltin.READONLY, BuiltinGroup.VARIABLES],
  [ShellBuiltin.SET, BuiltinGroup.VARIABLES],
  [ShellBuiltin.READ, BuiltinGroup.VARIABLES],
  [ShellBuiltin.MAPFILE, BuiltinGroup.VARIABLES],
  [ShellBuiltin.READARRAY, BuiltinGroup.VARIABLES],
  [ShellBuiltin.SHIFT, BuiltinGroup.VARIABLES],
  [ShellBuiltin.GETOPTS, BuiltinGroup.VARIABLES],
  [ShellBuiltin.LET, BuiltinGroup.VARIABLES],
  [ShellBuiltin.TRAP, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.SHOPT, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.UMASK, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.ALIAS, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.UNALIAS, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.EXEC, BuiltinGroup.SHELL_STATE],
  [ShellBuiltin.TEST, BuiltinGroup.CONDITIONS],
  [ShellBuiltin.BRACKET, BuiltinGroup.CONDITIONS],
  [ShellBuiltin.DOUBLE_BRACKET, BuiltinGroup.CONDITIONS],
  [ShellBuiltin.ECHO, BuiltinGroup.OUTPUT],
  [ShellBuiltin.PRINTF, BuiltinGroup.OUTPUT],
  [ShellBuiltin.SOURCE, BuiltinGroup.RUNNING_LINES],
  [ShellBuiltin.DOT, BuiltinGroup.RUNNING_LINES],
  [ShellBuiltin.EVAL, BuiltinGroup.RUNNING_LINES],
  [ShellBuiltin.COMMAND, BuiltinGroup.RUNNING_LINES],
  [ShellBuiltin.TYPE, BuiltinGroup.NAME_LOOKUP],
  [ShellBuiltin.WHICH, BuiltinGroup.NAME_LOOKUP],
  [ShellBuiltin.TRUE, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.FALSE, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.COLON, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.BREAK, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.CONTINUE, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.RETURN, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.EXIT, BuiltinGroup.CONTROL_FLOW],
  [ShellBuiltin.PRINTENV, BuiltinGroup.ENVIRONMENT],
  [ShellBuiltin.ENV, BuiltinGroup.ENVIRONMENT],
  [ShellBuiltin.WHOAMI, BuiltinGroup.ENVIRONMENT],
  [ShellBuiltin.MAN, BuiltinGroup.MANUALS_AND_HISTORY],
  [ShellBuiltin.HISTORY, BuiltinGroup.MANUALS_AND_HISTORY],
  [ShellBuiltin.WAIT, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.FG, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.KILL, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.JOBS, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.DISOWN, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.PS, BuiltinGroup.JOB_CONTROL],
  [ShellBuiltin.SLEEP, BuiltinGroup.CLOCK],
  [ShellBuiltin.BASH, BuiltinGroup.NESTED_SHELLS],
  [ShellBuiltin.SH, BuiltinGroup.NESTED_SHELLS],
  [ShellBuiltin.PYTHON, BuiltinGroup.INTERPRETERS],
  [ShellBuiltin.PYTHON3, BuiltinGroup.INTERPRETERS],
  [ShellBuiltin.NODE, BuiltinGroup.INTERPRETERS],
  [ShellBuiltin.JS, BuiltinGroup.INTERPRETERS],
  [ShellBuiltin.XARGS, BuiltinGroup.COMMAND_RUNNERS],
  [ShellBuiltin.TIMEOUT, BuiltinGroup.COMMAND_RUNNERS],
])

export const GRAMMAR_BUILTINS: ReadonlySet<ShellBuiltin> = new Set<ShellBuiltin>(
  [...BUILTIN_GROUP].filter(([, g]) => GROUP_TIER.get(g) === BuiltinTier.GRAMMAR).map(([b]) => b),
)

export const TOOL_BUILTINS: ReadonlySet<ShellBuiltin> = new Set<ShellBuiltin>(
  [...BUILTIN_GROUP].filter(([, g]) => GROUP_TIER.get(g) === BuiltinTier.TOOL).map(([b]) => b),
)
