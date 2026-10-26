// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import type { Outcome } from './suite.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'mirage-browser-shell-'))
let failed = true
try {
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    worker: { format: 'es' },
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'esnext',
      lib: {
        entry: join(root, 'integ/browser/suite.ts'),
        formats: ['es'],
        fileName: () => 'suite.js',
      },
    },
  })
  await writeFile(join(output, 'index.html'), '<!doctype html><title>Mirage shell</title>')
  // QuickJS runs on a worker, which a page with no shared memory reaches the
  // workspace through Mirage's service worker; the page serves both.
  const quickjs = process.env.MIRAGE_QUICKJS_HOME
  if (quickjs !== undefined && quickjs !== '') {
    await mkdir(join(output, 'quickjs'))
    await copyFile(join(quickjs, 'qjs-wasi.wasm'), join(output, 'quickjs', 'qjs-wasi.wasm'))
    await copyFile(
      join(root, 'typescript/packages/browser/dist/pyodide-sw.js'),
      join(output, 'pyodide-sw.js'),
    )
  }
  const server = await preview({
    configFile: false,
    root,
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
  })
  try {
    const browser = await chromium.launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chrome' }),
      headless: true,
    })
    const timeout = setTimeout(() => {
      void browser.close()
    }, 180_000)
    try {
      const page = await browser.newPage()
      page.on('pageerror', (error) => console.error(error))
      const baseUrl = server.resolvedUrls?.local[0]
      if (baseUrl === undefined) throw new Error('the preview server published no local URL')
      await page.goto(baseUrl)
      const outcomes = await page.evaluate(
        async ([entry, quickjsHome]) => {
          if (quickjsHome !== null) {
            const container = navigator.serviceWorker
            await container.register('/pyodide-sw.js')
            if (container.controller === null) {
              const controlled = new Promise((resolve) => {
                container.addEventListener('controllerchange', resolve, { once: true })
              })
              ;(await container.ready).active?.postMessage('claim')
              await controlled
            }
          }
          const suite = (await import(entry)) as {
            runSuite(quickjsHome: string | null): Promise<Outcome[]>
          }
          return suite.runSuite(quickjsHome)
        },
        ['/suite.js', quickjs !== undefined && quickjs !== '' ? '/quickjs/' : null] as const,
      )
      for (const outcome of outcomes) {
        console.log(
          outcome.error === undefined
            ? `ok   [browser] ${outcome.name}`
            : `FAIL [browser] ${outcome.name}: ${outcome.error}`,
        )
      }
      const bad = outcomes.filter((outcome) => outcome.error !== undefined).length
      console.log(`${String(outcomes.length - bad)} passed, ${String(bad)} failed`)
      failed = outcomes.length === 0 || bad > 0
    } finally {
      clearTimeout(timeout)
      await browser.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
