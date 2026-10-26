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
import {
  INTEGRATION_FILES,
  makeIntegrationWS,
  run,
  runExit,
} from '../../tests/workspace/fixtures/integration_fixture.ts'

function fresh(): { ws: Awaited<ReturnType<typeof makeIntegrationWS>>['ws'] } {
  const { ws } = makeIntegrationWS(INTEGRATION_FILES)
  return { ws }
}

describe('integration: nested loops', () => {
  it('nested for with file ops', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'for d in logs data; do for f in $(find /data/$d -type f | sort); do echo "$d: $f"; done; done',
    )
    expect(result).toContain('logs: /data/logs/app.log')
    expect(result).toContain('data: /data/data/scores.csv')
    await ws.close()
  })

  it('for with if and grep', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'for f in $(find /data/logs -type f | sort); do if grep -q ERROR $f; then echo "ERRORS: $f"; fi; done',
    )
    expect(result).toContain('ERRORS: /data/logs/app.log')
    expect(result).not.toContain('ERRORS: /data/logs/access.log')
    await ws.close()
  })

  it('while read with nested if', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'find /data/data -type f | sort | while read f; do if [ "$(wc -l < $f)" -gt 3 ]; then echo "big: $f"; else echo "small: $f"; fi; done',
    )
    const lines = result.trim().split('\n')
    expect(lines.length).toBe(3)
    await ws.close()
  })
})

describe('integration: multi-stage pipelines', () => {
  it('sort | uniq -c | sort -rn | head -n 1', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, 'cat /data/data/words.txt | sort | uniq -c | sort -rn | head -n 1')
    )
      .trim()
      .split(/\s+/)
    expect(result[0]).toBe('3')
    expect(result[1]).toBe('hello')
    await ws.close()
  })

  it('grep | cut | sort | uniq -c | sort -rn', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, "cat /data/logs/access.log | cut -d ' ' -f 1 | sort | uniq -c | sort -rn")
    ).trim()
    const lines = result.split('\n')
    expect(lines.length).toBe(3)
    const first = (lines[0] ?? '').split(/\s+/)
    expect(first[0]).toBe('3')
    expect(first[1]).toBe('GET')
    await ws.close()
  })

  it('five-stage pipeline', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      "cat /data/data/numbers.txt | sort -n | uniq | head -n 3 | tr '\\n' ','",
    )
    expect(result.startsWith('1,2,3')).toBe(true)
    await ws.close()
  })

  it('grep -c ERROR across file', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'grep -c ERROR /data/logs/app.log')).trim()
    expect(result).toBe('2')
    await ws.close()
  })
})

describe('integration: command substitution in pipelines', () => {
  it('$(wc -l < file) inside echo', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'echo "lines: $(wc -l < /data/data/words.txt)"')).trim()
    expect(result).toBe('lines: 7')
    await ws.close()
  })

  it('nested $()', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'echo $(echo $(echo deep))')).trim()
    expect(result).toBe('deep')
    await ws.close()
  })

  it('$(grep | cut) inside for', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'for line in $(grep ERROR /data/logs/app.log | cut -d \' \' -f 1); do echo "date:$line"; done',
    )
    expect(result).toContain('date:2026-01-02')
    expect(result).toContain('date:2026-01-05')
    await ws.close()
  })

  it('$(...) inside if test', async () => {
    const { ws } = fresh()
    const result = (
      await run(
        ws,
        'if [ $(grep -c ERROR /data/logs/app.log) -gt 1 ]; then echo many_errors; else echo few_errors; fi',
      )
    ).trim()
    expect(result).toBe('many_errors')
    await ws.close()
  })
})

describe('integration: while read with processing', () => {
  it('while read with transform', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'echo -e \'alice\\nbob\\ncharlie\' | while read name; do echo "user:$name"; done',
    )
    const lines = result.trim().split('\n')
    expect(lines).toEqual(['user:alice', 'user:bob', 'user:charlie'])
    await ws.close()
  })

  it('while read pipe to wc', async () => {
    const { ws } = fresh()
    const result = (
      await run(
        ws,
        'grep ERROR /data/logs/app.log | while read line; do echo "ALERT: $line"; done | wc -l',
      )
    ).trim()
    expect(result).toBe('2')
    await ws.close()
  })

  it('while read with grep filter', async () => {
    const { ws } = fresh()
    const result = (
      await run(
        ws,
        'cat /data/logs/access.log | while read line; do echo $line; done | grep 200 | wc -l',
      )
    ).trim()
    expect(result).toBe('3')
    await ws.close()
  })
})

