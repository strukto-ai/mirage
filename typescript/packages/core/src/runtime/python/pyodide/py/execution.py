import ast
import base64
import codeop
import errno
import glob
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import traceback
import types
import warnings
from contextlib import contextmanager

import _mirage_process
import _mirage_xattr

_process_active = False
_inherited_inputs = {}
_process_stdio = None


def _process_call(op, **params):
    global _process_active
    result = json.loads(_mirage_process.run(json.dumps(dict(op=op, **params))))
    if 'error' in result:
        raise OSError(getattr(errno, result['code'], errno.EIO),
                      result['error'])
    for pid, count in result.get('consumed', {}).items():
        inherited = _inherited_inputs.get(int(pid))
        if inherited is not None:
            stream, offset = inherited
            if not stream.closed:
                stream.seek(max(stream.tell(), offset + count))
    if op == 'spawn':
        _process_active = True
    elif op == 'finish':
        _process_active = False
        _inherited_inputs.clear()
    for stream in ('stdout', 'stderr'):
        data = base64.b64decode(result.get('inherited_' + stream, ''))
        if data:
            target = _process_stdio[1 if stream == 'stdout' else 2]
            target.buffer.write(data)
    return result


class ProcessPipe(io.RawIOBase):

    def __init__(self, pid, stream):
        super().__init__()
        self.pid = pid
        self.stream = stream
        self.pending = bytearray()
        self.eof = False

    def readable(self):
        return self.stream != 'stdin'

    def writable(self):
        return self.stream == 'stdin'

    def readinto(self, target):
        self._checkClosed()
        if not self.readable():
            raise io.UnsupportedOperation('not readable')
        if not target:
            return 0
        if not self.pending and not self.eof:
            result = _process_call('read', pid=self.pid, stream=self.stream)
            self.pending.extend(base64.b64decode(result['data']))
            self.eof = not self.pending
        size = min(len(target), len(self.pending))
        target[:size] = self.pending[:size]
        del self.pending[:size]
        return size

    def write(self, data):
        self._checkClosed()
        if not self.writable():
            raise io.UnsupportedOperation('not writable')
        data = bytes(data)
        _process_call('write',
                      pid=self.pid,
                      data=base64.b64encode(data).decode('ascii'))
        return len(data)

    def close(self):
        if not self.closed and _process_active:
            if self.writable():
                _process_call('close', pid=self.pid)
            else:
                _process_call('close', pid=self.pid, stream=self.stream)
        super().close()


