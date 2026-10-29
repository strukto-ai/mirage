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

// Every expectation is curl 8.14.1's, measured in debian:stable-slim.

import { describe, expect, it } from 'vitest'
import {
  CookieJar,
  JAR_HEADER,
  cookieValue,
  defaultPath,
  parseDate,
  pathMatches,
  sameOrigin,
} from './cookie.ts'

const NOW = 1793237940
const HOST = 'http://127.0.0.1:8080'

function jar(engine = true, literal: string | null = null): CookieJar {
  return new CookieJar(engine, literal, () => NOW)
}

function lines(j: CookieJar): string[] {
  return j.render().slice(JAR_HEADER.length).split('\n').slice(0, -1)
}

describe('parseDate', () => {
  it.each([
    ['Fri, 01 Jan 2027 00:00:00 GMT', 1798761600],
    ['Friday, 01-Jan-27 00:00:00 GMT', 1798761600],
    ['Fri Jan  1 00:00:00 2027', 1798761600],
    ['Fri, 01 Jan 2027 00:00:00 +0100', 1798758000],
    ['Fri, 01 Jan 2027 00:00:00 PST', 1798790400],
    ['01 Jan 2027', 1798761600],
    ['Fri, 1 Jan 2027 1:2:3 GMT', 1798765323],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 0],
    ['Fri, 01 Jan 70 00:00:00 GMT', 3155760000],
    ['Fri, 01 Jan 71 00:00:00 GMT', 31536000],
    ['Fri, 01-Jan-2027 00:00:00 GMT', 1798761600],
    ['Thu, 01-Jan-1970 00:00:00 GMT', 0],
    ['Fri, 01 Jan 2027 00:00:00-0800', 1798790400],
    ['Fri, 01 Jan 2027 00:00:00 +1400', 1798711200],
    ['Fri, 01 Jan 2027 00:00:00 +0060', 1798758000],
    ['Fri, 01 Jan 2027 00:00:00 GMT-0800', 1798761600],
    ['Fri, 01 Jan-0800 2027', 1798790400],
    ['Jan 01 2027 -1200', 1798804800],
  ])('reads %s', (text, epoch) => {
    expect(parseDate(text)).toBe(epoch)
  })

  it.each([
    '2027-01-01 00:00:00',
    'Fri, 32 Jan 2027 00:00:00 GMT',
    'Fri, 01 Jan 2027 25:00:00 GMT',
    'Wed, 31 Dec 1969 23:59:59 GMT',
    'Mon, 01 Jan 1601 00:00:00 GMT',
    'notadate',
    'Fri, 01 Jan 2027 00:00:00 +1401',
    'Fri, 01 Jan 2027 00:00:00 +12',
  ])('refuses %s', (text) => {
    expect(parseDate(text)).toBeNull()
  })
})

describe('paths', () => {
  it('defaults to the request path up to its last slash', () => {
    expect(['/x', '/jar/', '/jar', '/jar/a/b', '/a/b/c/'].map(defaultPath)).toEqual([
      '/',
      '/jar/',
      '/',
      '/jar/a/',
      '/a/b/c/',
    ])
  })

  it('matches below the path and ignores a trailing slash', () => {
    const covered = (cookie: string): string[] =>
      ['/jar/a', '/jar/a/x', '/jar/ab', '/jar/', '/Jar/a'].filter((p) => pathMatches(cookie, p))
    expect(covered('/jar/a/')).toEqual(['/jar/a', '/jar/a/x'])
    expect(covered('/jar/a')).toEqual(['/jar/a', '/jar/a/x'])
    expect(covered('abc')).toHaveLength(5)
    expect(covered('')).toHaveLength(5)
  })
})

