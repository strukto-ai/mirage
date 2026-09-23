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
import {
  countOccurrences,
  makeWorkspace,
  stdoutBytes,
  stdoutStr,
} from './fixtures/workspace_fixture.ts'

describe('workspace: grep/awk/sed/jq/wc/head/tail/cut/uniq/tr', () => {
  it('grep pattern', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('grep alice /s3/report.csv')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('alice')
    expect(stdoutStr(io)).not.toContain('bob')
    await ws.close()
  })

  it('grep count', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('grep -c GET /s3/access.log')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('grep invert', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('grep -v 500 /s3/access.log')
    const out = stdoutStr(io)
    expect(out).not.toContain('500')
    expect(out).toContain('200')
    await ws.close()
  })

  it('grep in pipe', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat /s3/access.log | grep POST')
    expect(countOccurrences(stdoutBytes(io), 'POST')).toBe(2)
    expect(stdoutStr(io)).not.toContain('GET')
    await ws.close()
  })

  it('awk print field', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("awk -F, '{print $1}' /s3/report.csv")
    const out = stdoutStr(io)
    expect(out).toContain('name')
    expect(out).toContain('alice')
    await ws.close()
  })

  it('awk sum', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("awk -F, 'NR>1{s+=$2}END{print s}' /s3/report.csv")
    expect(stdoutStr(io)).toContain('55')
    await ws.close()
  })

  it('sed substitute', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("sed 's/alice/ALICE/' /s3/report.csv")
    const out = stdoutStr(io)
    expect(out).toContain('ALICE')
    expect(out).not.toContain('alice')
    await ws.close()
  })

  it('sed delete line', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("sed '/bob/d' /s3/report.csv")
    const out = stdoutStr(io)
    expect(out).not.toContain('bob')
    expect(out).toContain('alice')
    await ws.close()
  })

  it('sed in pipe', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat /s3/report.csv | sed 's/,/ | /g'")
    expect(stdoutStr(io)).toContain(' | ')
    await ws.close()
  })

  it('jq field', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("jq '.[0].name' /s3/users.json")
    expect(stdoutStr(io)).toContain('alice')
    await ws.close()
  })

  it('jq length', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("jq 'length' /s3/users.json")
    expect(stdoutStr(io)).toContain('2')
    await ws.close()
  })

  it('jq in pipe', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat /s3/users.json | jq '.[1].age'")
    expect(stdoutStr(io)).toContain('25')
    await ws.close()
  })

  it('wc -l', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('wc -l /ram/notes.txt')
    expect(stdoutStr(io)).toContain('3')
    await ws.close()
  })

  it('wc -l in pipe', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cat /s3/access.log | wc -l')
    expect(stdoutStr(io)).toContain('5')
    await ws.close()
  })

  it('head -n', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('head -n 2 /s3/access.log')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines.length).toBe(2)
    await ws.close()
  })

  it('tail -n', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('tail -n 2 /s3/access.log')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines.length).toBe(2)
    await ws.close()
  })

  it('cut field', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('cut -d, -f1 /s3/report.csv')
    const out = stdoutStr(io)
    expect(out).toContain('name')
    expect(out).toContain('alice')
    await ws.close()
  })

  it('uniq dedupes', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('sort /ram/words.txt | uniq')
    expect(countOccurrences(stdoutBytes(io), 'apple')).toBe(1)
    await ws.close()
  })

  it('tr upper', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell("cat /s3/data.txt | tr 'a-z' 'A-Z'")
    expect(stdoutStr(io)).toContain('HELLO FROM S3')
    await ws.close()
  })

  it('sort numeric', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('sort -n /ram/nums.txt')
    const lines = stdoutStr(io).trim().split('\n')
    expect(lines).toEqual(['1', '2', '3', '4', '5'])
    await ws.close()
  })

  it('rev in pipe', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('echo hello | rev')
    expect(stdoutStr(io)).toContain('olleh')
    await ws.close()
  })

  it('nl numbers lines', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('nl /ram/notes.txt')
    const out = stdoutStr(io)
    expect(out).toContain('1')
    expect(out).toContain('line1')
    await ws.close()
  })
})
