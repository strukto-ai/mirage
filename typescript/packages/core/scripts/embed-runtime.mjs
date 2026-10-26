import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const modules = {
  pyodide: ['python/pyodide/py/execution.py'],
}
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
for (const [name, paths] of Object.entries(modules)) {
  const source = paths
    .map((path) => readFileSync(new URL(`../src/runtime/${path}`, import.meta.url), 'utf8'))
    .join('\n')
  writeFileSync(
    new URL(`${name}.ts`, output),
    `export default ${JSON.stringify(source)} as string\n`,
  )
}
