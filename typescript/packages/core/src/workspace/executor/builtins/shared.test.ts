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

import { describe, expect, it } from 'vitest'
import { IOResult } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { PolicyDenied } from '../../../policy/errors.ts'
import { ArithError } from '../../../shell/errors.ts'
import { Namespace } from '../../mount/namespace/namespace.ts'
import type { ResolveFn } from '../../dispatcher/index.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { SessionState } from '../../session/session.ts'
import { sessionView } from '../../session/state.ts'
import { IDENTIFIER_RE } from './constants.ts'
import {
  absPath,
  arithRefusal,
  expandOperands,
  fail,
  finish,
  isCountWord,
  isValidName,
  ok,
  operandText,
  readOnlyError,
  readonlyRefusal,
  refusal,
  splitFlags,
  splitValueFlags,
  requireView,
} from './shared.ts'

const DEC = new TextDecoder()

function stderrOf(io: IOResult): string {
  return io.stderr === null ? '' : DEC.decode(io.stderr as Uint8Array)
}

describe('builtins/shared: the result triple', () => {
  it('ok carries stdout and a clean node', () => {
    const [out, io, node] = ok('ln', new TextEncoder().encode('x\n'))
    expect(out === null ? '' : DEC.decode(out as Uint8Array)).toBe('x\n')
    expect(io.exitCode).toBe(0)
    expect(node.command).toBe('ln')
    expect(node.exitCode).toBe(0)
    expect(node.stderr).toEqual(new Uint8Array())
  })

  it('fail puts the message on both the IOResult and the node', () => {
    const [out, io, node] = fail('chmod', 'chmod: missing operand\n', 2)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(stderrOf(io)).toBe('chmod: missing operand\n')
    expect(node.exitCode).toBe(2)
    expect(DEC.decode(node.stderr)).toBe('chmod: missing operand\n')
  })

  it('finish with no errors keeps the carried writes and exits 0', () => {
    const io = new IOResult({ writes: { '/data/f.txt': new Uint8Array() } })
    const [out, resultIo, node] = finish('touch', [], io)
    expect(out).toBeNull()
    expect(resultIo.exitCode).toBe(0)
    expect(Object.keys(resultIo.writes)).toEqual(['/data/f.txt'])
    expect(node.exitCode).toBe(0)
    expect(node.stderr).toEqual(new Uint8Array())
  })

  it('finish joins the operand errors and exits 1', () => {
    const [, io, node] = finish('chown', ['a\n', 'b\n'])
    expect(io.exitCode).toBe(1)
    expect(stderrOf(io)).toBe('a\nb\n')
    expect(DEC.decode(node.stderr)).toBe('a\nb\n')
  })
})

describe('builtins/shared: operands and flags', () => {
  it('operandText unwraps a PathSpec the classifier wrapped', () => {
    expect(operandText(PathSpec.fromStrPath('/data/644'))).toBe('/data/644')
    expect(operandText('644')).toBe('644')
  })

  it('absPath resolves a relative operand against the cwd', () => {
    expect(absPath(PathSpec.fromStrPath('/data/f.txt'), '/tmp')).toBe('/data/f.txt')
    expect(absPath('f.txt', '/data')).toBe('/data/f.txt')
  })

  it('splitFlags collects known letters', () => {
    const [flags, operands] = splitFlags(['-sf', 'a', 'b'], 'sfnv')
    expect([...flags].sort()).toEqual(['f', 's'])
    expect(operands).toEqual(['a', 'b'])
  })

  it('splitFlags keeps a token with an unknown letter as an operand', () => {
    const [flags, operands] = splitFlags(['-q', 'a'], 'sfnv')
    expect(flags.size).toBe(0)
    expect(operands).toEqual(['-q', 'a'])
  })

  it('splitFlags stops parsing at --', () => {
    const [flags, operands] = splitFlags(['-s', '--', '-f'], 'sfnv')
    expect([...flags]).toEqual(['s'])
    expect(operands).toEqual(['-f'])
  })

  it('splitValueFlags takes a detached value', () => {
    const { flags, values, operands, bad } = splitValueFlags(
      ['-c', '-t', '202601021530', 'f.txt'],
      'acmh',
      'tdr',
    )
    expect(bad).toBeNull()
    expect([...flags]).toEqual(['c'])
    expect(values.get('t')).toBe('202601021530')
    expect(operands).toEqual(['f.txt'])
  })

  it('splitValueFlags takes an attached value', () => {
    const { values, operands, bad } = splitValueFlags(['-t202601021530', 'f'], 'acmh', 'tdr')
    expect(bad).toBeNull()
    expect(values.get('t')).toBe('202601021530')
    expect(operands).toEqual(['f'])
  })

  it('splitValueFlags reports an unknown letter', () => {
    const { bad } = splitValueFlags(['-q', 'f'], 'Rvf', '')
    expect(bad).toBe('q')
  })
})

