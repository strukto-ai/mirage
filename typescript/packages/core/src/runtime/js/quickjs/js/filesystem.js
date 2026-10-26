const {
  __mirage_byteLength,
  __mirage_chdir,
  __mirage_clearerr,
  __mirage_close,
  __mirage_eof,
  __mirage_ferror,
  __mirage_flush,
  __mirage_getcwd,
  __mirage_getline,
  __mirage_mkdir,
  __mirage_open,
  __mirage_os_open,
  __mirage_os_read,
  __mirage_os_write,
  __mirage_read,
  __mirage_read_bytes,
  __mirage_readdir,
  __mirage_remove,
  __mirage_rename,
  __mirage_seek,
  __mirage_sleep,
  __mirage_stat,
  __mirage_tell,
  __mirage_utimes,
  __mirage_write,
  __mirage_write_bytes,
} = globalThis
for (const name of Object.getOwnPropertyNames(globalThis))
  if (name.startsWith('__mirage_')) Reflect.deleteProperty(globalThis, name)
std.SEEK_SET = 0
std.SEEK_CUR = 1
std.SEEK_END = 2
// A FILE over one descriptor of the run's table, the standard streams
// (0 to 2) included, so std.open, std.fdopen and std.in, std.out and
// std.err answer alike. Its methods are its prototype's, as the real
// engine's FILE class has them, and its descriptor stays out of sight.
const __files = new WeakMap()
const __fdOf = (file) => {
  const state = __files.get(file)
  if (state === undefined || state.closed) throw new TypeError('invalid file handle')
  return state.fd
}
const FILE = {
  readAsString(max) {
    const size = max === undefined ? -1 : toIndex(max)
    return __text(__mirage_read(__fdOf(this), size))
  },
  readAsArrayBuffer(max) {
    return __mirage_read_bytes(__fdOf(this), max === undefined ? -1 : toIndex(max))
  },
  read(buffer, position, length) {
    const fd = __fdOf(this)
    const [pos, len] = span(buffer, position, length)
    const got = new Uint8Array(__mirage_read_bytes(fd, len))
    new Uint8Array(buffer, pos, got.length).set(got)
    return got.length
  },
  getline() {
    const line = __mirage_getline(__fdOf(this))
    return line === null ? null : __text(line)
  },
  getByte() {
    const got = new Uint8Array(__mirage_read_bytes(__fdOf(this), 1))
    return got.length === 0 ? -1 : got[0]
  },
  // fputc writes the value as an unsigned char and answers it, or EOF.
  putByte(c) {
    const fd = __fdOf(this)
    const byte = (Number(c) | 0) & 0xff
    return __mirage_write_bytes(fd, new Uint8Array([byte]).buffer) === 1 ? byte : -1
  },
  puts(s) {
    __mirage_write(__fdOf(this), __pieces(String(s)))
  },
  printf(format, ...args) {
    const fd = __fdOf(this)
    const s = __pieces(__sprintf(format, args))
    __mirage_write(fd, s)
    return __mirage_byteLength(s)
  },
  write(buffer, position, length) {
    const fd = __fdOf(this)
    const [pos, len] = span(buffer, position, length)
    return __mirage_write_bytes(fd, buffer.slice(pos, pos + len))
  },
  seek(offset, whence) {
    const fd = __fdOf(this)
    const at = seekOffset(offset)
    return at === null ? -EOVERFLOW : __mirage_seek(fd, at, whence === undefined ? 0 : whence | 0)
  },
  tell() {
    return __mirage_tell(__fdOf(this))
  },
  tello() {
    return BigInt(__mirage_tell(__fdOf(this)))
  },
  fileno() {
    return __fdOf(this)
  },
  error() {
    return __mirage_ferror(__fdOf(this))
  },
  clearerr() {
    __mirage_clearerr(__fdOf(this))
  },
  eof() {
    return __mirage_eof(__fdOf(this))
  },
  flush() {
    __mirage_flush(__fdOf(this))
  },
  close() {
    const fd = __fdOf(this)
    __files.get(this).closed = true
    return __mirage_close(fd)
  },
}
const makeFile = (fd) => {
  const file = Object.create(FILE)
  __files.set(file, { fd, closed: false })
  return file
}
std.open = (path, mode, errorObj) => {
  const fd = __mirage_open(String(path), String(mode))
  if (fd === null) throw new TypeError('invalid file mode')
  if (errorObj !== undefined) errorObj.errno = fd < 0 ? -fd : 0
  if (fd < 0) return null
  return makeFile(fd)
}
// fdopen takes the descriptor as it is: one that is not open answers as
// a FILE whose calls then fail, as on WASI.
std.fdopen = (fd, mode, errorObj) => {
  if (!/^[rwa]/.test(String(mode))) throw new TypeError('invalid file mode')
  if (errorObj !== undefined) errorObj.errno = 0
  return makeFile(Number(fd) | 0)
}
std.in = makeFile(0)
std.out = makeFile(1)
std.err = makeFile(2)
std.loadFile = (path, options) => {
  const file = std.open(path, 'r')
  if (file === null) return null
  try {
    const data =
      options?.binary === true ? new Uint8Array(file.readAsArrayBuffer()) : file.readAsString()
    return file.error() ? null : data
  } finally {
    file.close()
  }
}
// The file is created before its data is taken, so data it cannot write
// leaves it empty.
std.writeFile = (path, data) => {
  const file = std.open(path, 'w')
  if (file === null) throw new Error(`error opening ${path} for writing`)
  try {
    if (data === undefined) throw new Error(`error writing to ${path}`)
    if (data instanceof ArrayBuffer) file.write(data, 0, data.byteLength)
    else if (ArrayBuffer.isView(data))
      file.write(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        0,
        data.byteLength,
      )
    else file.puts(String(data))
    if (file.error()) throw new Error(`error writing to ${path}`)
  } finally {
    file.close()
  }
}
// A position past 2**53 is not exact as a number, so a seek there is
// refused (EOVERFLOW) rather than moved somewhere near it.
const EOVERFLOW = 61
const seekOffset = (offset) => {
  if (typeof offset !== 'bigint') return Number(offset)
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  return offset > limit || offset < -limit ? null : Number(offset)
}
// qjs reads a byte budget through JS_ToIndex: NaN is 0, and a negative
// or unsafe count is a RangeError.
const toIndex = (value) => {
  const n = Math.trunc(Number(value)) || 0
  if (n < 0 || n > Number.MAX_SAFE_INTEGER) throw new RangeError('invalid array index')
  return n
}
// read and write take an ArrayBuffer and a window of it, which must fit.
const span = (buffer, position, length) => {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('not an ArrayBuffer')
  const pos = toIndex(position)
  const len = toIndex(length)
  if (pos + len > buffer.byteLength) throw new RangeError('read/write array buffer overflow')
  return [pos, len]
}
globalThis.os = globalThis.os || {}
os.readdir = (path) => __mirage_readdir(String(path))
os.stat = (path) => __mirage_stat(String(path))
os.remove = (path) => __mirage_remove(String(path))
os.mkdir = (path) => __mirage_mkdir(String(path))
os.rename = (a, b) => __mirage_rename(String(a), String(b))
os.utimes = (path, atime, mtime) => __mirage_utimes(String(path), atime, mtime)
os.S_IFMT = 61440
os.S_IFDIR = 16384
os.S_IFCHR = 8192
os.S_IFREG = 32768
os.S_IFLNK = 40960

