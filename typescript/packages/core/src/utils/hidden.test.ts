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

import { describe, expect, it } from 'vitest'
import {
  classifyPaths,
  hiddenUnder,
  isGlob,
  leadsHidden,
  visibleLinks,
  moveReveals,
  pathVisible,
  showHead,
  varHidden,
} from './hidden.ts'
import {
  DEFAULT_VISIBILITY,
  MountMode,
  type HiddenPaths,
  type HiddenVars,
  type ShownPaths,
  type Visibility,
} from '../types.ts'
import { CycleError, resolveSymlinks } from './path.ts'

function vis(paths: HiddenPaths | null, shown: ShownPaths | null = null): Visibility {
  return { ...DEFAULT_VISIBILITY, paths, shown }
}

function shows(entries: ShownPaths['entries']): ShownPaths | null {
  return entries.length === 0 ? null : { entries }
}

function varsOnly(vars: HiddenVars): Visibility {
  return { ...DEFAULT_VISIBILITY, vars }
}

describe('varHidden', () => {
  it('null hides nothing', () => {
    expect(varHidden(null, 'SECRET')).toBe(false)
  })

  it('names are exact', () => {
    const h = varsOnly({ names: ['SLACK_TOKEN'] })
    expect(varHidden(h, 'SLACK_TOKEN')).toBe(true)
    expect(varHidden(h, 'SLACK_TOKEN2')).toBe(false)
  })

  it('patterns are globs over names', () => {
    const h = varsOnly({ patterns: ['AWS_*', '*_SECRET'] })
    expect(varHidden(h, 'AWS_ACCESS_KEY_ID')).toBe(true)
    expect(varHidden(h, 'DB_SECRET')).toBe(true)
    expect(varHidden(h, 'HOME')).toBe(false)
  })
})

describe('classifyPaths', () => {
  it('splits globs from exact subtrees, in the order written', () => {
    expect(classifyPaths(['/repo/.env', '*.pem', '/repo/docs/*', 'secrets'])).toEqual({
      paths: ['/repo/.env', 'secrets'],
      patterns: ['*.pem', '/repo/docs/*'],
    })
    expect(isGlob('/a/b[1]')).toBe(true)
    expect(isGlob('/a/?')).toBe(true)
    expect(isGlob('/a/b')).toBe(false)
  })

  it('empty is unrestricted', () => {
    expect(classifyPaths([])).toBeNull()
  })

  it('classified entries match like a hand-built spec', () => {
    const spec = vis(classifyPaths(['/s3/secrets', '*.key', '/repo/docs/*']))
    expect(pathVisible(spec, '/s3/secrets/deep/b')).toBe(false)
    expect(pathVisible(spec, '/a/b.key/c')).toBe(false)
    expect(pathVisible(spec, '/repo/docs/x/y')).toBe(false)
    expect(pathVisible(spec, '/repo/docsx')).toBe(true)
  })
})

describe('showHead', () => {
  it('is the anchor', () => {
    expect(showHead('/repo/public')).toBe('/repo/public')
    expect(showHead('/repo/docs/*')).toBe('/repo/docs')
    expect(showHead('/repo/*/x')).toBe('/repo')
  })
})

