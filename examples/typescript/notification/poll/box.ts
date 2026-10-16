import { setTimeout as delay } from 'node:timers/promises'
import { BoxVFS, PathSpec, Workspace } from '@struktoai/mirage-node'
import { runWithShutdown } from './dropbox.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

async function main(): Promise<void> {
  const vfs = new BoxVFS({ accessToken: required('BOX_ACCESS_TOKEN') })
  const ws = new Workspace({ '/box': vfs })
  const hook = vfs.deltaHook()
  const root = PathSpec.fromStrPath('/box', '')
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  try {
    await runWithShutdown(
      async () => {
        let checkpoint = (await hook.pull(root, null)).checkpoint
        controller.signal.throwIfAborted()
        console.log('Watching /box; edit files in the service (Ctrl-C to stop)')
        for (;;) {
          await delay(5000, undefined, { signal: controller.signal })
          const result = await hook.pull(root, checkpoint)
          controller.signal.throwIfAborted()
          for (const change of result.changes) {
            controller.signal.throwIfAborted()
            await ws.notify(change)
            console.log(`${change.kind}: ${change.path.virtual}`)
          }
          checkpoint = result.checkpoint
        }
      },
      () => ws.close(),
      controller.signal,
    )
  } finally {
    process.removeListener('SIGINT', stop)
  }
}

await main()
