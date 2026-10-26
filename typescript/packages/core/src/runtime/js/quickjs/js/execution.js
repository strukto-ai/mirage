// The host hands the bootstrap its functions as globals. Each part
// takes those it calls, and the last removes them all, so a program sees
// the real engine's globals.
const { __mirage_atob, __mirage_btoa, __mirage_env, __mirage_log, __mirage_now, __mirage_setExit } =
  globalThis
const __join = (a) => a.map(String).join(' ')
// The host's string channel is a C string: text with a NUL in it crosses
// as the pieces between its NULs.
const __text = (v) => (typeof v === 'string' ? v : v.join('\0'))
const __pieces = (s) => (s.includes('\0') ? s.split('\0') : s)
const __pad = (s, flags, width) => {
  if (s.length >= width) return s
  if (flags.includes('-')) return s + ' '.repeat(width - s.length)
  const fill = flags.includes('0') ? '0' : ' '
  if (fill === '0' && (s[0] === '-' || s[0] === '+'))
    return s[0] + '0'.repeat(width - s.length) + s.slice(1)
  return fill.repeat(width - s.length) + s
}
const __exp2 = (s) => s.replace(/e([+-])(\d)$/, (m, sg, d) => 'e' + sg + '0' + d)
const __sign = (s, flags) => {
  if (s[0] === '-') return s
  if (flags.includes('+')) return '+' + s
  if (flags.includes(' ')) return ' ' + s
  return s
}
const __padDigits = (s, prec) => {
  if (prec === undefined) return s
  const neg = s[0] === '-'
  const digits = neg ? s.slice(1) : s
  return (neg ? '-' : '') + digits.padStart(prec, '0')
}
const __int = (n, wide, unsigned) => {
  if (!wide) return BigInt(unsigned ? Math.trunc(n) >>> 0 : n | 0)
  const span = 1n << 64n
  const v = ((BigInt(Number.isFinite(n) ? Math.trunc(n) : 0) % span) + span) % span
  return unsigned || v < span >> 1n ? v : v - span
}
const __conv1 = (conv, flags, prec, arg, wide) => {
  const n = Number(arg)
  if (conv === 'd' || conv === 'i')
    return __sign(__padDigits(String(__int(n, wide, false)), prec), flags)
  if (conv === 'u') return __padDigits(String(__int(n, wide, true)), prec)
  if (conv === 'f' || conv === 'F') return __sign(n.toFixed(prec === undefined ? 6 : prec), flags)
  if (conv === 'e' || conv === 'E') {
    const s = __sign(__exp2(n.toExponential(prec === undefined ? 6 : prec)), flags)
    return conv === 'E' ? s.toUpperCase() : s
  }
  if (conv === 'g' || conv === 'G') {
    let s = n.toPrecision(prec === undefined || prec === 0 ? 6 : prec)
    if (s.includes('e')) s = __exp2(s.replace(/\.?0+e/, 'e'))
    else if (s.includes('.')) s = s.replace(/\.?0+$/, '')
    s = __sign(s, flags)
    return conv === 'G' ? s.toUpperCase() : s
  }
  if (conv === 'x' || conv === 'X') {
    let s = __int(n, wide, true).toString(16)
    if (flags.includes('#') && n !== 0) s = '0x' + s
    if (conv === 'X') s = s.toUpperCase()
    return s
  }
  if (conv === 'o') {
    let s = __int(n, wide, true).toString(8)
    if (flags.includes('#') && s[0] !== '0') s = '0' + s
    return s
  }
  if (conv === 'c') return typeof arg === 'number' ? String.fromCharCode(arg) : String(arg)[0] || ''
  return prec === undefined ? String(arg) : String(arg).slice(0, prec)
}
const __sprintf = (fmtIn, args) => {
  const fmt = String(fmtIn)
  let out = ''
  let ai = 0
  let i = 0
  while (i < fmt.length) {
    if (fmt[i] !== '%') {
      out += fmt[i]
      i++
      continue
    }
    i++
    if (fmt[i] === '%') {
      out += '%'
      i++
      continue
    }
    let flags = ''
    while ('-+0 #'.includes(fmt[i])) {
      flags += fmt[i]
      i++
    }
    let width = 0
    if (fmt[i] === '*') {
      if (ai >= args.length) throw new ReferenceError('missing argument for format')
      width = Math.trunc(Number(args[ai++]))
      if (width < 0) {
        flags += '-'
        width = -width
      }
      i++
    } else
      while (fmt[i] >= '0' && fmt[i] <= '9') {
        width = width * 10 + (fmt.charCodeAt(i) - 48)
        i++
      }
    let prec = undefined
    if (fmt[i] === '.') {
      i++
      prec = 0
      if (fmt[i] === '*') {
        if (ai >= args.length) throw new ReferenceError('missing argument for format')
        prec = Math.trunc(Number(args[ai++]))
        if (prec < 0) prec = undefined
        i++
      } else
        while (fmt[i] >= '0' && fmt[i] <= '9') {
          prec = prec * 10 + (fmt.charCodeAt(i) - 48)
          i++
        }
    }
    const wide = fmt[i] === 'l'
    if (wide) i++
    const conv = fmt[i]
    i++
    if (conv === undefined || !'diufFeEgGxXocs'.includes(conv))
      throw new TypeError('invalid conversion specifier in format string')
    if (ai >= args.length) throw new ReferenceError('missing argument for format')
    out += __pad(__conv1(conv, flags, prec, args[ai++], wide), flags, width)
  }
  return out
}
globalThis.console = { log: (...a) => __mirage_log(__pieces(__join(a) + '\n')) }
globalThis.print = (...a) => __mirage_log(__pieces(__join(a) + '\n'))
globalThis.std = {
  exit: (n) => {
    __mirage_setExit(n | 0)
    while (true) {
      /* The VM interrupt ends execution without a catchable throw. */
    }
  },
  getenv: (k) =>
    Object.prototype.hasOwnProperty.call(__mirage_env, k) ? __mirage_env[k] : undefined,
  setenv: (k, v) => {
    __mirage_env[String(k)] = String(v)
  },
  unsetenv: (k) => {
    Reflect.deleteProperty(__mirage_env, String(k))
  },
  getenviron: () => ({ ...__mirage_env }),
  // wasi-libc's messages by WASI errno; a number past them reads as its
  // first, as the real engine's strerror answers.
  strerror: (n) => __messages[n | 0] ?? __messages[0],
  gc: () => undefined,
  puts: (s) => std.out.puts(s),
  evalScript: (source, options) => {
    // The engine's eval takes no async flag, so an async evaluation
    // answers the script's value once it has run, as `{ value }`.
    if (options?.async !== true) return (0, eval)(String(source))
    try {
      return Promise.resolve({ value: (0, eval)(String(source)) })
    } catch (e) {
      return Promise.reject(e)
    }
  },
  loadScript: (path) => {
    const text = std.loadFile(path)
    if (text === null) throw new ReferenceError(`could not load '${path}'`)
    return (0, eval)(text)
  },
}
const __messages = [
  'Success',
  'Argument list too long',
  'Permission denied',
  'Address in use',
  'Address not available',
  'Address family not supported by protocol',
  'Resource temporarily unavailable',
  'Operation already in progress',
  'Bad file descriptor',
  'Bad message',
  'Resource busy',
  'Operation canceled',
  'No child process',
  'Connection aborted',
  'Connection refused',
  'Connection reset by peer',
  'Resource deadlock would occur',
  'Destination address required',
  'Domain error',
  'Quota exceeded',
  'File exists',
  'Bad address',
  'File too large',
  'Host is unreachable',
  'Identifier removed',
  'Illegal byte sequence',
  'Operation in progress',
  'Interrupted system call',
  'Invalid argument',
  'I/O error',
  'Socket is connected',
  'Is a directory',
  'Symbolic link loop',
  'No file descriptors available',
  'Too many links',
  'Message too large',
  'Multihop attempted',
  'Filename too long',
  'Network is down',
  'Connection reset by network',
  'Network unreachable',
  'Too many open files in system',
  'No buffer space available',
  'No such device',
  'No such file or directory',
  'Exec format error',
  'No locks available',
  'Link has been severed',
  'Out of memory',
  'No message of desired type',
  'Protocol not available',
  'No space left on device',
  'Function not implemented',
  'Socket not connected',
  'Not a directory',
  'Directory not empty',
  'State not recoverable',
  'Not a socket',
  'Not supported',
  'Not a tty',
  'No such device or address',
  'Value too large for data type',
  'Previous owner died',
  'Operation not permitted',
  'Broken pipe',
  'Protocol error',
  'Protocol not supported',
  'Protocol wrong type for socket',
  'Result not representable',
  'Read-only file system',
  'Invalid seek',
  'No such process',
  'Stale file handle',
  'Operation timed out',
  'Text file busy',
  'Cross-device link',
  'Capabilities insufficient',
]
globalThis.gc = () => undefined
globalThis.performance = { now: () => __mirage_now(), timeOrigin: Date.now() - __mirage_now() }
globalThis.navigator = { userAgent: 'quickjs' }

std.sprintf = (format, ...args) => __sprintf(format, args)
std.printf = (...args) => std.out.printf(...args)

std.Error = {}
for (const [name, value] of Object.entries({
  EINVAL: 28,
  EIO: 29,
  EACCES: 2,
  EEXIST: 20,
  ENOSPC: 51,
  ENOSYS: 52,
  EBUSY: 10,
  ENOENT: 44,
  EPERM: 63,
  EPIPE: 64,
  EBADF: 8,
}))
  Object.defineProperty(std.Error, name, { value, configurable: true, writable: true })
globalThis.queueMicrotask = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('not a function')
  Promise.resolve().then(fn)
}

globalThis.atob = (s) => __text(__mirage_atob(__pieces(String(s))))
globalThis.btoa = (s) => __text(__mirage_btoa(__pieces(String(s))))
