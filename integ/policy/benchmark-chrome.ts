import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'policy-benchmark-'))
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
        entry: join(root, 'integ/policy/benchmark-browser.ts'),
        formats: ['es'],
        fileName: () => 'benchmark.js',
      },
    },
  })
  await writeFile(join(output, 'index.html'), '<!doctype html><title>Policy benchmark</title>')
  const server = await preview({
    configFile: false,
    root,
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
  })
  try {
    const started = performance.now()
    const browser = await chromium.launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chrome' }),
      headless: true,
    })
    try {
      const page = await browser.newPage()
      const url = server.resolvedUrls?.local[0]
      if (url === undefined) throw new Error('preview server has no URL')
      await page.goto(url)
      const startupMs = performance.now() - started
      const result = await page.evaluate(async (entry) => {
        const started = performance.now()
        const suite = (await import(entry)) as { benchmark(): Promise<unknown> }
        const importMs = performance.now() - started
        return { import_ms: importMs, samples: await suite.benchmark() }
      }, '/benchmark.js')
      const cdp = await page.context().newCDPSession(page)
      const heap = await cdp.send('Runtime.getHeapUsage')
      console.log(
        JSON.stringify({
          host: 'chrome',
          runtime: browser.version(),
          startup_ms: startupMs,
          memory: heap,
          memory_note:
            'CDP heap data is not total browser RSS or a retained Rust memory bound. No process memory cap imposed.',
          ...result,
        }),
      )
    } finally {
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
