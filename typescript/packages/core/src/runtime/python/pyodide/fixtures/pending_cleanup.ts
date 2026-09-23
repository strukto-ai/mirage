import type { PyodideInterface } from '../loader.ts'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const cleanup = gate()
const started = gate()
let rejects = false
let installs = 0

export const events: string[] = []
export const failure = new Error('pending cleanup failed')
export const entered = started.promise
export const release = cleanup.resolve

export function configure(rejectCleanup: boolean): void {
  rejects = rejectCleanup
}

export default function install(py: PyodideInterface): () => Promise<void> {
  const id = ++installs
  events.push(`install ${String(id)}`)
  py.registerJsModule('_test_lifecycle', {
    use: () => {
      events.push(`use ${String(id)}`)
      return id
    },
  })
  return async () => {
    events.push(`closing ${String(id)}`)
    if (id === 1) {
      started.resolve()
      await cleanup.promise
    }
    py.unregisterJsModule?.('_test_lifecycle')
    events.push(`closed ${String(id)}`)
    if (rejects && id === 1) throw failure
  }
}
