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
from pyodide.ffi import run_sync
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
else:
    _open = builtins.open
    _io_open = io.open
    _listdir = os.listdir
    _stat = os.stat
    _scandir = os.scandir
    _mkdir = os.mkdir

def _under_prefix(path):
    if not isinstance(path, str):
        return False
    for p in _mb.prefixes():
        if path.startswith(p):
            return True
    return False

def _is_writable_mode(mode):
    for c in ('w', 'a', '+', 'x'):
        if c in mode:
            return True
    return False

class _FlushOnClose(io.FileIO):
    def __init__(self, path, mode='r', closefd=True, opener=None):
        super().__init__(path, mode=mode, closefd=closefd, opener=opener)
        self._mirage_path = os.fspath(path)
        self._mirage_dirty = False

    def write(self, b):
        n = super().write(b)
        if n:
            self._mirage_dirty = True
        return n

    def writelines(self, lines):
        super().writelines(lines)
        self._mirage_dirty = True

    def truncate(self, size=None):
        out = super().truncate(size)
        self._mirage_dirty = True
        return out

    def close(self):
        was_dirty = self._mirage_dirty and not self.closed
        super().close()
        if was_dirty:
            with _open(self._mirage_path, 'rb') as src:
                data = src.read()
            run_sync(_mb.flush(self._mirage_path, data))

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

def _patched_open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    if isinstance(file, int):
        return _open(file, mode, buffering, encoding, errors, newline, closefd, opener)
    sp = file if isinstance(file, str) else os.fspath(file)
    if isinstance(sp, bytes):
        sp = sp.decode()
    sp = os.path.normpath(sp)
    under = _under_prefix(sp)
    writable = _is_writable_mode(mode)
    if under and not writable and not _exists_raw(sp):
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

_mod = types.ModuleType('_mirage_fs_shim')
_mod._original_listdir = _listdir
_mod._original_stat = _stat
_mod._original_scandir = _scandir
_mod._original_mkdir = _mkdir
_mod._backfill = _backfill
sys.modules['_mirage_fs_shim'] = _mod
`