describe('CookieJar', () => {
  it('writes the login a server set, newest first, HttpOnly marked', () => {
    const j = jar()
    j.store(`${HOST}/jar/login`, [
      'session=s3cr3t; Path=/; HttpOnly',
      'theme=dark; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT',
    ])
    expect(j.render()).toBe(
      JAR_HEADER +
        '127.0.0.1\tFALSE\t/\tFALSE\t1827797940\ttheme\tdark\n' +
        '#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\ts3cr3t\n',
    )
    expect(j.header(`${HOST}/jar/private`)).toBe('session=s3cr3t; theme=dark')
  })

  it('writes the header alone for an empty jar', () => {
    expect(jar().render()).toBe(JAR_HEADER)
  })

  it('sends longer paths, then longer names, then newer cookies first', () => {
    const j = jar()
    j.store(`${HOST}/jar/x`, ['b=1; Path=/', 'a=1; Path=/', 'long=1; Path=/', 'p=1; Path=/jar'])
    j.store(`${HOST}/jar/x`, ['q=1; Path=/jar/x'])
    expect(j.header(`${HOST}/jar/x`)).toBe('q=1; p=1; long=1; a=1; b=1')
  })

  it('keeps a replaced cookie in its place', () => {
    const j = jar()
    j.load('127.0.0.1\tFALSE\t/\tFALSE\t0\taa\t1\n127.0.0.1\tFALSE\t/\tFALSE\t0\tbb\t1\n')
    j.store(`${HOST}/x`, ['aa=2; Path=/'])
    expect(lines(j)).toEqual([
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tbb\t1',
      '127.0.0.1\tFALSE\t/\tFALSE\t0\taa\t2',
    ])
    expect(j.header(`${HOST}/x`)).toBe('bb=1; aa=2')
  })

  it('takes the default path and the last attribute of a name', () => {
    const j = jar()
    j.store(`${HOST}/jar/a/b`, ['p=1', 'v=1; Path=/a; Path=/; Max-Age=60; Max-Age=0'])
    expect(lines(j)).toEqual(['127.0.0.1\tFALSE\t/jar/a/\tFALSE\t0\tp\t1'])
    expect([j.header(`${HOST}/jar/a`), j.header(`${HOST}/jar/x`)]).toEqual(['p=1', null])
  })

  it('times Max-Age from arrival and caps a lifetime at 400 days', () => {
    const now = 1793238212
    const j = new CookieJar(true, null, () => now)
    j.store(`${HOST}/x`, [
      'm=1; Max-Age=100; Path=/',
      'exact=1; Max-Age=34560000; Path=/',
      'over=1; Max-Age=34560001; Path=/',
      'both=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60; Path=/',
      'lead=1; Max-Age=12abc; Path=/',
    ])
    expect(lines(j).map((line) => line.split('\t').slice(4, 6).join(' '))).toEqual([
      `${String(now + 12)} lead`,
      `${String(now + 60)} both`,
      '1827798240 over',
      '1827798212 exact',
      `${String(now + 100)} m`,
    ])
  })

  it('deletes on an expired Max-Age or Expires and drops a bad Max-Age', () => {
    const j = jar()
    j.load(
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tgone\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t0\tpast\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t0\tkept\told\n',
    )
    j.store(`${HOST}/x`, [
      'gone=; Max-Age=-5; Path=/',
      'past=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      'kept=1; Max-Age=abc; Path=/',
      'plus=1; Max-Age=+30; Path=/',
      'new=1; Max-Age=0; Path=/',
      'bad=1; Expires=notadate; Path=/',
    ])
    expect(lines(j)).toEqual([
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tbad\t1',
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tkept\told',
    ])
  })

  it('bounds a Max-Age or a file expiry of any length', () => {
    const j = jar()
    j.store(`${HOST}/x`, [
      `big=1; Max-Age=${'9'.repeat(5000)}; Path=/`,
      `neg=1; Max-Age=-${'9'.repeat(5000)}; Path=/`,
    ])
    j.load(
      `127.0.0.1\tFALSE\t/\tFALSE\t${'9'.repeat(23)}\thuge\t1\n` +
        '127.0.0.1\tFALSE\t/\tFALSE\t9223372036854775808\tover\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t9223372036854775807\tmax\t1\n',
    )
    expect(j.header(`${HOST}/x`)).toBe('max=1; big=1')
    expect(j.cookies.find((c) => c.name === 'big')?.expires).toBe(NOW + 34560000)
  })

  it('keeps a Secure cookie from plain http on a remote host', () => {
    const j = jar()
    const plain = 'http://s.example.com/x'
    j.load(
      's.example.com\tFALSE\t/\tTRUE\t0\tsession\tgood\n' +
        's.example.com\tFALSE\t/ab\tTRUE\t0\tdeep\tgood\n' +
        '.example.com\tTRUE\t/\tTRUE\t0\twide\tgood\n',
    )
    j.store(plain, [
      'session=attacker; Path=/',
      'session=; Max-Age=0; Path=/',
      'session=attacker; Path=/x',
      'deep=a; Path=/a',
      'wide=a; Path=/',
    ])
    expect(lines(j)).toEqual([
      's.example.com\tFALSE\t/\tFALSE\t0\twide\ta',
      's.example.com\tFALSE\t/a\tFALSE\t0\tdeep\ta',
      '.example.com\tTRUE\t/\tTRUE\t0\twide\tgood',
      's.example.com\tFALSE\t/ab\tTRUE\t0\tdeep\tgood',
      's.example.com\tFALSE\t/\tTRUE\t0\tsession\tgood',
    ])
    j.store('https://s.example.com/x', ['session=new; Path=/'])
    expect(j.header('https://s.example.com/')).toContain('session=new')
    const local = jar()
    local.load('127.0.0.1\tFALSE\t/\tTRUE\t0\tsession\tgood\n')
    local.store(`${HOST}/x`, ['session=new; Path=/'])
    expect(lines(local)).toEqual(['127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tnew'])
  })

  it('reads a name and value the way curl does', () => {
    const j = jar()
    j.store(`${HOST}/x`, [
      'flag',
      '=x; Path=/',
      'e=; Path=/',
      ' n = v ; Path=/',
      'eq=a=b; Path=/',
      'tv=a\tb; Path=/',
      'cv=a\u0001b; Path=/',
    ])
    expect(j.header(`${HOST}/x`)).toBe('eq=a=b; n=v; e=; =x')
  })

  it('holds a Domain to the request host', () => {
    const j = jar()
    const sub = 'http://sub.example.com:8080/x'
    j.store(sub, [
      'dp=1; Domain=example.com; Path=/',
      'dc=1; Domain=com; Path=/',
      'ds=1; Domain=sub.example.com; Path=/',
      'du=1; Domain=EXAMPLE.COM; Path=/',
      'de=1; Domain=; Path=/',
      'dx=1; Domain=xample.com; Path=/',
    ])
    j.store(`${HOST}/x`, ['di=1; Domain=.127.0.0.1; Path=/', 'd2=1; Domain=0.0.1; Path=/'])
    expect(lines(j)).toEqual([
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tdi\t1',
      'sub.example.com\tFALSE\t/\tFALSE\t0\tde\t1',
      '.EXAMPLE.COM\tTRUE\t/\tFALSE\t0\tdu\t1',
      '.sub.example.com\tTRUE\t/\tFALSE\t0\tds\t1',
      '.example.com\tTRUE\t/\tFALSE\t0\tdp\t1',
    ])
    expect(j.header('http://other.example.com:8080/x')).toBe('du=1; dp=1')
  })

  it('takes a Secure cookie over http only from a local host', () => {
    const j = jar()
    j.store(`${HOST}/x`, ['sec=1; Secure; Path=/'])
    j.store('http://localhost:8080/x', ['sec=1; Secure; Path=/'])
    j.store('http://[::1]:8080/x', ['sec=1; Secure; Path=/'])
    j.store('http://sub.example.com/x', ['sec=1; Secure; Path=/', 'plain=1; Path=/'])
    expect(lines(j).map((line) => line.split('\t')[0])).toEqual([
      'sub.example.com',
      '::1',
      'localhost',
      '127.0.0.1',
    ])
    j.load('sub.example.com\tFALSE\t/\tTRUE\t0\tsecf\t1\n')
    expect(j.header('http://sub.example.com/x')).toBe('plain=1')
    expect(j.header('https://sub.example.com/x')).toBe('plain=1; secf=1')
    expect(j.header(`${HOST}/x`)).toBe('sec=1')
  })

  it('holds the name prefixes to their rules, case and all', () => {
    const j = jar()
    j.store(`${HOST}/x`, [
      '__Secure-a=1; Path=/',
      '__Secure-b=1; Secure; Path=/',
      '__Host-c=1; Secure; Path=/',
      '__Host-d=1; Secure; Path=/jar',
      '__Host-e=1; Path=/',
      '__secure-x=1; Path=/',
      '__Host-z=1; Secure; Path=/; Domain=127.0.0.1',
    ])
    expect(lines(j).map((line) => line.split('\t')[5])).toEqual([
      '__Host-z',
      '__secure-x',
      '__Host-c',
      '__Secure-b',
    ])
  })

  it('loads a cookie file and writes it back', () => {
    const j = jar()
    j.load(
      '# comment\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t1\told\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t0\tsess\t1\r\n' +
        '#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tho\t1\n' +
        '127.0.0.1\tTRUE\t/\tFALSE\t0\tsub\t1\n' +
        'example.com\tFALSE\t/\tFALSE\t0\tother\t1\n' +
        'bad line\n' +
        '127.0.0.1\tfalse\t/\ttrue\t0\tlt\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\tabc\tbe\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t 0\tsp\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t0x10\thx\t1\n' +
        '127.0.0.1\tFALSE\t/\tFALSE\t0\tnoval\n',
    )
    expect(j.header(`${HOST}/x`)).toBe('noval=; sess=1; sub=1; hx=1; lt=1; ho=1')
    expect(lines(j)).toEqual([
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tnoval\t',
      '127.0.0.1\tFALSE\t/\tFALSE\t0\thx\t1',
      '127.0.0.1\tFALSE\t/\tTRUE\t0\tlt\t1',
      'example.com\tFALSE\t/\tFALSE\t0\tother\t1',
      '.127.0.0.1\tTRUE\t/\tFALSE\t0\tsub\t1',
      '#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tho\t1',
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tsess\t1',
    ])
  })

  it('loads Set-Cookie lines, a domainless one riding everywhere unsaved', () => {
    const j = jar()
    j.load('Set-Cookie: sa=1; Path=/\nset-cookie: sb=2\nSet-Cookie: sc=3; Domain=example.com\n')
    expect(j.header(`${HOST}/jar/x`)).toBe('sa=1; sb=2')
    expect(lines(j)).toEqual(['.example.com\tTRUE\t/\tFALSE\t0\tsc\t3'])
  })

  it('sends the literal data after the jar and keeps nothing with the engine off', () => {
    const on = jar(true, 'x=1')
    on.store(`${HOST}/x`, ['a=1; Path=/'])
    expect(on.header(`${HOST}/x`)).toBe('a=1; x=1')
    const off = jar(false, 'a=1;b=2')
    off.store(`${HOST}/x`, ['h=1; Path=/'])
    expect([off.header(`${HOST}/x`), off.header('http://localhost/y')]).toEqual([
      'a=1;b=2',
      'a=1;b=2',
    ])
    expect(off.cookies).toEqual([])
    expect(jar(false).header(`${HOST}/x`)).toBeNull()
    expect(off.sent).toEqual(['a=1;b=2', 'a=1;b=2'])
  })
})

describe('sameOrigin', () => {
  it('compares scheme, host and port', () => {
    expect(sameOrigin('http://a.test/x', 'http://a.test:80/y')).toBe(true)
    expect(sameOrigin('http://a.test/x', 'https://a.test/x')).toBe(false)
    expect(sameOrigin('http://a.test/x', 'http://b.test/x')).toBe(false)
    expect(sameOrigin('http://a.test:8080/x', 'http://a.test/x')).toBe(false)
    expect(sameOrigin('not a url', 'http://a.test/')).toBe(false)
  })
})

describe('cookieValue', () => {
  it('joins the jar part and the typed header', () => {
    expect(cookieValue('a=1', 'x=1')).toBe('a=1; x=1')
    expect(cookieValue(null, 'x=1')).toBe('x=1')
    expect(cookieValue('a=1', null)).toBe('a=1')
    expect(cookieValue(null, null)).toBeNull()
  })
})
