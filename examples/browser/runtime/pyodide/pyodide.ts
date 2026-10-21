import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-browser'

const logEl = document.getElementById('log')!

function line(text: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = text
  logEl.appendChild(div)
}

// Shows the result and records it on #log as data-status, which is what
// the smoke test reads.
function finish(ok: boolean): void {
  line(ok ? 'done.' : 'failed.', ok ? 'ok' : 'err')
  logEl.dataset.status = ok ? 'done' : 'failed'
}

// Set by any command that exits non-zero, so the page finishes failed.
let failed = false

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const r = await ws.shell(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (r.exitCode !== 0) {
    line(`exit=${String(r.exitCode)}`, 'err')
    failed = true
  }
}

// A page that is not cross-origin isolated has no SharedArrayBuffer, so
// Pyodide reaches the mounts through Mirage's service worker, which the
// dev server serves at /pyodide-sw.js (see vite.config.ts).
async function controlled(): Promise<void> {
  if (crossOriginIsolated) return
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

async function main(): Promise<void> {
  line('=== Pyodide over a RAM mount ===', 'ok')
  line(crossOriginIsolated ? 'cross-origin isolated' : 'not isolated: using pyodide-sw.js')
  await controlled()
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, runtimes: ['pyodide'] },
  )
  try {
    await run(ws, "python3 -c 'import sys; print(sys.version.split()[0])'")
    await run(ws, "echo 'import sys; print(sys.argv[1:])' > /data/hello.py")
    await run(ws, 'python3 /data/hello.py alice bob')
    await run(ws, `python3 -c 'open("/data/out.txt", "w").write("written by python\\n")'`)
    await run(ws, 'cat /data/out.txt')
    await run(ws, `python3 -c 'import os; print(sorted(os.listdir("/data")))'`)
    finish(!failed)
  } catch (err) {
    line(`error: ${err instanceof Error ? err.message : String(err)}`, 'err')
    finish(false)
  } finally {
    await ws.close()
  }
}

void main()
