import { buildApp } from '../../typescript/packages/server/src/app.ts'
import { AuthMode } from '../../typescript/packages/server/src/auth/config.ts'

const app = buildApp({
  authConfig: { mode: AuthMode.Local },
  idleGraceSeconds: 60,
})
const gates = new Map<string, { wait: Promise<void>; release: () => void }>()
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_request, body, done) => done(null, body),
)

function gate(key: string) {
  let found = gates.get(key)
  if (found === undefined) {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    found = { wait, release }
    gates.set(key, found)
  }
  return found
}

app.route<{ Params: { key: string } }>({
  method: ['GET', 'POST'],
  url: '/__integ/hold/:key',
  handler: async (request) => {
    await gate(request.params.key).wait
    return 'released\n'
  },
})
app.get<{ Params: { key: string } }>('/__integ/entered/:key', async (request) => ({
  entered: gates.has(request.params.key),
}))
app.post<{ Params: { key: string } }>('/__integ/release/:key', async (request) => {
  gate(request.params.key).release()
  return { released: true }
})

process.once('SIGTERM', () => {
  for (const entry of gates.values()) entry.release()
  void app
    .close()
    .then(() => {
      console.log('STOPPED')
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
})
console.log(`READY ${await app.listen({ host: '127.0.0.1', port: 0 })}`)
