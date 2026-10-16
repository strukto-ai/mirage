import { setTimeout as delay } from 'node:timers/promises'
import { BoxVFS, PathSpec, Workspace } from '@struktoai/mirage-node'

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
    let checkpoint = (await hook.pull(root, null)).checkpoint
    console.log('Watching /box; edit files in the service (Ctrl-C to stop)')
    while (!controller.signal.aborted) {
      await delay(5000, undefined, { signal: controller.signal })
      const result = await hook.pull(root, checkpoint)
      for (const change of result.changes) {
        await ws.notify(change)
        console.log(`${change.kind}: ${change.path.virtual}`)
      }
      checkpoint = result.checkpoint
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError' && controller.signal.aborted))
      throw error
  } finally {
    process.removeListener('SIGINT', stop)
    await ws.close()
  }
}

await main()
