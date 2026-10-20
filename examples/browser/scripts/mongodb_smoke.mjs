import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not start within ${timeoutMs}ms`)
}

const base = 'http://localhost:5176'
const vite = spawn('pnpm', ['dev', '--port', '5176'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
})
await once(vite.stdout, 'data')
await waitForServer(`${base}/vfs/mongodb/mongodb.html`)

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
    await page.goto(`${base}/vfs/mongodb/mongodb.html`)
    try {
      await page.waitForFunction(
        () => document.querySelector('#log')?.hasAttribute('data-status') ?? false,
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
    // The page records its result on #log; the log text is backend data.
    if ((await page.locator('#log').getAttribute('data-status')) !== 'done') exit = 1
  } finally {
    await browser.close()
  }
} catch (err) {
  console.error(err)
  exit = 1
} finally {
  vite.kill('SIGTERM')
  await once(vite, 'exit').catch((err) => console.error('vite exit:', err))
}
process.exit(exit)