class MiragePopen:
    """The subprocess protocol backed by invocation-owned Mirage processes."""

    def __init__(self,
                 args,
                 bufsize=-1,
                 executable=None,
                 stdin=None,
                 stdout=None,
                 stderr=None,
                 preexec_fn=None,
                 close_fds=True,
                 shell=False,
                 cwd=None,
                 env=None,
                 universal_newlines=None,
                 startupinfo=None,
                 creationflags=0,
                 restore_signals=True,
                 start_new_session=False,
                 pass_fds=(),
                 *,
                 user=None,
                 group=None,
                 extra_groups=None,
                 encoding=None,
                 errors=None,
                 text=None,
                 umask=-1,
                 pipesize=-1,
                 process_group=None):
        if (preexec_fn is not None or not close_fds or startupinfo is not None
                or creationflags or not restore_signals or start_new_session
                or pass_fds or user is not None or group is not None
                or extra_groups is not None or umask != -1 or pipesize != -1
                or process_group not in (None, -1)):
            raise NotImplementedError(
                'native process attributes and descriptors are unsupported')
        if not isinstance(bufsize, int):
            raise TypeError('bufsize must be an integer')
        if text is not None and universal_newlines is not None and bool(
                text) != bool(universal_newlines):
            raise subprocess.SubprocessError(
                'Cannot disambiguate when both text and universal_newlines '
                'are supplied but different. Pass one or the other.')
        if stdin not in (None, subprocess.PIPE, subprocess.DEVNULL):
            raise NotImplementedError(
                'stdin supports inheritance, PIPE and DEVNULL')
        if stdout not in (None, subprocess.PIPE, subprocess.DEVNULL):
            raise NotImplementedError(
                'stdout supports inheritance, PIPE and DEVNULL')
        if stderr not in (None, subprocess.PIPE, subprocess.DEVNULL,
                          subprocess.STDOUT):
            raise NotImplementedError(
                'stderr supports inheritance, PIPE, DEVNULL and STDOUT')
        self.args = args
        if isinstance(args, (str, bytes, os.PathLike)):
            argv = [os.fsdecode(args)]
        else:
            argv = [os.fsdecode(arg) for arg in args]
        if not argv:
            raise ValueError('args must not be empty')
        if shell:
            argv = [
                os.fsdecode(executable) if executable else '/usr/bin/sh', '-c',
                *argv
            ]
        elif executable is not None:
            raise NotImplementedError(
                'separate executable and argv[0] are unsupported')
        if any('\0' in arg for arg in argv):
            raise ValueError('embedded null byte')
        environment = {
            os.fsdecode(k): os.fsdecode(v)
            for k, v in (os.environ if env is None else env).items()
        }
        if any('=' in k or '\0' in k or '\0' in v
               for k, v in environment.items()):
            raise ValueError('illegal environment variable')
        directory = os.getcwd() if cwd is None else os.path.abspath(
            os.fsdecode(cwd))
        if not os.path.isdir(directory):
            if os.path.exists(directory):
                raise NotADirectoryError(errno.ENOTDIR, 'Not a directory',
                                         directory)
            raise FileNotFoundError(errno.ENOENT, 'No such file or directory',
                                    directory)
        self.encoding, self.errors = encoding or 'utf-8', errors or 'strict'
        self.text_mode = bool(text or universal_newlines or encoding or errors)
        self.returncode = None
        self._communication_started = False
        self._output = None
        self._raw_pipes = {}
        self._input_mode = stdin
        self._output_mode = stdout
        self._error_mode = stderr
        inherited = b''
        source = None
        if stdin is None:
            source = _process_stdio[0].buffer
            offset = source.tell()
            inherited = source.read()
            source.seek(offset)
        result = _process_call(
            'spawn',
            argv=argv,
            cwd=directory,
            env=environment,
            stdin=stdin or 0,
            stdout=stdout or 0,
            stderr=stderr or 0,
            data=base64.b64encode(inherited).decode('ascii'))
        self.pid = result['pid']
        self._released = False
        if source is not None and inherited:
            _inherited_inputs[self.pid] = (source, offset)
        self.stdin = self._pipe('stdin',
                                bufsize) if stdin == subprocess.PIPE else None
        self.stdout = self._pipe(
            'stdout', bufsize) if stdout == subprocess.PIPE else None
        self.stderr = self._pipe(
            'stderr', bufsize) if stderr == subprocess.PIPE else None

    def _pipe(self, name, bufsize):
        raw = ProcessPipe(self.pid, name)
        self._raw_pipes[name] = raw
        stream = raw
        if bufsize != 0:
            size = io.DEFAULT_BUFFER_SIZE if bufsize < 2 else bufsize
            stream = io.BufferedWriter(
                raw, size) if name == 'stdin' else io.BufferedReader(
                    raw, size)
        if self.text_mode:
            stream = io.TextIOWrapper(stream,
                                      encoding=self.encoding,
                                      errors=self.errors,
                                      write_through=True,
                                      line_buffering=bufsize == 1)
        return stream

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        self.returncode = _process_call('poll', pid=self.pid)['returncode']
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        result = _process_call('wait', pid=self.pid, timeout=timeout)
        self.returncode = result['returncode']
        if result['timeout']:
            raise subprocess.TimeoutExpired(self.args, timeout)
        return self.returncode

    def communicate(self, input=None, timeout=None):
        if self._communication_started and input is not None:
            raise ValueError('Cannot send input after starting communication')
        if self._output is not None:
            return self._output
        if input is not None and self.stdin is None:
            raise ValueError('Cannot send input when stdin is not PIPE')
        params = dict(pid=self.pid, timeout=timeout)
        if not self._communication_started:
            if self.stdin is not None and not self.stdin.closed:
                try:
                    self.stdin.flush()
                except BrokenPipeError:
                    pass
            if input is not None:
                raw = input.encode(
                    self.encoding, self.errors
                ) if self.text_mode else memoryview(input).tobytes()
                params['data'] = base64.b64encode(raw).decode('ascii')
        self._communication_started = True
        result = _process_call('communicate', **params)
        out = base64.b64decode(
            result['stdout']) if self.stdout is not None else None
        err = base64.b64decode(
            result['stderr']) if self.stderr is not None else None
        self.returncode = result['returncode']
        if result['timeout']:
            raise subprocess.TimeoutExpired(self.args,
                                            timeout,
                                            output=out,
                                            stderr=err)
        outputs = []
        for name, data in (('stdout', out), ('stderr', err)):
            if data is None:
                outputs.append(None)
            else:
                raw = self._raw_pipes[name]
                raw.pending.extend(data)
                raw.eof = True
                outputs.append(getattr(self, name).read())
        for stream in (self.stdin, self.stdout, self.stderr):
            if stream is not None and not stream.closed:
                stream.close()
        self._output = tuple(outputs)
        self._release()
        return self._output

    def send_signal(self, signal):
        if signal not in (9, 15):
            raise NotImplementedError('only termination signals are supported')
        if self.returncode is None:
            _process_call('kill', pid=self.pid, signal=int(signal))

    def terminate(self):
        self.send_signal(15)

    def kill(self):
        self.send_signal(9)

    def _release(self):
        if not self._released:
            _process_call('release', pid=self.pid)
            _inherited_inputs.pop(self.pid, None)
            self._released = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        try:
            for stream in (self.stdout, self.stderr, self.stdin):
                if stream is not None and not stream.closed:
                    stream.close()
        finally:
            self.wait()
            self._release()


