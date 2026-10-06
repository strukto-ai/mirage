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

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from 'e2b'
import { chromium } from 'playwright-core'
import { build, loadEnv, preview } from 'vite'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const apiKey = process.env.E2B_API_KEY ?? loadEnv('development', root, 'E2B_API_KEY').E2B_API_KEY
assert.ok(apiKey, 'Set E2B_API_KEY or add it to .env.development')
const output = await mkdtemp(join(tmpdir(), 'mirage-e2b-browser-'))
try {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    worker: { format: 'es' },
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'esnext',
      lib: {
        entry: join(root, 'integ/fixtures/runtime/e2b_browser.ts'),
        formats: ['es'],
        fileName: () => 'check.js',
      },
      rollupOptions: { external: ['@pydantic/monty'] },
    },
  })
  await writeFile(
    join(output, 'index.html'),
    '<!doctype html><title>Mirage E2B integration</title>',
  )
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
      const sandbox = await Sandbox.create({ apiKey, timeoutMs: 300_000 })
      try {
        const page = await browser.newPage()
        const baseUrl = server.resolvedUrls?.local[0]
        assert.ok(baseUrl, 'Preview server did not publish its local URL')
        await page.goto(baseUrl)
        const checks = await page.evaluate(
          async ({ config, entry }) => {
            const test = (await import(entry)) as {
              exercise(config: { sandboxId: string; apiKey: string }): Promise<string[]>
            }
            return test.exercise(config)
          },
          { config: { sandboxId: sandbox.sandboxId, apiKey }, entry: '/check.js' },
        )
        // Mirage closes its workspace without deleting the application-owned sandbox.
        assert.ok(await sandbox.isRunning())
        console.log(
          JSON.stringify({
            check: 'browser_e2b_production_bundle',
            passed: [...checks, 'application-owned sandbox survives workspace close'],
          }),
        )
      } finally {
        await sandbox.kill()
      }
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
