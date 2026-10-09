// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { access, readFile } from 'node:fs/promises'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type * as Ssh2Mod from 'ssh2'
import type {
  AuthContext,
  Connection,
  ParsedKey,
  PseudoTtyInfo,
  ServerChannel,
  ServerConfig,
} from 'ssh2'
import type { WorkspaceRegistry } from '../registry.ts'
import type { SSHConfig } from './config.ts'
import { serveCodex } from './codex.ts'
import {
  ACCOUNT_OPTION,
  CODEX_SUBSYSTEM,
  KEEPALIVE_COUNT_MAX,
  KEEPALIVE_INTERVAL_SECONDS,
  PROFILE_OPTION,
} from './constants.ts'
import { SSHConfigError } from './errors.ts'
import { loadHostKey } from './keys.ts'
import {
  handleChannel,
  refuseSubsystem,
  type ChannelRequest,
  type Endpoint,
  type ShellChannel,
} from './session.ts'
import { serveSFTP } from './sftp.ts'
import type { SSHListener } from './types.ts'

/**
 * ssh2 is CommonJS, and Node's ESM loader names only the exports it can
 * find statically (`Client`, not `Server` or `utils`); the whole module is
 * its default export.
 */
async function loadSsh2(): Promise<typeof Ssh2Mod> {
  let mod: typeof Ssh2Mod & { default?: typeof Ssh2Mod }
  try {
    mod = await import('ssh2')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new SSHConfigError(
      `ssh_port is set but the SSH server needs ssh2; install it beside the daemon (npm install ssh2): ${message}`,
    )
  }
  return mod.default ?? mod
}

/** A key allowed to log in, with the profile and account its line binds it to. */
export interface AuthorizedKey {
  key: ParsedKey
  /** The line's `mirage-profile` values; empty when it has none. */
  profile: readonly string[]
  /** The line's `mirage-account` values; empty when it has none. */
  account: readonly string[]
}

interface KeyOption {
  name: string
  value: string | null
}

/**
 * The public keys allowed to log in, read fresh for every attempt so a key
 * added or revoked takes effect on the next login. A line that cannot be
 * read is skipped with a warning. `mirage-profile` and `mirage-account`
 * are the OpenSSH-style key options this dispatcher reads; a line carrying any
 * other (`command=`, `from=`, ...) is skipped too, since the entry point does not
 * honor it and so will not accept the key as if it were absent.
 */
export async function readAuthorizedKeys(
  path: string,
  utils: typeof Ssh2Mod.utils,
): Promise<AuthorizedKey[]> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`ssh: refusing logins, cannot read ${path}: ${message}`)
    return []
  }
  const keys: AuthorizedKey[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parsed = authorizedKey(line, utils)
    if (parsed instanceof Error) {
      console.warn(`ssh: skipping an authorized key that cannot be read: ${parsed.message}`)
      continue
    }
    keys.push(parsed)
  }
  return keys
}

/**
 * One authorized_keys line as its key and its `mirage-profile` and
 * `mirage-account` values. A line ssh2 reads as it stands carries no
 * options; otherwise its leading options field is split off the way
 * OpenSSH reads it.
 */
function authorizedKey(line: string, utils: typeof Ssh2Mod.utils): AuthorizedKey | Error {
  const plain = utils.parseKey(line)
  if (!(plain instanceof Error)) return { key: plain, profile: [], account: [] }
  const split = splitOptions(line)
  if (split === null) return plain
  const profile: string[] = []
  const account: string[] = []
  for (const option of split.options) {
    const name = option.name.toLowerCase()
    if (name === PROFILE_OPTION) profile.push(option.value ?? '')
    else if (name === ACCOUNT_OPTION) account.push(option.value ?? '')
    else return new Error(`unsupported key option ${option.name}`)
  }
  const key = utils.parseKey(split.rest)
  return key instanceof Error ? key : { key, profile, account }
}

/**
 * The comma-separated options field that leads an authorized_keys line
 * (`name` or `name="value"`, `\"` escaping a quote) and the key after it,
 * or null when the line does not start with one.
 */
function splitOptions(line: string): { options: KeyOption[]; rest: string } | null {
  const options: KeyOption[] = []
  let at = 0
  for (;;) {
    const name = /^[A-Za-z0-9-]+/.exec(line.slice(at))?.[0]
    if (name === undefined) return null
    at += name.length
    let value: string | null = null
    if (line[at] === '=') {
      if (line[at + 1] !== '"') return null
      at += 2
      value = ''
      while (at < line.length && line[at] !== '"') {
        if (line[at] === '\\' && line[at + 1] === '"') at += 1
        value += line.charAt(at)
        at += 1
      }
      if (at >= line.length) return null
      at += 1
    }
    options.push({ name, value })
    const next = line[at]
    if (next === ',') {
      at += 1
      continue
    }
    if (next === ' ' || next === '\t') return { options, rest: line.slice(at).trim() }
    return null
  }
}

/**
 * Admit a public key in the authorized keys, and nothing else: no
 * passwords, no keyboard-interactive. A key the client only offers is
 * accepted as usable; a signed attempt must verify.
 */
async function authenticate(
  ctx: AuthContext,
  keysFile: string,
  utils: typeof Ssh2Mod.utils,
): Promise<AuthorizedKey | null> {
  if (ctx.method !== 'publickey') {
    ctx.reject(['publickey'])
    return null
  }
  const offered = ctx.key.data
  const match = (await readAuthorizedKeys(keysFile, utils)).find((k) =>
    k.key.getPublicSSH().equals(offered),
  )
  if (match === undefined) {
    ctx.reject(['publickey'])
    return null
  }
  if (ctx.signature !== undefined && ctx.blob !== undefined) {
    if (!match.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
      ctx.reject(['publickey'])
      return null
    }
  }
  return match
}