def process_which(cmd, mode=os.F_OK | os.X_OK, path=None):
    if mode != os.F_OK | os.X_OK:
        raise NotImplementedError('which supports executable lookup only')
    result = _process_call('resolve',
                           argv=[os.fsdecode(cmd)],
                           cwd=os.getcwd(),
                           env={
                               'PATH':
                               os.fsdecode(path) if path is not None else
                               os.environ.get('PATH', '/usr/bin')
                           })
    found = result['path']
    return os.fsencode(found) if isinstance(
        cmd, bytes) and found is not None else found


subprocess.Popen = MiragePopen
shutil.which = process_which


class OutputCapture(io.RawIOBase):

    def __init__(self):
        super().__init__()
        self.data = bytearray()
        self.text = io.TextIOWrapper(self,
                                     encoding='utf-8',
                                     errors='replace',
                                     write_through=True,
                                     line_buffering=True)

    def writable(self):
        return True

    def write(self, data):
        self._checkClosed()
        self.data.extend(data)
        return len(data)

    def diagnostic(self, text):
        # Host diagnostics remain available even after the guest closes stderr.
        if self.text.buffer is not None and not self.text.closed:
            self.text.flush()
        self.data.extend(text.encode('utf-8', errors='replace'))

    def __exit__(self, *exc):
        try:
            # A guest may reconfigure buffering, close, or detach the wrapper.
            if self.text.buffer is not None and not self.text.closed:
                self.text.close()
        finally:
            self.close()

    def to_list(self):
        # Pyodide's toJs buffer conversion slices with signed wasm32 addresses:
        # above 2 GiB it reads the wrong bytes. Transfer numeric values.
        return list(self.data)


repl_session_globals = {}
repl_session_cwds = {}


