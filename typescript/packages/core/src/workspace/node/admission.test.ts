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

import { afterEach, describe, expect, it } from 'vitest'

import { IOResult, materialize } from '../../io/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { getTestParser, voicedStderr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parseSessionProfile, type SessionProfile } from '../../policy/profile.ts'
import { Admitted, admit, policyScopes } from './admission.ts'
import { admitLine } from './explain.ts'
import { PolicyDenied } from '../../policy/index.ts'
import type { CommandContext, CommandRule, AdmissionRules } from '../../policy/types.ts'
import type { Action } from '../../policy/index.ts'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { command, type CommandFn } from '../../commands/config.ts'
import { SPECS } from '../../commands/spec/index.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'

const DEC = new TextDecoder()

function gateCtx(tokens: string[]): CommandContext {
  return {
    command: tokens[0] ?? '',
    paths: [],
    argv: tokens.slice(1),
    cwd: '/',
    tokens,
  }
}

const DOC = parseSessionProfile({
  commands: {
    allow: [
      'cat',
      'rm',
      'ls',
      'ln',
      'echo',
      'head',
      'grep',
      'rg',
      'cd',
      'xargs',
      'sh',
      'mkdir',
      'eval',
      'source',
    ],
    deny: [
      { reason: 'sealed', commands: { cat: ['/data/secret*'] } },
      {
        reason: 'private',
        commands: { ls: ['/data/private'], grep: ['/data/private'], rg: ['/data/private'] },
      },
    ],
  },
})

const open: Workspace[] = []
afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function ws(profile: SessionProfile | null = DOC): Promise<Workspace> {
  const parser = await getTestParser()
  const w = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      ...(profile !== null ? { profiles: { default: profile } } : {}),
    },
  )
  open.push(w)
  return w
}

function virtuals(w: Workspace, name: string, ...args: string[]): string[] {
  const words = classifyParts([name, ...args], w.registry, '/')
  return policyScopes(name, args, words.slice(1), w.namespace, '/', null).map((p) => p.virtual)
}

