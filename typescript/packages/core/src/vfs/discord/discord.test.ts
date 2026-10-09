import { expect, it, vi } from 'vitest'
import { DiscordAccessor } from '../../accessor/discord.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { NodeDiscordTransport } from '../../core/discord/client.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DiscordVFSBase } from './discord.ts'

it.each([false, true])(
  'aborting cat releases a stalled attachment body (prefix=%s)',
  async (prefix) => {
    const abort = new AbortController()
    let markOpened = (): void => undefined
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve
    })
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let requestSignal: AbortSignal | null | undefined
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
          if (prefix) value.enqueue(new TextEncoder().encode('first\n'))
        },
        pull() {
          markOpened()
        },
      },
      { highWaterMark: 0 },
    )
    const fakeFetch = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal
      requestSignal?.addEventListener('abort', () => controller?.error(requestSignal?.reason), {
        once: true,
      })
      return Promise.resolve(new Response(body))
    })
    vi.stubGlobal('fetch', fakeFetch)
    const vfs = new DiscordVFSBase({
      name: 'discord',
      accessor: new DiscordAccessor(new NodeDiscordTransport('token')),
    })
    const ws = new Workspace({ '/chat': vfs }, { shellParser: await getTestParser() })
    const path = '/chat/team__G1/channels/general__C1/2026-04-24/files/report__A1.txt'
    await ws.mount('/chat').index.setDir(path.slice(0, path.lastIndexOf('/')), [
      [
        'report__A1.txt',
        new IndexEntry({
          id: 'A1',
          name: 'report.txt',
          vfsName: 'report__A1.txt',
          resourceType: 'discord/attachment',
          extra: { url: 'https://cdn.test/report' },
        }),
      ],
    ])
    const running = ws.shell(`cat ${path}`, { signal: abort.signal })
    const result = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await opened
      expect(requestSignal).toBeDefined()
      abort.abort()
      await result
      await ws.processes.drain()
      expect(requestSignal?.aborted).toBe(true)
      expect(body.locked).toBe(false)
      expect(await ws.cache.get(path)).toBeNull()
    } finally {
      abort.abort()
      controller?.error(new DOMException('test cleanup', 'AbortError'))
      await result
      await ws.close()
      vi.unstubAllGlobals()
    }
  },
)
