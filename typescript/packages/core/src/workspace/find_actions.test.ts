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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { compareDepthFirst } from './executor/find_action_dispatch.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

async function singleMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  ops.registerResource(root)
  return new Workspace({ '/': root }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

async function twoMountWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const a = new RAMResource()
  const b = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(a)
  ops.registerResource(b)
  return new Workspace(
    { '/': root, '/a': a, '/b': b },
    { mode: MountMode.WRITE, ops, shellParser: parser },
  )
}

async function setupHtmlFiles(ws: Workspace): Promise<void> {
  ws.createSession('s')
  await ws.execute('mkdir -p /a/b', { sessionId: 's' })
  await ws.execute('touch /foo.html /bar.htm /a/b/baz.html', { sessionId: 's' })
}

const MUTATE = 'sh -c \'echo "$KEEP:$PWD"; KEEP=child; cd /\''
const MUTATE_EXIT = "sh -c 'KEEP=child; cd /; exit 7'"
const BATCH = "sh -c 'KEEP=child; cd /; set -- child; set -u'"

describe('find action layer', () => {
  describe('-delete', () => {
    it('removes matched files', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -delete", { sessionId: 's' })
      expect(r.exitCode).toBe(0)
      expect(r.stdoutText).toBe('')
      const after = await ws.execute("find / -name '*.html'", { sessionId: 's' })
      expect(after.stdoutText).toBe('')
      const htm = await ws.execute("find / -name '*.htm'", { sessionId: 's' })
      expect(htm.stdoutText).toContain('/bar.htm')
    })

    it('is silent unless -print is also given', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -delete", { sessionId: 's' })
      expect(r.stdoutText).toBe('')
    })

    it('emits matches when -print -delete is combined', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -print -delete", {
        sessionId: 's',
      })
      const out = r.stdoutText
      expect(out).toContain('/foo.html')
      expect(out).toContain('/a/b/baz.html')
    })

    it('skips mount roots', async () => {
      const ws = await twoMountWs()
      ws.createSession('s')
      await ws.execute('touch /a/x.html /b/y.html', { sessionId: 's' })
      // Without -name, /a and /b appear as synthetic dir entries.
      // -delete must skip them.
      await ws.execute('find / -type d -delete', { sessionId: 's' })
      const ls = await ws.execute('ls /', { sessionId: 's' })
      const out = ls.stdoutText
      expect(out).toContain('a')
      expect(out).toContain('b')
    })

    it('orders deepest-first so children clear before parents', async () => {
      const ws = await singleMountWs()
      ws.createSession('s')
      await ws.execute('mkdir -p /tmp/a/b', { sessionId: 's' })
      await ws.execute('touch /tmp/a/b/file.txt', { sessionId: 's' })
      const r = await ws.execute("find /tmp -name '*.txt' -delete", {
        sessionId: 's',
      })
      expect(r.exitCode).toBe(0)
    })

    it('removes directories emptied by the deepest-first pass', async () => {
      const ws = await singleMountWs()
      ws.createSession('s')
      await ws.execute('mkdir -p /tree/deep', { sessionId: 's' })
      await ws.execute('touch /tree/deep/f.txt', { sessionId: 's' })
      const r = await ws.execute('find /tree -delete', { sessionId: 's' })
      expect(r.exitCode).toBe(0)
      expect(r.stderrText).toBe('')
      const after = await ws.execute('find / -name tree', { sessionId: 's' })
      expect(after.stdoutText).toBe('')
    })
  })

  describe('-print0', () => {
    it('separates matches with NUL bytes', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -print0", { sessionId: 's' })
      const out = r.stdoutText
      expect(out).toContain('\x00')
      // No newlines outside the NUL separators.
      expect(out.split('\x00').join('')).not.toContain('\n')
      expect(out.endsWith('\x00')).toBe(true)
    })
  })

  describe('-ls', () => {
    it("renders find's own layout per match", async () => {
      // GNU findutils 4.10 `-ls` is not `ls -l`: inode and 1K blocks
      // lead, and every column has a fixed width (inode 9, blocks 6,
      // links 3, owner and group 8 left-aligned, size 8). A VFS has
      // neither an inode nor a block allocation, so those two columns
      // carry `?`, the answer `stat %i` and `%b` already give.
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html' -ls", { sessionId: 's' })
      const lines = r.stdoutText.split('\n').filter((l) => l !== '')
      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) {
        expect(line).toMatch(
          /^ {8}\? {6}\? -rw-r--r-- {3}1 - {8}- {8} {7}\d [A-Z][a-z]{2} [ \d]\d \d\d:\d\d \/.*\.html$/,
        )
      }
    })
  })

  describe('-depth across start points', () => {
    it('orders each start point on its own', async () => {
      // GNU findutils 4.10 walks each start point to completion, so
      // `find b a -depth` is b's tree post-order, then a's: one sort
      // over every row put a's tree first, and -delete removed in that
      // order.
      const ws = await singleMountWs()
      try {
        await ws.execute('mkdir -p /w/b /w/a; printf x > /w/b/x; printf y > /w/a/y; cd /w')
        const out = async (line: string) => {
          const io = await ws.execute(line)
          return [io.stdoutText, io.stderrText, io.exitCode]
        }
        expect(await out('find b a -depth')).toEqual(['b/x\nb\na/y\na\n', '', 0])
        expect(await out('find b a -depth -print -delete')).toEqual(['b/x\nb\na/y\na\n', '', 0])
        expect(await out('test -e a -o -e b')).toEqual(['', '', 1])
      } finally {
        await ws.close()
      }
    })

    it('orders a trailing-slash start point after its tree', async () => {
      // `find d/` prints its root as `d/` and the rest as `d/a`; the
      // slash left an empty final component that sorted the directory
      // first, so `find d/ -delete` refused the non-empty directory.
      const ws = await singleMountWs()
      try {
        await ws.execute(
          'mkdir -p /w/d/sub; printf a > /w/d/a.txt; printf x > /w/d/sub/c.txt; cd /w',
        )
        const out = async (line: string) => {
          const io = await ws.execute(line)
          return [io.stdoutText, io.stderrText, io.exitCode]
        }
        expect(await out('find d/ -depth')).toEqual(['d/a.txt\nd/sub/c.txt\nd/sub\nd/\n', '', 0])
        expect(await out('find d/ -delete')).toEqual(['', '', 0])
        expect(await out('test -e d')).toEqual(['', '', 1])
      } finally {
        await ws.close()
      }
    })

    it('drops a trailing slash from the depth key', () => {
      expect(compareDepthFirst('d/a', 'd/')).toBeLessThan(0)
      expect(compareDepthFirst('/a', '/')).toBeLessThan(0)
      expect(compareDepthFirst('d/', 'd')).toBe(0)
    })

    it('walks a nested or repeated start point on its own', async () => {
      // GNU findutils 4.10 finishes `d` before it begins `d/sub` again,
      // and walks a repeated start point twice; the rows arrive as one
      // run per start point, so no sort can fold the two together.
      const ws = await singleMountWs()
      try {
        await ws.execute(
          'mkdir -p /w/d/sub; printf a > /w/d/a.txt; printf x > /w/d/sub/c.txt; cd /w',
        )
        const out = async (line: string) => {
          const io = await ws.execute(line)
          return [io.stdoutText, io.stderrText, io.exitCode]
        }
        const post = 'd/a.txt\nd/sub/c.txt\nd/sub\nd\n'
        expect(await out('find d d/sub -depth -print')).toEqual([
          post + 'd/sub/c.txt\nd/sub\n',
          '',
          0,
        ])
        expect(await out('find d d -depth')).toEqual([post + post, '', 0])
        expect(await out('find d d/sub -depth -exec echo saw {} \\;')).toEqual([
          (post + 'd/sub/c.txt\nd/sub\n')
            .split('\n')
            .filter((r) => r !== '')
            .map((r) => `saw ${r}\n`)
            .join(''),
          '',
          0,
        ])
      } finally {
        await ws.close()
      }
    })

    it('does not see a shell-only builtin under -exec', async () => {
      // GNU findutils 4.10 finds `echo`, `true`, `printf`, `test` and the
      // like through execvp, since coreutils ships them, and nothing the
      // shell alone defines: `cd`, `export`, `read` are `No such file or
      // directory` per match, exit 0.
      const ws = await singleMountWs()
      try {
        await ws.execute('mkdir -p /w/d; cd /w')
        const io = await ws.execute('find d -maxdepth 0 -exec cd {} \\;; echo rc=$?')
        expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([
          'rc=0\n',
          "find: 'cd': No such file or directory\n",
          0,
        ])
        const mixed = await ws.execute(
          'find d -maxdepth 0 -exec export X=1 \\;; find d -maxdepth 0 -exec echo hi {} \\;',
        )
        expect([mixed.stdoutText, mixed.stderrText]).toEqual([
          'hi d\n',
          "find: 'export': No such file or directory\n",
        ])
      } finally {
        await ws.close()
      }
    })

    it('does not see a shell function under -exec', async () => {
      // GNU findutils 4.10 execs the head through execvp, which sees no
      // shell function: `find: 'f': No such file or directory` per match,
      // exit 0, and the function never runs.
      const ws = await singleMountWs()
      try {
        await ws.execute('mkdir -p /w/d; cd /w')
        const io = await ws.execute(
          'f() { echo BAD; }; find d -maxdepth 0 -exec f {} \\;; echo rc=$?',
        )
        expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([
          'rc=0\n',
          "find: 'f': No such file or directory\n",
          0,
        ])
      } finally {
        await ws.close()
      }
    })

    it('escapes an -ls name as findutils does', async () => {
      // GNU findutils 4.10 `-ls` keeps one row on one line: a space, a
      // backslash and a double quote take a backslash, a newline is
      // `\n`, and a byte outside ASCII is octal; `-print` stays raw.
      const ws = await singleMountWs()
      try {
        await ws.execute(
          "mkdir -p /w/d; touch 'd/a b' 'd/c\\d' 'd/e\"f' \"d/n\nl\" 'd/ü' 2>/dev/null; cd /w; touch 'd/a b' 'd/c\\d' 'd/e\"f' \"d/n\nl\" 'd/ü'; ln -s 'a b' 'd/li nk'",
        )
        const io = await ws.execute('find d -mindepth 1 -ls | sort')
        expect([io.stderrText, io.exitCode]).toEqual(['', 0])
        const names = io.stdoutText
          .split('\n')
          .filter((r) => r !== '')
          .map((row) => row.replace(/^.*? \d\d:\d\d /, ''))
          .sort()
        expect(names).toEqual(
          [
            'd/a\\ b',
            'd/c\\\\d',
            'd/e\\"f',
            'd/li\\ nk -> a\\ b',
            'd/n\\nl',
            'd/\\303\\274',
          ].sort(),
        )
        expect((await ws.execute("find d -name 'a b'")).stdoutText).toBe('d/a b\n')
      } finally {
        await ws.close()
      }
    })
  })

  describe('default behavior', () => {
    it('find without action flags is unchanged', async () => {
      const ws = await singleMountWs()
      await setupHtmlFiles(ws)
      const r = await ws.execute("find / -name '*.html'", { sessionId: 's' })
      const out = r.stdoutText
      expect(out).toContain('/foo.html')
      expect(out).toContain('/a/b/baz.html')
      expect(out).not.toContain('\x00')
    })
  })

  describe('synthetic mount entries', () => {
    it('honors -name on mount roots', async () => {
      const ws = await twoMountWs()
      ws.createSession('s')
      const r = await ws.execute("find / -name 'a' -type d", { sessionId: 's' })
      const lines = r.stdoutText
        .trim()
        .split('\n')
        .filter((l) => l !== '')
      expect(lines).toContain('/a')
      expect(lines).not.toContain('/b')
    })
  })
})

