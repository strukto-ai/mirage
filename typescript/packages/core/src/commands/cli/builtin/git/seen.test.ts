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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'

import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import type { SessionProfile } from '../../../../policy/profile.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir, readOptional } from './io.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

const PROFILES: Record<string, SessionProfile> = {
  veiled: { paths: { hide: ['/repo/secret.txt', '/repo/box/secret.txt'] } },
  boxed: { paths: { hide: ['/repo/box/secret.txt'] } },
  sealed: { commands: { deny: [{ reason: 'sealed', paths: ['/repo/secret.txt'] }] } },
}

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

/**
 * A repository whose secret was committed twice, beside a folder holding
 * another secret and a public file; the second version's bytes are also
 * committed at a public place. One session per profile.
 */
async function history(): Promise<Workspace> {
  const ws = new Workspace(
    { '/repo': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: parser, profiles: PROFILES },
  )
  ws.registerCli('git', GIT)
  await ws.shell('cd /repo && git init -q')
  for (const [name, text, message] of [
    ['ok.txt', 'public\n', 'first'],
    ['secret.txt', 'S3CR3T one\n', 'second'],
    ['box/secret.txt', 'S3CR3T boxed\n', 'third'],
    ['box/pub.txt', 'pub\n', 'fourth'],
    ['secret.txt', 'S3CR3T two\n', 'fifth'],
    ['copy.txt', 'S3CR3T one\n', 'sixth'],
  ] as const) {
    const target = PathSpec.fromStrPath(`/repo/${name}`)
    await ensureDir(ws.vfs, target.parent)
    await ws.dispatch('write', target.virtual, [ENC.encode(text)])
    await ws.shell(`cd /repo && git add ${name} && git commit -q -m ${message}`)
  }
  for (const profile of Object.keys(PROFILES)) ws.createSession(profile, { profile })
  return ws
}

/** Run one line in /repo, as a session or unrestricted. */
async function shell(
  ws: Workspace,
  line: string,
  session: string | null = null,
): Promise<[number, string, string]> {
  const io = await ws.shell(
    `cd /repo && ${line}`,
    session === null ? undefined : { sessionId: session },
  )
  return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
}