/** Decides a login: the profile and account it runs as, or null once refused. */
type Admit = (ctx: AuthContext) => Promise<Pick<AuthorizedKey, 'profile' | 'account'> | null>

/**
 * Admit a login the HTTPS route already authenticated: its token was checked
 * and its account allowed the workspace the URL names, so it needs no key,
 * may only name that workspace, and runs as that account.
 */
function admitTunnel(workspaceId: string, account: string | null): Admit {
  return (ctx) => {
    if (ctx.username !== workspaceId) {
      ctx.reject([])
      return Promise.resolve(null)
    }
    return Promise.resolve({ profile: [], account: account === null ? [] : [account] })
  }
}

function serveConnection(
  client: Connection,
  registry: WorkspaceRegistry,
  admit: Admit,
  peer: Endpoint,
  local: Endpoint,
): void {
  let username = ''
  let profile: readonly string[] = []
  let account: readonly string[] = []
  client.on('authentication', (ctx) => {
    void admit(ctx)
      .then((match) => {
        if (match !== null) {
          username = ctx.username
          profile = match.profile
          account = match.account
          ctx.accept()
        }
      })
      .catch((error: unknown) => {
        console.warn('ssh: authentication failed', error)
        ctx.reject(['publickey'])
      })
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      let term: string | null = null
      let shell: ShellChannel | null = null
      const start = (channel: ServerChannel, command: string | null): void => {
        const request: ChannelRequest = { username, profile, account, command, term, peer, local }
        void handleChannel(registry, channel, request, (s) => {
          shell = s
        })
      }
      session.on('pty', (acceptPty, _reject, info) => {
        term = (info as PseudoTtyInfo & { term?: string }).term ?? ''
        acceptPty()
      })
      session.on('window-change', (acceptResize) => {
        acceptResize()
      })
      session.on('signal', (acceptSignal) => {
        acceptSignal()
        shell?.signal()
      })
      session.on('shell', (acceptShell) => {
        start(acceptShell(), null)
      })
      session.on('exec', (acceptExec, _reject, info) => {
        start(acceptExec(), info.command)
      })
      session.on('sftp', (acceptSftp) => {
        serveSFTP(registry, username, profile, account, acceptSftp())
      })
      session.on('subsystem', (acceptSubsystem, _reject, info) => {
        const channel = acceptSubsystem()
        if (info.name !== CODEX_SUBSYSTEM) {
          refuseSubsystem(channel, info.name)
          return
        }
        const request: ChannelRequest = {
          username,
          profile,
          account,
          command: null,
          term: null,
          peer,
          local,
        }
        void serveCodex(registry, channel, request)
      })
    })
  })
  client.on('error', (err: NodeJS.ErrnoException) => {
    // A client that vanishes mid-handshake or mid-session resets the
    // socket; that ends its channels, and is not the daemon's failure.
    if (err.code !== 'ECONNRESET') console.warn(`ssh: connection error: ${err.message}`)
  })
}

/** What every SSH connection the daemon serves runs with. */
async function serverOptions(
  config: SSHConfig,
  utils: typeof Ssh2Mod.utils,
): Promise<ServerConfig> {
  return {
    hostKeys: [await loadHostKey(config.hostKeyFile, utils)],
    keepaliveInterval: KEEPALIVE_INTERVAL_SECONDS * 1000,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
  }
}

/**
 * Listen for SSH, serving the daemon's workspaces.
 *
 * `ssh <workspace-id>@host` opens a shell in that workspace, `ssh
 * <workspace-id>@host cmd` runs one line, `sftp`/`scp` reach its files,
 * and the `codex-exec` subsystem serves Codex's tools. Each channel runs
 * as a fresh mirage session under the workspace's default profile. ssh2 is loaded here, on first use, the way
 * the Python daemon loads asyncssh only once a port is set.
 */
export async function startSSHServer(
  registry: WorkspaceRegistry,
  config: SSHConfig,
): Promise<SSHListener> {
  const listenPort = config.port
  if (listenPort === null) throw new Error('the SSH endpoint needs ssh_port')
  const ssh2 = await loadSsh2()
  try {
    await access(config.authorizedKeysFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    console.warn(
      `ssh: ${config.authorizedKeysFile} does not exist; every login will be refused until it holds a public key`,
    )
  }
  const clients = new Set<Connection>()
  let port = listenPort
  const server = new ssh2.Server(await serverOptions(config, ssh2.utils), (client, info) => {
    clients.add(client)
    client.on('close', () => {
      clients.delete(client)
    })
    const peer = { address: info.ip, port: info.port }
    const admit: Admit = (ctx) => authenticate(ctx, config.authorizedKeysFile, ssh2.utils)
    serveConnection(client, registry, admit, peer, { address: config.host, port })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  return {
    port,
    close: async () => {
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

/**
 * Serve one SSH connection the HTTPS route carries over `stream`. The route
 * has checked the caller's token and that its account may use
 * `workspaceId`, so the login needs no key: it may only name that
 * workspace, and runs as that account. Resolves once the connection ends.
 */
export async function serveTunnel(
  registry: WorkspaceRegistry,
  config: SSHConfig,
  stream: Duplex,
  workspaceId: string,
  account: string | null,
  peer: Endpoint,
  local: Endpoint,
): Promise<void> {
  const ssh2 = await loadSsh2()
  const ended = new Promise<void>((resolve) => {
    stream.once('close', resolve)
  })
  const server = new ssh2.Server(await serverOptions(config, ssh2.utils), (client) => {
    serveConnection(client, registry, admitTunnel(workspaceId, account), peer, local)
  })
  server.injectSocket(stream as Socket)
  await ended
}
