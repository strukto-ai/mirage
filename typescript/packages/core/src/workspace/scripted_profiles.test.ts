import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { ScriptSource } from '../runtime/types.ts'
import { MountMode } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

// Mirrors the profile policy cases in
// python/tests/workspace/workspace/test_policies.py.

// What every policy program starts with: its context, as JSON.
const CONTEXT = `\
import json
import os

ctx = json.loads(os.environ['MIRAGE_POLICY_CTX'])
`

// A per-command judge: deny cat under /data/sealed/ with a computed
// reason, take shred to the approval ledger, stay silent otherwise. A
// program prints its answer, and null is silence.
const JUDGE = `${CONTEXT}
def answer():
    for p in ctx['paths']:
        if ctx['command'] == 'cat' and p.startswith('/data/sealed/'):
            return {'kind': 'deny', 'reason': 'sealed by ' + ctx['profile']}
    if ctx['command'] == 'shred':
        return {'kind': 'ask', 'reason': 'sign-off'}
    return None

print(json.dumps(answer()))
`

// A judge that reads what the operand holds, not what it is called:
// the shape a content policy takes when it is a program.
const READER = `${CONTEXT}
def answer():
    for p in ctx['paths']:
        try:
            body = open(p).read()
        except OSError:
            continue
        if 'payload' in body:
            return {'kind': 'ask', 'reason': 'sign-off on payload'}
    return None

print(json.dumps(answer()))
`

type Method = 'preExecute' | 'preCommand' | 'preVfs' | 'preSession'

// One profile named release with a policy and nothing else, so what
// runs is purely the policy's decision.
function scripted(
  programs: Partial<Record<Method, string>> = { preCommand: JUDGE },
  runtime = 'monty',
) {
  return {
    release: {
      policy: Object.fromEntries(
        Object.entries(programs).map(([method, source]) => [
          method,
          [{ script: new ScriptSource(source, 'python'), runtime }],
        ]),
      ),
    },
  }
}

async function build(
  profiles: Record<string, unknown>,
  runtimes?: string[],
  profile?: string,
): Promise<Workspace> {
  const shellParser = await getTestParser()
  return new Workspace(
    { '/data/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      shellParser,
      profiles: profiles as never,
      ...(runtimes !== undefined ? { runtimes } : {}),
      ...(profile !== undefined ? { profile } : {}),
    },
  )
}

