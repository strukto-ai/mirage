import { expect, it } from 'vitest'
import { makeIntegrationWS } from '../fixtures/integration_fixture.ts'

it('keeps process-substitution operands separate from stdin and releases their paths', async () => {
  const { ws } = await makeIntegrationWS()
  try {
    const result = await ws.shell(
      "printf 'outer\\n' | cat <(echo one) - <(echo two); echo /dev/fd/*",
    )
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([
      0,
      'one\nouter\ntwo\n/dev/fd/*\n',
      '',
    ])
  } finally {
    await ws.close()
  }
})
