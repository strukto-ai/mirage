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

import type { Change } from './types.ts'

// The paragraph that opens VFS.md for an agent.
export const INTRO =
  'You work in a terminal over a virtual filesystem. Read files with shell commands; access is checked for each operation.'

// The file commands VFS.md names as reading every path.
export const READS: readonly string[] = ['ls', 'cat', 'grep', 'find', 'jq']

// The commands that change files: each works on a mount that answers every
// op of one alternative. A mount answers append and truncate by a rewrite
// where it only writes whole files, and cp copies within a mount through
// its copy.
export const CHANGES: readonly Change[] = [
  { label: '`>`', command: [], needs: [['write']] },
  { label: '`>>`', command: [], needs: [['append']] },
  { label: '`tee`', command: ['tee'], needs: [['write']] },
  { label: '`touch` of a new file', command: ['touch'], needs: [['write']] },
  { label: '`cp`', command: ['cp'], needs: [['write'], ['copy']] },
  {
    label: '`cp -r`',
    command: ['cp', '-r'],
    needs: [
      ['write', 'mkdir'],
      ['copy', 'mkdir'],
    ],
  },
  { label: '`mkdir`', command: ['mkdir'], needs: [['mkdir']] },
  { label: '`mv`', command: ['mv'], needs: [['rename']] },
  { label: '`rm`', command: ['rm'], needs: [['unlink']] },
  { label: '`rm -r`', command: ['rm', '-r'], needs: [['rm_r'], ['unlink', 'rmdir']] },
  { label: '`rmdir`', command: ['rmdir'], needs: [['rmdir']] },
  { label: '`truncate`', command: ['truncate'], needs: [['truncate']] },
  { label: '`sed -i`', command: ['sed', '-i'], needs: [['write']] },
]

// The ops a mount's service answers in place of reading a file, and the
// command each one serves.
export const ASKS: readonly (readonly [string, string])[] = [
  ['first_lines', 'head'],
  ['last_lines', 'tail'],
  ['line_count', 'wc -l'],
]

// The walks a mount's full_scan_limit stops, and the commands it refuses
// past it.
export const WALKS: readonly string[] = ['grep -r', 'find', 'du']
export const REFUSED: readonly string[] = ['tar -c', 'cp -r', 'rm -r']
