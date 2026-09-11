import { MountMode, RedisResource, Workspace } from '@struktoai/mirage-browser'

const logEl = document.getElementById('log')!

function line(text: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = text
  logEl.appendChild(div)
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const r = await ws.execute(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (r.exitCode !== 0) line(`exit=${String(r.exitCode)}`, 'err')
}

async function main(): Promise<void> {
  line('=== Redis via the Upstash REST API, straight from the page ===', 'ok')
  if (__UPSTASH_REDIS_URL__ === '') {
    line('set UPSTASH_REDIS_URL in .env.development', 'err')
    line('done.', 'ok')
    return
  }
  // __UPSTASH_REDIS_URL__ is a Vite define, so the password lands in the served
  // JavaScript: this page is a local demo for a trusted machine, not something to
  // build or host. A page for other people needs a server-side proxy instead.
  const resource = new RedisResource({
    url: __UPSTASH_REDIS_URL__,
    keyPrefix: 'mirage:browser-demo:',
  })
  await resource.open()
  const ws = new Workspace({ '/redis': resource }, { mode: MountMode.WRITE })
  try {
    await run(ws, 'mkdir -p /redis/notes')
    await run(ws, 'echo "hello from the browser" | tee /redis/notes/hello.txt')
    await run(ws, 'printf "alpha\\nbeta\\ngamma\\n" > /redis/notes/words.txt')
    await run(ws, 'ls -l /redis/notes')
    await run(ws, 'cat /redis/notes/hello.txt')
    await run(ws, 'grep -n beta /redis/notes/words.txt')
    await run(ws, 'find /redis -type f')
    await run(ws, 'du -a /redis/notes')
    await run(ws, 'rm -r /redis/notes')
    await run(ws, 'ls /redis')
    line('done.', 'ok')
  } catch (err) {
    line(`error: ${err instanceof Error ? err.message : String(err)}`, 'err')
  } finally {
    await ws.close()
  }
}

void main()
