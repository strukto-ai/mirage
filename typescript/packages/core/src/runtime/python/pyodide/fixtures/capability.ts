import type { PyodideInterface } from '../loader.ts'

export let installs = 0
export let disposals = 0

export default function install(py: PyodideInterface): () => void {
  installs++
  py.registerJsModule('_test_capability', { add: (a: number, b: number) => a + b })
  return () => {
    disposals++
    py.unregisterJsModule?.('_test_capability')
  }
}