describe('what a session is shown of history', () => {
  it('reads a hidden path as one the history never had', async () => {
    const ws = await history()
    for (const line of [
      'git show HEAD:{}',
      'git cat-file -p HEAD:{}',
      'git cat-file -s HEAD:{}',
      'git show :{}',
    ]) {
      const hidden = await shell(ws, line.replace('{}', 'secret.txt'), 'veiled')
      const missing = await shell(ws, line.replace('{}', 'nothere.txt'), 'veiled')
      expect(hidden).toEqual(
        missing.map((part) =>
          typeof part === 'string' ? part.replaceAll('nothere.txt', 'secret.txt') : part,
        ),
      )
    }
    expect(await shell(ws, 'git log -S S3CR3T --format=%s', 'veiled')).toEqual([0, 'sixth\n', ''])
    expect(await shell(ws, 'git grep -l S3CR3T HEAD~1', 'veiled')).toEqual([1, '', ''])
  })

  it('names nothing by an id held only at a hidden place', async () => {
    const ws = await history()
    const [, second] = await shell(ws, 'git rev-parse HEAD:secret.txt')
    const blob = second.trim()
    expect(await shell(ws, `git cat-file -p ${blob}`, 'veiled')).toEqual([
      128,
      '',
      `fatal: Not a valid object name ${blob}\n`,
    ])
    expect((await shell(ws, `git cat-file -e ${blob}`, 'veiled'))[0]).toBe(1)
    // The first version's bytes also stand at a public place.
    const [, first] = await shell(ws, 'git rev-parse HEAD:copy.txt')
    expect(await shell(ws, `git cat-file -p ${first.trim()}`, 'veiled')).toEqual([
      0,
      'S3CR3T one\n',
      '',
    ])
  })

  it('lists what a tree holds at its place', async () => {
    const ws = await history()
    const [, root] = await shell(ws, 'git ls-tree --name-only HEAD', 'boxed')
    expect(root.split(/\s+/)).toContain('secret.txt')
    for (const line of ['git ls-tree --name-only HEAD:box', 'git cat-file -p HEAD:box']) {
      const [code, out] = await shell(ws, line, 'boxed')
      expect(code).toBe(0)
      expect(out).toContain('pub.txt')
      expect(out).not.toContain('secret.txt')
    }
    const [, box] = await shell(ws, 'git rev-parse HEAD:box')
    const [code, out] = await shell(ws, `git ls-tree --name-only ${box.trim()}`, 'boxed')
    expect([code, out]).toEqual([0, 'pub.txt\n'])
    expect(await shell(ws, 'git show HEAD:box', 'boxed')).toEqual([
      0,
      'tree HEAD:box\n\npub.txt\n',
      '',
    ])
    const [shown, listing] = await shell(ws, 'git cat-file -p HEAD^{tree}', 'veiled')
    expect(shown).toBe(0)
    expect(listing).not.toContain('secret.txt')
    expect(listing).toContain('copy.txt')
  })

  it('keeps history content from a rule but not names', async () => {
    const ws = await history()
    for (const [verb, line] of [
      ['show', 'git show HEAD:secret.txt'],
      ['log', 'git log -p'],
      ['grep', 'git grep S3CR3T HEAD'],
      ['cat-file', 'git cat-file -s HEAD:secret.txt'],
    ] as const) {
      expect(await shell(ws, line, 'sealed')).toEqual([
        1,
        '',
        `git ${verb}: /repo/secret.txt: Permission denied\n`,
      ])
    }
    const [code, out] = await shell(ws, 'git log -p -- ok.txt', 'sealed')
    expect(code).toBe(0)
    expect(out).toContain('public')
    const [listed, names] = await shell(ws, 'git ls-tree --name-only HEAD', 'sealed')
    expect(listed).toBe(0)
    expect(names.split(/\s+/)).toContain('secret.txt')
  })

  it('leaves the index as it was when a checkout is refused', async () => {
    const ws = await history()
    const before = await shell(ws, 'git ls-files -s secret.txt')
    const [code, , err] = await shell(ws, 'git checkout HEAD~2 -- secret.txt', 'sealed')
    expect([code, err]).toEqual([1, 'git checkout: /repo/secret.txt: Permission denied\n'])
    expect(await shell(ws, 'git ls-files -s secret.txt')).toEqual(before)
    const data = await readOptional(ws.vfs, PathSpec.fromStrPath('/repo/secret.txt'))
    expect(DEC.decode(data ?? new Uint8Array())).toBe('S3CR3T two\n')
  })

  it('stands a path in a tree named by id where the tree does', async () => {
    const ws = await history()
    const [, box] = await shell(ws, 'git rev-parse HEAD:box')
    const tree = box.trim()
    const [code, out] = await shell(ws, `git cat-file -p ${tree}:secret.txt`, 'boxed')
    expect(code).toBe(128)
    expect(out).not.toContain('S3CR3T')
    expect(await shell(ws, `git cat-file -p ${tree}:pub.txt`, 'boxed')).toEqual([0, 'pub\n', ''])
  })

  it('names nothing by a tag or a ref naming a hidden blob', async () => {
    const ws = await history()
    const [, second] = await shell(ws, 'git rev-parse HEAD:secret.txt')
    const blob = second.trim()
    await shell(ws, `git tag -a -m 'points at a blob' atag ${blob}`)
    await ws.dispatch('write', '/repo/.git/refs/tags/raw', [ENC.encode(`${blob}\n`)])
    for (const line of [
      'git cat-file blob atag',
      'git show atag',
      "git for-each-ref --format='%(raw)' refs/tags/raw",
      "git for-each-ref --format='%(*raw)' refs/tags/atag",
    ]) {
      const [, out] = await shell(ws, line, 'veiled')
      expect(out, line).not.toContain('S3CR3T')
    }
    expect(await shell(ws, "git for-each-ref --format='%(raw)' refs/tags/raw", 'veiled')).toEqual([
      0,
      '',
      'error: refs/tags/raw does not point to a valid object!\n',
    ])
    const [, out] = await shell(ws, 'git cat-file blob atag')
    expect(out).toBe('S3CR3T two\n')
  })
})
