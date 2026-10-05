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

import { describe, expect, it } from 'vitest'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

// The twin of python's tests/commands/builtin/test_read_failure_exit.py.
// Same GNU pin, same reasoning; see that file's comment for the image and
// tool versions and for why the code belongs to the command rather than
// to the errno. [directoryExit, missingExit] per command line.
const GNU_READ_EXIT: Record<string, [number, number]> = {
  'cat {p}': [1, 1],
  'wc {p}': [1, 1],
  'head {p}': [1, 1],
  'cut -c1 {p}': [1, 1],
  'nl {p}': [1, 1],
  'tac {p}': [1, 1],
  'rev {p}': [1, 1],
  'fold {p}': [1, 1],
  'fmt {p}': [1, 1],
  'expand {p}': [1, 1],
  'strings {p}': [1, 1],
  'md5sum {p}': [1, 1],
  'base64 {p}': [1, 1],
  'od {p}': [1, 1],
  'uniq {p}': [1, 1],
  'paste {p}': [1, 1],
  'tsort {p}': [1, 1],
  'shuf {p}': [1, 1],
  'split {p}': [1, 1],
  'csplit {p} 1': [1, 1],
  'column {p}': [1, 1],
  'look x {p}': [1, 1],
  'comm {p} {p}': [1, 1],
  'join {p} {p}': [1, 1],
  'iconv -f utf-8 -t utf-8 {p}': [1, 1],
  'xxd {p}': [2, 2],
  'sort {p}': [2, 2],
  "awk '{print}' {p}": [2, 2],
  'jq . {p}': [2, 2],
  'grep x {p}': [2, 2],
  // One file named twice is equal unread, so the second operand is another
  // file.
  'cmp {p} /ram/dir/inner.txt': [2, 2],
  'sed -n p {p}': [4, 2],
  'gzip -c {p}': [2, 1],
  'gunzip -c {p}': [2, 1],
  'zcat {p}': [2, 1],
  'zgrep x {p}': [1, 2],
}

