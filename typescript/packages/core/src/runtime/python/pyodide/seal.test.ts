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

import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceBinding } from '../../binding.ts'
import { PrefixResolver } from '../../resolver.ts'
import { FileStat, FileType } from '../../../types.ts'
import type { BridgeDispatchFn, RunResult } from '../../types.ts'
import { PyodideRuntime } from './runtime.ts'
import { context } from '../../../../tests/workspace/fixtures/context.ts'
import * as sealing from './seal.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const dispatch: BridgeDispatchFn = (op, path, _bytes, _dst, attrs) => {
  if (attrs?.retained !== undefined) return Promise.resolve(attrs.retained)
  if (path !== '/data/hello.txt')
    return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  if (op === 'stat')
    return Promise.resolve(new FileStat({ name: path, type: FileType.FILE, size: 5 }))
  if (op === 'read') return Promise.resolve(ENC.encode('world'))
  return Promise.reject(new Error(`unexpected ${op}`))
}

function unexpected(): never {
  throw new Error('unexpected filesystem operation')
}

/** Run `code` at `/` with no stdin. */
function interpret(rt: PyodideRuntime, code: string): Promise<RunResult> {
  return rt.interpret(undefined, { code, args: [], stdin: null }, context())
}

function bind(rt: PyodideRuntime): PyodideRuntime {
  rt.bind(WorkspaceBinding.overBridge(dispatch, new PrefixResolver(() => ['/data'])))
  return rt
}

const GLOBALS = `
import pyodide_js
F = pyodide_js.loadPackage.constructor.constructor
print(F('return [typeof process, typeof require, typeof fetch, typeof WebSocket].join(",")')())
`

describe('stripWorkerGlobals', () => {
  it('removes host handles and preserves the shared-memory bridge tools', () => {
    const realm: Record<string, unknown> = {
      process: {},
      global: {},
      require: () => undefined,
      fetch: () => undefined,
      WebSocket: () => undefined,
      Atomics,
      SharedArrayBuffer,
    }
    expect(sealing.stripWorkerGlobals(realm)).toEqual([])
    expect(Object.keys(realm)).toEqual(['Atomics', 'SharedArrayBuffer'])
    expect(realm.Atomics).toBe(Atomics)
  })

  it('reports a nonremovable handle and clears a writable one', () => {
    const realm: Record<string, unknown> = {}
    Object.defineProperty(realm, 'process', { value: {}, configurable: false, writable: false })
    Object.defineProperty(realm, 'fetch', {
      value: () => undefined,
      configurable: false,
      writable: true,
    })
    expect(sealing.stripWorkerGlobals(realm)).toEqual(['process'])
    expect(realm.fetch).toBeUndefined()
  })
})

