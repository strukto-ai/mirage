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
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'

// Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
const CASES: [string, string, string][] = [
  // `>` onto an existing target is refused and the target is intact.
  [
    'echo a > /ram/f; set -C; echo b > /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // Existence is the test, not size: an empty file still refuses.
  [
    ': > /ram/f; set -C; echo b > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // `>|` overrides for one redirect, and does not clear the option.
  ['echo a > /ram/f; set -C; echo b >| /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
  [
    'echo a > /ram/f; set -C; echo b >| /ram/f; echo c > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // A new target and `>>` are both allowed.
  ['set -C; echo b > /ram/new; echo rc=$?; cat /ram/new', 'rc=0\nb\n', ''],
  ['echo a > /ram/f; set -C; echo b >> /ram/f; echo rc=$?; cat /ram/f', 'rc=0\na\nb\n', ''],
  // `2>` and `&>` are refused the same way.
  [
    'echo a > /ram/f; set -C; ls /nope 2> /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  [
    'echo a > /ram/f; set -C; echo b &> /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // bash stops at the first refused open: one message, neither written.
  [
    'echo a > /ram/x; echo a > /ram/y; set -C; echo b > /ram/x > /ram/y; echo rc=$?; cat /ram/x /ram/y',
    'rc=1\na\na\n',
    '/ram/x: cannot overwrite existing file\n',
  ],
  // A directory under the option answers in GNU's wording for that case.
  ['mkdir -p /ram/d; set -C; echo b > /ram/d; echo rc=$?', 'rc=1\n', '/ram/d: Is a directory\n'],
  // The letter and the long name are the same option, and `+C` clears it.
  [
    'echo a > /ram/f; set -o noclobber; echo b > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  ['echo a > /ram/f; set -C; set +C; echo b > /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
  // Off by default: the ordinary overwrite is untouched.
  ['echo a > /ram/f; echo b > /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
]

describe('set -C noclobber', () => {
  it.each(CASES)('%s', async (cmd, out, err) => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(cmd)
    expect(stdoutStr(io)).toBe(out)
    expect(stderrStr(io)).toBe(err)
    await ws.close()
  })

  it('a refused open stops the command from running', async () => {
    // bash opens every redirect before it forks, so a refused open means
    // the command never runs at all. Checking after the fact matched the
    // target's contents and nothing else: `touch marker > existing` still
    // created the marker.
    const { ws } = await makeWorkspace()
    const io = await ws.shell(
      'echo a > /ram/f; set -C; touch /ram/marker > /ram/f;' + ' echo rc=$?; ls /ram/marker',
    )
    expect(stderrStr(io)).toBe(
      '/ram/f: cannot overwrite existing file\n' +
        "ls: cannot access '/ram/marker': No such file or directory\n",
    )
    expect(stdoutStr(io)).toBe('rc=1\n')
    await ws.close()
  })

  it('a command cannot clear the way for its own refused redirect', async () => {
    // The worst shape of the same bug: `rm f > f` ran first, so by the
    // time the probe looked there was nothing to refuse and the line
    // reported success while the file was gone.
    const { ws } = await makeWorkspace()
    const io = await ws.shell(
      'echo one > /ram/f; set -C; rm /ram/f > /ram/f; echo rc=$?; cat /ram/f',
    )
    expect(stdoutStr(io)).toBe('rc=1\none\n')
    await ws.close()
  })

  it('makes an earlier redirect visible to a later one', async () => {
    // Each open is visible to the next, so the second `>` finds what the
    // first one created even though the target was absent when the
    // statement began. Probing every target against one pre-command
    // snapshot passed both and wrote the output.
    const { ws } = await makeWorkspace()
    const io = await ws.shell(
      'set -C; echo x > /ram/dup > /ram/dup; echo rc=$?; cat /ram/dup; echo end',
    )
    expect(stderrStr(io)).toBe('/ram/dup: cannot overwrite existing file\n')
    // The first redirect still created it, and the command never ran, so
    // the file is there and empty.
    expect(stdoutStr(io)).toBe('rc=1\nend\n')
    await ws.close()
  })

  it('counts append and override opens as creating', async () => {
    // `>>` and `>|` never refuse, but they do open, so a later `>` onto
    // the same absent target refuses against what they created.
    const { ws } = await makeWorkspace()
    const ap = await ws.shell(
      'set -C; echo x >> /ram/ap > /ram/ap; echo rc=$?; cat /ram/ap; echo end',
    )
    expect(stderrStr(ap)).toBe('/ram/ap: cannot overwrite existing file\n')
    expect(stdoutStr(ap)).toBe('rc=1\nend\n')
    const ov = await ws.shell(
      'set -C; echo x >| /ram/ov > /ram/ov; echo rc=$?; cat /ram/ov; echo end',
    )
    expect(stderrStr(ov)).toBe('/ram/ov: cannot overwrite existing file\n')
    expect(stdoutStr(ov)).toBe('rc=1\nend\n')
    await ws.close()
  })

  it('shows in the option listing', async () => {
    const { ws } = await makeWorkspace()
    // The session is reused across calls, so the default is asserted
    // before anything sets the option.
    expect(stdoutStr(await ws.shell('set -o'))).toContain('noclobber      \toff\n')
    expect(stdoutStr(await ws.shell('set -C; set -o'))).toContain('noclobber      \ton\n')
    expect(stdoutStr(await ws.shell('set +o'))).toContain('set -o noclobber\n')
    await ws.close()
  })
})