// zgrep runs gzip with -q, which keeps a directory's warning to itself, so
// GNU and mirage both exit 1 there without a word. jq 1.8.2 opens a
// directory, fails at its first read and says so without naming it, and
// glibc's iconv words it as "error while reading the input" (see the python
// twin).
const SILENT_HERE: ReadonlySet<string> = new Set(['zgrep x {p}'])
const BARE_HERE: ReadonlyMap<string, string> = new Map([
  ['jq . {p}', 'jq: error: Is a directory\n'],
  ['iconv -f utf-8 -t utf-8 {p}', 'iconv: error while reading the input: Is a directory\n'],
])

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  const ws = new Workspace(
    { '/ram': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  await ws.shell('mkdir -p /ram/dir')
  await ws.shell('echo inner > /ram/dir/inner.txt')
  return ws
}

describe('a read that fails answers like GNU', () => {
  for (const [template, [dirExit, missExit]] of Object.entries(GNU_READ_EXIT)) {
    it(`${template}: directory exits ${String(dirExit)}`, async () => {
      const ws = await makeWs()
      const io = await ws.shell(template.replaceAll('{p}', '/ram/dir'))
      expect(io.exitCode).toBe(dirExit)
    })

    it(`${template}: missing file exits ${String(missExit)}`, async () => {
      const ws = await makeWs()
      const io = await ws.shell(template.replaceAll('{p}', '/ram/nope.txt'))
      expect(io.exitCode).toBe(missExit)
    })

    const says = SILENT_HERE.has(template) ? 'is silent like GNU' : 'says Is a directory'
    it(`${template}: directory ${says}`, async () => {
      const ws = await makeWs()
      const io = await ws.shell(template.replaceAll('{p}', '/ram/dir'))
      const stderr = io.stderrText
      if (SILENT_HERE.has(template)) {
        expect(stderr).toBe('')
        return
      }
      const bare = BARE_HERE.get(template)
      if (bare !== undefined) {
        expect(stderr).toBe(bare)
        return
      }
      // FAILURE_WORDING's commands say the step in GNU's words where that
      // still names the operand (head/tail/uniq `error reading 'dir'`,
      // tac/tsort `dir: read error`, sed `read error on dir`); the rest say
      // the house `<cmd>: <path>: Is a directory`, awk mawk's `cannot open
      // "dir" (Is a directory)` and the gzip family gzip's own `dir is a
      // directory -- ignored` (see the python twin).
      expect(
        stderr.includes('/ram/dir: Is a directory') ||
          stderr.includes('/ram/dir: read error: Is a directory') ||
          stderr.includes("error reading '/ram/dir': Is a directory") ||
          stderr.includes('cannot open "/ram/dir" (Is a directory)') ||
          stderr.includes('gzip: /ram/dir is a directory -- ignored'),
      ).toBe(true)
      expect(stderr).not.toContain('No such file')
    })
  }
})

// GNU sed splits a failed operand two ways and only sed does: an OPEN
// error is reported and the run continues, a READ error is fatal. Every
// other command in the family continues past a directory (pinned: `cat ok
// dir ok2`, `wc`, `cut`, `nl`, `md5sum`, `od` and `paste` all emit the
// operands after the directory). sort emits nothing on any failure
// because it needs all input before it can sort.
const GNU_MULTI: [string, number, string, string][] = [
  [
    'sed -n p /ram/nope /ram/ok.txt',
    2,
    'a\nb\n',
    "sed: can't read /ram/nope: No such file or directory\n",
  ],
  ['sed -n p /ram/dir /ram/ok.txt', 4, '', 'sed: read error on /ram/dir: Is a directory\n'],
  [
    'sed -n p /ram/ok.txt /ram/dir /ram/ok2.txt',
    4,
    'a\nb\n',
    'sed: read error on /ram/dir: Is a directory\n',
  ],
  [
    'sed -n p /ram/ok.txt /ram/nope /ram/ok2.txt',
    2,
    'a\nb\nc\nd\n',
    "sed: can't read /ram/nope: No such file or directory\n",
  ],
  ['sed -n p /ram/dir /ram/dir', 4, '', 'sed: read error on /ram/dir: Is a directory\n'],
  [
    'sed -n p /ram/nope /ram/dir',
    4,
    '',
    "sed: can't read /ram/nope: No such file or directory\nsed: read error on /ram/dir: Is a directory\n",
  ],
  [
    'sort /ram/ok.txt /ram/dir /ram/ok2.txt',
    2,
    '',
    'sort: read failed: /ram/dir: Is a directory\n',
  ],
  ['cat /ram/ok.txt /ram/dir /ram/ok2.txt', 1, 'a\nb\nc\nd\n', 'cat: /ram/dir: Is a directory\n'],
  [
    'zcat /ram/dir /ram/nope',
    1,
    '',
    'gzip: /ram/dir is a directory -- ignored\ngzip: /ram/nope.gz: No such file or directory\n',
  ],
  // gzip's error outranks its warning in EITHER order, so the reversed line
  // is 1 too: `progerror` assigns ERROR outright while `WARN` assigns only
  // when nothing has failed yet. Two warnings and no error stay 2.
  [
    'zcat /ram/nope /ram/dir',
    1,
    '',
    'gzip: /ram/nope.gz: No such file or directory\ngzip: /ram/dir is a directory -- ignored\n',
  ],
  [
    'zcat /ram/dir /ram/dir',
    2,
    '',
    'gzip: /ram/dir is a directory -- ignored\ngzip: /ram/dir is a directory -- ignored\n',
  ],
]

describe('a multi-operand read failure answers like GNU', () => {
  for (const [line, code, out, err] of GNU_MULTI) {
    it(line, async () => {
      const ws = await makeWs()
      await ws.shell("printf 'a\\nb\\n' > /ram/ok.txt")
      await ws.shell("printf 'c\\nd\\n' > /ram/ok2.txt")
      const io = await ws.shell(line)
      expect(io.stderrText).toBe(err)
      expect(io.stdoutText).toBe(out)
      expect(io.exitCode).toBe(code)
    })
  }
})
