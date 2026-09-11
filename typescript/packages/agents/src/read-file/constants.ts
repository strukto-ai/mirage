import { ContentType } from '@struktoai/mirage-core/types'

export const READ_FILE_MIME = Object.freeze({
  BINARY: 'application/octet-stream',
  CSV: 'text/csv',
  HTML: 'text/html',
  IMAGE_GIF: 'image/gif',
  IMAGE_JPEG: 'image/jpeg',
  IMAGE_PNG: 'image/png',
  IMAGE_WEBP: 'image/webp',
  JSON: 'application/json',
  MARKDOWN: 'text/markdown',
  PDF: 'application/pdf',
  PLAIN_TEXT: 'text/plain',
  SVG: 'image/svg+xml',
} as const)

export type ReadFileMime = (typeof READ_FILE_MIME)[keyof typeof READ_FILE_MIME]

export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'yaml',
  'yml',
  'tsv',
  'xml',
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

export const MIME_FOR_EXTENSION: Readonly<Record<string, ReadFileMime>> = Object.freeze({
  json: READ_FILE_MIME.JSON,
  jsonl: READ_FILE_MIME.JSON,
  csv: READ_FILE_MIME.CSV,
  html: READ_FILE_MIME.HTML,
  htm: READ_FILE_MIME.HTML,
  md: READ_FILE_MIME.MARKDOWN,
  svg: READ_FILE_MIME.SVG,
  png: READ_FILE_MIME.IMAGE_PNG,
  jpg: READ_FILE_MIME.IMAGE_JPEG,
  jpeg: READ_FILE_MIME.IMAGE_JPEG,
  gif: READ_FILE_MIME.IMAGE_GIF,
  webp: READ_FILE_MIME.IMAGE_WEBP,
  pdf: READ_FILE_MIME.PDF,
})

export const MIME_FOR_FILE_TYPE: Readonly<Partial<Record<ContentType, ReadFileMime>>> =
  Object.freeze({
    [ContentType.JSON]: READ_FILE_MIME.JSON,
    [ContentType.CSV]: READ_FILE_MIME.CSV,
    [ContentType.TEXT]: READ_FILE_MIME.PLAIN_TEXT,
    [ContentType.IMAGE_PNG]: READ_FILE_MIME.IMAGE_PNG,
    [ContentType.IMAGE_JPEG]: READ_FILE_MIME.IMAGE_JPEG,
    [ContentType.IMAGE_GIF]: READ_FILE_MIME.IMAGE_GIF,
    [ContentType.PDF]: READ_FILE_MIME.PDF,
  })

export const MODEL_IMAGE_MIMES: ReadonlySet<ReadFileMime> = new Set([
  READ_FILE_MIME.IMAGE_JPEG,
  READ_FILE_MIME.IMAGE_PNG,
  READ_FILE_MIME.IMAGE_GIF,
  READ_FILE_MIME.IMAGE_WEBP,
])
