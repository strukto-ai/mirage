import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { DropboxVFS, PathSpec, Workspace, type FileEvent } from '@struktoai/mirage-node'
import type { DeltaHook } from '@struktoai/mirage-core/watch/base'

const MOUNT = '/dropbox'
const LONGPOLL_URL = 'https://notify.dropboxapi.com/2/files/list_folder/longpoll'
const TIMEOUT = 30

export function cursorOf(checkpoint: string | null): string | null {
  // This example knows where the Dropbox checkpoint keeps its cursor. Hand the
  // WHOLE checkpoint back to pull: it also holds the seen paths.
  const data: unknown = checkpoint === null ? null : JSON.parse(checkpoint)
  const state =
    data !== null && typeof data === 'object' && 'dropbox' in data ? data.dropbox : null
  if (state === null || typeof state !== 'object')
    throw new Error('Expected a Dropbox checkpoint')
  const cursor = 'cursor' in state ? state.cursor : null
  return typeof cursor === 'string' && cursor !== '' ? cursor : null
}

export async function longpoll(cursor: string, signal: AbortSignal): Promise<[boolean, number]> {
  // No Authorization header: the cursor is sufficient. Allow server jitter.
  const response = await fetch(LONGPOLL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, timeout: TIMEOUT }),
    signal: AbortSignal.any([signal, AbortSignal.timeout((TIMEOUT + 100) * 1000)]),
  })
  const result = (await response.json()) as {
    changes: boolean
    backoff?: number
    error?: { '.tag'?: string }
  }
  if (response.status === 409 && result.error?.['.tag'] === 'reset') return [true, 0]
  if (!response.ok) throw new Error(`Dropbox longpoll HTTP ${response.status}`)
  return [result.changes, result.backoff ?? 0]
}

export async function runLongpoll(
  hook: DeltaHook,
  root: PathSpec,
  notify: (change: FileEvent) => Promise<void>,
  poll: (cursor: string) => Promise<[boolean, number]>,
  pause: (seconds: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  let checkpoint = (await hook.pull(root, null)).checkpoint
  for (;;) {
    signal?.throwIfAborted()
    const cursor = cursorOf(checkpoint)
    let changed: boolean
    let backoff: number
    if (cursor === null) {
      await pause(TIMEOUT)
      changed = true
      backoff = 0
    } else {
      ;[changed, backoff] = await poll(cursor)
    }
    signal?.throwIfAborted()
    if (changed) {
      // Preserve the old snapshot on reset; the existing hook relists and diffs.
      const delta = await hook.pull(root, checkpoint)
      for (const change of delta.changes) {
        signal?.throwIfAborted()
        await notify(change)
      }
      checkpoint = delta.checkpoint
    }
    if (backoff) await pause(backoff)
  }
}

export async function runWithShutdown(
  run: () => Promise<void>,
  close: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  let settled = signal.aborted
  let closed = false
  let wake: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    wake = resolve
  })
  const stop = (): void => wake()
  const finish = (): void => {
    settled = true
    if (closed) clearTimeout(deadline)
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (signal.aborted) stop()
    else await Promise.race([run().finally(finish), stopped])
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    try {
      await close()
    } finally {
      closed = true
      signal.removeEventListener('abort', stop)
      // Finish workspace cleanup before bounding a pull that cannot be
      // cancelled through DeltaHook. Slow provider closes must not be cut off.
      if (signal.aborted && !settled) deadline = setTimeout(() => process.exit(130), 1000).unref()
    }
  }
}

async function main(): Promise<void> {
  const clientId = process.env.DROPBOX_APP_KEY
  const clientSecret = process.env.DROPBOX_APP_SECRET
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error('Set the three DROPBOX credentials')
  const vfs = new DropboxVFS({
    clientId,
    clientSecret,
    refreshToken,
    rootPath: process.env.DROPBOX_ROOT_PATH || '/',
  })
  const ws = new Workspace({ [MOUNT]: vfs })
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  try {
    console.log(`Watching ${MOUNT}; edit files in Dropbox (Ctrl-C to stop)`)
    await runWithShutdown(
      () =>
        runLongpoll(
          vfs.deltaHook(),
          PathSpec.fromStrPath(MOUNT, ''),
          async (change) => {
            await ws.notify(change)
            console.log(`${change.kind}: ${change.path.virtual}`)
          },
          (cursor) => longpoll(cursor, controller.signal),
          async (seconds) => {
            await delay(seconds * 1000, undefined, {
              signal: controller.signal,
            })
          },
          controller.signal,
        ),
      () => ws.close(),
      controller.signal,
    )
  } finally {
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
