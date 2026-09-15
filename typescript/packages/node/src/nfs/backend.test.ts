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

import { createServer } from 'node:net'

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountBackend, MountMode } from '@struktoai/mirage-core/types'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { NFSConfig } from './config.ts'
import {
  PRIVILEGED_PLATFORMS,
  checkPlatformNfs,
  checkPortAvailable,
  checkSizesNfs,
  prepareNfsBackend,
  prepareNfsMount,
  requiresPrivilege,
} from './backend.ts'

async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve()
    })
  })
  return port
}

async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const held = createServer()
  const port = await new Promise<number>((resolve) => {
    held.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = held.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  const release = (): Promise<void> =>
    new Promise<void>((resolve) => {
      held.close(() => {
        resolve()
      })
    })
  return { port, release }
}

describe('prepareNfsBackend', () => {
  it('accepts the nfs backend', () => {
    expect(prepareNfsBackend('nfs')).toBe(MountBackend.NFS)
  })

  it('refuses a non-kernel backend', () => {
    expect(() => prepareNfsBackend('vfs')).toThrow(/does not register a mountpoint/)
  })

  it('refuses a different kernel backend', () => {
    expect(() => prepareNfsBackend('fuse')).toThrow(/fuse/)
  })
})

describe('checkPortAvailable', () => {
  it('passes a free port', async () => {
    await expect(checkPortAvailable('127.0.0.1', await freePort())).resolves.toBeUndefined()
  })

  it('always passes port 0, which asks the OS to choose', async () => {
    await expect(checkPortAvailable('127.0.0.1', 0)).resolves.toBeUndefined()
  })

  it('refuses a taken port with the port named', async () => {
    const { port, release } = await holdPort()
    try {
      await expect(checkPortAvailable('127.0.0.1', port)).rejects.toThrow(String(port))
    } finally {
      await release()
    }
  })
})

describe('checkSizesNfs', () => {
  it('warns about a size-unknown mount but lets it proceed', () => {
    class UnsizedResource extends RAMResource {
      override readonly sizesAlwaysKnown: boolean = false
    }
    const ws = new Workspace({ '/api/': new UnsizedResource() }, { mode: MountMode.READ })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => {
        checkSizesNfs(ws, '')
      }).not.toThrow()
      expect(warn).toHaveBeenCalledOnce()
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain('will read as empty')
      expect(message).toContain('/api/')
    } finally {
      warn.mockRestore()
    }
  })

  it('says nothing when every mount can size its files', () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      checkSizesNfs(ws, '')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('platform guards', () => {
  it('names the platforms whose mount command needs privileges', () => {
    // macOS mounts a loopback NFS export as the invoking user; linux
    // reserves mount(2) for root, and windows is refused outright.
    expect([...PRIVILEGED_PLATFORMS]).toEqual(['linux', 'win32'])
  })

  it('reports the privilege requirement per platform', () => {
    expect(requiresPrivilege('darwin')).toBe(false)
    expect(requiresPrivilege('linux')).toBe(true)
    expect(requiresPrivilege('win32')).toBe(true)
  })

  it('refuses Windows with a clear error', () => {
    // mountArgs has no win32 branch and the Windows NFS client (Pro only,
    // mount.exe grammar) is untested; refusing loudly beats emitting a
    // Linux-shaped command that cannot work.
    expect(() => {
      checkPlatformNfs('win32')
    }).toThrow(/Windows/i)
  })

  it('passes macOS and Linux', () => {
    expect(() => {
      checkPlatformNfs('darwin')
    }).not.toThrow()
    expect(() => {
      checkPlatformNfs('linux')
    }).not.toThrow()
  })
})

describe('prepareNfsMount', () => {
  it('runs every guard and returns the validated backend', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const config = new NFSConfig({ port: await freePort() })
    await expect(prepareNfsMount('nfs', ws, config)).resolves.toBe(MountBackend.NFS)
  })

  it('refuses before the port is probed when the backend is wrong', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const { port, release } = await holdPort()
    try {
      // The backend check comes first, so the message names the backend
      // rather than the (also unusable) port.
      await expect(prepareNfsMount('fuse', ws, new NFSConfig({ port }))).rejects.toThrow(/fuse/)
    } finally {
      await release()
    }
  })

  it('refuses a port already in use', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const { port, release } = await holdPort()
    try {
      await expect(prepareNfsMount('nfs', ws, new NFSConfig({ port }))).rejects.toThrow(
        String(port),
      )
    } finally {
      await release()
    }
  })
})