@contextmanager
def working_directory(cwd, session=None):
    saved_getcwd, saved_chdir = os.getcwd, os.chdir
    saved_cwd = saved_getcwd()
    entered = False
    if session is not None:
        # A vanished cwd still fails this feed, but the next can recover.
        repl_session_cwds[session] = '/'
    try:
        if cwd:
            saved_chdir(cwd)
        entered = True
        yield
    finally:
        try:
            if entered and session is not None:
                repl_session_cwds[session] = saved_getcwd()
        finally:
            os.getcwd, os.chdir = saved_getcwd, saved_chdir
            saved_chdir(saved_cwd)


def eval_enc(o):
    if isinstance(o, (bytes, bytearray)):
        b64 = base64.b64encode(bytes(o)).decode('ascii')
        return {'__mirage_bytes__': b64}
    raise TypeError('%s is not JSON-serializable' % type(o).__name__)


def run(request, arm_interrupt, disarm_interrupt):
    global _process_stdio, _process_active
    user_code = request['code']
    init_flags = request['flags']
    argv = request['argv']
    cwd = request['cwd']
    script_cli = request['script_cli']
    merged_env = request['env']
    stdin_bytes = request['stdin']
    saved_getcwd = os.getcwd
    saved_cwd = saved_getcwd()
    saved_chdir = os.chdir
    saved_env = dict(os.environ)
    saved_path = list(sys.path)
    saved_stdin = sys.stdin
    saved_stdout = sys.stdout
    saved_stderr = sys.stderr
    saved_executable = sys.executable
    saved_argv = sys.argv
    had_main = '__main__' in sys.modules
    saved_main = sys.modules.get('__main__')

    out_bytes = OutputCapture()
    err_bytes = OutputCapture()
    out_text = out_bytes.text
    err_text = err_bytes.text

    stdin_buf = io.BytesIO(
        bytes(stdin_bytes) if stdin_bytes is not None else b'')
    stdin_text = io.TextIOWrapper(stdin_buf,
                                  encoding='utf-8',
                                  errors='replace')

    flags = dict(init_flags) if init_flags is not None else {}

    optimize = min(int(flags.get('O') or 0), 2)
    saved_dwb = sys.dont_write_bytecode
    saved_xop = dict(sys._xoptions)
    saved_filters = None

    with out_bytes, err_bytes:
        exit_code = 0
        try:
            sys.executable = "/usr/bin/python3"
            os.environ.clear()
            os.environ.update(merged_env)
            if flags.get('B'):
                sys.dont_write_bytecode = True
            for xopt in flags.get('X') or []:
                name, _, value = str(xopt).partition('=')
                sys._xoptions[name] = value if value else True
            if flags.get('W'):
                saved_filters = warnings.filters[:]
                for spec in flags.get('W') or []:
                    try:
                        warnings._setoption(str(spec))
                    except warnings._OptionError as werr:
                        err_bytes.diagnostic(
                            f'Invalid -W option ignored: {werr}\n')
            sys.stdin = stdin_text
            sys.stdout = out_text
            sys.stderr = err_text
            _process_stdio = (stdin_text, out_text, err_text)
            sys.argv = list(argv)
            main_module = types.ModuleType('__main__')
            user_globals = main_module.__dict__
            user_globals['__annotations__'] = {}
            sys.modules['__main__'] = main_module
            if script_cli:
                user_globals.update(argv=list(argv),
                                    stdin=bytes(stdin_bytes)
                                    if stdin_bytes is not None else None)
            try:
                try:
                    arm_interrupt()
                    if cwd != '':
                        saved_chdir(cwd)
                    exec(
                        compile(user_code,
                                '<string>',
                                'exec',
                                optimize=optimize), user_globals)
                finally:
                    disarm_interrupt()
            except SystemExit as e:
                code = e.code
                if code is None:
                    exit_code = 0
                elif isinstance(code, bool):
                    exit_code = int(code)
                elif isinstance(code, int):
                    exit_code = code
                else:
                    err_bytes.diagnostic(str(code) + '\n')
                    exit_code = 1
            except BaseException:
                err_bytes.diagnostic(traceback.format_exc())
                exit_code = 1
        finally:
            if had_main:
                sys.modules['__main__'] = saved_main
            else:
                sys.modules.pop('__main__', None)
            os.environ.clear()
            os.environ.update(saved_env)
            sys.path[:] = saved_path
            sys.dont_write_bytecode = saved_dwb
            sys._xoptions.clear()
            sys._xoptions.update(saved_xop)
            if saved_filters is not None:
                warnings.filters[:] = saved_filters
                warnings._filters_mutated()
            if _process_active:
                try:
                    _process_call("finish")
                except BaseException:
                    err_bytes.diagnostic(traceback.format_exc())
                    exit_code = 1
            _process_active = False
            _inherited_inputs.clear()
            _process_stdio = None
            sys.stdin = saved_stdin
            sys.stdout = saved_stdout
            sys.stderr = saved_stderr
            sys.executable = saved_executable
            sys.argv = saved_argv
            os.chdir = saved_chdir
            os.getcwd = saved_getcwd
            saved_chdir(saved_cwd)

    return (out_bytes.to_list(), err_bytes.to_list(), exit_code)