describe('admission', () => {
  it('cats 9000 long absolute operands with an unrelated path rule', async () => {
    const ram = new RAMVFS()
    const names = Array.from(
      { length: 9000 },
      (_, index) => String(index).padStart(6, '0') + 'x'.repeat(388),
    )
    for (const name of names) ram.store.files.set('/' + name, new Uint8Array([120]))
    const w = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        profiles: {
          default: parseSessionProfile({
            commands: { deny: [{ reason: 'elsewhere', paths: ['/secret'] }] },
          }),
        },
      },
    )
    open.push(w)
    const result = await w.shell('cat ' + names.map((name) => '/data/' + name).join(' '))
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(await materialize(result.stdout))).toBe('x'.repeat(9000))
    expect(DEC.decode(await materialize(result.stderr))).toBe('')
  }, 30000)

  it('policy scopes follow links only for a following command', async () => {
    const w = await ws()
    await w.shell('echo top > /data/secret && ln -s /data/secret /data/link')
    // cat opens the target: the typed path first, then what it resolves
    // to; rm and `ls -l` act on the link itself.
    expect(virtuals(w, 'cat', '/data/link')).toEqual(['/data/link', '/data/secret'])
    expect(virtuals(w, 'rm', '/data/link')).toEqual(['/data/link'])
    expect(virtuals(w, 'ls', '-l', '/data/link')).toEqual(['/data/link'])
    expect(virtuals(w, 'ls', '/data/link')).toEqual(['/data/link', '/data/secret'])
    // A path that is not a link reads once; no namespace reads typed.
    expect(virtuals(w, 'cat', '/data/secret')).toEqual(['/data/secret'])
    const words = classifyParts(['cat', '/data/link'], w.registry, '/')
    expect(
      policyScopes('cat', ['/data/link'], words.slice(1), null, '/', null).map((p) => p.virtual),
    ).toEqual(['/data/link'])
  })

  it('a bare listing reads the working directory', async () => {
    // `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the cwd,
    // an operand the executor injects after the gate; a rule on that
    // directory has to see it here, as the operand typed `.`.
    const w = await ws()
    await w.shell('mkdir -p /data/private && echo x > /data/private/f')
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const run = async (name: string, args: string[], stdin: Uint8Array | null = null) => {
      const words = classifyParts([name, ...args], w.registry, session.cwd)
      const refusal = await admit(
        name,
        args,
        words.slice(1),
        session,
        w.registry,
        w.namespace,
        stdin,
      )
      return refusal instanceof Admitted ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    expect(await run('ls', [])).toBeNull()
    await w.shell('cd /data/private')
    expect(await run('ls', [])).toEqual([
      1,
      "ls: cannot access '.': Permission denied\npolicy denied: private\n",
    ])
    // A named operand replaces the implied one.
    expect(await run('ls', ['/data'])).toBeNull()
    // grep reads the cwd only under -r; rg yields to a piped stdin.
    expect(await run('grep', ['x'])).toBeNull()
    expect(await run('grep', ['-r', 'x'])).toEqual([
      1,
      'grep: /data/private: Permission denied\npolicy denied: private\n',
    ])
    expect(await run('rg', ['x'], new TextEncoder().encode('x\n'))).toBeNull()
    expect(await run('rg', ['x'])).toEqual([
      1,
      'rg: /data/private: Permission denied\npolicy denied: private\n',
    ])
  })

  it('a hidden path is no path to any policy', async () => {
    // A session that cannot see a path must not learn of it from a
    // rule: the gate drops the operand before any method, the rule does
    // not fire, and the line goes on to the dispatcher, which answers ENOENT.
    const w = await ws()
    await w.shell('mkdir -p /data/private && echo s > /data/secret')
    const veiled = w.createSession('veiled', {
      profile: { paths: { hide: ['/data/secret', '/data/private'] } },
    })
    const plain = w.sessionManager.get(w.sessionManager.defaultId)
    const run = async (session: typeof plain, name: string, ...args: string[]) => {
      const words = classifyParts([name, ...args], w.registry, session.cwd)
      const refusal = await admit(name, args, words.slice(1), session, w.registry, w.namespace)
      return refusal instanceof Admitted ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    expect(await run(plain, 'cat', '/data/secret')).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await run(veiled, 'cat', '/data/secret')).toBeNull()
    expect(await run(plain, 'ls', '/data/private')).toEqual([
      1,
      "ls: cannot access '/data/private': Permission denied\npolicy denied: private\n",
    ])
    expect(await run(veiled, 'ls', '/data/private')).toBeNull()
    // The followed target and the implied operand are dropped too.
    await w.shell('ln -s /data/secret /data/l')
    expect(await run(plain, 'cat', '/data/l')).toEqual([
      1,
      'cat: /data/l: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await run(veiled, 'cat', '/data/l')).toBeNull()
    // Whatever the session sees is still read as before.
    expect(await run(veiled, 'cat', '/data/a')).toBeNull()
    await w.shell('echo x > /data/private/f')
    expect(await run(plain, 'grep', '-r', 'x', '/data/private')).toEqual([
      1,
      'grep: /data/private: Permission denied\npolicy denied: private\n',
    ])
    expect(await run(veiled, 'grep', '-r', 'x', '/data/private')).toBeNull()
  })

  it('admitLine reads literal words and refuses the unreadable', async () => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const reparse = (text: string) => parser.parse(text)
    const line = async (text: string) => {
      const refusal = await admitLine(parser.parse(text), session, w.registry, w.namespace, reparse)
      return refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    const unread = (raw: string) =>
      `Permission denied\npolicy denied: cannot read ${raw} before the runtime expands it\n`
    // Quotes and escapes read as the text they name: a quoted path is a
    // path, a quoted head is the command.
    expect(await line('\'cat\' "/data/secret"')).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line('cat /data/sec\\ret')).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    // A head only the runtime can expand is refused under any rule.
    expect(await line('$cmd /data/x')).toEqual([126, '$cmd: ' + unread('$cmd')])
    expect(await line('"$cmd" /data/x')).toEqual([126, '"$cmd": ' + unread('"$cmd"')])
    // An argument is refused only where a rule reads that command's
    // arguments: cat has a path rule, echo has none.
    expect(await line('cat "$f"')).toEqual([126, 'cat: ' + unread('"$f"')])
    expect(await line('cat /data/{a,secret}')).toEqual([126, 'cat: ' + unread('/data/{a,secret}')])
    expect(await line('echo "$HOME" $(ls /data)')).toBeNull()
    // What a word runs is admitted in turn.
    expect(await line("eval 'cat /data/secret'")).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line('eval "$p"')).toEqual([126, '"$p": ' + unread('"$p"')])
    expect(await line('echo $(cat /data/secret)')).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line('ls | xargs cat')).toEqual([
      126,
      'cat: Permission denied\npolicy denied: runs on operands the gate cannot read\n',
    ])
    expect(await line('ls | xargs echo')).toBeNull()
    expect(await line('source /data/env.sh')).toEqual([
      126,
      'source: Permission denied\npolicy denied: runs lines the gate cannot read\n',
    ])
    expect(await line('/data/run.sh')).toEqual([
      126,
      '/data/run.sh: Permission denied\npolicy denied: runs lines the gate cannot read\n',
    ])
    expect(await line("sh -c 'rm /data/x'; sh -c 'sort'")).toEqual([
      126,
      'sort: Permission denied\npolicy denied: sort is not allowed\n',
    ])
  })

  it('admitLine without rules admits the words as typed', async () => {
    // No command rule in force: nothing is refused for being unreadable,
    // which is what a coded policy always saw.
    const w = await ws(null)
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const reparse = (text: string) => parser.parse(text)
    for (const text of ['$cmd /data/x', 'eval "$p"', 'source /data/env.sh', 'ls | xargs cat']) {
      expect(
        await admitLine(parser.parse(text), session, w.registry, w.namespace, reparse),
      ).toBeNull()
    }
  })

  it('admitLine refuses the first offending command', async () => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) =>
      admitLine(parser.parse(text), session, w.registry, w.namespace, (t) => parser.parse(t))
    expect(await line('cat /data/a | head -n 1')).toBeNull()
    // An unlisted word anywhere in the line is the allow list's Deny.
    const unlisted = await line('cat /data/a | sort')
    expect(unlisted).not.toBeNull()
    expect([unlisted?.exitCode, DEC.decode(unlisted?.stderr)]).toEqual([
      126,
      'sort: Permission denied\n',
    ])
    // A rule reads the literal words, path-shaped ones as paths.
    const sealed = await line('ls /data && cat /data/secret')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([
      1,
      'cat: /data/secret: Permission denied\n',
    ])
    // The same gate, one command at a time.
    expect(await admit('rm', ['/data/x'], [], session, w.registry, w.namespace)).toBeInstanceOf(
      Admitted,
    )
  })

  it('admitLine classifies bare operands with the spec', async () => {
    // `cat secret` from /data names /data/secret only through cat's
    // spec: the bare word has no path shape for the heuristics, and the
    // runtime resolves it against the cwd exactly as the spec hints do.
    const w = await ws()
    await w.shell('cd /data')
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) =>
      admitLine(parser.parse(text), session, w.registry, w.namespace, (t) => parser.parse(t))
    const sealed = await line('cat secret')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([
      1,
      'cat: secret: Permission denied\n',
    ])
    expect(await line('cat open')).toBeNull()
  })

  it('admitLine reads an interpreter’s script as a path', async () => {
    // The runtime that takes the line runs the interpreter itself, where
    // no dispatcher follows the script read, so the gate types the script
    // slot from the interpreter's spec as it does a mount command's: a
    // bare name under the cwd is the file it names, and once -c or -e
    // names the program no operand is a path.
    const w = await ws(
      parseSessionProfile({
        commands: { deny: [{ reason: 'sealed', paths: ['/data/secret*'] }] },
      }),
    )
    await w.shell('cd /data')
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) =>
      admitLine(parser.parse(text), session, w.registry, w.namespace, (t) => parser.parse(t))
    const sealed = await line('python3 secret.py')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([
      1,
      'python3: secret.py: Permission denied\n',
    ])
    const dashed = await line('node -- secret.js')
    expect([dashed?.exitCode, DEC.decode(dashed?.stderr)]).toEqual([
      1,
      'node: secret.js: Permission denied\n',
    ])
    expect(await line("python3 -c 'print(1)' secret.py")).toBeNull()
    expect(await line('node -e 1 secret.js')).toBeNull()
    expect(await line('python3 open.py')).toBeNull()
  })

  it('admitLine refuses a walk or a glob under a path rule', async () => {
    // Every line executor acts outside the entry gate (a sandbox's own
    // disk), so a command a path rule reads must not reach it with a
    // walk or a pattern in hand: the walk would read entries the gate
    // never judged, and only the runtime would see the matches.
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = async (text: string) => {
      const refusal = await admitLine(parser.parse(text), session, w.registry, w.namespace, (t) =>
        parser.parse(t),
      )
      return refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    expect(await line('grep -r x /data')).toEqual([
      126,
      'grep: Permission denied\npolicy denied: walks a tree the gate cannot follow\n',
    ])
    expect(await line('rg x /data')).toEqual([
      126,
      'rg: Permission denied\npolicy denied: walks a tree the gate cannot follow\n',
    ])
    expect(await line('cat /data/se*')).toEqual([
      126,
      'cat: Permission denied\npolicy denied: expands a pattern only the runtime can read\n',
    ])
    // The judged words still pass: a named clean path, a command no
    // path rule reads, a walker the rules leave alone.
    expect(await line('grep x /data/open.txt')).toBeNull()
    expect(await line('echo /data/*')).toBeNull()
    expect(await line('head -n 1 /data/open.txt')).toBeNull()
  })

  it('admitLine reads redirect targets as words of the command', async () => {
    // The shell opens a redirect target on its own fds, outside the
    // admitted command's gate window, so the gate judges it with the
    // line: `cat < /data/secret` reads the file it protects, and a
    // target only the runtime can expand is unread like any word.
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = async (text: string) => {
      const refusal = await admitLine(parser.parse(text), session, w.registry, w.namespace, (t) =>
        parser.parse(t),
      )
      return refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    expect(await line('cat < /data/secret')).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line('head -c 1 /data/open > /data/secret2')).toBeNull()
    expect(await line('cat /data/open > /data/secret2')).toEqual([
      1,
      'cat: /data/secret2: Permission denied\npolicy denied: sealed\n',
    ])
    expect(await line('cat < $F')).toEqual([
      126,
      'cat: Permission denied\npolicy denied: cannot read $F before the runtime expands it\n',
    ])
    expect(await line('echo hi > $F')).toBeNull()
    expect(await line("cat /data/open <<< 'body'")).toBeNull()
  })

  // The parse hoists a trailing redirect over whatever precedes it, a `!`
  // included (`! cat < f` is redirected(negated(cat), < f)), and every
  // shape still names the command bash opens the file for.
  const HOISTED = [
    '! cat < /data/secret',
    'echo a && ! cat < /data/secret',
    '! cat < /data/secret | cat',
    'echo x | cat < /data/secret',
    'echo a && echo x | cat < /data/secret',
    'echo a && cat < /data/secret | cat',
    'time cat < /data/secret',
    '! { time cat < /data/secret; }',
  ]

  it.each(HOISTED)('admitLine binds a hoisted redirect to its command: %s', async (text) => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const refusal = await admitLine(parser.parse(text), session, w.registry, w.namespace, (t) =>
      parser.parse(t),
    )
    expect(refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]).toEqual([
      1,
      'cat: /data/secret: Permission denied\npolicy denied: sealed\n',
    ])
  })

  it.each(HOISTED)('the run judges a hoisted redirect with its command: %s', async (text) => {
    // The run hands a redirect's targets to the gate of the node it runs
    // under them, so a redirect left on a `!` (or a pipeline) never
    // reached `cat`'s gate and `! cat < /data/secret` printed the file.
    const w = await ws()
    await w.shell('echo TOPSECRET > /data/secret')
    const io = await w.shell(text)
    expect(DEC.decode(io.stdout)).not.toContain('TOPSECRET')
    expect(DEC.decode(await materialize(io.stderr))).toContain(
      'cat: /data/secret: Permission denied',
    )
    expect(io.refusal?.reason).toBe('sealed')
  })
  it('the admitted gate judges what the line did not name', () => {
    const deny: CommandRule = { reason: 'sealed', paths: ['/data/sealed'] }
    const ask: CommandRule = { reason: 'nod', commands: ['grep'], paths: ['/data/asked/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [deny] }
    const gate = new Admitted({
      rules,
      ctx: gateCtx(['grep', '-r', 'x', '/data']),
      judged: new Set(['/data']),
      granted: [],
    })
    gate.check('/data')
    gate.check('/data/open/o')
    let thrown: unknown = null
    try {
      gate.check('/data/sealed/s')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PolicyDenied)
    expect((thrown as PolicyDenied).message).toBe('Permission denied')
    expect((thrown as PolicyDenied).refusal?.reason).toBe('sealed')
    expect((thrown as PolicyDenied).virtualPath).toBe('/data/sealed/s')
    try {
      gate.check('/data/asked/a')
      thrown = null
    } catch (err) {
      thrown = err
    }
    expect((thrown as PolicyDenied | null)?.refusal?.reason).toBe('nod')
    // An operand the gate judged passes whatever the rules say about it
    // (the line was admitted on it), and a grant under the asking rule
    // opens its scope to the walk.
    const judged = new Admitted({
      rules,
      ctx: gateCtx(['grep', 'x', '/data/asked/a']),
      judged: new Set(['/data/asked/a']),
      granted: [],
    })
    judged.check('/data/asked/a')
    const granted = new Admitted({
      rules,
      ctx: gateCtx(['grep', '-r', 'x', '/data/asked']),
      judged: new Set(['/data/asked']),
      granted: [ask],
    })
    granted.check('/data/asked/a')
  })

  it('the admitted gate scopes each start point on its own', () => {
    // A walk keeps its native op where no rule could reach: the gate of
    // `find /data /other` sets aside only the walk of /data.
    const rules: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'sealed', paths: ['/data/sealed'] }],
    }
    const gate = new Admitted({
      rules,
      ctx: gateCtx(['find', '/data', '/other']),
      judged: new Set(['/data', '/other']),
      granted: [],
    })
    expect(['/data', '/data/sealed/s', '/other'].map((p) => gate.scopes(p))).toEqual([
      true,
      true,
      false,
    ])
  })

  it('admit reports the grant the line runs under', async () => {
    const w = await ws()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const words = classifyParts(['rm', '/data/x'], w.registry, session.cwd)
    const verdict = await admit('rm', ['/data/x'], words.slice(1), session, w.registry, w.namespace)
    expect(verdict).toBeInstanceOf(Admitted)
    const admitted = verdict as Admitted
    expect(admitted.ctx.tokens).toEqual(['rm', '/data/x'])
    expect([...admitted.judged]).toEqual(['/data/x'])
    expect(admitted.granted).toEqual([])
  })
})

