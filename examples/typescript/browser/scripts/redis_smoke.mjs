import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not start within ${timeoutMs}ms`)
}

// This machine may already run other dev servers, so ask the kernel for a
// port instead of guessing one, and hold vite to it with --strictPort.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(String(port)))
    })
  })
}
const port = process.env.PORT ?? (await freePort())
const base = `http://localhost:${port}`
const vite = spawn('pnpm', ['dev', '--port', port, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
})
// A dev server that never comes up must fail the run, not hang it: pnpm
// refusing to start (engine or dependency check) prints to stderr and exits
// with stdout silent, which would otherwise park the first read forever.
vite.stdout.resume()
vite.on('exit', (code) => {
  if (!serverReady) {
    console.error(`vite exited with code ${String(code)} before serving`)
    process.exit(1)
  }
})
let serverReady = false
await waitForServer(`${base}/redis.html`)
serverReady = true

let exit = 0
try {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  try {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    page.on('console', (msg) => console.log(`[browser:${msg.type()}]`, msg.text()))
    page.on('pageerror', (err) => {
      console.log('[pageerror]', err.message)
    })
    await page.goto(`${base}/redis.html`)
    try {
      await page.waitForFunction(
        () => document.querySelector('#log')?.textContent?.includes('done.') ?? false,
        { timeout: 120_000 },
      )
    } catch (err) {
      console.error('waitForFunction timed out')
      console.error(err.message)
      exit = 1
    }
    const text = await page.locator('#log').innerText()
    console.log('\n─── log content ───')
    console.log(text)
    if (!text.includes('done.')) exit = 1
  } finally {
    await browser.close()
  }
} catch (err) {
  console.error(err)
  exit = 1
} finally {
  vite.kill('SIGTERM')
  await once(vite, 'exit').catch(() => {})
}
process.exit(exit)
