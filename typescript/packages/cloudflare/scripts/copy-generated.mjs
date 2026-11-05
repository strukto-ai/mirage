import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'

const generated = new URL('../src/generated/', import.meta.url)
const output = new URL('../dist/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
for (const name of readdirSync(generated)) {
  if (name.startsWith('monty.') && (name.endsWith('.js') || name.endsWith('.wasm'))) {
    copyFileSync(new URL(name, generated), new URL(name, output))
  }
}
