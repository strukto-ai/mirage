import { GitHubApiError } from '../../../../core/github/client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { login } from '../../../../core/github/repo.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { ghTransport, webOrigin } from './accessor.ts'

/** Check the resolved config secret, whose original environment/file source is not retained. */
export async function status(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): Promise<CommandFnResult> {
  const host = new URL(webOrigin(config as GhConfig)).hostname
  let account: string
  try {
    account = await login(ghTransport(config))
  } catch (err) {
    if (!(err instanceof GitHubApiError) || ![401, 403].includes(err.status)) throw err
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(
          `${host}\n  X Failed to log in using the token in Mirage configuration (HTTP ${String(err.status)})\n`,
        ),
      }),
    ]
  }
  if (account === '')
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(`${host}: authenticated response has no login\n`),
      }),
    ]
  return [
    new TextEncoder().encode(
      `${host}\n  ✓ Logged in to ${host} account ${account} (Mirage configuration)\n  - Active account: true\n`,
    ),
    new IOResult(),
  ]
}

/**
 * `gh auth token`, refused: the token stays in Mirage configuration, where
 * every gh verb reads it, and is never printed. Mirrors Python's token.
 */
export function token(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): CommandFnResult {
  const host =
    new FlagView(ctx.flags).asNonEmpty('hostname') ??
    new URL(webOrigin(config as GhConfig)).hostname
  return [
    null,
    new IOResult({
      exitCode: 1,
      stderr: new TextEncoder().encode(
        `gh auth token: the token for ${host} stays in Mirage configuration and is never printed; gh commands use it directly\n`,
      ),
    }),
  ]
}