def evaluate(user_code, eval_inputs, cwd=''):
    out_bytes = OutputCapture()
    err_bytes = OutputCapture()
    out_text = out_bytes.text
    err_text = err_bytes.text

    with out_bytes, err_bytes:
        ok = True
        syntax = False
        value_json = 'null'
        try:
            tree = ast.parse(user_code)
        except SyntaxError:
            ok = False
            syntax = True
            err_bytes.diagnostic(traceback.format_exc())
        else:
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body[-1].value)
                tree.body = tree.body[:-1]
            g = dict(eval_inputs)
            g.setdefault('__builtins__', __builtins__)
            saved_stdout, saved_stderr = sys.stdout, sys.stderr
            sys.stdout, sys.stderr = out_text, err_text
            try:
                with working_directory(cwd):
                    exec(compile(tree, '<eval>', 'exec'), g)
                    value = None
                    if last is not None:
                        value = eval(compile(last, '<eval>', 'eval'), g)
                try:
                    value_json = json.dumps(value, default=eval_enc)
                except TypeError:
                    ok = False
                    err_bytes.diagnostic(
                        'eval: result of type %s is not JSON-serializable\n' %
                        type(value).__name__)
            except BaseException:
                ok = False
                err_bytes.diagnostic(traceback.format_exc())
            finally:
                sys.stdout, sys.stderr = saved_stdout, saved_stderr

    return (value_json, out_bytes.to_list(), err_bytes.to_list(), ok, syntax)


def repl(user_code, repl_session_id, repl_inputs, cwd=''):
    sid = repl_session_id
    if sid not in repl_session_globals:
        repl_session_cwds[sid] = cwd or os.getcwd()
        repl_session_globals[sid] = {
            '__name__': '__main__',
            '__doc__': None,
            '__package__': None,
            '__loader__': None,
            '__spec__': None,
            '__annotations__': {},
            '__builtins__': __builtins__,
        }
    repl_globals = repl_session_globals[sid]
    repl_globals.update(dict(repl_inputs))

    out_bytes = OutputCapture()
    err_bytes = OutputCapture()
    out_text = out_bytes.text
    err_text = err_bytes.text

    with out_bytes, err_bytes:
        status = 'complete'
        exit_code = 0
        codeobj = None

        try:
            codeobj = codeop.compile_command(user_code, '<repl>', 'single')
        except (SyntaxError, ValueError, OverflowError):
            err_bytes.diagnostic(traceback.format_exc())
            exit_code = 1
            codeobj = False

        if codeobj is None:
            status = 'incomplete'
        elif codeobj is not False:
            saved_stdout = sys.stdout
            saved_stderr = sys.stderr
            saved_stdin = sys.stdin
            sys.stdout = out_text
            sys.stderr = err_text
            sys.stdin = io.TextIOWrapper(io.BytesIO(b''),
                                         encoding='utf-8',
                                         errors='replace')
            try:
                with working_directory(repl_session_cwds[sid], sid):
                    exec(codeobj, repl_globals)
            except SystemExit as e:
                code = e.code
                if code is None:
                    exit_code = 0
                elif isinstance(code, bool):
                    exit_code = int(code)
                elif isinstance(code, int):
                    exit_code = code
                else:
                    err_bytes.diagnostic(str(code) + '\n')
                    exit_code = 1
                status = 'exit'
            except BaseException:
                err_bytes.diagnostic(traceback.format_exc())
                exit_code = 1
            finally:
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.stdin = saved_stdin

    return (out_bytes.to_list(), err_bytes.to_list(), exit_code, status)


