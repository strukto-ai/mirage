import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

for (const [name, className] of [
  ['box', 'BoxVFS'],
  ['gdrive', 'GDriveVFS'],
] as const) {
  for (const stage of ['baseline', 'delta', 'completed']) {
    test(`${name} closes on Ctrl-C during ${stage} pull`, { timeout: 15_000 }, async () => {
      const code = `
        import assert from 'node:assert/strict'
        import { createServer } from 'node:http'
        import { ${className}, Workspace } from ${JSON.stringify(import.meta.resolve('@struktoai/mirage-node'))}
        Object.assign(process.env, {
          BOX_ACCESS_TOKEN: 'test', GOOGLE_CLIENT_ID: 'test',
          GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test',
        })
        const server = createServer(() => process.emit('SIGINT'))
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        let pulls = 0
        ${className}.prototype.deltaHook = function () {
          return { pull: async (_root, checkpoint) => {
            pulls++
            if (pulls === 1) {
              assert.equal(checkpoint, null)
              if (${JSON.stringify(stage)} !== 'baseline')
                return { changes: [], checkpoint: 'baseline' }
            } else {
              assert.equal(checkpoint, 'baseline')
            }
            if (${JSON.stringify(stage)} === 'completed') {
              process.emit('SIGINT')
              return { changes: [{}], checkpoint: 'next' }
            }
            await fetch('http://127.0.0.1:' + server.address().port)
            throw new Error('stalled request unexpectedly completed')
          } }
        }
        let notifications = 0
        Workspace.prototype.notify = async () => { notifications++ }
        const close = Workspace.prototype.close
        Workspace.prototype.close = async function () {
          await close.call(this)
          console.log('closed')
        }
        await import(${JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href)})
        assert.equal(notifications, 0, 'notification after Ctrl-C')
        server.close()
      `
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        err += String(chunk)
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
      try {
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        assert.equal(exit, stage === 'completed' ? 0 : 130, err)
        assert.equal(out.split('\n').filter((line) => line === 'closed').length, 1)
        assert.equal(err, '')
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    })
  }
}