// The descriptor calls, in the real engine's shape: a count or -errno, and
// os.seek the new offset, a bigint for a bigint offset.
os.O_APPEND = 1
os.O_CREAT = 4096
os.O_EXCL = 16384
os.O_RDONLY = 67108864
os.O_RDWR = 335544320
os.O_TRUNC = 32768
os.O_WRONLY = 268435456
os.open = (path, flags) => __mirage_os_open(String(path), Number(flags) | 0)
// A guest's files and its piped streams are no terminal.
os.isatty = () => false
os.close = (fd) => __mirage_close(Number(fd) | 0)
os.read = (fd, buffer, position, length) => {
  const [pos, len] = span(buffer, position, length)
  const got = __mirage_os_read(Number(fd) | 0, len)
  if (typeof got === 'number') return got
  const bytes = new Uint8Array(got)
  new Uint8Array(buffer, pos, bytes.length).set(bytes)
  return bytes.length
}
os.write = (fd, buffer, position, length) => {
  const [pos, len] = span(buffer, position, length)
  return __mirage_os_write(Number(fd) | 0, buffer.slice(pos, pos + len))
}
os.seek = (fd, offset, whence) => {
  const target = seekOffset(offset)
  const moved = target === null ? -EOVERFLOW : __mirage_seek(Number(fd) | 0, target, whence | 0)
  const at = moved < 0 ? moved : __mirage_tell(Number(fd) | 0)
  return typeof offset === 'bigint' ? BigInt(at) : at
}

