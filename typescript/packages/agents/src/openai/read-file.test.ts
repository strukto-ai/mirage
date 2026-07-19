import { RunContext } from '@openai/agents'
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { mirageReadFileTool, type MirageReadFileOutput } from './read-file.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

async function invokeReadFile(ws: Workspace, path: string): Promise<MirageReadFileOutput> {
  const readFile = mirageReadFileTool(ws)
  const output = await readFile.invoke(new RunContext(), JSON.stringify({ path }))
  if (typeof output === 'string') throw new Error(`unexpected string output: ${output}`)
  return output
}

describe('mirageReadFileTool', () => {
  it('returns text as structured text input', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/notes.txt', 'hello')
    await expect(invokeReadFile(ws, '/notes.txt')).resolves.toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  it('returns images as structured image input', async () => {
    const ws = mkWs()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await ws.fs.writeFile('/photo.png', png)
    const output = await invokeReadFile(ws, '/photo.png')
    expect(output.type).toBe('image')
    if (output.type !== 'image') throw new Error('expected image output')
    expect(output.image).toEqual({ data: png, mediaType: 'image/png' })
  })

  it('returns PDFs as structured file input', async () => {
    const ws = mkWs()
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
    await ws.fs.writeFile('/document', pdf)
    const output = await invokeReadFile(ws, '/document')
    expect(output.type).toBe('file')
    if (output.type !== 'file') throw new Error('expected file output')
    expect(output.file).toEqual({
      data: pdf,
      mediaType: 'application/pdf',
      filename: 'document',
    })
  })

  it('detects extensionless files beneath dotted directories', async () => {
    const ws = mkWs()
    await ws.fs.mkdir('/archive.v1')
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
    await ws.fs.writeFile('/archive.v1/document', pdf)
    const output = await invokeReadFile(ws, '/archive.v1/document')
    expect(output.type).toBe('file')
  })

  it('describes unsupported binary files without corrupting them as text', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/blob.bin', new Uint8Array([0, 1, 2, 3]))
    const output = await invokeReadFile(ws, '/blob.bin')
    expect(output.type).toBe('text')
    if (output.type !== 'text') throw new Error('expected text output')
    expect(output.text).toContain('Binary file /blob.bin')
  })

  it('returns model-visible errors for missing files', async () => {
    const output = await invokeReadFile(mkWs(), '/missing.txt')
    expect(output.type).toBe('text')
    if (output.type !== 'text') throw new Error('expected text output')
    expect(output.text).toContain('Unable to read /missing.txt')
  })
})