describe('pathVisible', () => {
  const hidden = classifyPaths(['/repo'])
  const shown = shows([{ path: '/repo/public', mode: MountMode.READ }])

  it('null and empty specs hide nothing', () => {
    expect(pathVisible(null, '/a/b')).toBe(true)
    expect(pathVisible(vis({}), '/a/b')).toBe(true)
  })

  it('is the anchor-depth rule', () => {
    expect(pathVisible(vis(hidden, shown), '/repo/public/index.html')).toBe(true)
    expect(pathVisible(vis(hidden, shown), '/repo/public')).toBe(true)
    expect(pathVisible(vis(hidden, shown), '/repo/secrets/key.pem')).toBe(false)
    expect(pathVisible(vis(null, shown), '/anywhere')).toBe(true)
    expect(pathVisible(vis(hidden), '/repo/x')).toBe(false)
  })

  it('lets hide win the equal-depth tie', () => {
    const tied = classifyPaths(['/repo/public'])
    expect(pathVisible(vis(tied, shown), '/repo/public/x')).toBe(false)
  })

  it('re-closes a deeper hide inside a show', () => {
    const nested = classifyPaths(['/repo', '/repo/public/sealed'])
    expect(pathVisible(vis(nested, shown), '/repo/public/a.txt')).toBe(true)
    expect(pathVisible(vis(nested, shown), '/repo/public/sealed/k')).toBe(false)
  })

  it('outranks a name pattern only inside the anchor', () => {
    const pem = classifyPaths(['*.pem'])
    const open = shows([{ path: '/repo/public', mode: null }])
    expect(pathVisible(vis(pem, open), '/repo/public/tls.pem')).toBe(true)
    expect(pathVisible(vis(pem, open), '/other/tls.pem')).toBe(false)
  })

  it('keeps ancestors of a show anchor visible', () => {
    const deep = shows([{ path: '/repo/public/docs', mode: null }])
    for (const virtual of ['/', '/repo', '/repo/public']) {
      expect(pathVisible(vis(hidden, deep), virtual)).toBe(true)
    }
    expect(pathVisible(vis(hidden, deep), '/repo/other')).toBe(false)
  })

  it('opens no road through a hidden show anchor', () => {
    const reclosed = classifyPaths(['/repo', '/repo/public'])
    const open = shows([{ path: '/repo/public', mode: null }])
    expect(pathVisible(vis(reclosed, open), '/repo')).toBe(false)
    expect(pathVisible(vis(reclosed, open), '/repo/public/x')).toBe(false)
  })
})

describe('hiddenUnder', () => {
  it('is the per-operand gate', () => {
    const spec = classifyPaths(['/repo/.env'])
    expect(hiddenUnder(vis(spec), '/repo')).toBe(true)
    expect(hiddenUnder(vis(spec), '/')).toBe(true)
    expect(hiddenUnder(vis(spec), '/repo/.env')).toBe(true)
    expect(hiddenUnder(vis(spec), '/s3')).toBe(false)
    expect(hiddenUnder(vis(spec), '/repo/open')).toBe(false)
    expect(hiddenUnder(vis(classifyPaths(['*.pem'])), '/s3')).toBe(true)
    const sealed = classifyPaths(['/repo/sealed/*'])
    expect(hiddenUnder(vis(sealed), '/repo')).toBe(true)
    expect(hiddenUnder(vis(sealed), '/repo/sealed/x')).toBe(true)
    expect(hiddenUnder(vis(sealed), '/repo/open')).toBe(false)
    expect(hiddenUnder(null, '/')).toBe(false)
  })

  it("counts an operand below a pattern's head", () => {
    // The wildcard tail can match anywhere under the fixed head, so a
    // walk of any subtree below it may hold matches (`/repo/*/secret`
    // covers `/repo/public/secret`), even though the operand itself is
    // neither hidden nor an ancestor of the head.
    const spec = classifyPaths(['/repo/*/secret'])
    expect(hiddenUnder(vis(spec), '/repo/public')).toBe(true)
    expect(hiddenUnder(vis(spec), '/repo/public/deep')).toBe(true)
    expect(hiddenUnder(vis(spec), '/repo')).toBe(true)
    expect(hiddenUnder(vis(spec), '/other')).toBe(false)
  })
})

describe('a globbed show keeps its anchor traversable', () => {
  it('the anchor and the road above answer by the same compare', () => {
    // `hide /repo` + `show /repo/public/*`: the matches score the
    // anchor's depth, so the anchor directory and the road above it
    // stay visible instead of hiding around visible children.
    const hidden = classifyPaths(['/repo'])
    const shown = shows([{ path: '/repo/public/*', mode: null }])
    expect(pathVisible(vis(hidden, shown), '/repo/public/index.html')).toBe(true)
    expect(pathVisible(vis(hidden, shown), '/repo/public')).toBe(true)
    expect(pathVisible(vis(hidden, shown), '/repo')).toBe(true)
    expect(pathVisible(vis(hidden, shown), '/repo/secrets')).toBe(false)
    // A hide at the anchor's own depth still wins the tie.
    const rehidden = classifyPaths(['/repo', '/repo/public'])
    expect(pathVisible(vis(rehidden, shown), '/repo/public')).toBe(false)
    expect(pathVisible(vis(rehidden, shown), '/repo/public/index.html')).toBe(false)
  })
})