describe('what the handler a command resolves to declares', () => {
  const noop: CommandFn = () => [null, new IOResult()]

  // --token is filled from the session's env; the gate's walk must read it too.
  const ISSUES = new CLI({
    spec: new CommandSpec({
      name: 'issues',
      arguments: [new Argument('--token', { env: 'TOKEN', required: true })],
      subcommands: [
        new CommandSpec({ name: 'list' }),
        new CommandSpec({ name: 'create', aliases: ['new'] }),
      ],
    }),
    handlers: {
      list: new CLIHandler({ fn: noop }),
      create: new CLIHandler({ write: true, fn: noop }),
    },
  })
  // A tree a mount serves; the gate reads its group path, a leaf path the
  // env fills and a leaf's file, behind the env-filled --token, as the walk
  // does.
  const NOTES = new CLI({
    spec: new CommandSpec({
      name: 'notes',
      arguments: [
        new Argument('--file', { type: 'path' }),
        new Argument('--token', { env: 'TOKEN', required: true }),
      ],
      subcommands: [
        new CommandSpec({
          name: 'show',
          arguments: [
            new Argument('-C', { type: 'path' }),
            new Argument('paths', { type: 'path', nargs: '*' }),
          ],
          operandBase: '-C',
        }),
        new CommandSpec({
          name: 'add',
          arguments: [new Argument('--out', { type: 'path', env: 'OUT' })],
        }),
      ],
    }),
    handlers: {
      show: new CLIHandler({ fn: noop }),
      add: new CLIHandler({ write: true, fn: noop }),
    },
  })
  // A flat tree: -e from the env takes the text slot, so the word is a file.
  const SCAN = new CLI({
    spec: new CommandSpec({
      name: 'scan',
      arguments: [
        new Argument('-e', { env: 'PATTERN' }),
        new Argument('text', { nargs: '?', providedBy: ['-e'] }),
        new Argument('paths', { type: 'path', nargs: '*' }),
      ],
    }),
    handlers: { '': new CLIHandler({ fn: noop }) },
  })
  const PATHS = new CommandSpec({
    arguments: [new Argument('paths', { type: 'path', nargs: '*' })],
  })
  const COMMANDS = [
    ...command({ name: 'peek', vfs: null, spec: new CommandSpec(), fn: noop }),
    ...command({ name: 'stamp', vfs: null, spec: new CommandSpec(), write: true, fn: noop }),
    ...command({ name: 'show', vfs: null, spec: PATHS, fn: noop }),
    ...command({ name: 'show', vfs: null, spec: PATHS, filetype: '.csv', write: true, fn: noop }),
  ]

  it('reads a command as writing when its handler says so', async () => {
    const seen: Record<string, boolean | undefined> = {}
    const programs: Record<string, readonly string[] | undefined> = {}
    const paths: Record<string, string[]> = {}
    const ws = new Workspace(
      { '/data/': new RAMVFS(), '/other/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        policies: [
          {
            preCommand: (ctx: CommandContext): Action | null => {
              seen[ctx.line ?? ''] = ctx.write
              programs[ctx.line ?? ''] = ctx.program
              paths[ctx.line ?? ''] = ctx.paths.map((p) => p.virtual)
              return ctx.write === true ? { kind: 'deny', reason: 'this session only reads' } : null
            },
          },
        ],
      },
    )
    open.push(ws)
    ws.registerCli('issues', ISSUES)
    ws.mount('/data/').registerCommands(COMMANDS)
    ws.mount('/data/').registerCommands([NOTES, SCAN])
    // /other/'s diff writes, and an attached path option routes there.
    const diff = SPECS.diff
    if (diff === undefined) throw new Error('no diff spec')
    ws.mount('/other/').registerCommands([
      ...command({ name: 'show', vfs: null, spec: PATHS, write: true, fn: noop }),
      ...command({ name: 'diff', vfs: null, spec: diff, write: true, fn: noop }),
    ])
    const lines = {
      'issues list': false,
      'issues create': true,
      'issues new': true,
      'issues nope': false,
      'notes show': false,
      'notes add': true,
      'notes --file /other/secret show': false,
      'notes show /other/note': false,
      'notes show -C /other note': false,
      'scan /other/s': false,
      peek: false,
      stamp: true,
      'show /data/a.txt': false,
      'show /data/a.csv': true,
      'show /data/a.txt /other/b.txt': true,
      'show /data/l.txt': true,
      'diff --exclude-from=/other/list - -': true,
      'cat /data/a.txt': false,
      'rm -f /data/a.txt': true,
      'sort -o /data/b.txt /data/a.txt': true,
      // A builtin that writes only under an option reads as a reader without it.
      'sort /data/a.txt': false,
      'sed -n p /data/a.txt': false,
      'sed -i s/a/b/ /data/a.txt': true,
      'tar -tf /data/a.tar': false,
      'uniq /data/a.txt /data/u.txt': true,
      // A pattern may expand to an output file too; a quoted name is no pattern.
      'uniq /data/a.*': true,
      "uniq '/data/a[1].txt'": false,
      'chmod 644 /data/a.txt': true,
      'ln -s /data/a.txt /data/l': true,
      'echo hi': false,
    }
    await ws.shell('export TOKEN=t OUT=/other/out PATTERN=p')
    // A run follows the link to the .csv, whose `show` writes.
    await ws.vfs.write('/data/f.csv', new TextEncoder().encode('x\n'))
    await ws.vfs.symlink('/data/l.txt', '/data/f.csv')
    for (const line of Object.keys(lines)) await ws.shell(line)
    expect(seen).toEqual(lines)
    expect(programs['issues new']).toEqual(['issues', 'create'])
    expect(paths['notes --file /other/secret show']).toEqual(['/other/secret'])
    expect(paths['notes add']).toEqual(['/other/out'])
    expect(paths['notes show /other/note']).toEqual(['/other/note'])
    expect(paths['notes show -C /other note']).toEqual(['/other', '/other/note'])
    expect(paths['scan /other/s']).toEqual(['/other/s'])
  })

  it.each(['flat', 'tree'])(
    'admits a %s fallback using every candidate write declaration',
    async (shape) => {
      const calls: string[] = []
      const w = new Workspace(
        { '/reader': new RAMVFS(), '/write': new RAMVFS() },
        {
          mode: MountMode.WRITE,
          shellParser: await getTestParser(),
          policies: [
            {
              preCommand: (ctx): Action | null =>
                ctx.write === true ? { kind: 'deny', reason: 'no writes' } : null,
            },
          ],
        },
      )
      open.push(w)
      w.mount('/reader').registerCommands(
        command({
          name: 'remote',
          vfs: null,
          spec: new CommandSpec({ arguments: [new Argument('args', { nargs: '*' })] }),
          fn: () => {
            calls.push('read')
            return [null, new IOResult()]
          },
        }),
      )
      const write: CommandFn = () => {
        calls.push('write')
        return [null, new IOResult()]
      }
      w.mount('/write').registerCommands(
        shape === 'flat'
          ? command({ name: 'remote', vfs: null, spec: new CommandSpec(), fn: write, write: true })
          : [
              new CLI({
                spec: new CommandSpec({
                  name: 'remote',
                  subcommands: [new CommandSpec({ name: 'put' })],
                }),
                handlers: { put: new CLIHandler({ fn: write, write: true }) },
              }),
            ],
      )
      const result = await w.shell(shape === 'flat' ? 'remote' : 'remote put')
      expect(result.exitCode).toBe(126)
      expect(result.stderrText).toContain('Permission denied')
      expect(calls).toEqual([])
    },
  )

  it('keeps an explicitly bound flat reader independent of a writing fallback tree', async () => {
    const w = new Workspace(
      { '/reader': new RAMVFS(), '/write': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        policies: [
          {
            preCommand: (ctx): Action | null =>
              ctx.write === true ? { kind: 'deny', reason: 'no writes' } : null,
          },
        ],
      },
    )
    open.push(w)
    w.mount('/reader').registerCommands(
      command({
        name: 'remote',
        vfs: null,
        spec: new CommandSpec({ arguments: [new Argument('path', { type: 'path' })] }),
        fn: () => [new TextEncoder().encode('read\n'), new IOResult()],
      }),
    )
    w.mount('/write').registerCommands([
      new CLI({
        spec: new CommandSpec({
          name: 'remote',
          arguments: [new Argument('args', { nargs: '*' })],
        }),
        handlers: { '': new CLIHandler({ fn: noop, write: true }) },
      }),
    ])
    const result = await w.shell('remote /reader/item')
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([0, 'read\n', ''])
  })

  it.each(['deny', 'ask'] as const)(
    'applies %s to a selected tree verb after its group options',
    async (decision) => {
      const calls: string[] = []
      const w = new Workspace(
        { '/reader': new RAMVFS(), '/write': new RAMVFS() },
        {
          mode: MountMode.WRITE,
          shellParser: await getTestParser(),
          profiles: { default: parseSessionProfile({ commands: { [decision]: ['remote send'] } }) },
        },
      )
      open.push(w)
      w.mount('/reader').registerCommands(
        command({
          name: 'remote',
          vfs: null,
          spec: new CommandSpec({ arguments: [new Argument('args', { nargs: '*' })] }),
          fn: () => {
            calls.push('reader')
            return [null, new IOResult()]
          },
        }),
      )
      w.mount('/write').registerCommands([
        new CLI({
          spec: new CommandSpec({
            name: 'remote',
            arguments: [new Argument('--account')],
            subcommands: [new CommandSpec({ name: 'send', aliases: ['deliver'] })],
          }),
          handlers: {
            send: new CLIHandler({
              write: true,
              fn: () => {
                calls.push('writer')
                return [null, new IOResult()]
              },
            }),
          },
        }),
      ])
      const result = await w.shell('remote --account team deliver')
      expect(result.exitCode).not.toBe(0)
      expect(result.refusal).not.toBeNull()
      expect(calls).toEqual([])
    },
  )

  it('does not classify an unreachable read-only writer as the selected reader', async () => {
    const w = new Workspace(
      { '/reader': new RAMVFS(), '/write': [new RAMVFS(), MountMode.READ] },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        policies: [
          {
            preCommand: (ctx): Action | null =>
              ctx.write ? { kind: 'deny', reason: 'no writes' } : null,
          },
        ],
      },
    )
    open.push(w)
    for (const [prefix, write] of [
      ['/reader', false],
      ['/write', true],
    ] as const) {
      w.mount(prefix).registerCommands(
        command({
          name: 'remote',
          vfs: null,
          spec: new CommandSpec(),
          write,
          fn: () => [new TextEncoder().encode(`${prefix}\n`), new IOResult()],
        }),
      )
    }
    const result = await w.shell('remote')
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([0, '/reader\n', ''])
  })
})