describe('find -exec isolation', () => {
  for (const terminator of ['\\;', '{} +']) {
    const actions =
      terminator === '{} +'
        ? [BATCH, MUTATE, MUTATE_EXIT]
        : [
            "sh -c 'cd /'",
            "sh -c 'unset KEEP'",
            "sh -c 'export KEEP=child'",
            "sh -c 'set -- child'",
            "sh -c 'set -u'",
            MUTATE,
            MUTATE_EXIT,
          ]
    it.each(actions)(`isolates %s ${terminator}`, async (action) => {
      const ws = await singleMountWs()
      try {
        // The mutating programs are `sh -c` lines: GNU's -exec sees no
        // shell function, so a function head would not run at all.
        await ws.execute(
          'mkdir -p /w/d; touch /w/d/a.txt /w/d/b.txt; cd /w; KEEP=parent; set -- original',
        )
        const io = await ws.execute(
          `find d -name '*.txt' -exec ${action} ${terminator}; ` +
            'echo "$KEEP:$PWD:$1"; echo "${UNSET_FOR_TEST}"',
        )
        expect(io.stdoutText.endsWith('parent:/w:original\n\n')).toBe(true)
        if (action === MUTATE && terminator === '\\;') {
          expect(io.stdoutText).toBe('parent:/w\n'.repeat(2) + 'parent:/w:original\n\n')
        }
        expect(io.stderrText).toBe('')
        expect(io.exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    })
  }

  it('keeps the stderr of a program that exits 127, and names only a missing one', async () => {
    const ws = await singleMountWs()
    try {
      await ws.execute('mkdir -p /w/d; cd /w')
      const own = await ws.execute(
        "find d -maxdepth 0 -exec sh -c 'echo ownerr >&2; exit 127' \\; ; echo rc=$?",
      )
      expect([own.stdoutText, own.stderrText, own.exitCode]).toEqual(['rc=0\n', 'ownerr\n', 0])
      const missing = await ws.execute('find d -maxdepth 0 -exec nosuchcmd {} \\; ; echo rc=$?')
      expect([missing.stdoutText, missing.stderrText, missing.exitCode]).toEqual([
        'rc=0\n',
        "find: 'nosuchcmd': No such file or directory\n",
        0,
      ])
    } finally {
      await ws.close()
    }
  })

  it('runs -delete at its position, in -depth order, and ends the chain on a failure', async () => {
    const ws = await singleMountWs()
    const seed =
      "mkdir -p /w/d/sub; printf 'a\\n' > /w/d/a.txt; printf 'bb\\n' > /w/d/b.txt; " +
      'printf x > /w/d/sub/c.txt; cd /w'
    const out = async (line: string): Promise<[string, string, number]> => {
      const r = await ws.execute(line)
      return [r.stdoutText, r.stderrText, r.exitCode]
    }
    try {
      // GNU: the row is gone before the next action sees it, so cat
      // fails, its failure ends the chain, and -print never fires.
      await ws.execute(seed)
      expect(await out('find d -type f -delete -exec cat {} \\; -print')).toEqual([
        '',
        'cat: d/a.txt: No such file or directory\n' +
          'cat: d/b.txt: No such file or directory\n' +
          'cat: d/sub/c.txt: No such file or directory\n',
        0,
      ])
      expect(await out('find d -type f')).toEqual(['', '', 0])
      // -delete implies -depth, so every action runs in that order.
      await ws.execute(seed)
      expect(await out('find d -exec echo saw {} \\; -delete -print')).toEqual([
        'saw d/a.txt\nd/a.txt\nsaw d/b.txt\nd/b.txt\nsaw d/sub/c.txt\nd/sub/c.txt\n' +
          'saw d/sub\nd/sub\nsaw d\nd\n',
        '',
        0,
      ])
      expect(await out('test -e d')).toEqual(['', '', 1])
      await ws.execute(seed)
      const post = 'd/a.txt\nd/b.txt\nd/sub/c.txt\nd/sub\nd\n'
      expect(await out('find d -depth')).toEqual([post, '', 0])
      expect(await out('find d -depth -print')).toEqual([post, '', 0])
      expect(await out('find d')).toEqual(['d\nd/a.txt\nd/b.txt\nd/sub\nd/sub/c.txt\n', '', 0])
      expect(await out('find d ! -name c.txt -delete -print')).toEqual([
        'd/a.txt\nd/b.txt\n',
        "find: cannot delete 'd/sub': Directory not empty\n" +
          "find: cannot delete 'd': Directory not empty\n",
        1,
      ])
      expect(await out('find d -name c.txt -delete -delete -print')).toEqual([
        '',
        "find: cannot delete 'd/sub/c.txt': No such file or directory\n",
        1,
      ])
    } finally {
      await ws.close()
    }
  })

  it('batches -exec {} + once across start points on different mounts', async () => {
    // GNU: `-exec ... {} +` collects every start point's matches into one
    // batch; the actions run once at the command boundary, not once per
    // operand's native run.
    const ws = await twoMountWs()
    const out = async (line: string): Promise<[string, string, number]> => {
      const r = await ws.execute(line, { sessionId: 's' })
      return [r.stdoutText, r.stderrText, r.exitCode]
    }
    try {
      ws.createSession('s')
      await ws.execute('touch /a/x.txt /b/y.txt', { sessionId: 's' })
      expect(await out('find /a /b -maxdepth 0 -exec echo batch {} +')).toEqual([
        'batch /a /b\n',
        '',
        0,
      ])
      expect(await out('find /a /b -type f -exec echo {} \\;')).toEqual([
        '/a/x.txt\n/b/y.txt\n',
        '',
        0,
      ])
      expect(await out('find /a /b -type f -exec echo {} + -print')).toEqual([
        '/a/x.txt\n/b/y.txt\n/a/x.txt /b/y.txt\n',
        '',
        0,
      ])
    } finally {
      await ws.close()
    }
  })

  it('ends the chain of a row -ls cannot list', async () => {
    // GNU find 4.9: a row -delete removed is `find: 'd/a.txt': No such
    // file or directory` at -ls, exit 1, and -print never runs for it.
    const ws = await singleMountWs()
    try {
      await ws.execute('mkdir -p /w/d/sub; printf a > /w/d/a.txt; printf x > /w/d/sub/c.txt; cd /w')
      const io = await ws.execute('find d -type f -delete -ls -print')
      expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([
        '',
        "find: 'd/a.txt': No such file or directory\nfind: 'd/sub/c.txt': No such file or directory\n",
        1,
      ])
      expect((await ws.execute('find d -type f')).stdoutText).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('prints every row twice for a repeated -print', async () => {
    // GNU runs both actions; one explicit -print is the implicit one.
    const ws = await singleMountWs()
    try {
      await ws.execute('mkdir -p /w/d; touch /w/d/a.txt; cd /w')
      const twice = await ws.execute('find d -name a.txt -print -print')
      expect([twice.stdoutText, twice.stderrText, twice.exitCode]).toEqual([
        'd/a.txt\nd/a.txt\n',
        '',
        0,
      ])
      const once = await ws.execute('find d -name a.txt -print')
      expect([once.stdoutText, once.stderrText, once.exitCode]).toEqual(['d/a.txt\n', '', 0])
    } finally {
      await ws.close()
    }
  })

  it('runs a slash-carrying -exec head through the loader', async () => {
    // bash hands a slash-carrying head to the loader, so a workspace
    // script runs; one that is not there is GNU's execvp line, per match,
    // with find's exit status untouched.
    const ws = await singleMountWs()
    const out = async (line: string): Promise<[string, string, number]> => {
      const r = await ws.execute(line)
      return [r.stdoutText, r.stderrText, r.exitCode]
    }
    try {
      await ws.execute(
        "mkdir -p /w/d; touch /w/d/a.txt; printf '#!/bin/sh\\necho ran $1\\n' > /w/check.sh; cd /w",
      )
      expect(await out('find d -name a.txt -exec ./check.sh {} \\; -print')).toEqual([
        'ran d/a.txt\nd/a.txt\n',
        '',
        0,
      ])
      expect(await out('find d -name a.txt -exec /w/check.sh {} \\;')).toEqual([
        'ran d/a.txt\n',
        '',
        0,
      ])
      expect(await out('find d -name a.txt -exec ./missing.sh {} \\; -print')).toEqual([
        '',
        "find: './missing.sh': No such file or directory\n",
        0,
      ])
    } finally {
      await ws.close()
    }
  })

  it('unlinks a symlink row through the namespace under -delete', async () => {
    // A symlink row comes from the namespace, which no backend can see,
    // so the removal goes through the op dispatcher the way `rm link`
    // does; the mount's rm would only report the row absent and leave
    // the link in place.
    const ws = await singleMountWs()
    try {
      await ws.execute(
        'mkdir -p /w/d/sub; printf a > /w/d/a.txt; ln -s a.txt /w/d/link; ln -s nowhere /w/d/dangling; cd /w',
      )
      let io = await ws.execute('find d -type l -delete')
      expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['', '', 0])
      io = await ws.execute('find d -type l')
      expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['', '', 0])
      io = await ws.execute('cat d/a.txt')
      expect([io.stdoutText, io.exitCode]).toEqual(['a', 0])
      // An unfiltered -delete meets the link among the backend rows and
      // removes the whole tree, the directory holding it included.
      await ws.execute('ln -s a.txt /w/d/sub/link')
      io = await ws.execute('find d -delete')
      expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['', '', 0])
      io = await ws.execute('find d')
      expect([io.stderrText, io.exitCode]).toEqual(["find: 'd': No such file or directory\n", 1])
    } finally {
      await ws.close()
    }
  })

  it('renders a symlink row under -ls', async () => {
    // A symlink is namespace state no backend stat can see, so the
    // delegated ls needs the link view to render the row at all.
    const ws = await singleMountWs()
    try {
      await ws.execute(
        'mkdir -p /w/d; touch /w/d/a.txt; ln -s a.txt /w/d/link; ln -s nowhere /w/d/dangling; cd /w',
      )
      const io = await ws.execute('find d -type l -ls')
      expect([io.stderrText, io.exitCode]).toEqual(['', 0])
      const rows = io.stdoutText.split('\n').filter((l) => l !== '')
      expect(rows.map((r) => r.split(/\s+/).slice(-3))).toEqual([
        ['d/dangling', '->', 'nowhere'],
        ['d/link', '->', 'a.txt'],
      ])
      for (const row of rows) expect(row).toContain('lrwxrwxrwx')
    } finally {
      await ws.close()
    }
  })

  it.each(['-exec touch marker \\;', '-print', '-delete'])(
    'refuses a later test before %s has side effects',
    async (action) => {
      const ws = await singleMountWs()
      try {
        await ws.execute('mkdir -p /w/d; touch /w/d/a.txt; cd /w')
        const io = await ws.execute(`find d ${action} -name '*.txt' -print`)
        expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([
          '',
          'find: -name: tests after actions are not supported\n',
          1,
        ])
        expect((await ws.execute('test ! -e marker && test -e d/a.txt')).exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    },
  )
})

for (const nested of [false, true]) {
  it.each(['-exec rm {} \\;', '-exec rm {} +', '-delete'])(
    `preserves newline paths (nested: ${String(nested)}) with %s`,
    async (action) => {
      const ws = nested ? await twoMountWs() : await singleMountWs()
      try {
        const root = nested ? '/a/d' : '/d'
        await ws.execute(`mkdir -p ${root}; touch "${root}/a\nb" /bystander`)
        const io = await ws.execute(`find ${nested ? '/' : '/d'} -name 'a*' -type f ${action}`)
        expect(io.exitCode).toBe(0)
        expect(io.stderrText).toBe('')
        const check = await ws.execute(`test -f /bystander && test ! -e "${root}/a\nb"`)
        expect(check.exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    },
  )
}

it('refuses deletion under OR before removing any file', async () => {
  const ws = await singleMountWs()
  try {
    await ws.execute('mkdir d; touch d/keep d/remove')
    const io = await ws.execute('find d -name keep -o -delete')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toContain('supported only in a top-level')
    expect((await ws.execute('test -f d/keep && test -f d/remove')).exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})

it('preserves newline mount names and filenames through print0 and ls', async () => {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const root = new RAMResource()
  const nested = new RAMResource()
  ops.registerResource(root)
  ops.registerResource(nested)
  const ws = new Workspace(
    { '/': root, '/d/nested\nmount': nested },
    {
      mode: MountMode.WRITE,
      ops,
      shellParser: parser,
    },
  )
  try {
    await ws.execute('touch "/d/nested\nmount/a\nb"')
    const printed = await ws.execute('find /d -print0')
    expect(printed.stdoutText).toBe('/d\0/d/nested\nmount\0/d/nested\nmount/a\nb\0')
    expect(printed.stderrText).toBe('')
    const listed = await ws.execute('find /d -type f -ls')
    expect(listed.exitCode).toBe(0)
    expect(listed.stderrText).toBe('')
    // -ls escapes the newline, as findutils does; the row stays one line.
    expect(listed.stdoutText).toContain('a\\nb\n')
  } finally {
    await ws.close()
  }
})
