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

/**
 * Headless smoke test: spins up the vite dev server (with the /presign/*
 * middleware), loads the page in headless Chrome via playwright-core, and
 * asserts the expected output for OPFS + every configured cloud backend.
 *
 * The test auto-detects which backends have credentials in .env.development
 * via `GET /presign/status`, so running in CI (no creds) still passes the
 * OPFS checks.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright-core'

type BackendName = 's3' | 'gcs' | 'r2' | 'oci'

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not respond within ${String(timeoutMs)}ms`)
}

async function fetchStatus(base: string): Promise<BackendName[]> {
  const r = await fetch(`${base}/presign/status`)
  if (!r.ok) return []
  const { configured } = (await r.json()) as { configured: BackendName[] }
  return configured
}

async function main(): Promise<void> {
  const base = 'http://localhost:5174'
  const vite = spawn('pnpm', ['dev', '--port', '5174'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: new URL('..', import.meta.url).pathname,
  })
  await once(vite.stdout!, 'data')
  await waitForServer(`${base}/`)

  const configured = await fetchStatus(base)
  console.log(
    `configured backends: ${configured.length > 0 ? configured.join(', ') : '(none)'}`,
  )

  let exit = 0
  try {
    const browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      page.on('console', (msg) => {
        console.log(`[browser:${msg.type()}]`, msg.text())
      })
      page.on('pageerror', (err) => {
        console.log('[pageerror]', err.message)
      })
      await page.goto(`${base}/`)
      let text = ''
      try {
        await page.waitForFunction(
          () => document.querySelector('#log')?.textContent?.includes('done.') ?? false,
          { timeout: 300_000 },
        )
        text = await page.locator('#log').innerText()
      } catch (err) {
        text = await page.locator('#log').innerText().catch(() => '')
        console.error('waitForFunction failed; current log contents below')
        console.error(err)
      }
      console.log('\n─── log content ───')
      console.log(text)
      console.log('───────────────────')

      const hardExpectations: string[] = [
        'OPFS (/) — full shell demo',
        'hello from OPFS',
        'revenue,100',
      ]
      for (const b of configured) {
        hardExpectations.push(`${b.toUpperCase()} (/${b}/) — ws.shell shell`)
      }
      const missingHard = hardExpectations.filter((s) => !text.includes(s))
      if (missingHard.length > 0) {
        console.error('MISSING (hard):', missingHard)
        exit = 1
      }

      // Cloud round-trips are informational — they require bucket-level CORS
      // rules that allow http://localhost:5174. Report success/failure per
      // backend but don't fail the test when a bucket hasn't been configured.
      const cloudReport: Record<string, 'ok' | 'cors' | 'error'> = {}
      for (const b of configured) {
        if (text.includes(`hello from browser ${b}`)) cloudReport[b] = 'ok'
        else if (text.includes(`${b}: `) && text.includes('CORS')) cloudReport[b] = 'cors'
        else cloudReport[b] = 'error'
      }
      console.log('\n─── cloud round-trip report ───')
      for (const [b, status] of Object.entries(cloudReport)) {
        const emoji = status === 'ok' ? '✓' : status === 'cors' ? '⚠ (CORS not configured)' : '✗'
        console.log(`  ${b}: ${emoji}`)
      }
      console.log('───────────────────────────────')

      if (exit === 0) console.log('\nALL HARD CHECKS PASSED')
    } finally {
      await browser.close()
    }
  } finally {
    ;(vite as ChildProcess).kill('SIGTERM')
  }
  process.exit(exit)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
