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

// Linux's signal numbers by the names bash 5.2 gives them in `kill -l` and
// `trap -l` (debian:stable-slim). 32 and 33 have no name; 34 to 64 are the
// realtime range, named from its two ends. Mirrors Python's SIGNALS.
export const SIGNALS: ReadonlyMap<number, string> = new Map([
  [1, 'HUP'],
  [2, 'INT'],
  [3, 'QUIT'],
  [4, 'ILL'],
  [5, 'TRAP'],
  [6, 'ABRT'],
  [7, 'BUS'],
  [8, 'FPE'],
  [9, 'KILL'],
  [10, 'USR1'],
  [11, 'SEGV'],
  [12, 'USR2'],
  [13, 'PIPE'],
  [14, 'ALRM'],
  [15, 'TERM'],
  [16, 'STKFLT'],
  [17, 'CHLD'],
  [18, 'CONT'],
  [19, 'STOP'],
  [20, 'TSTP'],
  [21, 'TTIN'],
  [22, 'TTOU'],
  [23, 'URG'],
  [24, 'XCPU'],
  [25, 'XFSZ'],
  [26, 'VTALRM'],
  [27, 'PROF'],
  [28, 'WINCH'],
  [29, 'IO'],
  [30, 'PWR'],
  [31, 'SYS'],
])

// The other names GNU timeout 9.7 takes for -s, by the number
// `timeout -v -s NAME` then reports sending. bash refuses them all.
export const SIGNAL_ALIASES: ReadonlyMap<string, number> = new Map([
  ['EXIT', 0],
  ['IOT', 6],
  ['CLD', 17],
  ['POLL', 29],
])

// Where `timeout -v` names a number otherwise than bash does.
export const TIMEOUT_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'EXIT'],
  [29, 'POLL'],
])

export const SIGRTMIN = 34
export const SIGRTMAX = 64

export const SIGKILL = 9
export const SIGCHLD = 17
export const SIGSTOP = 19

// Signals whose default action leaves a process running: the command
// carries on past the deadline.
export const CONTINUE_SIGNALS: ReadonlySet<number> = new Set([0, SIGCHLD, 18, 23, 28])

// The job-control stops. timeout sends CONT after them unless run with
// --foreground, so there only the command stays stopped.
export const STOP_SIGNALS: ReadonlySet<number> = new Set([SIGSTOP, 20, 21, 22])

// What timeout cannot ignore when it signals its own process group, so it
// dies of them too: KILL, and the two glibc reserves for itself.
export const SELF_KILLING_SIGNALS: ReadonlySet<number> = new Set([SIGKILL, 32, 33])
