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

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { enoent } from '../../../errors/fs.ts'
import { DEFAULT_VISIBILITY, FileStat, FileType, PathSpec } from '../../../types.ts'
import type { NamespaceView } from '../../../view/types.ts'
import { removeTree } from './rm_cmd.ts'

it('loads rm first under native ESM without the Vitest module runner', async () => {
  const compiler = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href
  const loader = `
    import { readFile } from 'node:fs/promises';
    import ts from ${JSON.stringify(compiler)};
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
        const source = ts.transpileModule(await readFile(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        }).outputText;
        return { format: 'module', source, shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  `
  const target = new URL('./rm_cmd.ts', import.meta.url).href
  await promisify(execFile)(
    process.execPath,
    [
      '--loader',
      `data:text/javascript,${encodeURIComponent(loader)}`,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(target)})`,
    ],
    { timeout: 15000 },
  )
})

const TREE: Record<string, string[]> = {
  '/t': ['/t/a.txt', '/t/inner'],
  '/t/inner': ['/t/inner/b.txt'],
}

function treeOps(calls: string[][], gone: string | null = null) {
  return {
    readdir: (path: PathSpec) => Promise.resolve(TREE[path.virtual] ?? []),
    stat: (path: PathSpec) =>
      Promise.resolve(
        new FileStat({
          name: path.virtual,
          type: path.virtual in TREE ? FileType.DIRECTORY : FileType.FILE,
        }),
      ),
    unlink: (path: PathSpec) => {
      if (path.virtual === gone) return Promise.reject(enoent(path.virtual))
      calls.push(['unlink', path.virtual])
      return Promise.resolve()
    },
    rmdir: (path: PathSpec) => {
      calls.push(['rmdir', path.virtual])
      return Promise.resolve()
    },
  }
}

function ns(mounts: string[] = [], links: string[] = [], hidden: string[] = []): NamespaceView {
  const rows = new Map<string, FileStat[]>()
  for (const link of links) {
    const cut = link.lastIndexOf('/')
    const base = link.slice(0, cut)
    rows.set(base, [
      ...(rows.get(base) ?? []),
      new FileStat({ name: link.slice(cut + 1), type: FileType.SYMLINK }),
    ])
  }
  return {
    links: {
      statAt: () => null,
      children: (base) => rows.get(base) ?? [],
      subtree: () => [],
      resolve: (path) => path,
      exists: () => Promise.resolve(true),
      targetStat: () => Promise.resolve(null),
    },
    mounts: {
      descendants: () => mounts,
      visibleDescendants: () => mounts,
      isRoot: (path) => mounts.includes(path),
      rootOf: () => '/',
    },
    visibility: { ...DEFAULT_VISIBILITY, paths: { paths: hidden } },
  }
}

describe('removeTree', () => {
  it('never enters a mount below', async () => {
    const calls: string[][] = []
    const { failures } = await removeTree(PathSpec.fromStrPath('/t'), {
      ...treeOps(calls),
      ns: ns(['/t/inner']),
      force: false,
    })
    expect(calls).toEqual([['unlink', '/t/a.txt']])
    expect(failures).toEqual([])
  })

  it('leaves a hidden link to the directory', async () => {
    const calls: string[][] = []
    const { failures } = await removeTree(PathSpec.fromStrPath('/t/inner'), {
      ...treeOps(calls),
      ns: ns([], ['/t/inner/secret'], ['/t/inner/secret']),
      force: false,
    })
    expect(calls).toEqual([
      ['unlink', '/t/inner/b.txt'],
      ['rmdir', '/t/inner'],
    ])
    expect(failures).toEqual([])
  })

  it.each([true, false])('takes an entry gone as removed under -f=%s', async (force) => {
    const calls: string[][] = []
    const { failures } = await removeTree(PathSpec.fromStrPath('/t/inner'), {
      ...treeOps(calls, '/t/inner/b.txt'),
      ns: null,
      force,
    })
    expect(failures.map(([path]) => path.virtual)).toEqual(force ? [] : ['/t/inner/b.txt'])
    expect(calls.some(([op, path]) => op === 'rmdir' && path === '/t/inner')).toBe(force)
  })
})