describe('profile policies', () => {
  it('judges each command, with the facts as ctx', async () => {
    const ws = await build(scripted())
    try {
      await ws.shell('mkdir -p /data/sealed && echo k > /data/sealed/k')
      ws.createSession('s', { profile: 'release' })
      expect((await ws.shell('echo hi', { sessionId: 's' })).exitCode).toBe(0)
      const denied = await ws.shell('cat /data/sealed/k', { sessionId: 's' })
      expect(denied.exitCode).toBe(126)
      expect(denied.stderrText).toBe('cat: Permission denied\n')
      expect(denied.refusal).toMatchObject({ kind: 'deny', reason: 'sealed by release' })
    } finally {
      await ws.close()
    }
  }, 120000)

  it('reads resolved paths, not typed words', async () => {
    // `cd /data && cat sealed/k` names no /data/sealed word; the gate
    // hands the program the resolved operand, so the deny still lands.
    const ws = await build(scripted())
    try {
      ws.createSession('s', { profile: 'release' })
      const denied = await ws.shell('cd /data && cat sealed/k', { sessionId: 's' })
      expect(denied.exitCode).toBe(126)
      expect(denied.stderrText).toBe('cat: Permission denied\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a policy-only profile installs everything', async () => {
    // No allow list, so nothing is hidden: a command no document names
    // runs whenever the program stays silent on it.
    const ws = await build(scripted())
    try {
      await ws.shell('echo x > /data/x')
      ws.createSession('s', { profile: 'release' })
      expect((await ws.shell('rm /data/x', { sessionId: 's' })).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a document may ride beside the policy', async () => {
    // Optional, not required: a profile stating both keeps the allow
    // list, and the program adds its verdicts beside it.
    const profiles = scripted()
    const ws = await build({
      release: { ...profiles.release, commands: { allow: ['ls', 'cat', 'echo'] } },
    })
    try {
      ws.createSession('s', { profile: 'release' })
      expect((await ws.shell('rm /data/x', { sessionId: 's' })).exitCode).toBe(126)
      const denied = await ws.shell('cat /data/sealed/k', { sessionId: 's' })
      expect(denied.exitCode).toBe(126)
      expect(denied.stderrText).toBe('cat: Permission denied\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it('takes an ask it computed to the approval ledger', async () => {
    const ws = await build(scripted())
    try {
      ws.createSession('s', { profile: 'release' })
      const held = await ws.shell('shred /data/x', { sessionId: 's' })
      expect(held.exitCode).toBe(126)
      expect(held.stderrText).toBe('shred: Permission denied\n')
      expect(held.refusal).toMatchObject({ kind: 'pending', reason: 'sign-off' })
      expect(held.refusal?.askId).toBeTruthy()
    } finally {
      await ws.close()
    }
  }, 120000)

  it('leaves other sessions alone', async () => {
    const ws = await build(scripted())
    try {
      await ws.shell('mkdir -p /data/sealed && echo k > /data/sealed/k')
      ws.createSession('s', { profile: 'release' })
      const read = await ws.shell('cat /data/sealed/k')
      expect(read.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a scripted default profile shapes the default session', async () => {
    const ws = await build(scripted(), undefined, 'release')
    try {
      expect((await ws.shell('echo hi')).exitCode).toBe(0)
      const denied = await ws.shell('cat /data/sealed/k')
      expect(denied.exitCode).toBe(126)
      expect(denied.stderrText).toBe('cat: Permission denied\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it('reads what the line names, through the mounts', async () => {
    // Content, not names: the program opens each operand through the
    // same entry point an agent's program would, so it can ask about what a
    // file holds. A directory operand is not its business, and a file
    // without the marker runs.
    const ws = await build(scripted({ preCommand: READER }))
    try {
      await ws.shell(
        "mkdir -p /data/in && printf 'subject: invoice\\n\\na payload\\n' > /data/in/mail.txt && echo plain > /data/in/note.txt",
      )
      ws.createSession('s', { profile: 'release' })
      const held = await ws.shell('cat /data/in/mail.txt', { sessionId: 's' })
      expect(held.exitCode).toBe(126)
      expect(held.refusal).toMatchObject({ kind: 'pending', reason: 'sign-off on payload' })
      expect((await ws.shell('cat /data/in/note.txt', { sessionId: 's' })).exitCode).toBe(0)
      expect((await ws.shell('ls /data/in', { sessionId: 's' })).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  }, 120000)

  it('runs in a world with no evaluator', async () => {
    // A profile is operator configuration, so the runtime that judges
    // for it is a property of the profile, built fresh and never
    // resolved out of the runtime world.
    const ws = await build(scripted(), ['workspace'])
    try {
      ws.createSession('s', { profile: 'release' })
      const denied = await ws.shell('cat /data/sealed/k', { sessionId: 's' })
      expect(denied.exitCode).toBe(126)
      expect(denied.stderrText).toBe('cat: Permission denied\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a broken policy fails closed per command', async () => {
    // Silence on failure would run exactly the commands the policy
    // existed to judge.
    const ws = await build(scripted({ preCommand: "raise ValueError('boom')" }))
    try {
      ws.createSession('s', { profile: 'release' })
      const refused = await ws.shell('echo hi', { sessionId: 's' })
      expect(refused.exitCode).toBe(126)
      expect(refused.stderrText).toBe('echo: Permission denied\n')
      expect(refused.refusal?.reason).toMatch(/^profile 'release' policy exited /)
      expect((await ws.shell('echo hi')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a runtime policies do not run on fails closed', async () => {
    const ws = await build(scripted({ preCommand: JUDGE }, 'workspace'))
    try {
      ws.createSession('s', { profile: 'release' })
      const refused = await ws.shell('echo hi', { sessionId: 's' })
      expect(refused.exitCode).toBe(126)
      expect(refused.stderrText).toBe('echo: Permission denied\n')
      expect(refused.refusal?.reason).toBe(
        "profile 'release' policy names runtime 'workspace'; a policy program runs on monty or pyodide",
      )
    } finally {
      await ws.close()
    }
  })

  it('a program printing something else fails closed', async () => {
    // stdout is the answer: anything but one JSON answer or nothing is
    // refused rather than guessed at.
    const ws = await build(scripted({ preCommand: "print('looks fine to me')" }))
    try {
      ws.createSession('s', { profile: 'release' })
      const refused = await ws.shell('echo hi', { sessionId: 's' })
      expect(refused.exitCode).toBe(126)
      expect(refused.refusal?.reason).toMatch(
        /^profile 'release' policy must print a JSON answer at pre_command/,
      )
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a policy program states its runtime', async () => {
    await expect(
      build({
        release: { policy: { preCommand: [{ script: new ScriptSource(JUDGE, 'python') }] } },
      }),
    ).rejects.toThrow(/runtime names the runtime the program runs on/)
  })

  it('the old script and runtime keys are told the new block', async () => {
    // Shipped first as `script` with `runtime` beside it, a word for
    // what the file is rather than what it does and an engine that
    // read as the profile's own; the refusal says where they went.
    await expect(
      build({ release: { script: new ScriptSource(JUDGE, 'python'), runtime: 'monty' } }),
    ).rejects.toThrow(/now a policy block/)
  })

  it('names its programs per method', async () => {
    await expect(
      build({
        release: { policy: { script: new ScriptSource(JUDGE, 'python'), runtime: 'monty' } },
      }),
    ).rejects.toThrow(/per method/)
    const program = { script: new ScriptSource(JUDGE, 'python'), runtime: 'monty' }
    await expect(build({ release: { policy: { onRead: [program] } } })).rejects.toThrow(
      /names onRead/,
    )
    const ws = await build({ release: { policy: { postVfs: [program], preVfs: [program] } } })
    await ws.close()
    await expect(
      build({
        release: {
          policy: {
            constructor: [{ script: new ScriptSource(JUDGE, 'python'), runtime: 'monty' }],
          },
        },
      }),
    ).rejects.toThrow(/names constructor/)
  })

  it('an inline document may not add a policy', async () => {
    const ws = await build(scripted())
    try {
      expect(() =>
        ws.createSession('s', {
          permissions: {
            policy: {
              preCommand: [{ script: new ScriptSource(JUDGE, 'python'), runtime: 'monty' }],
            },
          },
        }),
      ).toThrow(/not a policy/)
    } finally {
      await ws.close()
    }
  })
})

// Programs at the op and session views and nowhere else: writes under
// /data/frozen and AWS_* variables are refused, and no command is judged.
const FROZEN = `${CONTEXT}
if ctx['write'] and ctx['path'].startswith('/data/frozen/'):
    print(json.dumps({'kind': 'deny', 'reason': 'frozen by ' + ctx['profile']}))
`
const CREDENTIALS = `${CONTEXT}
if ctx['key'].startswith('AWS_'):
    reason = 'credentials are set by the operator'
    print(json.dumps({'kind': 'deny', 'reason': reason}))
`
const GATES = { preVfs: FROZEN, preSession: CREDENTIALS }

describe('profile policies at the op and session views', () => {
  it("judges its session's file calls with the facts of the op", async () => {
    const ws = await build(scripted(GATES))
    try {
      await ws.shell('mkdir -p /data/frozen && echo keep > /data/frozen/k')
      ws.createSession('s', { profile: 'release' })
      // A read is not a write.
      expect(new TextDecoder().decode(await ws.vfs.read('/data/frozen/k', {}, 's'))).toBe('keep\n')
      await expect(ws.vfs.write('/data/frozen/f', 'x\n', 's')).rejects.toThrow()
      await expect(ws.vfs.unlink('/data/frozen/k', 's')).rejects.toThrow()
      expect((await ws.shell('cat /data/frozen/k')).stdoutText).toBe('keep\n')
      // A line's I/O is its commands', which preCommand judges, and this
      // profile has no command program.
      expect((await ws.shell('echo x > /data/frozen/f', { sessionId: 's' })).exitCode).toBe(0)
      // Another session is not judged by it.
      await ws.vfs.write('/data/frozen/g', 'x\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it('judges the session view with the facts of the write', async () => {
    const ws = await build(scripted(GATES))
    try {
      ws.createSession('s', { profile: 'release' })
      const refused = await ws.shell('export AWS_SECRET=x', { sessionId: 's' })
      expect(refused.exitCode).toBe(1)
      expect(refused.stderrText).toBe('AWS_SECRET: permission denied\n')
      expect(refused.refusal?.reason).toBe('credentials are set by the operator')
      const landed = await ws.shell('export SAFE=1 && echo $SAFE', { sessionId: 's' })
      expect(landed.exitCode).toBe(0)
      expect(landed.stdoutText).toBe('1\n')
    } finally {
      await ws.close()
    }
  }, 120000)

  it("a policy's own read passes the dispatcher its op program guards", async () => {
    // The command program opens the operand through the workspace's
    // dispatcher while the op program stands at it: the read is the
    // policy's own and is let through rather than re-entering the run
    // waiting on it, so the content verdict lands and the op program
    // still refuses a write.
    const ws = await build(scripted({ preCommand: READER, preVfs: FROZEN }))
    try {
      await ws.shell(
        "mkdir -p /data/in && printf 'subject: invoice\\n\\na payload\\n' > /data/in/mail.txt && echo plain > /data/in/note.txt",
      )
      ws.createSession('s', { profile: 'release' })
      const held = await ws.shell('cat /data/in/mail.txt', { sessionId: 's' })
      expect(held.exitCode).toBe(126)
      expect(held.refusal).toMatchObject({ kind: 'pending', reason: 'sign-off on payload' })
      expect((await ws.shell('cat /data/in/note.txt', { sessionId: 's' })).exitCode).toBe(0)
      await expect(ws.vfs.write('/data/frozen/f', 'x\n', 's')).rejects.toThrow()
    } finally {
      await ws.close()
    }
  }, 120000)
})

// A judge that reads one fixed file and refuses when it can, so what it
// sees is what the session it judges for may see.
const PEEK = `${CONTEXT}
try:
    body = open('/data/secret/k').read()
    print(json.dumps({'kind': 'deny', 'reason': 'saw ' + body.strip()}))
except OSError:
    pass
`

describe('a profile policy reads as the session it judges for', () => {
  it('cannot see what the session cannot, at admission as at the gate', async () => {
    // A compound line is judged whole at admission, before its tree
    // runs, and that pass runs bound to the line's session the way
    // python binds it before parsing: a path the profile hides is hidden
    // from its own policy's open() too, so the policy has nothing to
    // refuse on. The same program under a profile without the hide reads
    // the file and refuses.
    const policy = { preCommand: [{ script: new ScriptSource(PEEK, 'python'), runtime: 'monty' }] }
    const ws = await build({
      blind: { policy, paths: { hide: ['/data/secret'] } },
      sighted: { policy },
    })
    try {
      await ws.shell('mkdir -p /data/secret && echo k > /data/secret/k')
      ws.createSession('b', { profile: 'blind' })
      ws.createSession('s', { profile: 'sighted' })
      const ran = await ws.shell('echo hi && echo there', { sessionId: 'b' })
      expect(ran.exitCode).toBe(0)
      expect(ran.stdoutText).toBe('hi\nthere\n')
      const denied = await ws.shell('echo hi && echo there', { sessionId: 's' })
      expect(denied.exitCode).toBe(126)
      expect(denied.refusal).toMatchObject({ kind: 'deny', reason: 'saw k' })
    } finally {
      await ws.close()
    }
  }, 120000)
})
