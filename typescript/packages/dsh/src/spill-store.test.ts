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
import { Context } from '@deepseek-ai/cordis'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { MirageService } from './service.ts'
import { MirageSpillStore, encodeSegment, sessionDirName } from './spill-store.ts'
import type { MirageSpillConfig } from './spill-store.ts'

type SessionId = SaveTextSpill['owner']['sessionId']
type ToolCallId = Extract<SaveTextSpill['source'], { kind: 'tool' }>['callId']

const workspaces: Workspace[] = []

/**
 * A spill store over a fresh workspace.
 *
 * @param options `mode` for the `/tmp` mount, and the store's own config.
 * @returns the store and the workspace behind it.
 */
async function makeStore(
  options: { mode?: MountMode; config?: MirageSpillConfig } = {},
): Promise<{ store: MirageSpillStore; ws: Workspace }> {
  const ws = new Workspace({ '/tmp': [new RAMResource(), options.mode ?? MountMode.WRITE] })
  workspaces.push(ws)
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageSpillStore, options.config ?? {}).await()
  return { store: ctx.spillStore as MirageSpillStore, ws }
}

/**
 * One save request, with the fields a tool result carries.
 *
 * @param content the text to persist.
 * @param overrides session id and suggested name.
 * @returns the request.
 */
function request(
  content: string,
  overrides: { sessionId?: string; suggestedName?: string } = {},
): SaveTextSpill {
  return {
    owner: { sessionId: (overrides.sessionId ?? 'session-a') as SessionId },
    source: {
      kind: 'tool',
      toolName: 'bash',
      callId: 'call-1' as ToolCallId,
      label: 'result',
    },
    suggestedName: overrides.suggestedName ?? 'bash.txt',
    content,
  }
}

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
})

describe('encodeSegment', () => {
  it('keeps the portable filename characters as themselves', () => {
    expect(encodeSegment('web_fetch-1.txt')).toBe('web_fetch-1.txt')
  })

  it('encodes a separator, so the name cannot become a path', () => {
    expect(encodeSegment('a/b')).toBe('a~002Fb')
  })

  it('encodes traversal, so the name cannot climb out of its directory', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('../../etc/passwd')).not.toContain('/')
  })

  it('encodes the escape character itself, keeping the encoding reversible', () => {
    // Without this a literal `~002F` would decode as a separator that was
    // never in the caller's name.
    expect(encodeSegment('~002F')).toBe('~007E002F')
  })

  it('gives an empty name something to be', () => {
    expect(encodeSegment('')).toBe('~')
  })

  it('encodes a space, a newline and a NUL rather than passing them on', () => {
    expect(encodeSegment('a b\nc\u0000d')).toBe('a~0020b~000Ac~0000d')
  })
})

describe('sessionDirName', () => {
  it('is stable for one id and different across ids', () => {
    expect(sessionDirName('session-a')).toBe(sessionDirName('session-a'))
    expect(sessionDirName('session-a')).not.toBe(sessionDirName('session-b'))
  })

  it('does not republish the session id in a directory an agent can list', () => {
    expect(sessionDirName('session-a')).not.toContain('session-a')
    expect(sessionDirName('session-a')).toMatch(/^session-[0-9a-f]{12}$/)
  })
})

