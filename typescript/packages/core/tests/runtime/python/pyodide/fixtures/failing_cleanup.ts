let asynchronous = false

export let installs = 0
export let disposals = 0
export const failure = new Error('cleanup failed')

export function configure(kind: 'sync' | 'async'): void {
  asynchronous = kind === 'async'
}

function disposeSync(): never {
  disposals++
  throw failure
}

function disposeAsync(): Promise<never> {
  disposals++
  return Promise.reject(failure)
}

export default function install(): () => void | Promise<void> {
  installs++
  return asynchronous ? disposeAsync : disposeSync
}
