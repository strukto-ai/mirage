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

/**
 * Configure CORS on a GCS bucket using the native XML API via HMAC keys.
 * GCS's S3-compatibility layer rejects `PutBucketCors` because its CORS
 * schema differs from S3's; the XML API (same endpoint, same HMAC creds)
 * accepts GCS-shaped XML signed with AWS SigV4.
 *
 * Run with: npx tsx scripts/configure-gcs-cors.ts [origin1 origin2 ...]
 */
import { createHash, createHmac } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(here, '../../../.env.development') })

const ORIGINS =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['http://localhost:5173', 'http://localhost:5174']

function req(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`missing env: ${name}`)
  return v
}

const BUCKET = req('GCS_BUCKET')
const AK = req('GCS_ACCESS_KEY_ID')
const SK = req('GCS_SECRET_ACCESS_KEY')
const ENDPOINT = process.env.GCS_ENDPOINT_URL ?? 'https://storage.googleapis.com'
const REGION = process.env.GCS_REGION ?? 'auto'

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function corsXml(origins: string[]): string {
  const originTags = origins.map((o) => `    <Origin>${escapeXml(o)}</Origin>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<CorsConfig>
  <Cors>
    <Origins>
${originTags}
    </Origins>
    <Methods>
      <Method>GET</Method>
      <Method>PUT</Method>
      <Method>HEAD</Method>
      <Method>DELETE</Method>
      <Method>POST</Method>
    </Methods>
    <ResponseHeaders>
      <ResponseHeader>Content-Type</ResponseHeader>
      <ResponseHeader>Content-Length</ResponseHeader>
      <ResponseHeader>ETag</ResponseHeader>
      <ResponseHeader>Last-Modified</ResponseHeader>
    </ResponseHeaders>
    <MaxAgeSec>3000</MaxAgeSec>
  </Cors>
</CorsConfig>
`
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

async function main(): Promise<void> {
  const body = corsXml(ORIGINS)
  const url = new URL(`${ENDPOINT}/${BUCKET}?cors`)
  const host = url.host

  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)

  const headersMap: Record<string, string> = {
    'content-length': String(Buffer.byteLength(body)),
    'content-md5': createHash('md5').update(body).digest('base64'),
    'content-type': 'application/xml',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  const signedHeaderNames = Object.keys(headersMap).sort()
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headersMap[k]}\n`).join('')
  const signedHeadersStr = signedHeaderNames.join(';')

  const canonicalRequest = [
    'PUT',
    url.pathname,
    'cors=',
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const key = signingKey(SK, dateStamp, REGION, 's3')
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`

  const finalHeaders: Record<string, string> = {
    Authorization: authorization,
    ...Object.fromEntries(signedHeaderNames.map((k) => [k, headersMap[k]!])),
  }
  delete finalHeaders.host

  console.log(`PUT ${url.toString()}`)
  const resp = await fetch(url.toString(), {
    method: 'PUT',
    headers: finalHeaders,
    body,
  })
  const text = await resp.text()
  if (!resp.ok) {
    console.error(`  ✗ ${String(resp.status)} ${resp.statusText}`)
    console.error(text)
    process.exit(1)
  }
  console.log(`  ✓ CORS applied on gs://${BUCKET} for ${ORIGINS.join(', ')}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
