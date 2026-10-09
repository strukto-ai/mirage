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
