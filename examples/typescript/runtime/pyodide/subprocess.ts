import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEC = new TextDecoder()

const LOG =
  '09:00 INFO  boot\n' +
  '09:01 ERROR disk full on /var\n' +
  '09:02 INFO  retry\n' +
  '09:03 ERROR disk full on /var\n' +
  '09:05 ERROR timeout talking to db\n'

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, runtimes: ['pyodide'] },
  )
  ws.addMount('/ro', new RAMVFS(), MountMode.WRITE)
  await ws.vfs.write('/data/app.log', LOG)
  await ws.vfs.write('/ro/app.log', LOG)
  ws.setMountMode('/ro', MountMode.READ)
  await ws.vfs.write(
    '/data/subprocess.py',
    new Uint8Array(readFileSync(resolve(HERE, 'subprocess.py'))),
  )

  console.log('python3 in Pyodide, calling ordinary subprocess APIs on mirage\n')
  const t0 = Date.now()
  const res = await ws.shell('python3 /data/subprocess.py')
  process.stdout.write(DEC.decode(res.stdout))
  if (res.stderrText !== '') console.error('STDERR:', res.stderrText)
  console.log(`\nexit: ${String(res.exitCode)} (${String(Date.now() - t0)}ms)`)
  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
