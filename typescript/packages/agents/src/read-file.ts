import { detectFileType, FileType, type FileStat, type Workspace } from '@struktoai/mirage-core'

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'csv',
  'tsv',
  'xml',
  'svg',
  'html',
  'htm',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
  'log',
  'env',
  'ini',
  'toml',
  'conf',
  'cfg',
])

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

interface WorkspaceFileBase {
  path: string
  mimeType: string
  bytes: number
}

export type WorkspaceFileReadResult =
  | (WorkspaceFileBase & { kind: 'text'; content: string })
  | (WorkspaceFileBase & { kind: 'image'; data: Uint8Array })
  | (WorkspaceFileBase & { kind: 'file'; data: Uint8Array; filename: string })
  | (WorkspaceFileBase & { kind: 'binary'; note: string })

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot < 0 || dot < slash) return ''
  return path.slice(dot + 1).toLowerCase()
}

function filenameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const filename = slash < 0 ? path : path.slice(slash + 1)
  return filename === '' ? 'file' : filename
}

function mimeForExtension(path: string): string | undefined {
  const ext = extOf(path)
  if (ext === 'json' || ext === 'jsonl') return 'application/json'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  if (ext === 'md') return 'text/markdown'
  if (ext === 'svg') return 'image/svg+xml'
  if (TEXT_EXTS.has(ext)) return 'text/plain'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'pdf') return 'application/pdf'
  return undefined
}

function mimeForDetectedType(type: FileType): string {
  if (type === FileType.JSON) return 'application/json'
  if (type === FileType.CSV) return 'text/csv'
  if (type === FileType.TEXT) return 'text/plain'
  if (type === FileType.IMAGE_PNG) return 'image/png'
  if (type === FileType.IMAGE_JPEG) return 'image/jpeg'
  if (type === FileType.IMAGE_GIF) return 'image/gif'
  if (type === FileType.PDF) return 'application/pdf'
  return 'application/octet-stream'
}

function mimeFor(path: string, bytes: Uint8Array, stat: FileStat): string {
  const extensionMime = mimeForExtension(path)
  if (extensionMime !== undefined) return extensionMime
  if (extOf(path) !== '') return 'application/octet-stream'
  return mimeForDetectedType(detectFileType(bytes, stat))
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'image/svg+xml'
  )
}

export async function readWorkspaceFile(
  ws: Workspace,
  path: string,
): Promise<WorkspaceFileReadResult> {
  const stat = await ws.fs.stat(path)
  if (stat.type === FileType.DIRECTORY) {
    throw new Error(`Cannot read directory as a file: ${path}`)
  }
  const data = await ws.fs.readFile(path, { raw: true })
  const mimeType = mimeFor(path, data, stat)
  const base = { path, mimeType, bytes: data.byteLength }

  if (isTextMime(mimeType)) {
    return {
      ...base,
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: false }).decode(data),
    }
  }
  if (IMAGE_MIMES.has(mimeType)) {
    return { ...base, kind: 'image', data }
  }
  if (mimeType === 'application/pdf') {
    return { ...base, kind: 'file', data, filename: filenameOf(path) }
  }
  return {
    ...base,
    kind: 'binary',
    note:
      `Binary file ${path} (${mimeType}, ${String(data.byteLength)} bytes). ` +
      'Use the execute tool with shell commands (head, file, wc, od) to inspect.',
  }
}
