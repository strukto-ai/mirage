// Node's common APIs over qjs's std and os: fs, path, process, Buffer,
// require, the timers and node's console. The runtime evaluates this file
// ahead of a program (node.py, node.ts), and its value, the function
// below, takes the program's argv and script path, so a script written for
// node finds what it reaches for first. Its twin in the other host must stay
// byte-identical (python/tests/runtime/js/quickjs/test_node.py).
;(function (argv, script) {
  'use strict'
  const g = globalThis
  const define = (name, value) => {
    if (!(name in g)) {
      Object.defineProperty(g, name, {
        value,
        writable: true,
        configurable: true,
      })
    }
  }

  // An error the shim raises points at its caller's line, as a builtin's
  // does, rather than at the shim's own frames.
  const ours = new WeakSet()
  const raise = (e) => {
    ours.add(e)
    return e
  }
  const api = (fn) => {
    const call = function (...args) {
      try {
        return fn.apply(this, args)
      } catch (e) {
        if (ours.has(e)) Error.captureStackTrace(e, call)
        throw e
      }
    }
    Object.defineProperty(call, 'name', { value: fn.name })
    return call
  }

  // WASI's errno numbers, the ones std.open and os report, by node's
  // code and the number node reports on Linux.
  const CODES = {
    1: ['E2BIG', 7],
    2: ['EACCES', 13],
    6: ['EAGAIN', 11],
    8: ['EBADF', 9],
    10: ['EBUSY', 16],
    11: ['ECANCELED', 125],
    19: ['EDQUOT', 122],
    20: ['EEXIST', 17],
    21: ['EFAULT', 14],
    22: ['EFBIG', 27],
    27: ['EINTR', 4],
    28: ['EINVAL', 22],
    29: ['EIO', 5],
    31: ['EISDIR', 21],
    32: ['ELOOP', 40],
    33: ['EMFILE', 24],
    34: ['EMLINK', 31],
    37: ['ENAMETOOLONG', 36],
    41: ['ENFILE', 23],
    43: ['ENODEV', 19],
    44: ['ENOENT', 2],
    48: ['ENOMEM', 12],
    51: ['ENOSPC', 28],
    52: ['ENOSYS', 38],
    54: ['ENOTDIR', 20],
    55: ['ENOTEMPTY', 39],
    58: ['ENOTSUP', 95],
    59: ['ENOTTY', 25],
    60: ['ENXIO', 6],
    61: ['EOVERFLOW', 75],
    63: ['EPERM', 1],
    64: ['EPIPE', 32],
    69: ['EROFS', 30],
    70: ['ESPIPE', 29],
    73: ['ETIMEDOUT', 110],
    74: ['ETXTBSY', 26],
    75: ['EXDEV', 18],
  }
  function failure(errno, syscall, file) {
    const text = std.strerror(errno)
    const [code, number] = CODES[errno] || ['UNKNOWN', errno]
    const e = new Error(
      code +
        ': ' +
        text.charAt(0).toLowerCase() +
        text.slice(1) +
        ', ' +
        syscall +
        " '" +
        file +
        "'",
    )
    e.errno = -number
    e.code = code
    e.syscall = syscall
    e.path = file
    return raise(e)
  }
  const check = (r, syscall, file) => {
    if (r < 0) throw failure(-r, syscall, file)
  }

  // Bytes and text. The engine has no TextDecoder, so UTF-8 goes through
  // the URI functions, with a loose decoder for bytes they refuse.
  function latin1(bytes, start, end) {
    let s = ''
    for (let i = start; i < end; i += 8192) {
      const part = bytes.subarray(i, Math.min(end, i + 8192))
      s += String.fromCharCode.apply(null, part)
    }
    return s
  }
  function codes(s, mask) {
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & mask
    return out
  }
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
  function utf8Bytes(text) {
    try {
      return codes(unescape(encodeURIComponent(text)), 0xff)
    } catch {
      return codes(unescape(encodeURIComponent(text.replace(LONE, '�'))), 0xff)
    }
  }
  function looseText(bytes, start, end) {
    const units = []
    let s = ''
    for (let i = start; i < end;) {
      const b = bytes[i]
      const n =
        b < 0x80
          ? 0
          : b >= 0xc2 && b <= 0xdf
            ? 1
            : b >= 0xe0 && b <= 0xef
              ? 2
              : b >= 0xf0 && b <= 0xf4
                ? 3
                : -1
      let c = n <= 0 ? b : b & (0x3f >> n)
      let j = 1
      while (j <= n && i + j < end && (bytes[i + j] & 0xc0) === 0x80) {
        c = (c << 6) | (bytes[i + j] & 0x3f)
        j++
      }
      const bad =
        n < 0 ||
        j <= n ||
        (n === 2 && c < 0x800) ||
        (n === 3 && (c < 0x10000 || c > 0x10ffff)) ||
        (c >= 0xd800 && c <= 0xdfff)
      if (bad) units.push(0xfffd)
      else if (c >= 0x10000) {
        units.push(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + (c & 0x3ff))
      } else units.push(c)
      i += j
      if (units.length >= 8192) {
        s += String.fromCharCode.apply(null, units)
        units.length = 0
      }
    }
    return s + String.fromCharCode.apply(null, units)
  }
  function utf8Text(bytes, start, end) {
    try {
      return decodeURIComponent(escape(latin1(bytes, start, end)))
    } catch {
      return looseText(bytes, start, end)
    }
  }
  function encodingName(encoding) {
    const e = String(encoding).toLowerCase()
    if (e === 'utf8' || e === 'utf-8') return 'utf8'
    if (e === 'latin1' || e === 'binary') return 'latin1'
    if (['ascii', 'base64', 'base64url', 'hex'].includes(e)) return e
    const err = new TypeError('Unknown encoding: ' + encoding)
    err.code = 'ERR_UNKNOWN_ENCODING'
    throw raise(err)
  }
  function bytesOf(text, encoding) {
    const e = encodingName(encoding)
    if (e === 'utf8') return utf8Bytes(text)
    if (e === 'hex') {
      const out = new Uint8Array(text.length >> 1)
      for (let i = 0; i < out.length; i++) {
        const v = parseInt(text.substr(i * 2, 2), 16)
        if (Number.isNaN(v)) return out.subarray(0, i)
        out[i] = v
      }
      return out
    }
    if (e === 'base64' || e === 'base64url') {
      let s = text.replace(/-/g, '+').replace(/_/g, '/')
      s = s.replace(/[^A-Za-z0-9+/]/g, '')
      if (s.length % 4 === 1) s = s.slice(0, -1)
      while (s.length % 4) s += '='
      return codes(atob(s), 0xff)
    }
    return codes(text, 0xff)
  }
  const HEX = '0123456789abcdef'
  function textOf(bytes, encoding, start, end) {
    const e = encodingName(encoding)
    if (e === 'utf8') return utf8Text(bytes, start, end)
    if (e === 'latin1') return latin1(bytes, start, end)
    if (e === 'ascii') {
      return latin1(
        bytes.map((b) => b & 0x7f),
        start,
        end,
      )
    }
    if (e === 'hex') {
      let s = ''
      for (let i = start; i < end; i++) {
        s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
      }
      return s
    }
    const b64 = btoa(latin1(bytes, start, end))
    if (e === 'base64') return b64
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const view = (data) =>
    ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)

  class Buffer extends Uint8Array {
    static from(value, encoding, length) {
      if (typeof value === 'string') {
        const bytes = bytesOf(value, encoding === undefined ? 'utf8' : encoding)
        return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      }
      if (value instanceof ArrayBuffer) {
        return new Buffer(value, encoding || 0, length)
      }
      return new Buffer(value)
    }
    static alloc(size, fill, encoding) {
      const b = new Buffer(size)
      if (fill === undefined) return b
      if (typeof fill === 'number') return b.fill(fill & 255)
      const bytes =
        typeof fill === 'string'
          ? bytesOf(fill, encoding === undefined ? 'utf8' : encoding)
          : view(fill)
      if (bytes.length === 0) return b
      for (let i = 0; i < size; i++) b[i] = bytes[i % bytes.length]
      return b
    }
    static isBuffer(value) {
      return value instanceof Buffer
    }
    static byteLength(value, encoding) {
      if (typeof value !== 'string') return value.byteLength
      return bytesOf(value, encoding === undefined ? 'utf8' : encoding).length
    }
    static concat(list, total) {
      const size = total === undefined ? list.reduce((n, b) => n + b.length, 0) : total
      const out = new Buffer(size)
      let at = 0
      for (const b of list) {
        if (at >= size) break
        out.set(b.subarray(0, size - at), at)
        at += Math.min(b.length, size - at)
      }
      return out
    }
    toString(encoding, start, end) {
      const from = Math.max(0, start === undefined ? 0 : start)
      const to = end === undefined ? this.length : Math.min(this.length, end)
      if (from >= to) return ''
      return textOf(this, encoding === undefined ? 'utf8' : encoding, from, to)
    }
    toJSON() {
      return { type: 'Buffer', data: Array.from(this) }
    }
    equals(other) {
      return this.length === other.length && this.every((b, i) => b === other[i])
    }
  }
  class TextEncoder {
    get encoding() {
      return 'utf-8'
    }
    encode(text) {
      return utf8Bytes(text === undefined ? '' : String(text))
    }
  }
  class TextDecoder {
    constructor(label) {
      if (label !== undefined && encodingName(label) !== 'utf8') {
        throw new RangeError('The "' + label + '" encoding is not supported')
      }
    }
    get encoding() {
      return 'utf-8'
    }
    decode(input) {
      if (input === undefined) return ''
      const bytes = view(input)
      const s = utf8Text(bytes, 0, bytes.length)
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
    }
  }

  // Printing as node does: util.format's placeholders, and values shown
  // the way util.inspect shows them, broken over lines past 80 columns.
  const IDENT = /^[A-Za-z_$][\w$]*$/
  function quote(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'"
    const body = s
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .split(q)
      .join('\\' + q)
    return q + body + q
  }
  function errorText(e) {
    const head = String(e)
    const stack = typeof e.stack === 'string' ? e.stack.replace(/\s+$/, '') : ''
    if (stack === '' || stack.startsWith(head)) return stack || head
    return head + '\n' + stack
  }
  function nameOf(value) {
    const proto = Object.getPrototypeOf(value)
    const ctor = proto && proto.constructor
    return typeof ctor === 'function' ? ctor.name : ''
  }
  function show(value, depth, seen, indent, refs = new Map()) {
    switch (typeof value) {
      case 'string':
        return quote(value)
      case 'number':
        return Object.is(value, -0) ? '-0' : String(value)
      case 'bigint':
        return value + 'n'
      case 'function': {
        const name = value.name || '(anonymous)'
        if (/^class\b/.test(Function.prototype.toString.call(value))) {
          return '[class ' + name + ']'
        }
        return value.name ? '[Function: ' + name + ']' : '[Function ' + name + ']'
      }
      case 'object':
        break
      default:
        return String(value)
    }
    if (value === null) return 'null'
    if (seen.includes(value)) {
      if (!refs.has(value)) refs.set(value, refs.size + 1)
      return '[Circular *' + refs.get(value) + ']'
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    }
    if (value instanceof RegExp) return String(value)
    if (value instanceof Buffer) {
      const shown = Array.from(value.subarray(0, 50), (b) => HEX[b >> 4] + HEX[b & 15])
      const more = value.length > 50 ? ' ... ' + (value.length - 50) + ' more bytes' : ''
      return '<Buffer' + (shown.length ? ' ' + shown.join(' ') : '') + more + '>'
    }
    if (value instanceof Promise) return 'Promise {}'
    const error = value instanceof Error
    if (depth < 0 && !error) {
      return Array.isArray(value) ? '[Array]' : '[' + (nameOf(value) || 'Object') + ']'
    }
    const inner = seen.concat([value])
    const at = (v) => show(v, depth - 1, inner, indent + 2, refs)
    let start = ''
    let open = '{'
    let close = '}'
    let parts
    if (Array.isArray(value)) {
      open = '['
      close = ']'
      parts = value.slice(0, 100).map(at)
      if (value.length > 100) {
        parts.push('... ' + (value.length - 100) + ' more items')
      }
    } else if (value instanceof Map) {
      start = 'Map(' + value.size + ') '
      parts = Array.from(value, ([k, v]) => at(k) + ' => ' + at(v))
    } else if (value instanceof Set) {
      start = 'Set(' + value.size + ') '
      parts = Array.from(value, at)
    } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      start = nameOf(value) + '(' + value.length + ') '
      open = '['
      close = ']'
      parts = Array.from(value.subarray(0, 100), at)
    } else {
      const keys = Object.keys(value).map((k) => [IDENT.test(k) ? k : quote(k), k])
      for (const s of Object.getOwnPropertySymbols(value)) {
        if (Object.prototype.propertyIsEnumerable.call(value, s)) {
          keys.push(['[' + s.toString() + ']', s])
        }
      }
      const shown = (k) => {
        const d = Object.getOwnPropertyDescriptor(value, k)
        if (d === undefined || 'value' in d) return at(value[k])
        if (d.get && d.set) return '[Getter/Setter]'
        return d.get ? '[Getter]' : '[Setter]'
      }
      parts = keys.map(([label, k]) => label + ': ' + shown(k))
      if (error) start = errorText(value) + ' '
      else if (Object.getPrototypeOf(value) === null) {
        start = '[Object: null prototype] '
      } else {
        const name = nameOf(value)
        if (name && name !== 'Object') start = name + ' '
      }
    }
    if (parts.length === 0) return error ? start.slice(0, -1) : start + open + close
    // An object a value inside it points back at is marked, as node does.
    const ref = refs.has(value) ? '<ref *' + refs.get(value) + '> ' : ''
    const width = parts.reduce((n, p) => n + p.length + 2, 0)
    const fits = width + indent + start.length + open.length + 10 <= 80
    if (fits && !start.includes('\n') && !parts.some((p) => p.includes('\n'))) {
      return ref + start + open + ' ' + parts.join(', ') + ' ' + close
    }
    const pad = '\n' + ' '.repeat(indent)
    const lines = parts.join(',' + pad + '  ')
    return ref + start + open + pad + '  ' + lines + pad + close
  }
  const inspect = (value, options) => {
    const depth = options && options.depth !== undefined ? options.depth : 2
    return show(value, depth === null ? Infinity : depth, [], 0)
  }
  function format(args) {
    if (args.length === 1 && typeof args[0] === 'string') return args[0]
    const formatted = typeof args[0] === 'string'
    let at = 0
    let head = ''
    if (formatted) {
      at = 1
      head = args[0].replace(/%[sdifjoOc%]/g, (m) => {
        if (m === '%%') return '%'
        if (at >= args.length) return m
        const v = args[at++]
        switch (m[1]) {
          case 's':
            if (typeof v === 'string') return v
            if (typeof v === 'bigint') return v + 'n'
            return typeof v === 'object' && v !== null ? show(v, 0, [], 0) : String(v)
          case 'd':
          case 'i':
          case 'f':
            if (typeof v === 'bigint') return m[1] === 'f' ? String(Number(v)) : v + 'n'
            if (typeof v === 'symbol' || (typeof v === 'object' && v !== null)) {
              return 'NaN'
            }
            return String(m[1] === 'i' ? parseInt(v) : m[1] === 'f' ? parseFloat(v) : Number(v))
          case 'j':
            try {
              return JSON.stringify(v)
            } catch {
              return '[Circular]'
            }
          case 'c':
            return ''
          default:
            return show(v, m[1] === 'o' ? 4 : 2, [], 0)
        }
      })
    }
    const rest = args.slice(at).map((v) => (typeof v === 'string' ? v : inspect(v)))
    return (formatted ? [head] : []).concat(rest).join(' ')
  }
  const printer =
    (file) =>
    (...args) => {
      file.puts(format(args) + '\n')
    }
  console.log = printer(std.out)
  console.info = console.log
  console.debug = console.log
  console.error = printer(std.err)
  console.warn = console.error
  console.dir = (value, options) => {
    std.out.puts(inspect(value, options) + '\n')
  }
  console.assert = (ok, ...message) => {
    if (!ok) {
      std.err.puts('Assertion failed' + (message.length ? ': ' + format(message) : '') + '\n')
    }
  }

  // path, POSIX only.
  const posix = {
    sep: '/',
    delimiter: ':',
    isAbsolute: (p) => String(p).startsWith('/'),
    normalize(p) {
      p = String(p)
      if (p === '') return '.'
      const absolute = p.startsWith('/')
      const out = []
      for (const part of p.split('/')) {
        if (part === '' || part === '.') continue
        if (part !== '..') out.push(part)
        else if (out.length && out[out.length - 1] !== '..') out.pop()
        else if (!absolute) out.push('..')
      }
      let r = out.join('/')
      if (r === '' && !absolute) r = '.'
      if (p.endsWith('/') && r !== '') r += '/'
      return (absolute ? '/' : '') + r
    },
    join(...parts) {
      const joined = parts
        .map(String)
        .filter((p) => p !== '')
        .join('/')
      return joined === '' ? '.' : posix.normalize(joined)
    },
    resolve(...parts) {
      let r = ''
      for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
        const p = String(parts[i])
        if (p !== '') r = p + (r ? '/' + r : '')
      }
      if (!r.startsWith('/')) r = process.cwd() + (r ? '/' + r : '')
      const n = posix.normalize(r)
      return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
    },
    dirname(p) {
      p = String(p)
      if (p === '') return '.'
      const s = p.replace(/\/+$/, '')
      if (s === '') return '/'
      const i = s.lastIndexOf('/')
      if (i < 0) return '.'
      return s.slice(0, i).replace(/\/+$/, '') || '/'
    },
    basename(p, ext) {
      if (ext !== undefined && String(p) === ext) return ''
      const s = String(p).replace(/\/+$/, '')
      let b = s.slice(s.lastIndexOf('/') + 1)
      if (ext !== undefined && b !== ext && b.endsWith(ext)) {
        b = b.slice(0, b.length - ext.length)
      }
      return b
    },
    extname(p) {
      const b = posix.basename(p)
      const i = b.lastIndexOf('.')
      return i <= 0 || b === '..' ? '' : b.slice(i)
    },
    relative(from, to) {
      const a = posix.resolve(from).split('/').filter(Boolean)
      const b = posix.resolve(to).split('/').filter(Boolean)
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      return a
        .slice(i)
        .map(() => '..')
        .concat(b.slice(i))
        .join('/')
    },
    parse(p) {
      p = String(p)
      const base = posix.basename(p)
      const ext = posix.extname(p)
      const dir = p.includes('/') ? posix.dirname(p) : ''
      return {
        root: p.startsWith('/') ? '/' : '',
        dir,
        base,
        ext,
        name: ext ? base.slice(0, -ext.length) : base,
      }
    },
    format(o) {
      const dir = o.dir || o.root || ''
      const base = o.base || (o.name || '') + (o.ext || '')
      return dir === '' ? base : dir === o.root ? dir + base : dir + '/' + base
    },
  }
  posix.posix = posix

  // fs, its synchronous calls over std and os, and the callback and
  // promise forms of each.
  // stdin, read as it arrives, at the one position fs.readFileSync(0),
  // process.stdin and readline all take from.
  let stdinEnded = false
  function stdinChunk() {
    if (stdinEnded) return null
    const buffer = new ArrayBuffer(65536)
    const n = os.read(0, buffer, 0, buffer.byteLength)
    if (n <= 0) {
      stdinEnded = true
      return null
    }
    return new Buffer(buffer, 0, n)
  }
  function stdinRest() {
    const chunks = []
    for (let c = stdinChunk(); c !== null; c = stdinChunk()) chunks.push(c)
    return Buffer.concat(chunks)
  }
  // Text from chunks, in an encoding: what ends whole now and the rest with
  // the next chunk (a character UTF-8 splits, a group of fewer than three
  // bytes base64 would pad), and all of it at null.
  function textStream(encoding) {
    const e = encodingName(encoding)
    let carry = new Uint8Array(0)
    return (chunk) => {
      let bytes = chunk === null ? carry : Buffer.concat([carry, chunk])
      let cut = bytes.length
      if (chunk !== null && e === 'utf8') {
        let i = bytes.length
        while (i > 0 && bytes.length - i < 3 && (bytes[i - 1] & 0xc0) === 0x80) {
          i--
        }
        const lead = i > 0 ? bytes[i - 1] : 0
        const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
        if (i > 0 && size > bytes.length - i + 1) cut = i - 1
      } else if (chunk !== null && e.startsWith('base64')) {
        cut -= bytes.length % 3
      }
      carry = bytes.slice(cut)
      bytes = bytes.subarray(0, cut)
      return textOf(bytes, e, 0, bytes.length)
    }
  }
  const isStdin = (file) => file === 0 || file === '/dev/stdin'
  const encodingOf = (options) =>
    (typeof options === 'string' ? options : options && options.encoding) || null
  const flagOf = (options, fallback) =>
    (options && typeof options === 'object' && options.flag) || fallback
  function open(file, mode, syscall) {
    const e = {}
    const f = std.open(String(file), mode, e)
    if (f === null) throw failure(e.errno, syscall, file)
    return f
  }
  function lookup(stat, syscall, file) {
    const [st, errno] = stat(String(file))
    if (errno !== 0) throw failure(errno, syscall, file)
    return st
  }
  // The WASI build has no lstat or realpath: stat stands in for lstat,
  // and a path resolves to itself once it is there.
  const lstat = os.lstat || os.stat
  const TYPE = Symbol('type')
  const kind = (mode) => mode & os.S_IFMT
  class Stats {
    constructor(st) {
      for (const k of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev']) {
        this[k] = st[k]
      }
      this.size = st.size
      this.blocks = st.blocks
      this.atimeMs = st.atime
      this.mtimeMs = st.mtime
      this.ctimeMs = st.ctime
      this.atime = new Date(st.atime)
      this.mtime = new Date(st.mtime)
      this.ctime = new Date(st.ctime)
    }
    isFile() {
      return kind(this.mode) === os.S_IFREG
    }
    isDirectory() {
      return kind(this.mode) === os.S_IFDIR
    }
    isSymbolicLink() {
      return kind(this.mode) === os.S_IFLNK
    }
  }
  class Dirent {
    constructor(name, dir, mode) {
      this.name = name
      this.parentPath = dir
      this.path = dir
      Object.defineProperty(this, TYPE, { value: kind(mode) })
    }
    isFile() {
      return this[TYPE] === os.S_IFREG
    }
    isDirectory() {
      return this[TYPE] === os.S_IFDIR
    }
    isSymbolicLink() {
      return this[TYPE] === os.S_IFLNK
    }
  }
  function readBytes(file) {
    if (isStdin(file)) return stdinRest()
    if (kind(lookup(os.stat, 'open', file).mode) === os.S_IFDIR) {
      throw failure(31, 'read', file)
    }
    const f = open(file, 'r', 'open')
    try {
      return new Buffer(f.readAsArrayBuffer())
    } finally {
      f.close()
    }
  }
  function write(file, data, options, flag) {
    const encoding = encodingOf(options)
    if (typeof data === 'string' && encoding && encodingName(encoding) !== 'utf8') {
      data = Buffer.from(data, encoding)
    }
    const f = open(file, flagOf(options, flag), 'open')
    let error = null
    try {
      if (typeof data === 'string') f.puts(data)
      else if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
        const bytes = view(data)
        f.write(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      } else f.puts(String(data))
      if (f.error()) error = failure(29, 'write', file)
    } catch (e) {
      error = e
    }
    const closed = f.close()
    if (error === null && closed < 0) error = failure(-closed, 'write', file)
    if (error !== null) throw error
  }
  // An entry, and what is in it first only when it is a directory with
  // entries. remove takes a link itself, never what it points at, so the
  // walk never leaves the tree through one, though stat follows links.
  function removeTree(at, file, force) {
    const r = os.remove(at)
    if (r === -44 && force) return
    if (r !== -55) return check(r, 'rm', file)
    const [names, errno] = os.readdir(at)
    if (errno === 44 && force) return
    if (errno !== 0) throw failure(errno, 'rm', file)
    for (const name of names) {
      if (name !== '.' && name !== '..') {
        removeTree(posix.join(at, name), file, force)
      }
    }
    const last = os.remove(at)
    if (!(last === -44 && force)) check(last, 'rm', file)
  }
  const fs = {
    readFileSync(file, options) {
      const encoding = encodingOf(options)
      if (encoding !== null && encodingName(encoding) === 'utf8' && !isStdin(file)) {
        if (kind(lookup(os.stat, 'open', file).mode) === os.S_IFDIR) {
          throw failure(31, 'read', file)
        }
        const f = open(file, 'r', 'open')
        try {
          return f.readAsString()
        } finally {
          f.close()
        }
      }
      const bytes = readBytes(file)
      return encoding === null ? bytes : bytes.toString(encoding)
    },
    writeFileSync(file, data, options) {
      write(file, data, options, 'w')
    },
    appendFileSync(file, data, options) {
      write(file, data, options, 'a')
    },
    copyFileSync(from, to, mode) {
      const excl = (mode | 0) & 1
      write(to, readBytes(from), null, excl ? 'wx' : 'w')
    },
    existsSync(file) {
      if (isStdin(file)) return true
      return typeof file === 'string' && os.stat(file)[1] === 0
    },
    accessSync(file) {
      lookup(os.stat, 'access', file)
    },
    statSync(file, options) {
      const [st, errno] = os.stat(String(file))
      if (errno === 0) return new Stats(st)
      if (errno === 44 && options && options.throwIfNoEntry === false) return
      throw failure(errno, 'stat', file)
    },
    lstatSync(file, options) {
      const [st, errno] = lstat(String(file))
      if (errno === 0) return new Stats(st)
      if (errno === 44 && options && options.throwIfNoEntry === false) return
      throw failure(errno, 'lstat', file)
    },
    readdirSync(file, options) {
      const dir = String(file)
      const [names, errno] = os.readdir(dir)
      if (errno !== 0) throw failure(errno, 'scandir', file)
      const list = names.filter((n) => n !== '.' && n !== '..').sort()
      if (!(options && options.withFileTypes)) return list
      return list.map((name) => {
        const [st] = lstat(posix.join(dir, name))
        return new Dirent(name, dir, st ? st.mode : 0)
      })
    },
    realpathSync(file) {
      if (os.realpath) return lookup(os.realpath, 'realpath', file)
      lookup(os.stat, 'realpath', file)
      return posix.resolve(String(file))
    },
    mkdirSync(file, options) {
      const recursive = options && typeof options === 'object' && options.recursive
      const mode = typeof options === 'number' ? options : (options && options.mode) || 0o777
      if (!recursive) return check(os.mkdir(String(file), mode), 'mkdir', file)
      const full = posix.resolve(String(file))
      let first
      let at = ''
      for (const part of full.split('/').filter(Boolean)) {
        at += '/' + part
        const [st] = os.stat(at)
        if (st === null) {
          check(os.mkdir(at, mode), 'mkdir', file)
          if (first === undefined) first = at
        } else if (kind(st.mode) !== os.S_IFDIR) {
          throw failure(at === full ? 20 : 54, 'mkdir', file)
        }
      }
      return first
    },
    rmdirSync(file) {
      const [st, errno] = os.stat(String(file))
      if (errno === 0 && kind(st.mode) !== os.S_IFDIR) {
        throw failure(54, 'rmdir', file)
      }
      check(os.remove(String(file)), 'rmdir', file)
    },
    unlinkSync(file) {
      const [st, errno] = os.stat(String(file))
      if (errno === 0 && kind(st.mode) === os.S_IFDIR) {
        throw failure(31, 'unlink', file)
      }
      check(os.remove(String(file)), 'unlink', file)
    },
    renameSync(from, to) {
      check(os.rename(String(from), String(to)), 'rename', from)
    },
    rmSync(file, options) {
      const at = String(file)
      const [st, errno] = os.stat(at)
      if (errno !== 0) {
        // A link to nothing stats as missing, and removes all the same.
        if (errno === 44 && os.remove(at) === 0) return
        if (errno === 44 && options && options.force) return
        throw failure(errno, 'rm', file)
      }
      if (kind(st.mode) === os.S_IFDIR && !(options && options.recursive)) {
        const e = new Error('Path is a directory: rm returned EISDIR ' + file)
        e.code = 'ERR_FS_EISDIR'
        throw raise(e)
      }
      removeTree(at, file, Boolean(options && options.force))
    },
  }
  for (const name of Object.keys(fs)) fs[name] = api(fs[name])
  const promises = {}
  for (const name of Object.keys(fs)) {
    if (name === 'existsSync') continue
    const sync = fs[name]
    const base = name.slice(0, -4)
    promises[base] = (...args) => new Promise((resolve) => resolve(sync(...args)))
    fs[base] = (...args) => {
      const done = args.pop()
      if (typeof done !== 'function') {
        throw new TypeError('The "cb" argument must be of type function')
      }
      let result
      let error = null
      try {
        result = sync(...args)
      } catch (e) {
        error = e
      }
      queueMicrotask(() => (error ? done(error) : done(null, result)))
    }
  }
  fs.exists = (file, done) => {
    const found = fs.existsSync(file)
    queueMicrotask(() => done(found))
  }
  fs.promises = promises
  fs.constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 }

  // process, and stdin as node hands it to listeners and readline.
  function writer(file, fd) {
    return {
      fd,
      isTTY: false,
      write(chunk, encoding, done) {
        if (
          typeof chunk === 'string' &&
          (typeof encoding !== 'string' || encodingName(encoding) === 'utf8')
        ) {
          file.puts(chunk)
        } else {
          const bytes = view(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk)
          file.write(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        }
        const callback = typeof encoding === 'function' ? encoding : done
        if (typeof callback === 'function') queueMicrotask(callback)
        return true
      },
    }
  }
  // Listeners on target, and the pump that feeds them, started by the
  // first listener for what it delivers (an error listener reads nothing)
  // or by resume(), and run one step a timer until it answers false. A
  // pump steps aside once an async loop takes the stream: the loop reads
  // only as it asks, so nothing reads ahead of it or is left reading
  // after it ends.
  function emitter(target, pump) {
    const listeners = {}
    let scheduled = false
    const start = () => {
      if (!scheduled) {
        scheduled = true
        os.setTimeout(() => {
          scheduled = false
          if (pump()) start()
        }, 0)
      }
    }
    const on = (event, fn) => {
      ;(listeners[event] = listeners[event] || []).push(fn)
      if (event !== 'error') start()
      return target
    }
    const off = (event, fn) => {
      const list = listeners[event] || []
      const i = list.findIndex((l) => l === fn || l.listener === fn)
      if (i >= 0) list.splice(i, 1)
      return target
    }
    target.on = on
    target.addListener = on
    target.off = off
    target.removeListener = off
    target.once = (event, fn) => {
      const once = (...args) => {
        off(event, once)
        fn(...args)
      }
      once.listener = fn
      return on(event, once)
    }
    const emit = (event, ...args) => {
      for (const fn of (listeners[event] || []).slice()) fn(...args)
    }
    const has = (event) => (listeners[event] || []).length > 0
    return { emit, start, has }
  }
  let decoder = null
  let buffered = null
  let ended = false
  // As node's: null until a data listener or resume() starts the flow.
  let flowing = null
  let iterating = false
  let finished = false
  const finish = () => {
    if (!finished) {
      finished = true
      events.emit('end')
      events.emit('close')
    }
  }
  const input = {
    fd: 0,
    isTTY: false,
    setEncoding(e) {
      decoder = textStream(e === undefined ? 'utf8' : e)
      return input
    },
    resume() {
      flowing = true
      events.start()
      return input
    },
    pause() {
      flowing = false
      return input
    },
    // A read that takes the last of ended input ends the stream once its
    // caller is done with what it took.
    read() {
      const chunk = buffered
      buffered = null
      if (chunk !== null) events.emit('data', chunk)
      if (ended) queueMicrotask(finish)
      else events.start()
      return chunk
    },
    async *[Symbol.asyncIterator]() {
      iterating = true
      const held = buffered
      buffered = null
      if (held !== null) yield held
      for (let c = stdinChunk(); c !== null; c = stdinChunk()) {
        const value = decoder === null ? c : decoder(c)
        if (value.length) yield value
      }
      const tail = decoder === null ? '' : decoder(null)
      if (tail.length) yield tail
      finish()
    },
  }
  // The next chunk as the encoding reads it, null once input has ended.
  const next = () => {
    const chunk = stdinChunk()
    if (chunk === null) ended = true
    return decoder === null ? chunk : decoder(chunk)
  }
  // With a readable listener, as in node, a chunk waits until read()
  // takes it, nothing more is read while it waits, and data comes only
  // from read(); without one, chunks flow to data while the stream flows.
  const events = emitter(input, () => {
    const readable = events.has('readable')
    const flows = flowing === true || (flowing === null && events.has('data'))
    if (iterating || finished || (readable ? buffered !== null : !flows)) {
      return false
    }
    let value = buffered
    buffered = null
    if (value === null && !ended) value = next()
    if (value !== null && value.length) {
      if (readable) {
        buffered = value
        events.emit('readable')
      } else events.emit('data', value)
    } else if (readable && ended) events.emit('readable')
    if (ended && buffered === null) finish()
    return !ended
  })
  const readline = {
    createInterface() {
      let closed = false
      let iterating = false
      let rest = ''
      const text = textStream('utf8')
      // The lines the next chunk completes, and whether input has ended.
      const pull = () => {
        const chunk = stdinChunk()
        const all = (rest + text(chunk)).split('\n')
        rest = chunk === null ? '' : all.pop()
        if (chunk === null && all[all.length - 1] === '') all.pop()
        const lines = all.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
        return [lines, chunk === null]
      }
      const rl = {
        close() {
          if (!closed) {
            closed = true
            lines.emit('close')
          }
        },
        async *[Symbol.asyncIterator]() {
          iterating = true
          try {
            while (!closed) {
              const [all, done] = pull()
              for (const line of all) {
                if (closed) return
                yield line
              }
              if (done) return
            }
          } finally {
            rl.close()
          }
        },
      }
      const lines = emitter(rl, () => {
        if (closed || iterating) return false
        const [all, done] = pull()
        for (const line of all) {
          if (closed) return false
          lines.emit('line', line)
        }
        if (done) rl.close()
        return !done
      })
      return rl
    },
  }
  const process = {
    argv,
    argv0: argv[0],
    execArgv: [],
    env: std.getenviron(),
    exitCode: undefined,
    exit(code) {
      std.exit((code === undefined ? process.exitCode : code) | 0)
    },
    cwd() {
      return os.getcwd()[0]
    },
    chdir(dir) {
      check(os.chdir(String(dir)), 'chdir', dir)
    },
    nextTick(fn, ...args) {
      queueMicrotask(() => fn(...args))
    },
    stdin: input,
    stdout: writer(std.out, 1),
    stderr: writer(std.err, 2),
  }

  // Timers, which node keeps as globals and qjs keeps under os.
  const later = (repeat, fn, ms, args) => {
    if (typeof fn !== 'function') {
      throw new TypeError('The "callback" argument must be of type function')
    }
    const delay = Math.max(1, Number(ms) || 0)
    return (repeat ? os.setInterval : os.setTimeout)(() => fn(...args), delay)
  }
  const clear = (handle) => {
    if (handle !== undefined && handle !== null) os.clearTimeout(handle)
  }
  define('setTimeout', (fn, ms, ...args) => later(false, fn, ms, args))
  define('setInterval', (fn, ms, ...args) => later(true, fn, ms, args))
  define('setImmediate', (fn, ...args) => later(false, fn, 0, args))
  define('clearTimeout', clear)
  define('clearInterval', clear)
  define('clearImmediate', clear)

  // require: the modules above, and files by path, JavaScript run as
  // CommonJS and JSON parsed.
  const promisify = (fn) =>
    function (...args) {
      return new Promise((resolve, reject) => {
        fn.call(this, ...args, (e, value) => (e ? reject(e) : resolve(value)))
      })
    }
  const builtins = {
    buffer: { Buffer },
    fs,
    'fs/promises': promises,
    path: posix,
    process,
    readline,
    util: { format: (...args) => format(args), inspect, promisify },
  }
  const cache = {}
  function locate(full, id) {
    const tries = [full, full + '.js', full + '.json', full + '/index.js']
    for (const file of tries) {
      const [st] = os.stat(file)
      if (st !== null && kind(st.mode) === os.S_IFREG) return file
    }
    const e = new Error("Cannot find module '" + id + "'")
    e.code = 'MODULE_NOT_FOUND'
    throw raise(e)
  }
  function load(file, main) {
    if (cache[file]) return cache[file].exports
    const module = { id: file, filename: file, loaded: false, exports: {} }
    cache[file] = module
    try {
      const source = fs.readFileSync(file, 'utf8')
      if (file.endsWith('.json')) module.exports = JSON.parse(source)
      else {
        const body = source.startsWith('#!') ? '//' + source.slice(2) : source
        const run = std.evalScript(
          '(function (exports, require, module, __filename, __dirname) {' + body + '\n})',
          { backtrace_barrier: true },
        )
        const dir = posix.dirname(file)
        run.call(module.exports, module.exports, requirer(dir, main), module, file, dir)
      }
    } catch (e) {
      delete cache[file]
      throw e
    }
    module.loaded = true
    return module.exports
  }
  function requirer(dir, main) {
    const require = api(function require(id) {
      id = String(id)
      const name = id.startsWith('node:') ? id.slice(5) : id
      if (Object.prototype.hasOwnProperty.call(builtins, name)) {
        return builtins[name]
      }
      if (/^\.{0,2}\//.test(id)) {
        return load(locate(posix.resolve(dir, id), id), main)
      }
      const e = new Error(
        "Cannot find module '" +
          id +
          "': quickjs has " +
          Object.keys(builtins).join(', ') +
          ' and files by path, no npm',
      )
      e.code = 'MODULE_NOT_FOUND'
      throw raise(e)
    })
    require.resolve = (id) => locate(posix.resolve(dir, String(id)), id)
    require.cache = cache
    require.main = main
    return require
  }

  const main = {
    id: '.',
    filename: script === null ? '[eval]' : script,
    loaded: false,
    exports: {},
  }
  if (script !== null) cache[script] = main
  define('global', g)
  define('process', process)
  define('Buffer', Buffer)
  define('TextEncoder', TextEncoder)
  define('TextDecoder', TextDecoder)
  define('module', main)
  define('exports', main.exports)
  define('require', requirer(script === null ? process.cwd() : posix.dirname(script), main))
  define('__filename', main.filename)
  define('__dirname', script === null ? '.' : posix.dirname(script))
})