os.getcwd = () => [__mirage_getcwd(), 0]
os.chdir = (path) => __mirage_chdir(String(path))

os.S_IFBLK = 24576
os.S_IFIFO = 4096
os.S_IFSOCK = 49152
os.S_ISGID = 1024
os.S_ISUID = 2048
os.platform = 'wasi'
os.SIGINT = 2
os.SIGABRT = 6
os.SIGFPE = 8
os.SIGILL = 4
os.SIGSEGV = 11
os.SIGTERM = 15
// WASI delivers no signals, so a handler is never called.
os.signal = () => undefined
os.exePath = () => undefined
os.now = () => __mirage_now()
os.sleep = (ms) => {
  __mirage_sleep(Number(ms) || 0)
}

// The real engine's loop: once the script and its jobs are done, the
// host calls its turn until that answers -1, after the ms it answers.
// A handler on a descriptor is called each turn, as one select(2) finds
// ready: a file or the run's input always is.
const __timers = new Map()
const __readers = new Map()
const __writers = new Map()
let __lastTimer = 0
const __timer = (fn, ms, every) => {
  if (typeof fn !== 'function') throw new TypeError('not a function')
  const delay = Math.max(0, Number(ms) || 0)
  __lastTimer += 1
  __timers.set(__lastTimer, { at: __mirage_now() + delay, fn, every: every ? delay : null })
  return __lastTimer
}
os.setTimeout = (fn, ms) => __timer(fn, ms, false)
os.setInterval = (fn, ms) => __timer(fn, ms, true)
os.clearTimeout = (id) => {
  __timers.delete(id)
}
os.clearInterval = os.clearTimeout
os.sleepAsync = (ms) =>
  new Promise((resolve) => {
    os.setTimeout(resolve, ms)
  })
const __handler = (table) => (fd, fn) => {
  if (fn === null || fn === undefined) table.delete(Number(fd) | 0)
  else table.set(Number(fd) | 0, fn)
}
os.setReadHandler = __handler(__readers)
os.setWriteHandler = __handler(__writers)
// The host reaches the loop's turn under a symbol, which no name a
// program lists shows.
const __tick = () => {
  // One call a turn, as the real engine's poll makes: the earliest
  // expired timer, else the first handler registered.
  const now = __mirage_now()
  let first = null
  for (const [id, timer] of __timers)
    if (timer.at <= now && (first === null || timer.at < first[1].at)) first = [id, timer]
  if (first !== null) {
    const [id, timer] = first
    if (timer.every === null) __timers.delete(id)
    else timer.at = now + timer.every
    timer.fn()
    return 0
  }
  const handler = [...__readers.values(), ...__writers.values()][0]
  if (handler !== undefined) {
    handler()
    return 0
  }
  if (__timers.size === 0) return -1
  const next = Math.min(...[...__timers.values()].map((timer) => timer.at))
  return Math.max(0, next - __mirage_now())
}
Object.defineProperty(globalThis, Symbol.for('mirage.tick'), { value: __tick })