describe('builtins/shared: expandOperands', () => {
  it('expands a pattern per mount and passes a plain path through', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    await ws.shell('echo a > /data/a.txt && echo b > /data/b.txt')
    const globSpec = new PathSpec({
      virtual: '/data/*.txt',
      directory: '/data/',
      pattern: '*.txt',
      resolved: false,
      vfsPath: '*.txt',
    })
    const expanded = await expandOperands(ws.namespace, [globSpec, '/data/c.md'])
    expect(expanded.map((p) => p.virtual).sort()).toEqual([
      '/data/a.txt',
      '/data/b.txt',
      '/data/c.md',
    ])
    await ws.close()
  })
})

describe('builtins/shared: the session helpers', () => {
  it('requireView returns the threaded view', () => {
    const session = new SessionState({ sessionId: 's1' })
    const view = sessionView(session)
    expect(requireView(view)).toBe(view)
  })

  it('requireView refuses a missing view', () => {
    expect(() => requireView(null)).toThrow(/gated session view/)
  })

  it('refusal speaks in the builtin voice', () => {
    const [out, io, node] = refusal('export', new PolicyDenied('X: refused', 'X'))
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(stderrOf(io)).toBe('X: refused\n')
    expect(node.command).toBe('export')
  })

  it('readonlyRefusal names the variable', () => {
    const [out, io, node] = readonlyRefusal('read', 'X')
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(stderrOf(io)).toBe('bash: X: readonly variable\n')
    expect(node.command).toBe('read')
  })

  it('arithRefusal prefixes the builtin', () => {
    const [out, io, node] = arithRefusal('let', new ArithError('1+: syntax error'))
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(stderrOf(io)).toBe('bash: let: 1+: syntax error\n')
    expect(node.command).toBe('let')
  })

  it('isValidName / isCountWord', () => {
    expect(isValidName('_x9')).toBe(true)
    expect(isValidName('9x')).toBe(false)
    expect(isValidName('a-b')).toBe(false)
    expect(isValidName('')).toBe(false)
    expect(IDENTIFIER_RE.test('abc')).toBe(true)
    expect(isCountWord('3')).toBe(true)
    expect(isCountWord('-3')).toBe(true)
    expect(isCountWord('+3')).toBe(true)
    expect(isCountWord('x')).toBe(false)
    expect(isCountWord('-')).toBe(false)
  })
  it('readOnlyError names the owning mount', () => {
    // The one voice for a mode refusal, whichever tier reached it: the
    // command tier renders this line for a backend operand and the node
    // table renders it for a symlink, so `rm f.txt` and `rm lk` under one
    // read grant answer identically.
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const owned = PathSpec.fromStrPath('/data/lk')
    expect(readOnlyError('rm', ws.namespace, owned)).toBe('rm: read-only mount at /data/\n')
  })

  it('readOnlyError falls back to GNUs phrase with no mount', () => {
    // No prefix to blame, so it does not invent one. Inside a workspace
    // this is unreachable -- a "/" mount is always synthesized, and that
    // root is what governs a path above every other mount -- so the
    // branch belongs to a namespace built without one.
    const unusedResolve: ResolveFn = () => Promise.reject(new Error('unused'))
    const ns = new Namespace(new MountRegistry({}, MountMode.WRITE), unusedResolve)
    expect(ns.tryMountFor('/top')).toBe(null)
    expect(readOnlyError('ln', ns, PathSpec.fromStrPath('/top'))).toBe(
      'ln: /top: Read-only file system\n',
    )
  })
})
