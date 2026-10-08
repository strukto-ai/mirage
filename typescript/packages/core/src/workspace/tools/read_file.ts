import { detectFileType } from '../../commands/builtin/file_sniff.ts'
import type { Files } from '../files.ts'
import { FileStat, FileType } from '../../types.ts'
import type { ContentType } from '../../types.ts'
import {
  MIME_FOR_EXTENSION,
  MIME_FOR_FILE_TYPE,
  MODEL_IMAGE_MIMES,
  READ_FILE_MIME,
  TEXT_FILE_EXTENSIONS,
  type ReadFileMime,
} from './read_file/constants.ts'

interface WorkspaceFileBase {
  path: string
  mimeType: ReadFileMime
  bytes: number
}

export type WorkspaceFileReadResult =
  | (WorkspaceFileBase & { kind: 'text'; content: string })
  | (WorkspaceFileBase & { kind: 'image'; data: Uint8Array })
  | (WorkspaceFileBase & { kind: 'file'; data: Uint8Array; filename: string })
  | (WorkspaceFileBase & { kind: 'binary'; note: string })

export type WorkspaceMediaRead = Extract<WorkspaceFileReadResult, { kind: 'image' | 'file' }>

export type WorkspaceFileReader = (path: string) => Promise<Uint8Array>

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

function mimeForExtension(path: string): ReadFileMime | undefined {
  const ext = extOf(path)
  return (
    MIME_FOR_EXTENSION[ext] ??
    (TEXT_FILE_EXTENSIONS.has(ext) ? READ_FILE_MIME.PLAIN_TEXT : undefined)
  )
}

function mimeForDetectedType(type: ContentType): ReadFileMime {
  return MIME_FOR_FILE_TYPE[type] ?? READ_FILE_MIME.BINARY
}

function mimeFor(path: string, bytes: Uint8Array, stat: FileStat): ReadFileMime {
  const extensionMime = mimeForExtension(path)
  if (extensionMime !== undefined) return extensionMime
  if (extOf(path) !== '') return READ_FILE_MIME.BINARY
  return mimeForDetectedType(detectFileType(bytes, stat))
}

/**
 * A file a model takes as media, from the bytes already read: an image
 * the models read, or a PDF. Its extension decides; a name with none is
 * sniffed from its bytes alone, so no stat is needed beyond the read.
 * Undefined for anything else, which the text read answers.
 */
export function mediaOf(path: string, data: Uint8Array): WorkspaceMediaRead | undefined {
  const ext = extOf(path)
  const mimeType =
    ext === ''
      ? mimeForDetectedType(
          detectFileType(data, new FileStat({ name: filenameOf(path), type: FileType.FILE })),
        )
      : MIME_FOR_EXTENSION[ext]
  if (mimeType === undefined) return undefined
  const base = { path, mimeType, bytes: data.byteLength }
  if (MODEL_IMAGE_MIMES.has(mimeType)) return { ...base, kind: 'image', data }
  if (mimeType === READ_FILE_MIME.PDF) {
    return { ...base, kind: 'file', data, filename: filenameOf(path) }
  }
  return undefined
}

function isTextMime(mimeType: ReadFileMime): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === READ_FILE_MIME.JSON ||
    mimeType === READ_FILE_MIME.SVG
  )
}

export async function readWorkspaceFile(
  vfs: Files,
  path: string,
  reader?: WorkspaceFileReader,
): Promise<WorkspaceFileReadResult> {
  const stat = await vfs.stat(path)
  if (stat.type === FileType.DIRECTORY) {
    throw new Error(`Cannot read directory as a file: ${path}`)
  }
  const data = reader === undefined ? await vfs.read(path, { raw: true }) : await reader(path)
  const mimeType = mimeFor(path, data, stat)
  const base = { path, mimeType, bytes: data.byteLength }

  if (isTextMime(mimeType)) {
    return {
      ...base,
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: false }).decode(data),
    }
  }
  if (MODEL_IMAGE_MIMES.has(mimeType)) {
    return { ...base, kind: 'image', data }
  }
  if (mimeType === READ_FILE_MIME.PDF) {
    return { ...base, kind: 'file', data, filename: filenameOf(path) }
  }
  return {
    ...base,
    kind: 'binary',
    note:
      `Binary file ${path} (${mimeType}, ${String(data.byteLength)} bytes). ` +
      'Use the shell tool with commands such as head, file, wc and od to inspect it.',
  }
}
