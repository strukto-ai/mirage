std.SEEK_SET = 0
std.SEEK_CUR = 1
std.SEEK_END = 2
std.open = (path, mode, errorObj) => {
  const fd = __mirage_open(String(path), String(mode))
  if (fd === null) throw new TypeError('invalid file mode')
  if (errorObj !== undefined) errorObj.errno = fd < 0 ? -fd : 0
  if (fd < 0) return null
  let closed = false
  const methods = {
    readAsString: (max) => {
      const size = max === undefined ? -1 : toIndex(max)
      return __text(__mirage_read(fd, size))
    },
    read: (buffer, position, length) => {
      const [pos, len] = span(buffer, position, length)
      const got = new Uint8Array(__mirage_read_bytes(fd, len))
      new Uint8Array(buffer, pos, got.length).set(got)
      return got.length
    },
    getline: () => {
      const line = __mirage_getline(fd)
      return line === null ? null : __text(line)
    },
    getByte: () => {
      const got = new Uint8Array(__mirage_read_bytes(fd, 1))
      return got.length === 0 ? -1 : got[0]
    },
    // fputc writes the value as an unsigned char and answers it, or EOF.
    putByte: (c) => {
      const byte = (Number(c) | 0) & 0xff
      return __mirage_write_bytes(fd, new Uint8Array([byte]).buffer) === 1 ? byte : -1
    },
    puts: (s) => {
      __mirage_write(fd, __pieces(String(s)))
    },
    write: (buffer, position, length) => {
      const [pos, len] = span(buffer, position, length)
      return __mirage_write_bytes(fd, buffer.slice(pos, pos + len))
    },
    seek: (offset, whence) =>
      __mirage_seek(fd, Number(offset), whence === undefined ? 0 : whence | 0),
    tell: () => __mirage_tell(fd),
    error: () => __mirage_ferror(fd),
    clearerr: () => {
      __mirage_clearerr(fd)
    },
    eof: () => __mirage_eof(fd),
    flush: () => {
      __mirage_flush(fd)
    },
    close: () => {
      closed = true
      return __mirage_close(fd)
    },
  }
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args) => {
        if (closed) throw new TypeError('invalid file handle')
        return method(...args)
      },
    ]),
  )
}
std.loadFile = (path) => {
  const file = std.open(path, 'r')
  if (file === null) return null
  try {
    const text = file.readAsString()
    return file.error() ? null : text
  } finally {
    file.close()
  }
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
  const moved = __mirage_seek(Number(fd) | 0, Number(offset), whence | 0)
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
