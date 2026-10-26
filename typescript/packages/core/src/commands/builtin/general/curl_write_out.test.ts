import { PathSpec } from '../../../types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { GENERAL_CURL } from './curl.ts'
import { eacces, enoent } from '../../../errors/fs.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

afterEach(() => vi.unstubAllGlobals())
it('wget enforces its deadline and returns the network failure code', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init.signal == null) throw new Error('request lacks a timeout signal')
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    ),
  )
  const ws = new Workspace({})
  try {
    const result = await ws.shell('wget --timeout=0.01 -q -O - https://example.test/hello')
    expect(result.exitCode).toBe(4)
    expect(result.stderr.length).toBe(0)
  } finally {
    await ws.close()
  }
})

it.each([undefined, enoent('/format'), eacces('/format')])(
  'refuses a transfer when its template cannot be read (%s)',
  async (failure) => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const cmd = GENERAL_CURL[0]
    if (cmd === undefined) throw new Error('curl not registered')
    for (const [silent, show_error] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      const detail = silent ? '' : 'curl: Failed to open /format\n'
      await expect(
        cmd.fn(new RAMVFS().accessor, [], ['https://example.test/hello'], {
          stdin: null,
          cwd: PathSpec.fromStrPath('/'),
          flags: {
            write_out: '@/format',
            silent: silent ?? false,
            show_error: show_error ?? false,
          },
          ...(failure === undefined ? {} : { dispatch: vi.fn().mockRejectedValue(failure) }),
        }),
      ).rejects.toMatchObject({
        exitCode: 26,
        message:
          detail +
          'curl: option -w: error encountered when reading a file\n' +
          "curl: try 'curl --help' or 'curl --manual' for more information",
      })
    }
    expect(request).not.toHaveBeenCalled()
  },
)