describe('saveText', () => {
  it('writes the full content where the locator says', async () => {
    const { store, ws } = await makeStore()
    const ref = await store.saveText(request('the whole output'))
    expect(await ws.fs.readFileText(String(ref.locator))).toBe('the whole output')
  })

  it('reports the exact UTF-8 byte length, not the character count', async () => {
    const { store } = await makeStore()
    const ref = await store.saveText(request('héllo'))
    expect(ref.bytes).toBe(6)
  })

  it('lands under the configured directory', async () => {
    const { store } = await makeStore({ config: { dir: '/tmp/elsewhere' } })
    const ref = await store.saveText(request('x'))
    expect(String(ref.locator)).toMatch(/^\/tmp\/elsewhere\/session-[0-9a-f]{12}\//)
  })

  it('defaults to /tmp/dsh-spill, the directory the bundle patch mounts', async () => {
    const { store } = await makeStore()
    const ref = await store.saveText(request('x'))
    expect(String(ref.locator)).toMatch(/^\/tmp\/dsh-spill\/session-[0-9a-f]{12}\//)
  })

  it('canonicalizes a non-canonical dir, so the locator addresses the bytes', async () => {
    // Written literally, a `..` component lands on a key that every
    // reader normalizes away, so neither spelling can open the file.
    const { store, ws } = await makeStore({ config: { dir: '/tmp/artifacts/../spill' } })
    const ref = await store.saveText(request('PAYLOAD'))
    const locator = String(ref.locator)
    expect(locator).toMatch(/^\/tmp\/spill\/session-[0-9a-f]{12}\//)
    expect(locator).not.toContain('..')
    expect(await ws.fs.readFileText(locator)).toBe('PAYLOAD')
    // The whole point: a shell reading the locator back finds it.
    ws.createSession('probe')
    const read = await ws.execute(`cat ${locator}`, { sessionId: 'probe' })
    expect(read.exitCode).toBe(0)
    // `ws.execute` answers in bytes, unlike the dsh shell seam's text.
    expect(new TextDecoder().decode(read.stdout)).toBe('PAYLOAD')
  })

  it('collapses a redundant slash and a dot segment', async () => {
    const { store } = await makeStore({ config: { dir: '/tmp//./spill' } })
    expect(String((await store.saveText(request('x'))).locator)).toMatch(
      /^\/tmp\/spill\/session-[0-9a-f]{12}\//,
    )
  })

  it('clamps a dir that climbs past the workspace root', async () => {
    const { store } = await makeStore({ config: { dir: '/../../tmp/spill' } })
    expect(String((await store.saveText(request('x'))).locator)).toMatch(/^\/tmp\/spill\//)
  })

  it('refuses a relative dir at construction', async () => {
    await expect(makeStore({ config: { dir: 'spill' } })).rejects.toThrow(
      /spill dir must be an absolute workspace path/,
    )
  })

  it('scopes one session away from another', async () => {
    const { store } = await makeStore()
    const a = await store.saveText(request('a', { sessionId: 'session-a' }))
    const b = await store.saveText(request('b', { sessionId: 'session-b' }))
    const dirOf = (locator: string): string => locator.slice(0, locator.lastIndexOf('/'))
    expect(dirOf(String(a.locator))).not.toBe(dirOf(String(b.locator)))
  })

  it('derives the name from the suggestion without ever equalling it', async () => {
    const { store } = await makeStore()
    const ref = await store.saveText(request('x', { suggestedName: 'web_fetch.txt' }))
    const name = String(ref.locator).split('/').pop() ?? ''
    expect(name).toContain('web_fetch.txt')
    expect(name).not.toBe('web_fetch.txt')
  })

  it('keeps two results with one suggested name apart', async () => {
    const { store, ws } = await makeStore()
    const first = await store.saveText(request('first', { suggestedName: 'r.txt' }))
    const second = await store.saveText(request('second', { suggestedName: 'r.txt' }))
    expect(String(first.locator)).not.toBe(String(second.locator))
    expect(await ws.fs.readFileText(String(first.locator))).toBe('first')
    expect(await ws.fs.readFileText(String(second.locator))).toBe('second')
  })

  it('cannot be walked out of its directory by a suggested name', async () => {
    const { store } = await makeStore()
    const ref = await store.saveText(request('x', { suggestedName: '../../escaped' }))
    expect(String(ref.locator)).toMatch(/^\/tmp\/dsh-spill\/session-[0-9a-f]{12}\/[^/]+$/)
  })

  it('rejects rather than return a locator for a file it never wrote', async () => {
    // A read-only mount is the shape of the predictable misconfiguration:
    // the spill directory is somewhere this world cannot write.
    const { store } = await makeStore({ mode: MountMode.READ })
    await expect(store.saveText(request('x'))).rejects.toThrow(/cannot write spill artifact/)
  })

  it('names the path it could not write, and keeps the cause', async () => {
    const { store } = await makeStore({ mode: MountMode.READ })
    const err = await store.saveText(request('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('/tmp/dsh-spill/')
    expect((err as Error).cause).toBeDefined()
  })
})
