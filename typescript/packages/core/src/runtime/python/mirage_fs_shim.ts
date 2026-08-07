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

export const MIRAGE_FS_SHIM_PY = `
import builtins
import io
import js
import os
import sys
import types
from pyodide.ffi import run_sync, to_js
import _mirage_bridge as _mb

_already_patched = getattr(builtins.open, '_mirage_patched', False)
if _already_patched:
    _open = builtins.open._mirage_original_open
    _io_open = io.open
    _shim = sys.modules['_mirage_fs_shim']
    _listdir = _shim._original_listdir
    _stat = _shim._original_stat
    _scandir = _shim._original_scandir
    _mkdir = _shim._original_mkdir
    _rmdir = _shim._original_rmdir
    _unlink = _shim._original_unlink
    _rename = _shim._original_rename
    _lstat = _shim._original_lstat
else:
    _open = builtins.open
    _io_open = io.open
    _listdir = os.listdir
    _stat = os.stat
    _scandir = os.scandir
    _mkdir = os.mkdir
    _rmdir = os.rmdir
    _unlink = os.unlink
    _rename = os.rename
    _lstat = os.lstat

def _under_prefix(path):
    if not isinstance(path, str):
        return False
    for p in _mb.prefixes():
        if path.startswith(p):
            return True
    return False

# The mount serving a path, longest prefix first, or None. Two paths
# belong to the same mount only when this agrees for both, which is what
# the cross-mount rename guard needs. prefixes() is a sync JS call, so
# this costs no stack switching.
def _mount_of(path):
    best = None
    for p in _mb.prefixes():
        if path == p.rstrip('/') or path.startswith(p):
            if best is None or len(p) > len(best):
                best = p
    return best

def _is_writable_mode(mode):
    for c in ('w', 'a', '+', 'x'):
        if c in mode:
            return True
    return False

def _truncates(mode):
    return 'w' in mode or 'x' in mode

def _read_raw(path):
    try:
        with _open(path, 'rb') as f:
            return f.read()
    except OSError as exc:
        js.console.warn('mirage flush: read back ' + path + ' failed: ' + str(exc))
        return b''

# close() only records on the bridge (a sync JS call): awaiting the async
# op from these sync WASM frames would need JSPI stack switching, which
# most engines do not enable. The runtime replays the journal after the
# script returns.
#
# An append-mode handle records only the bytes it wrote, never the whole
# file. That is what makes append safe on a file MEMFS has not seen: the
# mount keeps whatever it already held and gains the tail, instead of
# being overwritten by a buffer that started empty.
class _FlushOnClose(io.FileIO):
    def __init__(self, path, mode='r', closefd=True, opener=None):
        super().__init__(path, mode=mode, closefd=closefd, opener=opener)
        self._mirage_path = os.fspath(path)
        self._mirage_dirty = False
        self._mirage_append = 'a' in mode
        self._mirage_delta = bytearray()

    def write(self, b):
        n = super().write(b)
        if n:
            self._mirage_dirty = True
            if self._mirage_append:
                self._mirage_delta += bytes(b)[:n]
        return n

    def writelines(self, lines):
        # IOBase.writelines calls self.write per line, so the delta is
        # already accumulated above; this only records the dirty edge.
        super().writelines(lines)
        self._mirage_dirty = True

    def truncate(self, size=None):
        out = super().truncate(size)
        self._mirage_dirty = True
        # Truncation rewrites history the tail-only record cannot express,
        # so fall back to shipping the whole file for this handle.
        self._mirage_append = False
        return out

    def close(self):
        was_dirty = self._mirage_dirty and not self.closed
        path = self._mirage_path
        append = self._mirage_append
        delta = bytes(self._mirage_delta)
        super().close()
        if not was_dirty:
            return
        if append:
            _mb.markAppend(path, to_js(delta))
        else:
            _mb.markWrite(path, to_js(_read_raw(path)))

def _strip_bt(mode):
    return mode.replace('b', '').replace('t', '')

def _entry_path(e):
    return getattr(e, 'path', None) or e['path']

def _entry_is_dir(e):
    val = getattr(e, 'isDir', None)
    if val is None:
        val = e['isDir']
    return bool(val)

def _to_bytes(data):
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    to_py = getattr(data, 'to_py', None)
    if to_py is not None:
        converted = to_py()
        if isinstance(converted, (bytes, bytearray)):
            return bytes(converted)
        return bytes(converted)
    return bytes(data)

# The lazy backfill below is the shim's one JSPI-dependent surface:
# run_sync suspends the WASM stack while the async bridge op settles, and
# raises RuntimeError on engines without stack switching. Both callers
# treat that as a miss (warn, return None), so without JSPI reads fall
# back to whatever the host preloaded into MEMFS before the run.
def _list_bridge(target):
    try:
        return run_sync(_mb.list(target))
    except BaseException as exc:
        js.console.warn('mirage lazy: list ' + target + ' failed: ' + str(exc))
        return None

def _fetch_bridge(path):
    try:
        return run_sync(_mb.fetch(path))
    except BaseException as exc:
        js.console.warn('mirage lazy: fetch ' + path + ' failed: ' + str(exc))
        return None

def _exists_raw(path):
    try:
        _stat(path)
        return True
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError:
        return False

def _makedirs_raw(path):
    if path == '' or path == '/' or _exists_raw(path):
        return
    parent = os.path.dirname(path)
    if parent and parent != path:
        _makedirs_raw(parent)
    try:
        _mkdir(path)
    except FileExistsError:
        pass
    except OSError as exc:
        js.console.warn('mirage lazy: mkdir ' + path + ' failed: ' + str(exc))

def _populate_entries(entries):
    for e in entries:
        ep = _entry_path(e)
        if not isinstance(ep, str) or ep == '':
            continue
        if _entry_is_dir(e):
            _makedirs_raw(ep)
        else:
            if not _exists_raw(ep):
                data = _fetch_bridge(ep)
                if data is None:
                    continue
                parent = os.path.dirname(ep)
                if parent:
                    _makedirs_raw(parent)
                try:
                    with _open(ep, 'wb') as f:
                        f.write(_to_bytes(data))
                except OSError as exc:
                    js.console.warn('mirage lazy: write ' + ep + ' failed: ' + str(exc))

def _backfill(path):
    if not _under_prefix(path):
        return False
    norm = os.path.normpath(path)
    as_dir = norm if norm.endswith('/') else norm + '/'
    entries = _list_bridge(as_dir)
    if entries is not None and len(entries) > 0:
        _populate_entries(entries)
        return True
    parent = os.path.dirname(norm)
    if parent == '' or parent == norm:
        return entries is not None
    parent_dir = parent if parent.endswith('/') else parent + '/'
    if not _under_prefix(parent_dir):
        return entries is not None
    parent_entries = _list_bridge(parent_dir)
    if parent_entries is None:
        return entries is not None
    _populate_entries(parent_entries)
    return True

def _normalize_path(path):
    if isinstance(path, int):
        return None
    sp = path if isinstance(path, str) else os.fspath(path)
    if isinstance(sp, bytes):
        sp = sp.decode()
    return sp

def _patched_listdir(path='.'):
    sp = _normalize_path(path)
    if sp is None:
        return _listdir(path)
    try:
        return _listdir(sp)
    except FileNotFoundError:
        if _backfill(sp):
            return _listdir(sp)
        raise

def _patched_stat(path, *, dir_fd=None, follow_symlinks=True):
    sp = _normalize_path(path)
    if sp is None:
        return _stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    try:
        return _stat(sp, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    except FileNotFoundError:
        if _backfill(sp):
            return _stat(sp, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
        raise

def _patched_lstat(path, *, dir_fd=None):
    sp = _normalize_path(path)
    if sp is None:
        return _lstat(path, dir_fd=dir_fd)
    try:
        return _lstat(sp, dir_fd=dir_fd)
    except FileNotFoundError:
        if _backfill(sp):
            return _lstat(sp, dir_fd=dir_fd)
        raise

def _patched_scandir(path='.'):
    sp = _normalize_path(path)
    if sp is None:
        return _scandir(path)
    try:
        return _scandir(sp)
    except FileNotFoundError:
        if _backfill(sp):
            return _scandir(sp)
        raise

# The mutation patches below apply to MEMFS first, so the rest of the run
# sees its own change, and then record on the bridge. They never consult
# the bridge inline, so unlike the lazy backfill they need no JSPI.
#
# A MEMFS miss is not an error here and must not be raised: the mount is
# the authority, and this interpreter only ever preloads a prefix once, so
# anything a shell command created since is legitimately absent from MEMFS.
# Refusing on that basis is exactly the bug this patch set removes. A path
# that truly exists nowhere fails when the journal is replayed, which puts
# the message on stderr and the run's exit code at 1.
def _patched_mkdir(path, mode=0o777, *, dir_fd=None):
    sp = _normalize_path(path)
    if sp is None or dir_fd is not None:
        return _mkdir(path, mode, dir_fd=dir_fd)
    norm = os.path.normpath(sp)
    if not _under_prefix(norm):
        return _mkdir(path, mode, dir_fd=dir_fd)
    _makedirs_raw(os.path.dirname(norm))
    _mkdir(norm, mode)
    _mb.markMkdir(norm)

def _patched_rmdir(path, *, dir_fd=None):
    sp = _normalize_path(path)
    if sp is None or dir_fd is not None:
        return _rmdir(path, dir_fd=dir_fd)
    norm = os.path.normpath(sp)
    if not _under_prefix(norm):
        return _rmdir(path, dir_fd=dir_fd)
    try:
        _rmdir(norm)
    except FileNotFoundError:
        pass
    _mb.markRmdir(norm)

def _patched_unlink(path, *, dir_fd=None):
    sp = _normalize_path(path)
    if sp is None or dir_fd is not None:
        return _unlink(path, dir_fd=dir_fd)
    norm = os.path.normpath(sp)
    if not _under_prefix(norm):
        return _unlink(path, dir_fd=dir_fd)
    try:
        _unlink(norm)
    except FileNotFoundError:
        pass
    _mb.markUnlink(norm)

def _patched_rename(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
    ssp = _normalize_path(src)
    dsp = _normalize_path(dst)
    if ssp is None or dsp is None or src_dir_fd is not None or dst_dir_fd is not None:
        return _rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    s = os.path.normpath(ssp)
    d = os.path.normpath(dsp)
    if not _under_prefix(s) and not _under_prefix(d):
        return _rename(src, dst)
    # The dispatcher picks the mount from the source and addresses the
    # destination against that same backend, so a cross-mount rename would
    # drop the source and write into the wrong store. EXDEV is the POSIX
    # answer, and the one that tells a caller to copy instead.
    if _mount_of(s) != _mount_of(d):
        raise OSError(18, 'Invalid cross-device link', s, None, d)
    _makedirs_raw(os.path.dirname(d))
    try:
        _rename(s, d)
    except FileNotFoundError:
        pass
    _mb.markRename(s, d)

def _patched_open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    if isinstance(file, int):
        return _open(file, mode, buffering, encoding, errors, newline, closefd, opener)
    sp = file if isinstance(file, str) else os.fspath(file)
    if isinstance(sp, bytes):
        sp = sp.decode()
    sp = os.path.normpath(sp)
    under = _under_prefix(sp)
    writable = _is_writable_mode(mode)
    # A non-truncating writable open ('a', 'r+') keeps what the file
    # already holds, so it needs the same backfill a read does; only 'w'
    # and 'x' start from nothing. Without this an update-in-place opened
    # against a MEMFS miss would build its buffer from empty.
    if under and (not writable or not _truncates(mode)) and not _exists_raw(sp):
        _backfill(sp)
    if under and writable:
        binary_mode = _strip_bt(mode) or 'r'
        if 'b' in mode:
            return _FlushOnClose(sp, mode=binary_mode, closefd=closefd, opener=opener)
        raw = _FlushOnClose(sp, mode=binary_mode, closefd=closefd, opener=opener)
        line_buffering = buffering == 1
        return io.TextIOWrapper(raw, encoding=encoding, errors=errors, newline=newline, line_buffering=line_buffering)
    return _open(file, mode, buffering, encoding, errors, newline, closefd, opener)

if not _already_patched:
    _patched_open._mirage_patched = True
    _patched_open._mirage_original_open = _open
    builtins.open = _patched_open
    io.open = _patched_open
    os.listdir = _patched_listdir
    os.stat = _patched_stat
    os.scandir = _patched_scandir
    # Rebinding these six covers the whole family: os.makedirs calls the
    # module's own mkdir, pathlib's Path.mkdir/unlink/rename and
    # shutil.rmtree/move all reach the mutation through os, so no
    # per-spelling patch list is needed and none can fall out of step.
    os.mkdir = _patched_mkdir
    os.rmdir = _patched_rmdir
    os.unlink = _patched_unlink
    os.remove = _patched_unlink
    os.rename = _patched_rename
    os.replace = _patched_rename
    os.lstat = _patched_lstat
    # Nothing reached over the bridge can act on a directory fd: the
    # mount ops address paths. Saying so keeps a caller that chooses
    # between a path-based and an fd-relative implementation on the one
    # these patches can see.
    os.supports_dir_fd = frozenset()
    # shutil is already imported when the shim installs, so it cached
    # that answer from the unpatched os and rmtree would still walk with
    # openat/unlinkat, invisible here. Correct the cached gate. If
    # upstream renames it, the rmtree conformance row goes red rather
    # than dropping the mutation silently.
    _shutil = sys.modules.get('shutil')
    if _shutil is not None and hasattr(_shutil, '_use_fd_functions'):
        _shutil._use_fd_functions = False

_mod = types.ModuleType('_mirage_fs_shim')
_mod._original_listdir = _listdir
_mod._original_stat = _stat
_mod._original_scandir = _scandir
_mod._original_mkdir = _mkdir
_mod._original_rmdir = _rmdir
_mod._original_unlink = _unlink
_mod._original_rename = _rename
_mod._original_lstat = _lstat
_mod._backfill = _backfill
sys.modules['_mirage_fs_shim'] = _mod
`
