import { expect, it, vi } from 'vitest'
import { SlackAccessor } from '../../accessor/slack.ts'
import { NodeSlackTransport } from '../../core/slack/client.ts'
import { FileStat, FileType } from '../../types.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SlackVFSBase } from './slack.ts'
import { seedChannel } from '../../../tests/vfs/slack/_test_util.ts'

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
    const vfs = new SlackVFSBase({
      name: 'slack',
      accessor: new SlackAccessor(new NodeSlackTransport('token')),
    })
    const ws = new Workspace({ '/chat': vfs }, { shellParser: await getTestParser() })
    const path = '/chat/channels/general__C1/2026-04-24/files/report__F1.txt'
    const index = ws.mount('/chat').index
    await seedChannel(index, '/chat', 'general__C1', 'C1', { dates: ['2026-04-24'] })
    await index.setDir(path.slice(0, path.lastIndexOf('/')), [
      [
        'report__F1.txt',
        new FileStat({
          name: 'report__F1.txt',
          type: FileType.FILE,
          extra: { file_id: 'F1', url_private_download: 'https://cdn.test/report' },
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