describe('moveReveals', () => {
  it('an exact entry below the source reveals at its mapped path', () => {
    const spec = classifyPaths(['/m/data/secret'])
    expect(moveReveals(vis(spec), '/m/data', '/m/moved')).toBe(true)
    expect(moveReveals(vis(spec), '/m/other', '/m/moved')).toBe(false)
    // The entry itself is the source: the operand is hidden and the
    // per-path guard answered before this predicate is asked.
    expect(moveReveals(vis(spec), '/m/data/secret/deep', '/m/x')).toBe(false)
    expect(moveReveals(null, '/m/data', '/m/moved')).toBe(false)
  })

  it('no reveal when the mapped path stays hidden', () => {
    const spec = classifyPaths(['/m/d/sec', '/m/moved/sec'])
    expect(moveReveals(vis(spec), '/m/d', '/m/moved')).toBe(false)
    expect(moveReveals(vis(spec), '/m/d', '/m/elsewhere')).toBe(true)
  })

  it('component patterns follow the name and never reveal', () => {
    expect(moveReveals(vis(classifyPaths(['*.env'])), '/m/d', '/m/moved')).toBe(false)
  })

  it('anchored patterns fail toward refusal', () => {
    expect(moveReveals(vis(classifyPaths(['/m/d/sec/*'])), '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(vis(classifyPaths(['/m/d/*'])), '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(vis(classifyPaths(['/m/*/secret'])), '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(vis(classifyPaths(['/other/*/secret'])), '/m/d', '/m/moved')).toBe(false)
  })

  it('a show below the mapped path counts as a reveal', () => {
    const hidden = classifyPaths(['/m/d/sec', '/m/moved'])
    const shown = shows([{ path: '/m/moved/sec/open', mode: null }])
    expect(moveReveals(vis(hidden, shown), '/m/d', '/m/moved')).toBe(true)
    expect(moveReveals(vis(hidden), '/m/d', '/m/moved')).toBe(false)
  })

  it('a source reached through a show reveals what it leaves hidden', () => {
    // /m/box is hidden and reached only through its shown pub.txt, so the
    // rest of it sits under a hide that does not move with it.
    const shown = shows([{ path: '/m/box/pub.txt', mode: null }])
    expect(moveReveals(vis(classifyPaths(['/m/box']), shown), '/m/box', '/v/mb')).toBe(true)
    expect(moveReveals(vis(classifyPaths(['/m']), shown), '/m/box', '/v/mb')).toBe(true)
    // Into a place the session does not see, nothing comes into view.
    expect(moveReveals(vis(classifyPaths(['/m/box', '/v']), shown), '/m/box', '/v/mb')).toBe(false)
    // A show at the source reopens all of it.
    const whole = shows([{ path: '/m/box', mode: null }])
    expect(moveReveals(vis(classifyPaths(['/m']), whole), '/m/box', '/v/mb')).toBe(false)
  })
})

const LINKS = new Map([
  ['/data/shared/to_secret', '/data/secret/f'],
  ['/data/shared/rel_secret', '../secret/f'],
  ['/data/shared/dirlink', '/data/secret'],
  ['/data/shared/chain', '/data/shared/to_secret'],
  ['/data/shared/to_pub', '/data/pub/n.txt'],
  ['/data/shared/dangling', '/data/nope'],
  ['/data/shared/loop', '/data/shared/loop'],
  ['/data/shared/through', '/data/secret/../pub/n.txt'],
  ['/data/alias', '/data/secret'],
  ['/data/shared/via_alias', '/data/alias/f'],
])

describe('leadsHidden', () => {
  it('does not inspect targets of hidden links', () => {
    const lookups: string[] = []
    class LookupLinks extends Map<string, string> {
      override get(path: string): string | undefined {
        lookups.push(path)
        return super.get(path)
      }
    }
    const links = new LookupLinks([['/secret/link', '/x']])
    const scope = vis(classifyPaths(['/secret']))
    expect(visibleLinks(scope, ['/secret/link', '/public'], links)).toEqual([false, true])
    expect(lookups).not.toContain('/secret/link')
  })

  it('reads only reached links and observes same-size mutations', () => {
    class LookupLinks extends Map<string, string> {
      override [Symbol.iterator](): MapIterator<[string, string]> {
        throw new Error('Unrelated link entries must not be enumerated')
      }
    }
    const links = new LookupLinks(
      Array.from({ length: 10000 }, (_, index) => [`/unused${String(index)}`, '/public']),
    )
    links.set('/link', '/public')
    const scope = vis(classifyPaths(['/secret']))
    expect(leadsHidden(scope, '/link', links)).toBe(false)
    links.set('/link', '/secret')
    expect(leadsHidden(scope, '/link', links)).toBe(true)
  })

  it.each(['', '.', './', '/./'])('keeps effective parent steps after target %s', (target) => {
    const links = new Map([['/link', target]])
    const path = '/link/secret/./..//public/'
    expect(resolveSymlinks(path, links)).toBe('/public/')
    expect(leadsHidden(vis(classifyPaths(['/secret'])), path, links)).toBe(true)
  })

  it('checks the followed link name before the hop limit', () => {
    const links = new Map(
      Array.from({ length: 41 }, (_, index) => [
        `/link${String(index)}`,
        `/link${String(index + 1)}`,
      ]),
    )
    expect(leadsHidden(vis(classifyPaths(['/link40'])), '/link0', links)).toBe(true)
    expect(leadsHidden(vis(classifyPaths(['/elsewhere'])), '/link0', links)).toBe(false)
    expect(() => resolveSymlinks('/link0', links)).toThrow(CycleError)
  })

  it('propagates lookup errors', () => {
    const failure = new CycleError('/caller')
    class ErrorLinks extends Map<string, string> {
      override get(): string | undefined {
        throw failure
      }
    }
    expect(() =>
      leadsHidden(vis(classifyPaths(['/secret'])), '/link', new ErrorLinks([['/link', '/public']])),
    ).toThrow(failure)
  })

  it('keeps batch order and surrogate target text', () => {
    const links = new Map([['/link\ud800', '/secret\ud800/../public']])
    const scope = vis(classifyPaths(['/secret\ud800']))
    expect(resolveSymlinks('/link\ud800/', links)).toBe('/public/')
    expect(visibleLinks(scope, ['/link\ud800', '/public', '/secret\ud800/key'], links)).toEqual([
      false,
      true,
      false,
    ])
    links.set('/link\ud800', '/public')
    expect(visibleLinks(scope, ['/link\ud800'], links)).toEqual([true])
  })
  it('follows a link into hidden space', () => {
    const v = vis(classifyPaths(['/data/secret']))
    for (const path of [
      '/data/shared/to_secret',
      '/data/shared/rel_secret',
      '/data/shared/dirlink',
      '/data/shared/dirlink/f',
      '/data/shared/chain',
      '/data/shared/through',
      '/data/shared/via_alias',
    ]) {
      expect(leadsHidden(v, path, LINKS), path).toBe(true)
    }
    for (const path of [
      '/data/shared/to_pub',
      '/data/shared/dangling',
      '/data/shared/loop',
      '/data/pub/n.txt',
    ]) {
      expect(leadsHidden(v, path, LINKS), path).toBe(false)
    }
  })

  it('judges what a link brings in, not the typed path', () => {
    const carved = vis(classifyPaths(['*.key']), shows([{ path: '/repo/*/public', mode: null }]))
    const links = new Map([
      ['/other/l', '/x'],
      ['/repo/alias', '/repo/dir.key/public'],
    ])
    expect(pathVisible(carved, '/repo/dir.key/public/f.txt')).toBe(true)
    expect(leadsHidden(carved, '/repo/dir.key/public/f.txt', links)).toBe(false)
    expect(leadsHidden(carved, '/repo/alias/f.txt', links)).toBe(false)
  })

  it('needs a hide and a link', () => {
    expect(leadsHidden(null, '/data/shared/to_secret', LINKS)).toBe(false)
    expect(leadsHidden(vis(classifyPaths([])), '/data/shared/to_secret', LINKS)).toBe(false)
    expect(
      leadsHidden(vis(classifyPaths(['/data/secret'])), '/data/shared/to_secret', new Map()),
    ).toBe(false)
  })
})
