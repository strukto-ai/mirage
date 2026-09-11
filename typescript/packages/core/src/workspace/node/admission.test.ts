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

import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { classifyParts } from '../expand/classify/parts.ts'
import { getTestParser, voicedStderr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parseSessionProfile, type SessionProfile } from '../../policy/profile.ts'
import { Admitted, admit, admitLine, policyScopes } from './admission.ts'
import { PolicyDenied } from '../../policy/index.ts'
import type { CommandRule, AdmissionRules } from '../../policy/types.ts'

const DEC = new TextDecoder()

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
    { '/data': new RAMResource() },
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
  return policyScopes(name, args, words.slice(1), w.namespace, '/').map((p) => p.virtual)
}

describe('admission', () => {
  it('policy scopes follow links only for a following command', async () => {
    const w = await ws()
    await w.execute('echo top > /data/secret && ln -s /data/secret /data/link')
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
      policyScopes('cat', ['/data/link'], words.slice(1), null, '/').map((p) => p.virtual),
    ).toEqual(['/data/link'])
  })

  it('a bare listing reads the working directory', async () => {
    // `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the cwd,
    // an operand the executor injects after the gate; a rule on that
    // directory has to see it here, as the operand typed `.`.
    const w = await ws()
    await w.execute('mkdir -p /data/private && echo x > /data/private/f')
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
        '',
        stdin,
      )
      return refusal instanceof Admitted ? null : [refusal.exitCode, DEC.decode(refusal.stderr)]
    }
    expect(await run('ls', [])).toBeNull()
    await w.execute('cd /data/private')
    expect(await run('ls', [])).toEqual([1, 'ls: .: private\n'])
    // A named operand replaces the implied one.
    expect(await run('ls', ['/data'])).toBeNull()
    // grep reads the cwd only under -r; rg yields to a piped stdin.
    expect(await run('grep', ['x'])).toBeNull()
    expect(await run('grep', ['-r', 'x'])).toEqual([1, 'grep: /data/private: private\n'])
    expect(await run('rg', ['x'], new TextEncoder().encode('x\n'))).toBeNull()
    expect(await run('rg', ['x'])).toEqual([1, 'rg: /data/private: private\n'])
  })

  it('a hidden path is no path to any policy', async () => {
    // A session that cannot see a path must not learn of it from a
    // rule: the gate drops the operand before any hook, the rule does
    // not fire, and the line goes on to the door, which answers ENOENT.
    const w = await ws()
    await w.execute('mkdir -p /data/private && echo s > /data/secret')
    const veiled = w.createSession('veiled', {
      profile: { paths: { hide: ['/data/secret', '/data/private'] } },
    })
    const plain = w.sessionManager.get(w.sessionManager.defaultId)
    const run = async (session: typeof plain, name: string, ...args: string[]) => {
      const words = classifyParts([name, ...args], w.registry, session.cwd)
      const refusal = await admit(name, args, words.slice(1), session, w.registry, w.namespace)
      return refusal instanceof Admitted ? null : [refusal.exitCode, DEC.decode(refusal.stderr)]
    }
    expect(await run(plain, 'cat', '/data/secret')).toEqual([1, 'cat: /data/secret: sealed\n'])
    expect(await run(veiled, 'cat', '/data/secret')).toBeNull()
    expect(await run(plain, 'ls', '/data/private')).toEqual([1, 'ls: /data/private: private\n'])
    expect(await run(veiled, 'ls', '/data/private')).toBeNull()
    // The followed target and the implied operand are dropped too.
    await w.execute('ln -s /data/secret /data/l')
    expect(await run(plain, 'cat', '/data/l')).toEqual([1, 'cat: /data/l: sealed\n'])
    expect(await run(veiled, 'cat', '/data/l')).toBeNull()
    // Whatever the session sees is still read as before.
    expect(await run(veiled, 'cat', '/data/a')).toBeNull()
    await w.execute('echo x > /data/private/f')
    expect(await run(plain, 'grep', '-r', 'x', '/data/private')).toEqual([
      1,
      'grep: /data/private: private\n',
    ])
    expect(await run(veiled, 'grep', '-r', 'x', '/data/private')).toBeNull()
  })

  it('admitLine reads literal words and refuses the unreadable', async () => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const reparse = (text: string) => parser.parse(text)
    const line = async (text: string) => {
      const refusal = await admitLine(
        parser.parse(text),
        session,
        w.registry,
        w.namespace,
        '',
        reparse,
      )
      return refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    const unread = (raw: string) =>
      `Permission denied\npolicy denied: cannot read ${raw} before the runtime expands it\n`
    // Quotes and escapes read as the text they name: a quoted path is a
    // path, a quoted head is the command.
    expect(await line('\'cat\' "/data/secret"')).toEqual([1, 'cat: /data/secret: sealed\n'])
    expect(await line('cat /data/sec\\ret')).toEqual([1, 'cat: /data/secret: sealed\n'])
    // A head only the runtime can expand is refused under any rule.
    expect(await line('$cmd /data/x')).toEqual([126, '$cmd: ' + unread('$cmd')])
    expect(await line('"$cmd" /data/x')).toEqual([126, '"$cmd": ' + unread('"$cmd"')])
    // An argument is refused only where a rule reads that command's
    // arguments: cat has a path rule, echo has none.
    expect(await line('cat "$f"')).toEqual([126, 'cat: ' + unread('"$f"')])
    expect(await line('cat /data/{a,secret}')).toEqual([126, 'cat: ' + unread('/data/{a,secret}')])
    expect(await line('echo "$HOME" $(ls /data)')).toBeNull()
    // What a word runs is admitted in turn.
    expect(await line("eval 'cat /data/secret'")).toEqual([1, 'cat: /data/secret: sealed\n'])
    expect(await line('eval "$p"')).toEqual([126, '"$p": ' + unread('"$p"')])
    expect(await line('echo $(cat /data/secret)')).toEqual([1, 'cat: /data/secret: sealed\n'])
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
      127,
      'sort: command not found\n',
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
        await admitLine(parser.parse(text), session, w.registry, w.namespace, '', reparse),
      ).toBeNull()
    }
  })

  it('admitLine refuses the first offending command', async () => {
    const w = await ws()
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) =>
      admitLine(parser.parse(text), session, w.registry, w.namespace, '', (t) => parser.parse(t))
    expect(await line('cat /data/a | head -n 1')).toBeNull()
    // An unlisted word anywhere in the line is 127 before any hook.
    const unlisted = await line('cat /data/a | sort')
    expect(unlisted).not.toBeNull()
    expect([unlisted?.exitCode, DEC.decode(unlisted?.stderr)]).toEqual([
      127,
      'sort: command not found\n',
    ])
    // A rule reads the literal words, path-shaped ones as paths.
    const sealed = await line('ls /data && cat /data/secret')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([
      1,
      'cat: /data/secret: sealed\n',
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
    await w.execute('cd /data')
    const parser = await getTestParser()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    const line = (text: string) =>
      admitLine(parser.parse(text), session, w.registry, w.namespace, '', (t) => parser.parse(t))
    const sealed = await line('cat secret')
    expect([sealed?.exitCode, DEC.decode(sealed?.stderr)]).toEqual([1, 'cat: secret: sealed\n'])
    expect(await line('cat open')).toBeNull()
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
      const refusal = await admitLine(
        parser.parse(text),
        session,
        w.registry,
        w.namespace,
        '',
        (t) => parser.parse(t),
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
      const refusal = await admitLine(
        parser.parse(text),
        session,
        w.registry,
        w.namespace,
        '',
        (t) => parser.parse(t),
      )
      return refusal === null ? null : [refusal.exitCode, voicedStderr(refusal)]
    }
    expect(await line('cat < /data/secret')).toEqual([1, 'cat: /data/secret: sealed\n'])
    expect(await line('head -c 1 /data/open > /data/secret2')).toBeNull()
    expect(await line('cat /data/open > /data/secret2')).toEqual([
      1,
      'cat: /data/secret2: sealed\n',
    ])
    expect(await line('cat < $F')).toEqual([
      126,
      'cat: Permission denied\npolicy denied: cannot read $F before the runtime expands it\n',
    ])
    expect(await line('echo hi > $F')).toBeNull()
    expect(await line("cat /data/open <<< 'body'")).toBeNull()
  })
  it('the admitted gate judges what the line did not name', () => {
    const deny: CommandRule = { reason: 'sealed', paths: ['/data/sealed'] }
    const ask: CommandRule = { reason: 'nod', commands: ['grep'], paths: ['/data/asked/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [deny] }
    const gate = new Admitted({
      rules,
      tokens: ['grep', '-r', 'x', '/data'],
      judged: new Set(['/data']),
      granted: [],
      scoped: true,
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
    expect((thrown as PolicyDenied).message).toBe('sealed')
    expect((thrown as PolicyDenied).virtualPath).toBe('/data/sealed/s')
    expect(() => {
      gate.check('/data/asked/a')
    }).toThrow('nod')
    // An operand the gate judged passes whatever the rules say about it
    // (the line was admitted on it), and a grant under the asking rule
    // opens its scope to the walk.
    new Admitted({
      rules,
      tokens: ['grep', 'x', '/data/asked/a'],
      judged: new Set(['/data/asked/a']),
      granted: [],
      scoped: true,
    }).check('/data/asked/a')
    new Admitted({
      rules,
      tokens: ['grep', '-r', 'x', '/data/asked'],
      judged: new Set(['/data/asked']),
      granted: [ask],
      scoped: true,
    }).check('/data/asked/a')
  })

  it('admit reports the grant the line runs under and its scope', async () => {
    const w = await ws()
    const session = w.sessionManager.get(w.sessionManager.defaultId)
    let words = classifyParts(['rm', '/data/x'], w.registry, session.cwd)
    const verdict = await admit('rm', ['/data/x'], words.slice(1), session, w.registry, w.namespace)
    expect(verdict).toBeInstanceOf(Admitted)
    const admitted = verdict as Admitted
    expect(admitted.tokens).toEqual(['rm', '/data/x'])
    expect([...admitted.judged]).toEqual(['/data/x'])
    expect(admitted.granted).toEqual([])
    // `rm` is under no path rule in this document; `cat` is.
    expect(admitted.scoped).toBe(false)
    words = classifyParts(['cat', '/data/a'], w.registry, session.cwd)
    const scoped = await admit('cat', ['/data/a'], words.slice(1), session, w.registry, w.namespace)
    expect(scoped).toBeInstanceOf(Admitted)
    expect((scoped as Admitted).scoped).toBe(true)
  })
})