describe('integration: subshell and grouping', () => {
  it('subshell pipe chain', async () => {
    const { ws } = fresh()
    const result = await run(ws, '(echo hello; echo world) | sort | tr a-z A-Z')
    const lines = result.trim().split('\n')
    expect(lines).toEqual(['HELLO', 'WORLD'])
    await ws.close()
  })

  it('brace group redirect', async () => {
    const { ws } = fresh()
    const result = await run(ws, '{ echo first; echo second; } > /data/out.txt; cat /data/out.txt')
    expect(result).toBe('first\nsecond\n')
    await ws.close()
  })

  it('subshell variable isolation', async () => {
    const { ws } = fresh()
    const result = await run(ws, 'export X=outer; (export X=inner; echo $X); echo $X')
    const lines = result.trim().split('\n')
    expect(lines).toEqual(['inner', 'outer'])
    await ws.close()
  })

  it('subshell function def does not leak', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      '(only_inner() { echo inner; }); only_inner 2>/dev/null || echo gone',
    )
    expect(result.trim()).toBe('gone')
    await ws.close()
  })

  it('subshell function redefinition is isolated', async () => {
    const { ws } = fresh()
    const result = await run(ws, 'greet() { echo outer; }; (greet() { echo inner; }; greet); greet')
    expect(result.trim().split('\n')).toEqual(['inner', 'outer'])
    await ws.close()
  })

  it('subshell inherits parent functions', async () => {
    const { ws } = fresh()
    expect((await run(ws, 'greet() { echo hi; }; (greet)')).trim()).toBe('hi')
    await ws.close()
  })

  it('subshell positional params are isolated', async () => {
    const { ws } = fresh()
    expect((await run(ws, 'set -- a b c; (set -- x); echo $# $1')).trim()).toBe('3 a')
    await ws.close()
  })

  it('subshell inherits parent positional params', async () => {
    const { ws } = fresh()
    expect((await run(ws, 'set -- a b; (echo $1 $2)')).trim()).toBe('a b')
    await ws.close()
  })
})

describe('integration: functions with pipelines', () => {
  it('function in pipeline', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'upper() { tr a-z A-Z; }; echo hello | upper')).trim()
    expect(result).toBe('HELLO')
    await ws.close()
  })

  it('function with args in loop (classify files)', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'classify() { case $1 in *.py) echo "python: $1";; *.txt) echo "text: $1";; *.json) echo "json: $1";; *.csv) echo "csv: $1";; *.log) echo "log: $1";; *) echo "other: $1";; esac; }; find /data -type f | sort | while read f; do classify $f; done',
    )
    expect(result).toContain('python: /data/src/main.py')
    expect(result).toContain('json: /data/config.json')
    expect(result).toContain('log: /data/logs/app.log')
    expect(result).toContain('csv: /data/data/scores.csv')
    await ws.close()
  })
})

describe('integration: conditional chains (&&, ||)', () => {
  it('grep -q && echo || echo', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, "grep -q ERROR /data/logs/app.log && echo 'has errors' || echo 'clean'")
    ).trim()
    expect(result).toBe('has errors')
    await ws.close()
  })

  it('or fallback when no match', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, "grep -q FATAL /data/logs/app.log && echo 'has fatal' || echo 'no fatal'")
    ).trim()
    expect(result).toBe('no fatal')
    await ws.close()
  })

  it('chained conditionals', async () => {
    const { ws } = fresh()
    const result = (
      await run(
        ws,
        "grep -q ERROR /data/logs/app.log && grep -q INFO /data/logs/app.log && echo 'has both'",
      )
    ).trim()
    expect(result).toBe('has both')
    await ws.close()
  })
})

describe('integration: redirects combined with pipes', () => {
  it('pipe with output redirect', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'grep ERROR /data/logs/app.log | sort > /data/errors.txt; cat /data/errors.txt',
    )
    const lines = result.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines).toEqual([...lines].sort())
    await ws.close()
  })

  it('append redirect in for loop', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'for x in one two three; do echo $x >> /data/result.txt; done; cat /data/result.txt',
    )
    expect(result).toBe('one\ntwo\nthree\n')
    await ws.close()
  })

  it('stdin redirect in pipeline', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'sort < /data/data/numbers.txt | uniq | wc -l')).trim()
    expect(result).toBe('7')
    await ws.close()
  })
})

