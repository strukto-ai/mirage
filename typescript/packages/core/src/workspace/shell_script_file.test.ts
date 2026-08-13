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
import { makeIntegrationWS, run, runExit, runResult } from './fixtures/integration_fixture.ts'

describe('sh/bash script file', () => {
  it.each(['sh', 'bash'])('%s runs the lines of a script file', async (head) => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo one\necho two\n' })
    try {
      expect(await run(ws, `${head} /data/run.sh`)).toBe('one\ntwo\n')
    } finally {
      await ws.close()
    }
  })

  it('resolves the script file against the working directory', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await run(ws, 'cd /data; sh run.sh')).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('takes a script file after --', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await run(ws, 'bash -- /data/run.sh')).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('passes operands to the script as positional parameters', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo $# $1 $2\n' })
    try {
      expect(await run(ws, 'sh /data/run.sh a b')).toBe('2 a b\n')
    } finally {
      await ws.close()
    }
  })

  it('stops parsing options at the script file', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo "$@"\n' })
    try {
      expect(await run(ws, 'sh /data/run.sh -c foo')).toBe('-c foo\n')
    } finally {
      await ws.close()
    }
  })

  it('sets $0 to the script file', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo $0\n' })
    try {
      expect(await run(ws, 'sh /data/run.sh')).toBe('/data/run.sh\n')
    } finally {
      await ws.close()
    }
  })

  it('restores $0 and the positional parameters afterwards', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo inner $1\n' })
    try {
      const out = await run(ws, 'set -- outer; sh /data/run.sh inner-arg; echo $0 $1')
      expect(out).toBe('inner inner-arg\nmirage outer\n')
    } finally {
      await ws.close()
    }
  })

  it('propagates the script exit status', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'exit 7\n' })
    try {
      expect(await runExit(ws, 'sh /data/run.sh')).toBe(7)
    } finally {
      await ws.close()
    }
  })

  it.each(['sh', 'bash'])('%s reports a missing script and exits 127', async (head) => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(ws, `${head} /data/nope.sh`)
      expect(err).toBe(`${head}: /data/nope.sh: No such file or directory\n`)
      expect(code).toBe(127)
    } finally {
      await ws.close()
    }
  })

  it('reports a directory operand and exits 126', async () => {
    const { ws } = await makeIntegrationWS({ 'sub/keep.txt': 'x\n' })
    try {
      const [code, , err] = await runResult(ws, 'sh /data/sub')
      expect(err).toBe('/data/sub: /data/sub: Is a directory\n')
      expect(code).toBe(126)
    } finally {
      await ws.close()
    }
  })

  it('traces the script under -x', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      const [code, out, err] = await runResult(ws, 'bash -x /data/run.sh')
      expect(out).toBe('hi\n')
      expect(err).toBe('+ echo hi\n')
      expect(code).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('does not leak -x into the caller', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      const [, , err] = await runResult(ws, 'bash -x /data/run.sh; echo after')
      expect(err).toBe('+ echo hi\n')
    } finally {
      await ws.close()
    }
  })

  it('still runs inline text under -c', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "sh -c 'echo hello'")).toBe('hello\n')
    } finally {
      await ws.close()
    }
  })

  it('takes a name and positional parameters after -c', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "sh -c 'echo $0 $# $1 $2' myname a b")).toBe('myname 2 a b\n')
    } finally {
      await ws.close()
    }
  })

  it('names the head word when -c has no argument', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(ws, 'sh -c')
      expect(err).toBe('sh: -c: option requires an argument\n')
      expect(code).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('applies the option named by -o', async () => {
    const { ws } = await makeIntegrationWS({ 'pf.sh': 'false | true\necho pipefail=$?\n' })
    try {
      expect(await run(ws, 'bash -o pipefail /data/pf.sh')).toBe('pipefail=1\n')
    } finally {
      await ws.close()
    }
  })

  it('applies -o from inside a cluster', async () => {
    const { ws } = await makeIntegrationWS({ 'pf.sh': 'false | true\necho pipefail=$?\n' })
    try {
      const [code, out, err] = await runResult(ws, 'bash -xo pipefail /data/pf.sh')
      expect(out).toBe('pipefail=1\n')
      expect(err).toBe('+ false\n+ true\n+ echo pipefail=1\n')
      expect(code).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('reads a + word as an option, not as the script', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await runResult(ws, 'bash +x /data/run.sh')).toEqual([0, 'hi\n', ''])
      expect(await runResult(ws, 'bash +o xtrace /data/run.sh')).toEqual([0, 'hi\n', ''])
    } finally {
      await ws.close()
    }
  })

  it('ends option parsing at a single dash', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await run(ws, 'bash - /data/run.sh')).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('lets a long option consume its value', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await runResult(ws, 'bash --rcfile /data/run.sh')).toEqual([0, '', ''])
    } finally {
      await ws.close()
    }
  })

  it('refuses an unknown long option', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      const [code, , err] = await runResult(ws, 'bash --nosuch /data/run.sh')
      expect(err).toBe('bash: --nosuch: unsupported option\n')
      expect(code).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('reads the program from stdin when no operand names one', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "echo 'echo hi' | bash")).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps every operand positional under -s', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "echo 'echo zero=$0 one=$1' | bash -s A B")).toBe('zero=bash one=A\n')
    } finally {
      await ws.close()
    }
  })

  it('does not leak the working directory out of a nested shell', async () => {
    const { ws } = await makeIntegrationWS({
      'cd.sh': 'cd /data/sub\n',
      'sub/keep.txt': 'x\n',
    })
    try {
      expect(await run(ws, 'cd /data; bash /data/cd.sh; pwd')).toBe('/data\n')
    } finally {
      await ws.close()
    }
  })

  it('does not leak an export out of a nested shell', async () => {
    const { ws } = await makeIntegrationWS({ 'exp.sh': 'export LEAK=1\n' })
    try {
      expect(await run(ws, 'bash /data/exp.sh; echo [$LEAK]')).toBe('[]\n')
    } finally {
      await ws.close()
    }
  })

  it('does not leak a shell option out of a nested shell', async () => {
    const { ws } = await makeIntegrationWS({ 'opt.sh': 'set -f\n', 'a.txt': 'x\n' })
    try {
      expect(await run(ws, 'bash /data/opt.sh; echo /data/*.txt')).toBe('/data/a.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps a sourced shell option set in the caller', async () => {
    const { ws } = await makeIntegrationWS({ 'opt.sh': 'set -f\n', 'a.txt': 'x\n' })
    try {
      expect(await run(ws, 'source /data/opt.sh; echo /data/*.txt')).toBe('/data/*.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('reports a file source cannot read, as typed', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(ws, 'cd /data; source nope.sh')
      expect(err).toBe('source: nope.sh: No such file or directory\n')
      expect(code).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('reports a directory operand to source', async () => {
    const { ws } = await makeIntegrationWS({ 'sub/keep.txt': 'x\n' })
    try {
      const [code, , err] = await runResult(ws, 'source /data/sub')
      expect(err).toBe('source: /data/sub: Is a directory\n')
      expect(code).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('refuses source with no operand', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, out, err] = await runResult(ws, 'source; echo after=$?')
      expect(err).toBe(
        'source: filename argument required\nsource: usage: source filename [arguments]\n',
      )
      expect(out).toBe('after=2\n')
      expect(code).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each(['sh', 'bash', 'source'])('%s follows a symlinked script operand', async (head) => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await run(ws, `ln -s /data/run.sh /data/link.sh; ${head} /data/link.sh`)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('follows a relative symlinked script operand', async () => {
    const { ws } = await makeIntegrationWS({ 'run.sh': 'echo hi\n' })
    try {
      expect(await run(ws, 'ln -s run.sh /data/rel.sh; sh /data/rel.sh')).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })

  it('reports the link for a broken symlinked script operand', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(
        ws,
        'ln -s /data/gone.sh /data/dead.sh; sh /data/dead.sh',
      )
      expect(err).toBe('sh: /data/dead.sh: No such file or directory\n')
      expect(code).toBe(127)
    } finally {
      await ws.close()
    }
  })

  it('keeps return invalid in a child shell run from a sourced file', async () => {
    const { ws } = await makeIntegrationWS({
      'child.sh': 'return 5\necho child-after\n',
      'lib.sh': 'bash /data/child.sh\necho after=$?\n',
    })
    try {
      const [code, out, err] = await runResult(ws, 'source /data/lib.sh; echo done')
      expect(out).toBe('child-after\nafter=0\ndone\n')
      expect(err).toBe("return: can only `return' from a function or sourced script\n")
      expect(code).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('keeps return valid in the sourced file itself', async () => {
    const { ws } = await makeIntegrationWS({ 'child.sh': 'return 5\necho child-after\n' })
    try {
      expect(await run(ws, 'source /data/child.sh; echo after=$?')).toBe('after=5\n')
    } finally {
      await ws.close()
    }
  })
})
