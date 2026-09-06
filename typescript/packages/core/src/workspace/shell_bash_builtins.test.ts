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

import { afterEach, describe, expect, it } from 'vitest'

import type { Workspace } from './workspace/workspace.ts'
import { makeIntegrationWS, runResult } from './fixtures/integration_fixture.ts'

let ws: Workspace | null = null

afterEach(async () => {
  if (ws !== null) await ws.close()
  ws = null
})

// Every expectation is pinned against GNU bash 5.2.37 on
// debian:stable-slim. The python twins live beside the sources these
// exercise: tests/workspace/executor/builtins/test_{let,umask,shopt,
// alias,mapfile,read_flags,exec_cmd}.py and
// tests/workspace/session/test_nameref.py.
const CASES: [string, string, string, string, number][] = [
  // ── let ───────────────────────────────────────────────────
  ['let_assigns', 'let x=1+2; echo $x', '3\n', '', 0],
  ['let_zero_is_status_one', 'let z=0', '', '', 1],
  [
    'let_last_expression_decides',
    'let a=1 b=0; echo rc=$?; let c=0 d=1; echo rc=$?',
    'rc=1\nrc=0\n',
    '',
    0,
  ],
  ['let_no_operand', 'let', '', 'bash: let: expression expected\n', 1],
  [
    'let_array_element',
    "a=(1 2); let 'a[1]+=5'; declare -p a",
    'declare -a a=([0]="1" [1]="7")\n',
    '',
    0,
  ],

  // ── umask ─────────────────────────────────────────────────
  ['umask_default_octal', 'umask', '0022\n', '', 0],
  ['umask_symbolic', 'umask -S', 'u=rwx,g=rx,o=rx\n', '', 0],
  ['umask_reusable', 'umask -p', 'umask 0022\n', '', 0],
  ['umask_sets_octal', 'umask 077; umask; umask -S', '0077\nu=rwx,g=,o=\n', '', 0],
  ['umask_symbolic_clause', 'umask 022; umask g+w; umask', '0002\n', '', 0],
  [
    'umask_refuses_bad_mode',
    'umask 999; echo rc=$?; umask',
    'rc=1\n0022\n',
    'bash: umask: 999: octal number out of range\n',
    0,
  ],
  [
    'umask_applies_to_new_entries',
    'umask 077; touch /data/uf; mkdir /data/ud; stat -c "%a %n" /data/uf /data/ud',
    '600 /data/uf\n700 /data/ud\n',
    '',
    0,
  ],

  // ── shopt ─────────────────────────────────────────────────
  [
    'shopt_set_and_query',
    'shopt -q nullglob; echo rc=$?; shopt -s nullglob; shopt nullglob; shopt -p nullglob',
    'rc=1\nnullglob       \ton\nshopt -s nullglob\n',
    '',
    0,
  ],
  ['shopt_bad_name', 'shopt -s bogus', '', 'bash: shopt: bogus: invalid shell option name\n', 1],
  [
    'shopt_conflicting_flags',
    'shopt -su nullglob',
    '',
    'bash: shopt: cannot set and unset shell options simultaneously\n',
    1,
  ],
  [
    'shopt_bad_letter',
    'shopt -z',
    '',
    'bash: shopt: -z: invalid option\nshopt: usage: shopt [-pqsu] [-o] [optname ...]\n',
    2,
  ],
  ['shopt_o_bridges_set', 'shopt -so errexit; shopt -o errexit', 'errexit        \ton\n', '', 0],
  ['shopt_refuses_extglob', 'shopt -s extglob', '', 'mirage: shopt: extglob: not supported\n', 1],

  // ── glob options ──────────────────────────────────────────
  ['glob_default_keeps_literal', 'echo /data/zz*', '/data/zz*\n', '', 0],
  ['glob_nullglob_drops', 'shopt -s nullglob; echo pre /data/zz* post', 'pre post\n', '', 0],
  [
    'glob_failglob_is_fatal',
    'shopt -s failglob; echo /data/zz*',
    '',
    'bash: no match: /data/zz*\n',
    1,
  ],
  [
    'glob_dotglob',
    'touch /data/.h /data/v.txt; echo /data/*; shopt -s dotglob; echo /data/*',
    '/data/v.txt\n/data/.h /data/v.txt\n',
    '',
    0,
  ],
  [
    'glob_globstar',
    'mkdir -p /data/d/e; touch /data/f.txt /data/d/g.txt /data/d/e/h.txt; ' +
      'shopt -s globstar; echo /data/**/*.txt; echo /data/d/**',
    '/data/d/e/h.txt /data/d/g.txt /data/f.txt\n' +
      '/data/d/ /data/d/e /data/d/e/h.txt /data/d/g.txt\n',
    '',
    0,
  ],

  // ── alias ─────────────────────────────────────────────────
  ['alias_off_by_default', "alias x='echo hi'\nx", '', 'x: command not found\n', 127],
  [
    'alias_expands_from_next_line',
    "shopt -s expand_aliases\nalias x='echo hi'\nx one",
    'hi one\n',
    '',
    0,
  ],
  [
    'alias_same_line_does_not_expand',
    "shopt -s expand_aliases\nalias x='echo hi'; x",
    '',
    'x: command not found\n',
    127,
  ],
  [
    'alias_value_is_reparsed',
    'shopt -s expand_aliases\nmkdir -p /data/ad; touch /data/ad/foo /data/ad/bar\n' +
      "alias lg='ls /data/ad | grep'\nlg foo",
    'foo\n',
    '',
    0,
  ],
  [
    'alias_trailing_blank_checks_next_word',
    "shopt -s expand_aliases\nalias run='do '\nalias do='echo DID'\nrun echo hi",
    'DID echo hi\n',
    '',
    0,
  ],
  [
    'alias_type_and_command_v',
    "alias x='echo hi'\ntype -t x; command -v x",
    "alias\nalias x='echo hi'\n",
    '',
    0,
  ],
  ['unalias_missing_name', 'unalias nope', '', 'bash: unalias: nope: not found\n', 1],
  ['alias_bad_name', "alias 'a b'=x", '', "bash: alias: `a b': invalid alias name\n", 1],
  ['alias_value_holding_a_quote', 'alias x="it\'s"; alias x', "alias x='it'\\''s'\n", '', 0],

  // ── mapfile / readarray ───────────────────────────────────
  [
    'mapfile_strips_with_t',
    "printf 'a\\nb\\nc\\n' | { mapfile -t A; declare -p A; }",
    'declare -a A=([0]="a" [1]="b" [2]="c")\n',
    '',
    0,
  ],
  [
    'mapfile_keeps_delimiter',
    "printf 'a\\nb\\n' | { mapfile A; declare -p A; }",
    "declare -a A=([0]=$'a\\n' [1]=$'b\\n')\n",
    '',
    0,
  ],
  [
    'mapfile_delimiter',
    "printf 'a:b:c' | { mapfile -d : -t D; declare -p D; }",
    'declare -a D=([0]="a" [1]="b" [2]="c")\n',
    '',
    0,
  ],
  [
    'mapfile_count_and_skip',
    "printf '1\\n2\\n3\\n' | { mapfile -t -n 2 N; declare -p N; }; " +
      "printf '1\\n2\\n3\\n' | { mapfile -t -s 1 S; declare -p S; }",
    'declare -a N=([0]="1" [1]="2")\ndeclare -a S=([0]="2" [1]="3")\n',
    '',
    0,
  ],
  [
    'mapfile_origin_keeps_other_elements',
    "printf 'x\\ny\\n' | { O=(a b c d); mapfile -t -O 1 O; declare -p O; }",
    'declare -a O=([0]="a" [1]="x" [2]="y" [3]="d")\n',
    '',
    0,
  ],
  [
    'readarray_is_the_same_builtin',
    "readarray -t R <<< $'x\\ny'; declare -p R",
    'declare -a R=([0]="x" [1]="y")\n',
    '',
    0,
  ],
  [
    'mapfile_default_name',
    "mapfile <<< 'z'; declare -p MAPFILE",
    "declare -a MAPFILE=([0]=$'z\\n')\n",
    '',
    0,
  ],
  ['mapfile_bad_name', 'mapfile 1bad', '', "bash: mapfile: `1bad': not a valid identifier\n", 1],
  [
    'mapfile_callback_gets_one_argument',
    'cb(){ echo "argc=$# [$2]"; }; ' +
      "printf 'x; touch /data/ran\\nb c\\n' | { mapfile -c 1 -C cb -t A; }; " +
      'test -e /data/ran && echo RAN || echo clean',
    'argc=2 [x; touch /data/ran]\nargc=2 [b c]\nclean\n',
    '',
    0,
  ],
  [
    'mapfile_refuses_assoc',
    "declare -A M; printf 'x\\n' | { mapfile -t M; }",
    '',
    'bash: mapfile: M: not an indexed array\n',
    1,
  ],

  // ── read flags ────────────────────────────────────────────
  [
    'read_a_stores_fields',
    "echo 'p q r' | { read -a W; declare -p W; }",
    'declare -a W=([0]="p" [1]="q" [2]="r")\n',
    '',
    0,
  ],
  ['read_d_delimiter', 'printf \'ab:cd\' | { read -d : X; echo "[$X]"; }', '[ab]\n', '', 0],
  ['read_n_chars', 'printf \'wxyz\' | { read -n 2 Y; echo "[$Y]"; }', '[wx]\n', '', 0],
  [
    'read_N_reads_through_delimiters',
    'printf \'a b\\ncd\' | { read -N 4 A; echo "[$A]"; }',
    '[a b\n]\n',
    '',
    0,
  ],
  ['read_tty_flags_are_no_ops', 'echo v | { read -p \'P: \' -s V; echo "[$V]"; }', '[v]\n', '', 0],
  [
    'read_n_counts_characters_not_bytes',
    'printf \'\\xc3\\xa9x\' | { read -n 1 a; read -n 1 b; echo "[$a][$b]"; }',
    '[é][x]\n',
    '',
    0,
  ],
  ['read_bad_timeout', 'read -t x V', '', 'bash: read: x: invalid timeout specification\n', 1],
  [
    'read_bad_descriptor',
    'read -u 3 V',
    '',
    'bash: read: 3: invalid file descriptor: Bad file descriptor\n',
    1,
  ],

  // ── nameref / declare -g ──────────────────────────────────
  [
    'nameref_reads_and_writes_target',
    'v=real; declare -n r=v; echo $r; r=2; echo $v; echo ${!r}',
    'real\n2\nv\n',
    '',
    0,
  ],
  [
    'nameref_reaches_array_elements',
    'arr=(1 2); declare -n r=arr; echo ${r[1]} ${#r[@]}; r[2]=3; declare -p arr',
    '2 2\ndeclare -a arr=([0]="1" [1]="2" [2]="3")\n',
    '',
    0,
  ],
  [
    'nameref_in_tests_and_arithmetic',
    'v=1; declare -n r=v; [[ -v r ]] && echo yes; echo $((r+1))',
    'yes\n2\n',
    '',
    0,
  ],
  [
    'nameref_self_reference_refused',
    'declare -n s=s',
    '',
    'bash: declare: s: nameref variable self references not allowed\n',
    1,
  ],
  [
    'nameref_bad_target_refused',
    "declare -n r='a b'",
    '',
    "bash: declare: `a b': invalid variable name for name reference\n",
    1,
  ],
  ['unset_n_drops_the_reference', 'v=1; declare -n r=v; unset -n r; echo $v', '1\n', '', 0],
  [
    'declare_g_writes_the_global',
    'G=0; f(){ local G=5; declare -g G=1; echo in=$G; }; f; echo out=$G',
    'in=5\nout=1\n',
    '',
    0,
  ],
  [
    'declare_g_reaches_past_a_callers_local',
    'g(){ declare -g X=inner; }; f(){ local X=local; g; echo f=$X; }; f; echo top=$X',
    'f=local\ntop=inner\n',
    '',
    0,
  ],
  [
    'declare_g_arrays',
    'f(){ declare -ga A=(1 2); declare -gi I=3+4; }; f; declare -p A I',
    'declare -a A=([0]="1" [1]="2")\ndeclare -i I="7"\n',
    '',
    0,
  ],

  // ── disown / wait ─────────────────────────────────────────
  ['disown_drops_the_job', 'sleep 5 & disown; echo rc=$?; jobs', 'rc=0\n', '', 0],
  ['disown_with_no_jobs', 'disown', '', 'bash: disown: current: no such job\n', 1],
  [
    'disown_bad_option',
    'disown -x',
    '',
    'bash: disown: -x: invalid option\ndisown: usage: disown [-h] [-ar] [jobspec ... | pid ...]\n',
    2,
  ],
  ['wait_n_answers_first_finisher', '(exit 3) & wait -n', '', '', 3],
  // `-p` holds a job id, not bash's pid (a mirage job has no OS
  // process); the rest of the line is bash's.
  [
    'wait_p_names_the_job_reported',
    '(exit 3) & (exit 5) & wait -p V %1 %2; echo rc=$? V=$V',
    'rc=5 V=2\n',
    '',
    0,
  ],
  [
    'wait_p_with_no_operand_leaves_it_unset',
    '(exit 0) & V=stale; wait -p V; echo "V=[${V-UNSET}]"',
    'V=[UNSET]\n',
    '',
    0,
  ],
  ['wait_n_with_no_jobs', 'wait -n', '', '', 127],
  ['wait_bad_spec', 'wait bogus', '', "bash: wait: `bogus': not a pid or valid job spec\n", 1],
  [
    'wait_bad_option',
    'wait -x',
    '',
    'bash: wait: -x: invalid option\nwait: usage: wait [-fn] [-p var] [id ...]\n',
    2,
  ],

  // ── exec ──────────────────────────────────────────────────
  ['exec_bare_is_a_noop', 'exec; echo ok', 'ok\n', '', 0],
  [
    'exec_command_form_refused',
    'exec echo hi; echo after',
    'after\n',
    'mirage: exec: echo: process replacement is not supported (no OS process to replace)\n',
    0,
  ],
  [
    'exec_redirect_diverts_stdout',
    '( exec > /data/o.txt; echo a; echo b ); cat /data/o.txt',
    'a\nb\n',
    '',
    0,
  ],
  [
    'exec_append_keeps_existing',
    'echo old > /data/a.txt; ( exec >> /data/a.txt; echo new ); cat /data/a.txt',
    'old\nnew\n',
    '',
    0,
  ],
  [
    'exec_stdin_feeds_read',
    "printf 'l1\\nl2\\n' > /data/i.txt; ( exec < /data/i.txt; read a; read b; echo $a-$b )",
    'l1-l2\n',
    '',
    0,
  ],
  [
    'exec_opens_both_forms_at_exec_time',
    '( exec > /data/t.txt; ); ( exec >> /data/n.txt; ); ' +
      'echo old > /data/k.txt; ( exec >> /data/k.txt; ); ' +
      'test -e /data/t.txt && test -e /data/n.txt && cat /data/k.txt',
    'old\n',
    '',
    0,
  ],
  [
    // bash 5.2 keeps the file each earlier redirect opened but restores
    // the descriptors, and writes the diagnostic through the descriptors
    // as they stood at the failure.
    'exec_failed_later_redirect_puts_earlier_ones_back',
    '( exec > /data/good < /data/missing; echo visible ); ' +
      'test -e /data/good && wc -c < /data/good',
    'visible\n0\n',
    '/data/missing: No such file or directory\n',
    0,
  ],
  [
    // bash 5.2: a dup copies the terminal stream it names, so `2>&1` puts
    // stderr on stdout and `1>&2` then `2>&1` leaves both on stderr.
    'exec_dup_copies_the_terminal_stream_it_names',
    '( exec 2>&1; echo err >&2 ); ( exec 1>&2; echo a ); ( exec 1>&2; exec 2>&1; echo c; echo d >&2 ); echo after >&2',
    'err\n',
    'a\nc\nd\nafter\n',
    0,
  ],
  [
    'exec_failed_redirect_diagnostic_follows_a_dup_to_stdout',
    '( exec 2>&1 < /data/missing; echo out; echo err >&2 )',
    '/data/missing: No such file or directory\nout\n',
    'err\n',
    0,
  ],
  [
    // bash 5.2: after `exec 1>&0` every write to stdout is `write error:
    // Bad file descriptor`, status 1.
    'exec_stream_bound_to_stdin_cannot_be_written',
    '( exec 1>&0; echo hi; echo rc=$? >&2; echo again ); ( exec 2>&0; echo hi >&2; echo rc=$? ); echo back',
    'rc=1\nback\n',
    'echo: write error: Bad file descriptor\nrc=1\necho: write error: Bad file descriptor\n',
    0,
  ],
  [
    // bash 5.2: `0<&0` and `0>&0` are a descriptor dup onto itself, so
    // the file an earlier `exec <f` bound stays; `<&-` still closes it.
    'exec_stdin_dup_onto_itself_keeps_the_bound_file',
    "printf 'l1\\nl2\\n' > /data/in; ( exec < /data/in; exec 0<&0; read a; exec 0>&0; read b; echo $a-$b; exec <&-; read c; echo rc=$? )",
    'l1-l2\nrc=1\n',
    'bash: read: read error: 0: Bad file descriptor\n',
    0,
  ],
  [
    'exec_failed_redirect_diagnostic_goes_where_stderr_pointed',
    '( exec 2> /data/e < /data/missing; echo toerr >&2 ); cat /data/e',
    '/data/missing: No such file or directory\n',
    'toerr\n',
    0,
  ],
  [
    'exec_opened_targets_take_the_umask_mode',
    'umask 077; ( exec > /data/m.txt; echo z ); echo z > /data/p.txt; ' +
      'stat -c "%a %n" /data/m.txt /data/p.txt',
    '600 /data/m.txt\n600 /data/p.txt\n',
    '',
    0,
  ],
]

describe('bash builtins: let, umask, shopt, alias, mapfile, read flags, nameref, disown/wait, exec', () => {
  for (const [id, cmd, wantOut, wantErr, wantCode] of CASES) {
    it(id, async () => {
      ;({ ws } = await makeIntegrationWS())
      const [code, out, err] = await runResult(ws, cmd)
      expect([out, err, code]).toEqual([wantOut, wantErr, wantCode])
    })
  }
})
