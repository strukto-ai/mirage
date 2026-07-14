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

import dotenv from 'dotenv'
import {
  DiscordResource,
  MountMode,
  Workspace,
  type DiscordConfig,
  type FileStat,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function buildConfig(): DiscordConfig {
  const token = process.env.DISCORD_BOT_TOKEN
  if (token === undefined || token === '') {
    throw new Error('DISCORD_BOT_TOKEN env var is required')
  }
  return { token }
}

function assertNonEmpty(out: string, msg: string): void {
  if (out.trim() === '') throw new Error(`regression: ${msg}`)
}

async function main(): Promise<void> {
  const resource = new DiscordResource(buildConfig())
  const ws = new Workspace({ '/discord': resource }, { mode: MountMode.READ })

  try {
    console.log('=== ls /discord/ (guilds) ===')
    let r = await ws.execute('ls /discord/')
    console.log(r.stdoutText)
    assertNonEmpty(r.stdoutText, 'ls /discord/ returned no guilds')

    const guild = r.stdoutText.trim().split('\n')[0]!.trim()
    console.log(`=== ls /discord/${guild}/channels/ ===`)
    r = await ws.execute(`ls "/discord/${guild}/channels/"`)
    console.log(r.stdoutText)
    assertNonEmpty(r.stdoutText, 'no channels in first guild')

    const ch = r.stdoutText.trim().split('\n')[0]!.trim()
    const base = `/discord/${guild}/channels/${ch}`

    // ── pick a date with messages ──────────────────
    console.log(`\n=== ls ${base}/ (date directories, last 5) ===`)
    r = await ws.execute(`ls "${base}/" | tail -n 5`)
    console.log(r.stdoutText)
    const dates = r.stdoutText
      .trim()
      .split('\n')
      .map((d) => d.trim())
      .filter((d) => d !== '')
    if (dates.length === 0) {
      console.log('  (no date directories — channel is empty)')
      return
    }
    let targetDate = dates[dates.length - 1]!
    for (let i = dates.length - 1; i >= 0; i--) {
      const d = dates[i]!
      const test = await ws.execute(`cat "${base}/${d}/chat.jsonl" | head -c 1`)
      if (test.stdoutText.trim() !== '') {
        targetDate = d
        break
      }
    }
    console.log(`  using date: ${targetDate}`)
    const filePath = `${base}/${targetDate}/chat.jsonl`

    // ── cat chat.jsonl ─────────────────────────────
    console.log(`\n=== cat ${targetDate}/chat.jsonl | head -n 3 ===`)
    r = await ws.execute(`cat "${filePath}" | head -n 3`)
    console.log(r.stdoutText.slice(0, 300))

    // ── date dir contents ──────────────────────────
    console.log(`\n=== ls ${base}/${targetDate}/ ===`)
    r = await ws.execute(`ls "${base}/${targetDate}/"`)
    console.log(r.stdoutText)


    // chmod/chown/touch never hit the Discord API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${filePath} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "${filePath}" && chown 500:dev "${filePath}" && touch -t 202601021530 "${filePath}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `${filePath}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    // ── files dir ──────────────────────────────────
    console.log(`\n=== ls ${base}/${targetDate}/files/ (attachments) ===`)
    r = await ws.execute(`ls "${base}/${targetDate}/files/"`)
    const filesOut = r.stdoutText.trim()
    if (filesOut !== '') {
      for (const line of filesOut.split('\n').slice(0, 5)) console.log(`  ${line}`)
    } else {
      console.log('  (no attachments on this date)')
    }

    // ── stat + cat first attachment (byte-exact CDN download) ──
    if (filesOut !== '') {
      const firstAtt = filesOut.split('\n')[0]!.trim()
      const attPath = `${base}/${targetDate}/files/${firstAtt}`

      console.log(`\n=== stat ${firstAtt} ===`)
      r = await ws.execute(`stat "${attPath}"`)
      const statOut = r.stdoutText.trim()
      console.log(`  ${statOut.slice(0, 200)}`)
      const sizeMatch = /size=(\d+)/.exec(statOut)
      const expectedSize = sizeMatch !== null ? Number.parseInt(sizeMatch[1]!, 10) : null

      console.log(`\n=== cat ${firstAtt} (byte-exact CDN download) ===`)
      r = await ws.execute(`cat "${attPath}"`)
      console.log(
        `  bytes=${String(r.stdout.byteLength)} expected=${String(expectedSize)} exit=${String(r.exitCode)}`,
      )
      if (expectedSize !== null && r.stdout.byteLength !== expectedSize) {
        throw new Error(
          `regression: attachment cat got ${String(r.stdout.byteLength)} bytes, expected ${String(expectedSize)}`,
        )
      }
    }

    // ── grep at FILE level ─────────────────────────
    console.log(`\n=== grep at FILE level: grep -c . ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`grep -c . "${filePath}"`)
    console.log(`  line count: ${r.stdoutText.trim()}`)

    // ── grep at CHANNEL level (Discord search push-down) ──
    console.log(`\n=== grep at CHANNEL level: grep -m 5 . ${base}/ ===`)
    r = await ws.execute(`grep -m 5 . "${base}/"`)
    console.log(`  exit=${String(r.exitCode)}`)
    const chanOut = r.stdoutText.trim()
    if (chanOut !== '') {
      for (const line of chanOut.split('\n').slice(0, 5)) console.log(`  ${line.slice(0, 120)}`)
    } else {
      console.log('  (no results)')
    }
    const err = r.stderrText
    if (err !== '') console.log(`  stderr: ${err.slice(0, 200)}`)

    // ── grep at GUILD level ────────────────────────
    console.log(`\n=== grep at GUILD level: grep -m 5 . /discord/${guild}/ ===`)
    r = await ws.execute(`grep -m 5 . "/discord/${guild}/"`)
    console.log(`  exit=${String(r.exitCode)}`)
    const guildOut = r.stdoutText.trim()
    if (guildOut !== '') {
      for (const line of guildOut.split('\n').slice(0, 5)) console.log(`  ${line.slice(0, 120)}`)
    }

    // ── jq pipeline ────────────────────────────────
    console.log(`\n=== jq -r '.[] | .author.username' ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`jq -r ".[] | .author.username" "${filePath}" | head -n 5`)
    const jqOut = r.stdoutText.trim()
    if (jqOut !== '') {
      for (const line of jqOut.split('\n').slice(0, 5)) console.log(`  ${line}`)
    }

    // ── stat ───────────────────────────────────────
    console.log(`\n=== stat ${filePath} ===`)
    r = await ws.execute(`stat "${filePath}"`)
    console.log(`  ${r.stdoutText.trim().slice(0, 200)}`)

    // ── wc ─────────────────────────────────────────
    console.log(`\n=== wc -l ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`wc -l "${filePath}"`)
    console.log(`  ${r.stdoutText.trim()}`)

    // ── basename / dirname / realpath (path ops) ───────
    console.log(`\n=== basename ${filePath} ===`)
    r = await ws.execute(`basename "${filePath}"`)
    const baseOut = r.stdoutText.trim()
    console.log(`  ${baseOut}`)
    if (baseOut !== 'chat.jsonl') throw new Error(`basename expected 'chat.jsonl', got ${baseOut}`)

    const expectedDir = `${base}/${targetDate}`
    console.log(`\n=== dirname ${filePath} ===`)
    r = await ws.execute(`dirname "${filePath}"`)
    const dirOut = r.stdoutText.trim()
    console.log(`  ${dirOut}`)
    if (dirOut !== expectedDir) throw new Error(`dirname expected ${expectedDir}, got ${dirOut}`)

    console.log(`\n=== realpath ${filePath} ===`)
    r = await ws.execute(`realpath "${filePath}"`)
    const realOut = r.stdoutText.trim()
    console.log(`  ${realOut}`)
    if (realOut !== filePath) throw new Error(`realpath expected ${filePath}, got ${realOut}`)

    console.log(`\n=== realpath -e ${filePath} (must exist) ===`)
    r = await ws.execute(`realpath -e "${filePath}"`)
    console.log(`  exit=${String(r.exitCode)} ${r.stdoutText.trim()}`)
    if (r.exitCode !== 0) {
      throw new Error(`regression: realpath -e failed for existing file; stderr=${r.stderrText}`)
    }

    // ── tree ───────────────────────────────────────
    console.log(`\n=== tree -L 2 /discord/${guild}/ | head -n 20 ===`)
    r = await ws.execute(`tree -L 2 "/discord/${guild}/" | head -n 20`)
    for (const line of r.stdoutText.trim().split('\n').slice(0, 20)) {
      console.log(`  ${line}`)
    }

    // ── find chat.jsonl everywhere ────────────────
    console.log(`\n=== find /discord/${guild}/ -name chat.jsonl | head -n 5 ===`)
    r = await ws.execute(`find "/discord/${guild}/" -name "chat.jsonl" | head -n 5`)
    console.log(`  exit=${String(r.exitCode)}`)
    if (r.exitCode !== 0) {
      throw new Error(
        `regression: find chat.jsonl exited ${String(r.exitCode)} (soft errors should not abort)`,
      )
    }
    const findOut = r.stdoutText.trim()
    if (findOut !== '') {
      for (const line of findOut.split('\n')) console.log(`  ${line}`)
    }

    // ── pwd / cd / relative ────────────────────────
    console.log(`\n=== cd ${base} ===`)
    r = await ws.execute(`cd "${base}"`)
    console.log(`  exit=${String(r.exitCode)}`)

    console.log('\n=== pwd (after cd) ===')
    r = await ws.execute('pwd')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log(`\n=== cat ${targetDate}/chat.jsonl (relative) | head -n 1 ===`)
    r = await ws.execute(`cat "${targetDate}/chat.jsonl" | head -n 1`)
    if (r.stdoutText.trim() !== '') {
      console.log(`  ${r.stdoutText.trim().slice(0, 120)}`)
    }

    // ── members ────────────────────────────────────────
    console.log(`\n=== ls /discord/${guild}/members/ | head -n 5 ===`)
    r = await ws.execute(`ls "/discord/${guild}/members/" | head -n 5`)
    const memOut = r.stdoutText.trim()
    if (memOut !== '') {
      for (const line of memOut.split('\n')) console.log(`  ${line}`)
      const firstMember = memOut.split('\n')[0]!.trim()
      console.log(`\n=== cat /discord/${guild}/members/${firstMember} ===`)
      r = await ws.execute(`cat "/discord/${guild}/members/${firstMember}"`)
      console.log(`  ${r.stdoutText.trim().slice(0, 200)}`)
    } else {
      console.log('  (no members visible)')
    }

    // ── glob expansion: a mid-path glob replaces the guild segment
    // (which may contain spaces) and walks into the literal tail.
    console.log('\n=== echo /discord/*/channels (mid-path glob) ===')
    r = await ws.execute('echo /discord/*/channels')
    const globOut = r.stdoutText.trim()
    console.log(`  ${globOut.slice(0, 200)}`)
    if (!globOut.endsWith('/channels')) {
      throw new Error('regression: mid-path glob did not expand')
    }

    console.log('\n=== for f in /discord/*/channels/* (channel glob loop) ===')
    r = await ws.execute('for f in /discord/*/channels/*; do echo found:$f; done | head -n 3')
    for (const line of r.stdoutText.trim().split('\n')) {
      console.log(`  ${line.slice(0, 120)}`)
    }

    // A glob that matches nothing stays the literal word, so the
    // command reports it like GNU coreutils.
    console.log('\n=== cat /discord/zz-none-*/guild.json (no match) ===')
    r = await ws.execute('cat /discord/zz-none-*/guild.json')
    const globErr = r.stderrText.trim()
    console.log(`  exit=${r.exitCode}  ${globErr.slice(0, 120)}`)
    if (r.exitCode !== 1 || !globErr.includes('zz-none-*')) {
      throw new Error('regression: zero-match glob did not keep the literal')
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
