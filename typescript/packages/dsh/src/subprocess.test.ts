import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Workspace } from '@struktoai/mirage-node'
import { MirageService } from './service.ts'
import { MirageSubprocess } from './subprocess.ts'

async function attach() {
  const ws = new Workspace({}, { runtimes: [] })
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageSubprocess).await()
  return { ws, provider: ctx.subprocess }
}

describe('workspace subprocess', () => {
  it('uses the configured session profile for child admission', async () => {
    const ws = new Workspace({}, { runtimes: [] })
    ws.createSession('limited', {
      profile: { commands: { deny: [{ commands: ['printf'], reason: 'restricted' }] } },
    })
    const ctx = new Context()
    await ctx.plugin(MirageService, { workspace: ws }).await()
    await ctx.plugin(MirageSubprocess, { sessionId: 'limited' }).await()
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['printf', 'forbidden'],
        cwd: '/',
        graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 256 } },
      })
      expect((await handle.done).exitCode).not.toBe(0)
      expect(handle.collected.stdout?.readFrom(0).text).toBe('')
      expect(await handle.waitForExit()).toBe(true)
    } finally {
      await ws.close()
    }
  })
  it('passes literal argv and offers independent output cursors', async () => {
    const { ws, provider } = await attach()
    try {
      const handle = provider.spawn({
        argv: ['printf', '%s', '$(literal)'],
        cwd: '/',
        graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 32 } },
      })
      expect((await handle.done).exitCode).toBe(0)
      expect(handle.collected.stdout?.readFrom(0)).toEqual({
        text: 'ral)',
        nextOffset: 10,
        lossy: true,
      })
      expect(handle.collected.stdout?.readFrom(6)).toEqual({
        text: 'ral)',
        nextOffset: 10,
        lossy: false,
      })
      expect(await handle.waitForExit()).toBe(true)
    } finally {
      await ws.close()
    }
  })
  it('streams a protocol without shell expansion', async () => {
    const { ws, provider } = await attach()
    try {
      const handle = provider.spawn({
        argv: ['cat'],
        cwd: '/',
        graceMs: 100,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 32 } },
      })
      if (handle.stdin === undefined || handle.stdout === undefined) throw new Error('missing pipe')
      handle.stdin.end('hello\n')
      const chunks: Buffer[] = []
      for await (const chunk of handle.stdout) chunks.push(chunk as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('hello\n')
      expect((await handle.done).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })
  it('fails closed on unsupported terminal and spawn contracts', async () => {
    const { ws, provider } = await attach()
    try {
      await expect(
        provider.spawnTerminal({ argv: ['bash'], cwd: '/', graceMs: 100, rows: 24, cols: 80 }),
      ).rejects.toThrow('terminal')
      expect(() =>
        provider.spawn({
          argv: [],
          cwd: '/',
          graceMs: 100,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        }),
      ).toThrow('argv')
    } finally {
      await ws.close()
    }
  })
})
