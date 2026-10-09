import type { S3Client } from '@aws-sdk/client-s3'
import type { S3Config } from '../../vfs/s3/config.ts'

export interface S3SendClient {
  send: (cmd: unknown) => Promise<Record<string, unknown>>
  destroy?: () => void
}

export interface S3Module {
  S3Client: new (options: Record<string, unknown>) => S3Client
  GetObjectCommand: new (input: Record<string, unknown>) => unknown
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown
  PutObjectCommand: new (input: Record<string, unknown>) => unknown
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown
  DeleteObjectsCommand: new (input: Record<string, unknown>) => unknown
  CopyObjectCommand: new (input: Record<string, unknown>) => unknown
}

/** One open S3 client plus the module and config that shaped it. */
export interface S3Conn {
  send: S3SendClient['send']
  mod: S3Module
  config: S3Config
}