describe('integration: process substitution', () => {
  it('cat <(echo hello)', async () => {
    const { ws } = fresh()
    const result = await run(ws, 'cat <(echo hello)')
    expect(result).toContain('hello')
    await ws.close()
  })
})

describe('integration: sed and tr pipelines', () => {
  it('sed in pipeline', async () => {
    const { ws } = fresh()
    const result = await run(ws, "cat /data/logs/app.log | grep ERROR | sed 's/ERROR/CRITICAL/'")
    expect(result).toContain('CRITICAL')
    expect(result).not.toContain('ERROR')
    await ws.close()
  })

  it('tr multiple transforms', async () => {
    const { ws } = fresh()
    const result = (await run(ws, "echo 'Hello World' | tr A-Z a-z | tr ' ' '_'")).trim()
    expect(result).toBe('hello_world')
    await ws.close()
  })
})

describe('integration: complex real-world patterns', () => {
  it('log analysis pipeline', async () => {
    const { ws } = fresh()
    const result = (
      await run(
        ws,
        "cat /data/logs/app.log | grep -v INFO | cut -d ' ' -f 2 | sort | uniq -c | sort -rn",
      )
    ).trim()
    const first = (result.split('\n')[0] ?? '').split(/\s+/)
    expect(first[0]).toBe('2')
    expect(first[1]).toBe('ERROR')
    await ws.close()
  })

  it('find + grep + count pattern', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'find /data/src -name \'*.py\' -type f | sort | while read f; do echo "$(grep -c import $f) $f"; done',
    )
    expect(result).toContain('2 /data/src/main.py')
    await ws.close()
  })

  it('csv processing pipeline', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, 'cat /data/data/scores.csv | sort -t, -k2 -rn | head -n 1 | cut -d, -f1')
    ).trim()
    expect(result).toBe('bob')
    await ws.close()
  })

  it('word frequency full pipeline', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'cat /data/data/words.txt | sort | uniq -c | sort -rn | while read count word; do echo "$word appears $count times"; done | head -n 2',
    )
    const lines = result.trim().split('\n')
    expect(lines[0]).toContain('hello appears 3 times')
    expect(lines[1]).toContain('foo appears 2 times')
    await ws.close()
  })

  it('while read with command sub body', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'find /data -name \'*.py\' -type f | sort | while read f; do echo "$f: $(wc -l < $f) lines"; done',
    )
    expect(result).toContain('/data/src/main.py: 3 lines')
    expect(result).toContain('/data/src/utils.py: 2 lines')
    await ws.close()
  })

  it('multiline script with function and loop', async () => {
    const { ws } = fresh()
    const result = await run(
      ws,
      'count_matches() { grep -c $1 $2; }; find /data/logs -type f | sort | while read f; do echo "$f: $(count_matches ERROR $f) errors"; done',
    )
    expect(result).toContain('/data/logs/app.log: 2 errors')
    expect(result).toContain('/data/logs/access.log: 0 errors')
    await ws.close()
  })
})

describe('integration: edge cases', () => {
  it('empty file in pipeline', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'cat /data/empty.txt | wc -l')).trim()
    expect(result).toBe('0')
    await ws.close()
  })

  it('while read with empty input', async () => {
    const { ws } = fresh()
    const result = (
      await run(ws, 'cat /data/empty.txt | while read line; do echo "got: $line"; done; echo done')
    ).trim()
    expect(result).toBe('done')
    await ws.close()
  })

  it('deeply nested command sub', async () => {
    const { ws } = fresh()
    const result = (await run(ws, 'echo $(echo $(echo $(echo nested)))')).trim()
    expect(result).toBe('nested')
    await ws.close()
  })

  it('pipe exit code: last command fails', async () => {
    const { ws } = fresh()
    expect(await runExit(ws, 'echo hello | grep world')).not.toBe(0)
    await ws.close()
  })

  it('pipe exit code: last command succeeds', async () => {
    const { ws } = fresh()
    expect(await runExit(ws, 'echo hello | grep hello')).toBe(0)
    await ws.close()
  })
})
