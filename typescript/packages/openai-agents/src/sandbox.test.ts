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

import { describe, expect, it, vi } from 'vitest'
import { RunState, run, type Editor } from '@openai/agents'
import {
  Manifest,
  SandboxAgent,
  SandboxUnsupportedFeatureError,
  shell,
} from '@openai/agents/sandbox'
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { INTERRUPT, INTERRUPTED_EXIT_CODE, NO_STDIN } from './constants.ts'
import { MirageSandboxClient, combinedOutput } from './sandbox.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function mkWs(): Workspace {
  return new Workspace(
    { '/': new RAMVFS(), '/ro': [new RAMVFS(), MountMode.READ] },
    { mode: MountMode.WRITE },
  )
}

function statusOf(result: Awaited<ReturnType<Editor['createFile']>>): string | undefined {
  return result ? result.status : undefined
}

function outputOf(response: string): string {
  return response.slice(response.indexOf('Output:\n') + 'Output:\n'.length)
}

describe('MirageSandboxClient', () => {
  it('starts every command at the manifest root', async () => {
    const client = new MirageSandboxClient(mkWs())
    const session = await client.create(
      new Manifest({
        root: '/workspace',
        entries: { 'notes.md': { type: 'file', content: 'hi\n' } },
      }),
    )
    expect((await session.exec({ cmd: 'pwd' })).stdout).toBe('/workspace\n')
    expect((await session.exec({ cmd: 'cat notes.md' })).stdout).toBe('hi\n')
  })

  it('runs in the model workdir, resolved against the root', async () => {
    const ws = mkWs()
    const session = await new MirageSandboxClient(ws).create(new Manifest({ root: '/project' }))
    await ws.vfs.mkdir('/project/sub')
    expect((await session.exec({ cmd: 'pwd', workdir: 'sub' })).stdout).toBe('/project/sub\n')
  })

  it('runs an unconfigured session at the mirage root', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    expect(session.state.manifest.root).toBe('/')
    expect((await session.exec({ cmd: 'pwd' })).stdout).toBe('/\n')
  })

  it('maps only the untouched SDK default manifest to the mirage root', () => {
    const client = new MirageSandboxClient(mkWs())
    expect(client.resolveTrustedManifestForResume(new Manifest()).root).toBe('/')
    const configured = new Manifest({ entries: { 'a.txt': { type: 'file', content: 'a' } } })
    expect(client.resolveTrustedManifestForResume(configured)).toBe(configured)
  })

  it('keeps cd and export inside their command', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    await session.exec({ cmd: 'cd /ro; export X=1' })
    expect((await session.exec({ cmd: 'pwd; echo X=$X' })).stdout).toBe('/\nX=\n')
  })

  it('gives each sandbox session its own mirage session until deleted', async () => {
    const ws = mkWs()
    const client = new MirageSandboxClient(ws)
    const first = await client.create()
    const second = await client.create()
    const ids = ws.listSessions().map((s) => s.sessionId)
    expect(ids).toContain(first.sessionId)
    expect(ids).toContain(second.sessionId)
    await client.delete(first.state)
    expect(ws.listSessions().map((s) => s.sessionId)).not.toContain(first.sessionId)
  })

  it('resolves relative paths against the manifest root', async () => {
    const ws = mkWs()
    const session = await new MirageSandboxClient(ws).create(new Manifest({ root: '/project' }))
    await ws.vfs.write('/project/rel.txt', 'rel')
    expect(new TextDecoder().decode(await session.readFile({ path: 'rel.txt' }))).toBe('rel')
    expect(await session.pathExists('rel.txt')).toBe(true)
  })

  it('tells a directory from a file and from nothing', async () => {
    const ws = mkWs()
    const session = await new MirageSandboxClient(ws).create(new Manifest({ root: '/project' }))
    await ws.vfs.mkdir('/project/sub')
    await ws.vfs.write('/project/sub/f.txt', 'f')
    expect(await session.directoryExists('sub')).toBe(true)
    expect(await session.directoryExists('sub/f.txt')).toBe(false)
    expect(await session.directoryExists('nope')).toBe(false)
  })

  it('materializes nested entries, creating every parent', async () => {
    const ws = mkWs()
    await new MirageSandboxClient(ws).create(
      new Manifest({
        root: '/workspace',
        entries: {
          'a/b': { type: 'dir', children: { 'c.txt': { type: 'file', content: 'deep' } } },
        },
      }),
    )
    expect(DEC.decode(await ws.vfs.read('/workspace/a/b/c.txt'))).toBe('deep')
  })

  it('passes the manifest environment to every command', async () => {
    const session = await new MirageSandboxClient(mkWs()).create(
      new Manifest({ root: '/project', environment: { GREETING: 'hi' } }),
    )
    expect((await session.exec({ cmd: 'echo $GREETING' })).stdout).toBe('hi\n')
  })

  it('patches files inside the sandbox session, resolved against the root', async () => {
    const ws = mkWs()
    const session = await new MirageSandboxClient(ws).create(new Manifest({ root: '/project' }))
    const writes = vi.spyOn(ws.vfs, 'write')
    const editor = session.createEditor()
    const created = await editor.createFile({
      type: 'create_file',
      path: 'pkg/new.py',
      diff: '+x = 1\n',
    })
    expect(statusOf(created)).toBe('completed')
    expect(DEC.decode(await ws.vfs.read('/project/pkg/new.py'))).toBe('x = 1')
    expect(writes.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['/project/pkg/new.py', session.sessionId],
    ])
    const updated = await editor.updateFile({
      type: 'update_file',
      path: 'pkg/new.py',
      diff: '@@\n-x = 1\n+x = 2\n',
    })
    expect(statusOf(updated)).toBe('completed')
    expect(DEC.decode(await ws.vfs.read('/project/pkg/new.py'))).toBe('x = 2')
    expect(statusOf(await editor.deleteFile({ type: 'delete_file', path: 'pkg/new.py' }))).toBe(
      'completed',
    )
    expect(await ws.vfs.exists('/project/pkg/new.py')).toBe(false)
  })

  it('keeps a leading BOM when it patches a file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/bom.txt', '\ufeffone\ntwo\nthree\n')
    const session = await new MirageSandboxClient(ws).create()
    const updated = await session.createEditor().updateFile({
      type: 'update_file',
      path: '/bom.txt',
      diff: '@@\n two\n-three\n+THREE\n',
    })
    expect(statusOf(updated)).toBe('completed')
    expect(Array.from(await ws.vfs.read('/bom.txt'))).toEqual(
      Array.from(ENC.encode('\ufeffone\ntwo\nTHREE\n')),
    )
  })

  it('reports a patch under a read-only mount as failed', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const result = await session
      .createEditor()
      .createFile({ type: 'create_file', path: '/ro/sub/new.py', diff: '+x\n' })
    expect(statusOf(result)).toBe('failed')
  })

  it('closes the session when the manifest cannot be written', async () => {
    const ws = mkWs()
    const before = ws.listSessions().length
    await expect(
      new MirageSandboxClient(ws).create(
        new Manifest({ entries: { 'x.txt': { type: 'local_file', src: '/etc/hosts' } } }),
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError)
    expect(ws.listSessions()).toHaveLength(before)
  })

  it('refuses an entry type it cannot materialize', async () => {
    const client = new MirageSandboxClient(mkWs())
    await expect(
      client.create(
        new Manifest({ entries: { 'x.txt': { type: 'local_file', src: '/etc/hosts' } } }),
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError)
  })

  it('lists a directory with each entry type', async () => {
    const ws = mkWs()
    const session = await new MirageSandboxClient(ws).create()
    await ws.vfs.mkdir('/d')
    await ws.vfs.mkdir('/d/sub')
    await ws.vfs.write('/d/f.txt', 'x')
    const entries = await session.listDir({ path: '/d' })
    expect(entries.map((e) => [e.name, e.path, e.type]).sort()).toEqual([
      ['f.txt', '/d/f.txt', 'file'],
      ['sub', '/d/sub', 'dir'],
    ])
  })

  it('keeps a long command running in the background', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const started = await session.exec({ cmd: 'sleep 1; echo done', yieldTimeMs: 100 })
    expect(started.sessionId).toBeDefined()
    expect(started.exitCode).toBeUndefined()
    const finished = await session.writeStdin({
      sessionId: started.sessionId ?? -1,
      yieldTimeMs: 5000,
    })
    expect(finished).toContain('Process exited with code 0')
    expect(outputOf(finished)).toBe('done\n')
  })

  it('runs a command beside a background one', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const started = await session.exec({ cmd: 'sleep 30', yieldTimeMs: 100 })
    expect(started.sessionId).toBeDefined()
    const quick = await session.exec({ cmd: 'echo fast' })
    expect(quick.exitCode).toBe(0)
    expect(quick.output).toBe('fast\n')
    await session.close()
  })

  it('answers a quick command at once with both streams', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const result = await session.exec({ cmd: 'echo out; echo err >&2' })
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('out\nerr\n')
  })

  it('cancels a background command on interrupt', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const started = await session.exec({ cmd: 'sleep 30', yieldTimeMs: 100 })
    const stopped = await session.writeStdin({
      sessionId: started.sessionId ?? -1,
      chars: INTERRUPT,
    })
    expect(stopped).toContain(`Process exited with code ${String(INTERRUPTED_EXIT_CODE)}`)
  })

  it('refuses stdin for a background command', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const started = await session.exec({ cmd: 'sleep 30', yieldTimeMs: 100 })
    await expect(
      session.writeStdin({ sessionId: started.sessionId ?? -1, chars: 'y\n' }),
    ).rejects.toThrow(NO_STDIN)
    await session.close()
  })

  it('reports an unknown background session', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    expect(await session.writeStdin({ sessionId: 42 })).toContain('session not found: 42')
  })

  it('keeps the agent edits when a deleted session resumes', async () => {
    const ws = mkWs()
    const client = new MirageSandboxClient(ws)
    const session = await client.create(
      new Manifest({
        root: '/workspace',
        entries: { 'notes.md': { type: 'file', content: 'v1\n' } },
      }),
    )
    await session.exec({ cmd: 'echo v2 > notes.md' })
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(session.state),
    )
    await client.delete(session.state)
    const resumed = await client.resume(state)
    expect((await resumed.exec({ cmd: 'cat notes.md' })).stdout).toBe('v2\n')
  })

  it('hands back the live session when it was never deleted', async () => {
    const client = new MirageSandboxClient(mkWs())
    const session = await client.create()
    expect(await client.resume(session.state)).toBe(session)
  })

  it('round-trips a workspace through persist and hydrate', async () => {
    const source = await new MirageSandboxClient(mkWs()).create()
    await source.exec({ cmd: 'echo kept > /kept.txt' })
    const archive = await source.persistWorkspace()
    const ws = mkWs()
    const target = await new MirageSandboxClient(ws).create()
    await target.hydrateWorkspace(archive)
    expect(DEC.decode(await ws.vfs.read('/kept.txt'))).toBe('kept\n')
  })

  it('joins stdout and stderr on separate lines', () => {
    expect(combinedOutput({ stdout: 'a', stderr: 'b', exitCode: 1 })).toBe('a\nb')
    expect(combinedOutput({ stdout: 'a\n', stderr: '', exitCode: 0 })).toBe('a\n')
  })

  it('resumes an approved command through the runner', async () => {
    const client = new MirageSandboxClient(mkWs())
    const agent = new SandboxAgent({
      name: 'gated',
      model: new ScriptedModel([
        [functionCall('exec_command', { cmd: 'echo resumed' }, { callId: 'call-1' })],
        [assistantMessage('done')],
      ]),
      capabilities: [
        shell({
          configureTools: (tools) =>
            tools.map((tool) => ({ ...tool, needsApproval: () => Promise.resolve(true) })),
        }),
      ],
    })
    const paused = await run(agent, 'go', { sandbox: { client } })
    expect(paused.interruptions.map((item) => item.name)).toEqual(['exec_command'])
    const state = await RunState.fromString(agent, paused.state.toString())
    for (const interruption of state.getInterruptions()) state.approve(interruption)
    const result = await run(agent, state, { sandbox: { client } })
    const outputs = result.newItems.filter((item) => item.type === 'tool_call_output_item')
    expect(JSON.stringify(outputs.map((item) => item.output))).toContain('resumed')
  })
})
