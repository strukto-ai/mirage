import type { PathSpec } from '@struktoai/mirage-core/types'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { vfsCall } from '@struktoai/mirage-core/vfs/call'
import { Effect } from '@struktoai/mirage-core/vfs/types'
import { stderr, stdout } from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { buildApp } from '../app.ts'
import * as ioSerde from '../io_serde.ts'
import { HttpError, invalidBody, invalidChoice, queryFlag } from './vfs.ts'

describe('validation failures in FastAPI shape', () => {
  const Body = z
    .object({
      command: z.string(),
      record: z.boolean().optional(),
      mounts: z.record(z.string(), z.string()).optional(),
    })
    .strict()

  it.each([
    [{}, [{ type: 'missing', loc: ['body', 'command'], msg: 'Field required', input: {} }]],
    [
      { command: 'x', a: 1, b: 2 },
      [
        {
          type: 'extra_forbidden',
          loc: ['body', 'a'],
          msg: 'Extra inputs are not permitted',
          input: 1,
        },
        {
          type: 'extra_forbidden',
          loc: ['body', 'b'],
          msg: 'Extra inputs are not permitted',
          input: 2,
        },
      ],
    ],
    [
      { command: 'x', record: 'yes' },
      [
        {
          type: 'bool_type',
          loc: ['body', 'record'],
          msg: 'Input should be a valid boolean',
          input: 'yes',
        },
      ],
    ],
    [
      { command: 'x', mounts: { '/': 5 } },
      [
        {
          type: 'string_type',
          loc: ['body', 'mounts', '/'],
          msg: 'Input should be a valid string',
          input: 5,
        },
      ],
    ],
    [
      'x',
      [
        {
          type: 'model_attributes_type',
          loc: ['body'],
          msg: 'Input should be a valid dictionary or object to extract fields from',
          input: 'x',
        },
      ],
    ],
  ])('names each field of %j as pydantic does', (body, detail) => {
    const parsed = Body.safeParse(body)
    expect(parsed.success).toBe(false)
    const error = invalidBody((parsed as { error: z.ZodError }).error, body)
    expect([error.status, error.detail]).toEqual([422, detail])
  })

  it('locates a multipart part under body', () => {
    const parsed = Body.safeParse({ command: 1 })
    const error = invalidBody((parsed as { error: z.ZodError }).error, { command: 1 }, 'request')
    expect((error.detail as { loc: unknown[] }[]).map((issue) => issue.loc)).toEqual([
      ['body', 'request', 'command'],
    ])
  })

  it('reads every flag and names every bad one', () => {
    expect(queryFlag({ a: 'Yes', b: '0' }, 'a', 'b', 'c')).toEqual({ a: true, b: false, c: false })
    let refused: unknown
    try {
      queryFlag({ a: 'maybe', b: '' }, 'a', 'b')
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(HttpError)
    expect((refused as HttpError).detail).toEqual([
      {
        type: 'bool_parsing',
        loc: ['query', 'a'],
        msg: 'Input should be a valid boolean, unable to interpret input',
        input: 'maybe',
      },
      {
        type: 'bool_parsing',
        loc: ['query', 'b'],
        msg: 'Input should be a valid boolean, unable to interpret input',
        input: '',
      },
    ])
  })

  it('takes the last value of a flag given more than once', () => {
    expect(queryFlag({ a: ['abc', 'true'] }, 'a')).toEqual({ a: true })
    expect(queryFlag({ a: ['true', 'false'] }, 'a')).toEqual({ a: false })
    expect(() => queryFlag({ a: ['false', 'abc'] }, 'a')).toThrow(HttpError)
  })

  it('words a choice as pydantic words an enum', () => {
    expect(invalidChoice(['query', 'state'], ['a', 'b', 'c'], 'z').detail).toEqual([
      {
        type: 'enum',
        loc: ['query', 'state'],
        msg: "Input should be 'a', 'b' or 'c'",
        input: 'z',
        ctx: { expected: "'a', 'b' or 'c'" },
      },
    ])
  })
})

describe('vfs/read failure responses', () => {
  it.each([
    [new Error('backend token=secret'), 500, { detail: 'internal server error' }],
    [
      Object.assign(new Error('backend token=secret'), { code: 'ENOENT' }),
      404,
      { detail: 'No such file or directory', errno: 'ENOENT' },
    ],
    [
      Object.assign(new Error('backend token=secret'), { code: 'EDQUOT' }),
      507,
      { detail: 'Disk quota exceeded', errno: 'EDQUOT' },
    ],
    [
      Object.assign(new Error('backend token=secret'), { code: 'STALE_WRITE' }),
      409,
      { detail: 'changed since it was read; read it again before writing', errno: 'STALE_WRITE' },
    ],
    [
      Object.assign(new Error('backend token=secret'), { code: 'EFBIG' }),
      400,
      { detail: 'File too large', errno: 'EFBIG' },
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
      const diagnostics = vi.spyOn(stderr, 'write').mockReturnValue(true)
      const protocolOutput = vi.spyOn(stdout, 'write').mockReturnValue(true)
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${wid}/vfs/read`,
        payload: { path: '/file' },
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
    expect(reply.json()).toBe('/data/visible')
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
    expect(reply.json()).toBeNull()
    expect(backend.calls).toBe(2)
    for (const reserved of ['session_id', 'report', 'admit_only', 'retained', 'stream']) {
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
      url: base + '/read?session_id=agent',
      payload: { path: '/data/visible', stream: true },
    })
    expect(reply.statusCode).toBe(200)
    expect(reply.headers['content-type']).toBe('application/octet-stream')
    expect(Buffer.compare(reply.rawPayload, data)).toBe(0)
    reply = await app.inject({
      method: 'POST',
      url: base + '/read?session_id=agent',
      payload: { path: '/data/secret', stream: true },
    })
    expect(reply.statusCode).toBe(404)
    reply = await app.inject({
      method: 'POST',
      url: base + '/read?session_id=agent',
      payload: { path: '/data/visible', stream: 'yes' },
    })
    expect(reply.statusCode).toBe(400)
  } finally {
    await app.close()
  }
})
