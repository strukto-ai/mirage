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
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Direct port of tests/commands/native/test_grep_filters.py, pinned
// against GNU grep 3.11 on debian:stable-slim.

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMVFS()
  r.store.files.set('/notes.tex', ENC.encode('score 9\n'))
  r.store.files.set('/notes.txt', ENC.encode('score 8\n'))
  r.store.dirs.add('/sub')
  r.store.files.set('/sub/inner.tex', ENC.encode('score 7\n'))
  r.store.files.set('/data.parquet', ENC.encode('score binary\n'))
  const registry = new OpsRegistry()
  registry.registerVfs(r)
  return new Workspace({ '/': r }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

describe('grep --include/--exclude/--exclude-dir and -a', () => {
  it('--include filters the recursive walk', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep -RInE --include='*.tex' score /")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('/notes.tex:1:score 9\n/sub/inner.tex:1:score 7\n')
  })

  it('a later exclude overrides an earlier include', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep -r --include='*.tex' --exclude='notes.*' score /")
    expect(stdoutStr(io)).toBe('/sub/inner.tex:score 7\n')
  })

  it('a later include overrides an earlier exclude', async () => {
    // GNU 3.11 resolves the two kinds by line order, so the reversed
    // spelling searches what the previous test skipped.
    const ws = await makeWs()
    const io = await ws.shell("grep -r --exclude='notes.*' --include='*.tex' score /")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('/notes.tex:score 9\n/sub/inner.tex:score 7\n')
  })

  it('the same pattern resolves by line order', async () => {
    // Pinned GNU 3.11: include-then-exclude of one pattern skips the
    // file, exclude-then-include searches it. The reversed order also
    // flips the no-match default, which is what admits notes.txt.
    const ws = await makeWs()
    const skipped = await ws.shell("grep -r --include='*.tex' --exclude='*.tex' score /")
    expect(skipped.exitCode).toBe(1)
    // The reversed order admits every no-match file, /.bash_history
    // included, so the pattern requires the digit only file bodies
    // carry to keep the recorded command lines out of the output.
    const searched = await ws.shell("grep -rE --exclude='*.tex' --include='*.tex' 'score [0-9]' /")
    expect(searched.exitCode).toBe(0)
    expect(stdoutStr(searched)).toBe(
      '/notes.tex:score 9\n/notes.txt:score 8\n/sub/inner.tex:score 7\n',
    )
  })

  it('the no-match default follows the first kind', async () => {
    // GNU 3.11: a file matching no rule is searched when the first
    // filter option is an exclude, skipped when it is an include.
    const ws = await makeWs()
    const excludeFirst = await ws.shell("grep -r --exclude='*.log' --include='*.zzz' score /")
    expect(excludeFirst.exitCode).toBe(0)
    const includeFirst = await ws.shell("grep -r --include='*.zzz' --exclude='*.log' score /")
    expect(includeFirst.exitCode).toBe(1)
  })

  it('an explicit operand follows the order rule', async () => {
    const ws = await makeWs()
    const admitted = await ws.shell("grep --exclude='*.txt' --include='*.txt' score /notes.txt")
    expect(admitted.exitCode).toBe(0)
    const skipped = await ws.shell("grep --include='*.txt' --exclude='*.txt' score /notes.txt")
    expect(skipped.exitCode).toBe(1)
  })

  it('--exclude-dir prunes the walk', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep -r --include='*.tex' --exclude-dir=sub score /")
    expect(stdoutStr(io)).toBe('/notes.tex:score 9\n')
  })

  it('a glob carrying a slash matches nothing', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep -r --include='sub/*.tex' score /")
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('--include filters an explicit operand in silence', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep --include='*.tex' -n score /notes.txt")
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('')
  })

  it('-a reads binary extensions in the walk', async () => {
    const ws = await makeWs()
    const without = await ws.shell('grep -r score /')
    expect(stdoutStr(without)).not.toContain('data.parquet')
    const withA = await ws.shell('grep -ra score /')
    expect(stdoutStr(withA)).toContain('/data.parquet:score binary')
  })

  it('-a is accepted on an explicit operand', async () => {
    const ws = await makeWs()
    const io = await ws.shell("grep -aoiE 'SCORE' /notes.tex")
    expect(stdoutStr(io)).toBe('score\n')
  })
})
