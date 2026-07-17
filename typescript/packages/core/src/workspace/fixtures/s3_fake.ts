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

import type { S3Module } from '../../core/s3/_client.ts'

class NoSuchKeyError extends Error {
  override readonly name = 'NoSuchKey'
}

class PreconditionFailedError extends Error {
  override readonly name = 'PreconditionFailed'
}

function etagOf(data: string): string {
  let hash = 5381
  for (let i = 0; i < data.length; i++) {
    hash = ((hash * 33) ^ data.charCodeAt(i)) >>> 0
  }
  return `"${hash.toString(16)}"`
}

class FakeGetObjectCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

class FakePutObjectCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

class FakeListObjectsV2Command {
  constructor(readonly input: Record<string, unknown>) {}
}

class FakeDeleteObjectsCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

class FakeUnusedCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

export const FAKE_S3_MODULE = {
  S3Client: FakeUnusedCommand,
  GetObjectCommand: FakeGetObjectCommand,
  HeadObjectCommand: FakeUnusedCommand,
  ListObjectsV2Command: FakeListObjectsV2Command,
  PutObjectCommand: FakePutObjectCommand,
  DeleteObjectCommand: FakeUnusedCommand,
  DeleteObjectsCommand: FakeDeleteObjectsCommand,
  CopyObjectCommand: FakeUnusedCommand,
} as unknown as S3Module

/**
 * In-memory S3 modeling exactly what the record stores rely on:
 * content ETags on GET and conditional PUTs (If-Match, If-None-Match).
 * Mirrors the Python tests' FakeConditionalS3Client.
 */
export class FakeConditionalS3Client {
  readonly objects = new Map<string, string>()

  private static objectKey(bucket: string, key: string): string {
    return `${bucket}/${key}`
  }

  entry(bucket: string, key: string): string | undefined {
    return this.objects.get(FakeConditionalS3Client.objectKey(bucket, key))
  }

  setEntry(bucket: string, key: string, data: string): void {
    this.objects.set(FakeConditionalS3Client.objectKey(bucket, key), data)
  }

  async send(cmd: unknown): Promise<Record<string, unknown>> {
    if (cmd instanceof FakeGetObjectCommand) return this.getObject(cmd.input)
    if (cmd instanceof FakePutObjectCommand) return this.putObject(cmd.input)
    if (cmd instanceof FakeListObjectsV2Command) return this.listObjects(cmd.input)
    if (cmd instanceof FakeDeleteObjectsCommand) return this.deleteObjects(cmd.input)
    throw new Error(`unexpected command: ${String(cmd)}`)
  }

  protected getObject(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = this.entry(input.Bucket as string, input.Key as string)
    if (data === undefined) throw new NoSuchKeyError(String(input.Key))
    return Promise.resolve({
      Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(data)) },
      ETag: etagOf(data),
    })
  }

  protected putObject(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bucket = input.Bucket as string
    const key = input.Key as string
    const current = this.entry(bucket, key)
    if (input.IfNoneMatch === '*' && current !== undefined) {
      throw new PreconditionFailedError(key)
    }
    if (
      input.IfMatch !== undefined &&
      (current === undefined || etagOf(current) !== input.IfMatch)
    ) {
      throw new PreconditionFailedError(key)
    }
    this.setEntry(bucket, key, input.Body as string)
    return Promise.resolve({})
  }

  protected listObjects(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bucket = input.Bucket as string
    const prefix = (input.Prefix as string | undefined) ?? ''
    const contents: { Key: string }[] = []
    const marker = FakeConditionalS3Client.objectKey(bucket, prefix)
    for (const stored of [...this.objects.keys()].sort()) {
      if (stored.startsWith(marker)) {
        contents.push({ Key: stored.slice(bucket.length + 1) })
      }
    }
    return Promise.resolve({ Contents: contents, IsTruncated: false })
  }

  protected deleteObjects(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bucket = input.Bucket as string
    const entries = (input.Delete as { Objects: { Key: string }[] }).Objects
    for (const entry of entries) {
      this.objects.delete(FakeConditionalS3Client.objectKey(bucket, entry.Key))
    }
    return Promise.resolve({})
  }
}

let current: FakeConditionalS3Client | null = null

/** Point the mocked client seam at a fresh fake; returns the fake. */
export function installFakeS3(client?: FakeConditionalS3Client): FakeConditionalS3Client {
  current = client ?? new FakeConditionalS3Client()
  return current
}

export function currentFakeS3(): FakeConditionalS3Client {
  if (current === null) throw new Error('installFakeS3() was not called')
  return current
}