def seed_sys_path(paths):
    misses = []
    expanded = []
    for path in paths:
        if any(c in path for c in '*?['):
            hits = sorted(glob.glob(path))
            if not hits:
                misses.append(path)
            expanded.extend(hits)
        else:
            expanded.append(path)
    sys.path[:0] = [path for path in expanded if path not in sys.path]
    importlib.invalidate_caches()
    return misses


# Emscripten builds os without the extended-attribute family CPython has
# on linux, so a guest asking a mounted path for its attributes got
# AttributeError. The host
# registers _mirage_xattr, which answers from the workspace door, and
# each condition it reports is raised as the errno linux would raise.
XATTR_ERRNO = {
    'NO_XATTR': errno.ENODATA,
    'ENOENT': errno.ENOENT,
    'ENOTDIR': errno.ENOTDIR,
    'EEXIST': errno.EEXIST,
    'EACCES': errno.EACCES,
    'EPERM': errno.EPERM,
    'EROFS': errno.EROFS,
    'EINVAL': errno.EINVAL,
    'ELOOP': errno.ELOOP,
    'ENOTSUP': errno.ENOTSUP,
}


def xattr_door(op,
               path,
               attribute=None,
               value=None,
               flags=0,
               follow_symlinks=True):
    if isinstance(path, int):
        raise OSError(errno.ENOTSUP, os.strerror(errno.ENOTSUP))
    target = os.path.abspath(os.fsdecode(path))
    name = None if attribute is None else os.fsdecode(attribute)
    payload = (None if value is None else base64.b64encode(
        bytes(value)).decode('ascii'))
    answer = json.loads(
        _mirage_xattr.call(op, target, name, payload, bool(flags & 1),
                           bool(flags & 2), not follow_symlinks))
    code = answer.get('code')
    if code is not None:
        number = XATTR_ERRNO.get(code, errno.EIO)
        raise OSError(number, os.strerror(number), target)
    return answer.get('value')


def getxattr(path, attribute, *, follow_symlinks=True):
    found = xattr_door('getxattr',
                       path,
                       attribute,
                       follow_symlinks=follow_symlinks)
    return base64.b64decode(found)


def listxattr(path=None, *, follow_symlinks=True):
    return list(
        xattr_door('listxattr',
                   '.' if path is None else path,
                   follow_symlinks=follow_symlinks))


def setxattr(path, attribute, value, flags=0, *, follow_symlinks=True):
    xattr_door('setxattr', path, attribute, value, flags, follow_symlinks)


def removexattr(path, attribute, *, follow_symlinks=True):
    xattr_door('removexattr', path, attribute, follow_symlinks=follow_symlinks)


def install_xattrs():
    os.getxattr = getxattr
    os.listxattr = listxattr
    os.setxattr = setxattr
    os.removexattr = removexattr
    os.XATTR_CREATE = 1
    os.XATTR_REPLACE = 2
    os.XATTR_SIZE_MAX = 65536


install_xattrs()
