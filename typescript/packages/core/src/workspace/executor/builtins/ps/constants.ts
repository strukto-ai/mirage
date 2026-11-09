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

import type { ProcessState } from '../../../../execution/process/types.ts'

// procps-ng 4.0.4's usage block, printed under every option error.
export const USAGE =
  '\nUsage:\n ps [options]\n\n' +
  " Try 'ps --help <simple|list|output|threads|misc|all>'\n" +
  "  or 'ps --help <s|l|o|t|m|a>'\n" +
  ' for additional help text.\n\n' +
  'For more details see ps(1).\n'

// procps-ng 4.0.4's -o keys: the header, width and right alignment measured
// from its `ps -o` output, and the fact `psCell` renders; accounting a runner
// lacks prints procps's none.
export const COLUMNS: Readonly<Record<string, readonly [string, number, boolean, string]>> = {
  pid: ['PID', 7, true, 'pid'],
  tgid: ['TGID', 7, true, 'pid'],
  lwp: ['LWP', 7, true, 'pid'],
  spid: ['SPID', 7, true, 'pid'],
  tid: ['TID', 7, true, 'pid'],
  ppid: ['PPID', 7, true, 'ppid'],
  pgid: ['PGID', 7, true, 'pgid'],
  pgrp: ['PGRP', 7, true, 'pgid'],
  sid: ['SID', 7, true, 'sid'],
  sess: ['SESS', 7, true, 'sid'],
  tpgid: ['TPGID', 7, true, 'tpgid'],
  stat: ['STAT', 4, false, 'stat'],
  state: ['S', 1, false, 'state'],
  s: ['S', 1, false, 'state'],
  cmd: ['CMD', 27, false, 'args'],
  args: ['COMMAND', 27, false, 'args'],
  command: ['COMMAND', 27, false, 'args'],
  comm: ['COMMAND', 15, false, 'comm'],
  ucmd: ['CMD', 15, false, 'comm'],
  ucomm: ['COMMAND', 15, false, 'comm'],
  user: ['USER', 8, false, 'user'],
  euser: ['EUSER', 8, false, 'user'],
  uname: ['USER', 8, false, 'user'],
  ruser: ['RUSER', 8, false, 'user'],
  suser: ['SUSER', 8, false, 'user'],
  fuser: ['FUSER', 8, false, 'user'],
  uid: ['UID', 5, true, 'user'],
  euid: ['EUID', 5, true, 'user'],
  ruid: ['RUID', 5, true, 'user'],
  suid: ['SUID', 5, true, 'user'],
  fuid: ['FUID', 5, true, 'user'],
  gid: ['GID', 5, true, 'group'],
  egid: ['EGID', 5, true, 'group'],
  rgid: ['RGID', 5, true, 'group'],
  group: ['GROUP', 8, false, 'group'],
  egroup: ['EGROUP', 8, false, 'group'],
  rgroup: ['RGROUP', 8, false, 'group'],
  tty: ['TT', 8, false, 'tty'],
  tt: ['TT', 8, false, 'tty'],
  tname: ['TTY', 8, false, 'tty'],
  time: ['TIME', 8, true, 'time'],
  cputime: ['TIME', 8, true, 'time'],
  cputimes: ['TIME', 8, true, 'zero'],
  etime: ['ELAPSED', 11, true, 'etime'],
  etimes: ['ELAPSED', 7, true, 'etimes'],
  lstart: ['STARTED', 24, true, 'lstart'],
  start: ['STARTED', 8, true, 'start'],
  start_time: ['START', 5, false, 'stime'],
  stime: ['STIME', 5, false, 'stime'],
  bsdstart: ['START', 6, true, 'bsdstart'],
  rss: ['RSS', 5, true, 'zero'],
  rssize: ['RSS', 5, true, 'zero'],
  rsz: ['RSZ', 5, true, 'zero'],
  vsz: ['VSZ', 6, true, 'zero'],
  vsize: ['VSZ', 6, true, 'zero'],
  sz: ['SZ', 5, true, 'zero'],
  trs: ['TRS', 4, true, 'zero'],
  drs: ['DRS', 5, true, 'zero'],
  dsiz: ['DSIZ', 4, true, 'zero'],
  size: ['SIZE', 5, true, 'zero'],
  pss: ['PSS', 5, true, 'zero'],
  uss: ['USS', 5, true, 'zero'],
  maj_flt: ['MAJFL', 6, true, 'zero'],
  min_flt: ['MINFL', 6, true, 'zero'],
  majflt: ['MAJFLT', 6, true, 'zero'],
  minflt: ['MINFLT', 6, true, 'zero'],
  '%cpu': ['%CPU', 4, true, 'percent'],
  pcpu: ['%CPU', 4, true, 'percent'],
  '%mem': ['%MEM', 4, true, 'percent'],
  pmem: ['%MEM', 4, true, 'percent'],
  c: ['C', 2, true, 'zero'],
  cp: ['CP', 3, true, 'zero'],
  ni: ['NI', 3, true, 'zero'],
  nice: ['NI', 3, true, 'zero'],
  pri: ['PRI', 3, true, 'pri'],
  priority: ['PRI', 3, true, 'priority'],
  opri: ['PRI', 3, true, 'opri'],
  rtprio: ['RTPRIO', 6, true, 'dash'],
  cls: ['CLS', 3, true, 'cls'],
  class: ['CLS', 3, false, 'cls'],
  policy: ['POL', 3, false, 'cls'],
  psr: ['PSR', 3, true, 'zero'],
  nlwp: ['NLWP', 4, true, 'one'],
  thcount: ['THCNT', 5, true, 'one'],
  f: ['F', 1, false, 'zero'],
  flag: ['F', 1, false, 'zero'],
  flags: ['F', 1, false, 'zero'],
  wchan: ['WCHAN', 6, false, 'dash'],
  nwchan: ['WCHAN', 6, true, 'dash'],
  label: ['LABEL', 31, false, 'dash'],
  machine: ['MACHINE', 31, false, 'machine'],
}

// What ps prints without -o: each process's pid, the machine it runs on
// (`mirage` for Mirage's own) and its command. Mirrors Python's `PLAIN`.
export const PLAIN: readonly (readonly [string, string])[] = [
  ['pid', 'PID'],
  ['machine', 'MACHINE'],
  ['cmd', 'CMD'],
]

// What a forest (BSD `f`, `--forest`) puts before each command, as
// procps-ng 4.0.4 draws it: a child's branch, then for each ancestor between
// it and the root a bar while that ancestor has a later sibling.
export const BRANCH = ' \\_ '
export const BAR = ' |  '
export const GAP = '    '

// The fixed answers for a runner: what procps prints for a process on no
// terminal, never scheduled away from the default policy and priority.
export const FIXED: Readonly<Record<string, string>> = {
  tpgid: '-1',
  tty: '?',
  time: '00:00:00',
  zero: '0',
  one: '1',
  percent: '0.0',
  pri: '19',
  priority: '20',
  opri: '80',
  dash: '-',
  cls: 'TS',
}

// A runner's state letter: live and waiting, being cancelled (still
// unwinding), or exited and not yet reaped. The one running ps is `R`, and
// one paused or on a machine shows what it is doing.
export const STATES: Readonly<Record<ProcessState, string>> = {
  running: 'S',
  stopping: 'S',
  exited: 'Z',
}

// Letters that select every process: SysV -e/-A/-a/-x, BSD a/x.
export const ALL = new Set(['e', 'A', 'a', 'x'])