// One test in the spelling a name gives it: `test e`, `[ e ]` or `[[ e ]]`.
function spell(name: string, expr: string): string {
  return name === 'test' ? `test ${expr}` : `${name} ${expr} ${name === '[' ? ']' : ']]'}`
}

// The answer to one test spelled under a name, on fresh files, in a session
// under `profile`: exit, stdout, stderr.
async function tested(profile: SessionProfile, name: string, prefix: string, expr: string) {
  const w = await ws(null)
  await w.shell('echo a > /data/a.txt; echo s > /data/secret.txt')
  w.createSession('s', { profile })
  const r = await w.shell(`${prefix}${spell(name, expr)}; echo $?`, { sessionId: 's' })
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

// `[ ]` and `[[ ]]` are the shell's own tests, which no command gate sees,
// so each is admitted by its own name on what it tests, as `test` is: a path
// rule reads a file operand however it is spelled, and an allow list answers
// each name for itself.
describe("the shell's own tests", () => {
  const DENY: SessionProfile = {
    commands: { deny: [{ reason: 'secret', paths: ['/data/secret.txt'] }] },
  }

  it.each(['test', '[', '[['])('%s reads a file operand as a path rule does', async (name) => {
    expect(await tested(DENY, name, 'cd /data && ', '-e secret.txt')).toEqual([
      1,
      '',
      `${name}: secret.txt: Permission denied\n`,
    ])
    expect(await tested(DENY, name, '', '-e /data/secret.txt')).toEqual([
      1,
      '',
      `${name}: /data/secret.txt: Permission denied\n`,
    ])
    expect(await tested(DENY, name, 'cd /data && ', 'a.txt -nt secret.txt')).toEqual([
      1,
      '',
      `${name}: secret.txt: Permission denied\n`,
    ])
    expect(await tested(DENY, name, 'cd /data && ', '-e a.txt')).toEqual([0, '0\n', ''])
  })

  it.each(['test', '['])('%s compares a file operator on the left as a string', async (name) => {
    expect(await tested(DENY, name, 'cd /data && ', '-e = secret.txt')).toEqual([0, '1\n', ''])
  })

  it('[[ admits each leaf', async () => {
    // The line's reader sees every literal leaf, so a ruled one holds the line
    // as `test -e a -o -e b` would.
    for (const expr of ['-e a.txt || -e secret.txt', '-e nope || -e secret.txt']) {
      expect(await tested(DENY, '[[', 'cd /data && ', expr)).toEqual([
        1,
        '',
        '[[: secret.txt: Permission denied\n',
      ])
    }
    // A leaf only the run can expand is admitted where it is reached, and a
    // branch never reached is never admitted.
    expect(await tested(DENY, '[[', 'cd /data && x=secret.txt && ', '-e nope || -e $x')).toEqual([
      0,
      '1\n',
      '[[: secret.txt: Permission denied\n',
    ])
    expect(await tested(DENY, '[[', 'cd /data && x=secret.txt && ', '-e a.txt || -e $x')).toEqual([
      0,
      '0\n',
      '',
    ])
  })

  it.each(['test', '[', '[['])('%s is answered by its own name in an allow list', async (name) => {
    const without = { commands: { allow: ['echo', 'cd'] } }
    expect(await tested(without, name, 'cd /data && ', '-e a.txt')).toEqual([
      0,
      '126\n',
      `${name}: Permission denied\n`,
    ])
    const listed = { commands: { allow: ['echo', 'cd', name] } }
    expect(await tested(listed, name, 'cd /data && ', '-e a.txt')).toEqual([0, '0\n', ''])
  })
})
