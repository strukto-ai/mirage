import type { PathSpec } from '@struktoai/mirage-core/types'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { vfsCall } from '@struktoai/mirage-core/vfs/call'
import { Effect } from '@struktoai/mirage-core/vfs/types'
import { stderr, stdout } from 'node:process'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import * as ioSerde from '../io_serde.ts'

describe.each(['vfs/read', 'glob'])('%s failure responses', (route) => {
  it.each([
    [new Error('backend token=secret'), 500, { detail: 'internal server error' }],
    [
      Object.assign(new Error('backend token=secret'), { code: 'ENOENT' }),
      404,
      { detail: 'No such file or directory', errno: 'ENOENT' },
    ],
  ])('keeps private exception details out of HTTP responses (%s)', async (err, status, body) => {
    const app = buildApp()
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { mounts: { '/': { vfs: 'ram' } } } },
      })
      const wid = created.json<{ id: string }>().id
      vi.spyOn(ioSerde, 'answered').mockRejectedValue(err)
      vi.spyOn(Session.prototype, 'glob').mockRejectedValue(err)
      const diagnostics = vi.spyOn(stderr, 'write').mockReturnValue(true)
      const protocolOutput = vi.spyOn(stdout, 'write').mockReturnValue(true)
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${wid}/${route}`,
        payload: route === 'vfs/read' ? { path: '/file' } : { pattern: '/*' },
      })
      expect(response.statusCode).toBe(status)
      expect(response.json()).toEqual(body)
      expect(diagnostics.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(err.stack)
      expect(protocolOutput).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await app.close()
    }
  })
})

class PeekVFS extends RAMVFS {
  calls = 0
  @vfsCall({ effect: Effect.WRITE })
  shelve(_path: PathSpec): Promise<void> {
    this.calls++
    return Promise.resolve()
  }
  @vfsCall({ effect: Effect.READ })
  peek(path: PathSpec): Promise<string> {
    this.calls++
    return Promise.resolve(path.virtual)
  }
}

it('keeps the session gate for custom functions and streamed reads', async () => {
  const app = buildApp()
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        config: {
          mounts: { '/base': { vfs: 'ram' } },
          profiles: { agent: { paths: { hide: ['/data/secret'] } } },
        },
      },
    })
    expect(created.statusCode, created.body).toBeLessThan(300)
    const wid = created.json<{ id: string }>().id
    const ws = app.registry.get(wid).runner.ws
    const backend = new PeekVFS()
    ws.addMount('/data', backend, MountMode.WRITE)
    const data = Buffer.from('abcdefgh'.repeat(131072))
    await ws.vfs.write('/data/visible', data)
    await ws.vfs.write('/data/secret', 'secret')
    await ws.session('agent', { profile: 'agent' })
    const base = `/v1/workspaces/${wid}/vfs`
    let reply = await app.inject({
      method: 'POST',
      url: base + '/peek?session_id=agent',
      payload: { path: '/data/visible' },
    })
    expect(reply.statusCode, reply.body).toBe(200)
    expect(reply.json()).toEqual({ value: '/data/visible' })
    reply = await app.inject({
      method: 'POST',
      url: base + '/peek?session_id=agent',
      payload: { path: '/data/secret' },
    })
    expect(reply.statusCode).toBe(404)
    expect(backend.calls).toBe(1)
    reply = await app.inject({
      method: 'POST',
      url: base + '/shelve?session_id=agent',
      payload: { path: '/data/visible' },
    })
    expect(reply.statusCode, reply.body).toBe(200)
    expect(reply.json()).toEqual({ value: null })
    expect(backend.calls).toBe(2)
    for (const reserved of ['session_id', 'report', 'admit_only', 'stream']) {
      reply = await app.inject({
        method: 'POST',
        url: base + '/peek?session_id=agent',
        payload: { path: '/data/secret', kwargs: { [reserved]: 'default' } },
      })
      expect(reply.statusCode).toBe(400)
    }
    reply = await app.inject({
      method: 'POST',
      url: base + '/copy?session_id=agent',
      payload: { path: '/data/visible', kwargs: { dst: '/data/x' } },
    })
    expect(reply.statusCode, reply.body).toBe(400)
    reply = await app.inject({
      method: 'POST',
      url: base + '/read_stream?session_id=agent',
      payload: { path: '/data/visible' },
    })
    expect(reply.statusCode).toBe(200)
    expect(reply.headers['content-type']).toBe('application/octet-stream')
    expect(Buffer.compare(reply.rawPayload, data)).toBe(0)
    reply = await app.inject({
      method: 'POST',
      url: base + '/read_stream?session_id=agent',
      payload: { path: '/data/secret' },
    })
    expect(reply.statusCode).toBe(404)
  } finally {
    await app.close()
  }
})