describe('sealPyodideHostApis', () => {
  it('closes public and internal host filesystem and socket APIs', async () => {
    const filesystems = { MEMFS: {}, NODEFS: {}, NODERAWFS: {}, NATIVEFS_ASYNC: {} }
    const pyodide = {
      FS: { filesystems, createPreloadedFile: () => 'loaded' },
      _module: { NODEFS: filesystems.NODEFS, FS_createPreloadedFile: () => 'loaded' },
      mountNodeFS: () => 'mounted',
      mountNativeFS: () => 'mounted',
      useNodeSockFS: () => 'connected',
      _api: { config: {}, initializeNodeSockFS: () => 'connected' },
    }
    await sealing.sealPyodideHostApis(pyodide)
    expect(Object.keys(filesystems)).toEqual(['MEMFS'])
    expect(pyodide._module.NODEFS).toBeUndefined()
    for (const call of [
      pyodide.mountNodeFS,
      pyodide.mountNativeFS,
      pyodide.useNodeSockFS,
      pyodide._api.initializeNodeSockFS,
      pyodide.FS.createPreloadedFile,
      pyodide._module.FS_createPreloadedFile,
    ]) {
      expect(call).toThrow(/disabled in the sandboxed worker/)
    }
  })

  it('accepts an explicitly allowed package root nested beneath the distribution through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-seal-nested-'))
    const dist = join(dir, 'dist')
    const packages = join(dir, 'packages')
    await mkdir(dist)
    await mkdir(packages)
    await symlink(packages, join(dist, 'wheels'))
    const wheel = join(packages, 'probe.whl')
    await writeFile(wheel, 'native package')
    const pyodide = {
      _api: {
        config: { indexURL: dist, packageBaseUrl: join(dist, 'wheels') },
        loadBinaryFile: (path: string): Promise<unknown> => readFile(path, 'utf8'),
      },
    }
    try {
      await sealing.sealPyodideHostApis(pyodide)
      expect(await pyodide._api.loadBinaryFile(join(dist, 'wheels/probe.whl'))).toBe(
        'native package',
      )
      await writeFile(join(dir, 'outside'), 'secret')
      await symlink(join(dir, 'outside'), join(packages, 'escape'))
      await expect(pyodide._api.loadBinaryFile(join(dist, 'wheels/escape'))).rejects.toThrow(
        /not allowed/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('allows distribution reads but refuses URLs, traversal, sibling prefixes and symlink escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-seal-'))
    const root = join(dir, 'dist')
    await mkdir(root)
    await writeFile(join(root, 'pkg.whl'), 'wheel')
    await writeFile(join(dir, 'marker'), 'host-only')
    await symlink(join(dir, 'marker'), join(root, 'escape'))
    const seen: string[] = []
    const pyodide = {
      _api: {
        config: { indexURL: root },
        loadBinaryFile: (path: string): unknown => {
          seen.push(path)
          return 'bytes'
        },
      },
    }
    try {
      await sealing.sealPyodideHostApis(pyodide)
      const load = pyodide._api.loadBinaryFile
      expect(await load(join(root, 'pkg.whl'))).toBe('bytes')
      expect(await load(`file://${root}/pkg.whl`)).toBe('bytes')
      for (const path of [
        join(dir, 'marker'),
        `file://${dir}/marker`,
        `${root}/../marker`,
        `${root}-other/pkg.whl`,
        'https://cdn.example/pkg.whl',
      ]) {
        expect(() => load(path)).toThrow(/is not allowed in the sandboxed worker/)
      }
      await expect(load(join(root, 'escape'))).rejects.toThrow(
        /is not allowed in the sandboxed worker/,
      )
      pyodide._api.config.indexURL = dir
      expect(() => load(join(dir, 'marker'))).toThrow(/is not allowed in the sandboxed worker/)
      expect(seen).toEqual([
        await realpath(join(root, 'pkg.whl')),
        await realpath(join(root, 'pkg.whl')),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(typeof module.registerHooks !== 'function')(
  'a sealed Pyodide worker',
  { timeout: 120_000 },
  () => {
    it('refuses existing host files through exposed binary loaders and host mounts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mirage-seal-'))
      const file = join(dir, 'marker')
      await writeFile(file, 'host-only')
      const rt = bind(new PyodideRuntime({ config: { autoLoadFromImports: false } }))
      try {
        const result = await interpret(
          rt,
          `
import pyodide_js
F = pyodide_js.loadPackage.constructor.constructor

def refusal(fn):
    try:
        fn()
        return 'ran'
    except Exception as e:
        return 'refused' if 'sandboxed worker' in str(e) else str(e)

print(F('py', 'return typeof py.FS.filesystems.NODEFS + "," + typeof py._module.NODEFS')(pyodide_js))
print(refusal(lambda: pyodide_js.mountNodeFS('/host', ${JSON.stringify(dir)})))
print(refusal(lambda: pyodide_js._api.loadBinaryFile(${JSON.stringify(file)})))
print(refusal(lambda: pyodide_js._api.loadBinaryFile(${JSON.stringify(`file://${file}`)})))
print(refusal(lambda: pyodide_js._module.asyncLoad(${JSON.stringify(file)})))
print(refusal(lambda: F('fs', 'path', 'return fs.forceLoadFile({url: path})')(pyodide_js.FS, ${JSON.stringify(file)})))
print(refusal(lambda: pyodide_js._module.FS_createPreloadedFile('/', 'host', ${JSON.stringify(file)}, True, False)))
`,
        )
        expect(result.exitCode).toBe(0)
        expect(DEC.decode(result.stderr ?? undefined)).toBe('')
        expect(DEC.decode(result.stdout)).toBe('undefined,undefined\n' + 'refused\n'.repeat(6))
      } finally {
        await rt.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('loads a local wheel on import after sealing the worker', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mirage-seal-packages-'))
      const builder = new PyodideRuntime({ config: { autoLoadFromImports: false } })
      const rt = bind(
        new PyodideRuntime({
          config: { packageBaseUrl: dir, lockFileUrl: join(dir, 'pyodide-lock.json') },
        }),
      )
      try {
        const result = await interpret(
          builder,
          `
import base64, io, zipfile
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    archive.writestr('mirage_seal_probe.py', 'value = 42')
    archive.writestr('mirage_seal_probe-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: mirage-seal-probe\\nVersion: 1.0\\n')
    archive.writestr('mirage_seal_probe-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
    archive.writestr('mirage_seal_probe-1.0.dist-info/RECORD', '')
print(base64.b64encode(buffer.getvalue()).decode())
`,
        )
        const wheel = Buffer.from(DEC.decode(result.stdout).trim(), 'base64')
        const filename = 'mirage_seal_probe-1.0-py3-none-any.whl'
        await writeFile(join(dir, filename), wheel)
        const require = createRequire(import.meta.url)
        const lock = JSON.parse(
          await readFile(join(dirname(require.resolve('pyodide')), 'pyodide-lock.json'), 'utf8'),
        ) as { packages: Record<string, unknown> }
        lock.packages['mirage-seal-probe'] = {
          name: 'mirage-seal-probe',
          version: '1.0',
          file_name: filename,
          imports: ['mirage_seal_probe'],
          depends: [],
          install_dir: 'site',
          package_type: 'package',
          sha256: createHash('sha256').update(wheel).digest('hex'),
        }
        await writeFile(join(dir, 'pyodide-lock.json'), JSON.stringify(lock))
        const run = await interpret(
          rt,
          `import mirage_seal_probe; print(mirage_seal_probe.value)\n${GLOBALS}`,
        )
        expect(DEC.decode(run.stderr ?? undefined)).toBe('')
        expect(run.exitCode).toBe(0)
        expect(DEC.decode(run.stdout)).toBe('42\nundefined,undefined,undefined,undefined\n')
      } finally {
        await builder.close()
        await rt.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('loads an offline native wheel after sealing and keeps host APIs absent', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mirage-seal-native-'))
      const require = createRequire(import.meta.url)
      const distribution = dirname(require.resolve('pyodide'))
      const lockText = await readFile(join(distribution, 'pyodide-lock.json'), 'utf8')
      const lock = JSON.parse(lockText) as {
        packages: Record<string, { file_name: string; sha256: string; depends: string[] }>
      }
      const { version } = JSON.parse(
        await readFile(join(distribution, 'package.json'), 'utf8'),
      ) as { version: string }
      const rt = bind(
        new PyodideRuntime({
          config: {
            packageBaseUrl: dir,
            lockFileUrl: join(dir, 'pyodide-lock.json'),
          },
        }),
      )
      try {
        const pending = ['pillow']
        const downloaded = new Set<string>()
        while (pending.length > 0) {
          const name = pending.pop()
          if (name === undefined) break
          if (downloaded.has(name)) continue
          const pkg = lock.packages[name]
          if (pkg === undefined) throw new Error(`unknown package: ${name}`)
          const response = await fetch(
            `https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`,
          )
          expect(response.ok).toBe(true)
          const bytes = new Uint8Array(await response.arrayBuffer())
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(pkg.sha256)
          await writeFile(join(dir, pkg.file_name), bytes)
          downloaded.add(name)
          pending.push(...pkg.depends)
        }
        await writeFile(join(dir, 'pyodide-lock.json'), lockText)
        const run = await interpret(
          rt,
          `
from PIL import Image, _imaging
import io
image = Image.new('RGB', (2, 3), (12, 34, 56))
buffer = io.BytesIO()
image.save(buffer, format='PNG')
with Image.open(io.BytesIO(buffer.getvalue())) as restored:
    print(restored.size, restored.getpixel((1, 2)))
print(_imaging.__file__.endswith('.so'))
${GLOBALS}
`,
        )
        expect(DEC.decode(run.stderr ?? undefined)).toBe('')
        expect(run.exitCode).toBe(0)
        expect(DEC.decode(run.stdout)).toBe(
          '(2, 3) (12, 34, 56)\nTrue\nundefined,undefined,undefined,undefined\n',
        )
      } finally {
        await rt.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('keeps normal Python and mount reads working across fresh runs', async () => {
      const rt = bind(new PyodideRuntime({ config: { autoLoadFromImports: false } }))
      try {
        for (let i = 0; i < 2; i++) {
          const result = await interpret(
            rt,
            `${GLOBALS}\nprint(sum(i*i for i in range(5)))\nprint(open('/data/hello.txt').read())`,
          )
          expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('')
          expect(result.exitCode).toBe(0)
          expect(DEC.decode(result.stdout)).toBe(
            'undefined,undefined,undefined,undefined\n30\nworld\n',
          )
        }
        expect(typeof process.versions.node).toBe('string')
        expect(typeof (await import('node:fs')).readFile).toBe('function')
      } finally {
        await rt.close()
      }
    })
  },
)

it('keeps an init_module worker open for trusted host access', async () => {
  const rt = bind(
    new PyodideRuntime({
      config: {
        initModule: new URL(
          '../../../../tests/runtime/python/pyodide/fixtures/capability.ts',
          import.meta.url,
        ).href,
        autoLoadFromImports: false,
      },
    }),
  )
  try {
    const result = await interpret(rt, GLOBALS)
    expect(result.exitCode).toBe(0)
    const kinds = DEC.decode(result.stdout).trim().split(',')
    expect(kinds[0]).toBe('object')
    expect(kinds[2]).toBe('function')
  } finally {
    await rt.close()
  }
}, 120_000)

it.skipIf(typeof module.registerHooks !== 'function')(
  'refuses host imports, including cached builtins, once the worker is sealed',
  async () => {
    const sealUrl = new URL('./seal.ts', import.meta.url).href
    const code = `
    import { parentPort } from 'node:worker_threads'
    await import('node:fs')
    const { sealWorkerRealm } = await import(${JSON.stringify(sealUrl)})
    await sealWorkerRealm({})
    const specifiers = ['node:child_process', 'node:fs', 'node:module', 'data:text/javascript,export default 1']
    parentPort.postMessage(await Promise.all(specifiers.map((s) => import(s).then(() => 'LOADED', (e) => e.message))))
  `
    const worker = new Worker(code, {
      eval: true,
      execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'],
    })
    try {
      const results = await new Promise<string[]>((resolve, reject) => {
        worker.on('message', resolve)
        worker.on('error', reject)
      })
      expect(results).toHaveLength(4)
      for (const line of results) expect(line).toContain('cannot be loaded in the sandboxed worker')
    } finally {
      await worker.terminate()
    }
  },
  30_000,
)

it('skips the whole seal when synchronous module hooks are unavailable', async () => {
  const sealUrl = new URL('./seal.ts', import.meta.url).href
  const code = `
    import { parentPort } from 'node:worker_threads'
    import module from 'node:module'
    const { sealWorkerRealm } = await import(${JSON.stringify(sealUrl)})
    module.registerHooks = undefined
    module.syncBuiltinESMExports()
    const mountNodeFS = () => 'mounted'
    const py = { mountNodeFS }
    await sealWorkerRealm(py)
    parentPort.postMessage([typeof process, py.mountNodeFS === mountNodeFS, typeof (await import('node:fs')).readFile])
  `
  const worker = new Worker(code, {
    eval: true,
    execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'],
  })
  try {
    const result = await new Promise<[string, boolean, string]>((resolve, reject) => {
      worker.on('message', resolve)
      worker.on('error', reject)
    })
    expect(result).toEqual(['object', true, 'function'])
  } finally {
    await worker.terminate()
  }
}, 30_000)

it('fails a run whose worker seal failed', async () => {
  const error = new Error('seal failed')
  const seal = vi.spyOn(sealing, 'sealWorkerRealm').mockRejectedValueOnce(error)

  const rt = new PyodideRuntime(
    { config: { autoLoadFromImports: false } },
    {
      read: unexpected,
      readCached: unexpected,
      statCached: unexpected,
      stat: unexpected,
      checkPath: unexpected,
      readdir: unexpected,
      readlink: unexpected,
      flush: () => undefined,
      xattr: unexpected,
    },
  )
  try {
    await expect(interpret(rt, 'print(42)')).rejects.toBe(error)
    expect(seal).toHaveBeenCalledTimes(1)
  } finally {
    await rt.close()
    seal.mockRestore()
  }
}, 60_000)
