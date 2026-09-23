import ast
import base64
import codeop
import errno
import glob
import importlib
import io
import json
import os
import sys
import traceback
import types
import warnings

import _mirage_xattr


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


def eval_enc(o):
    if isinstance(o, (bytes, bytearray)):
        b64 = base64.b64encode(bytes(o)).decode('ascii')
        return {'__mirage_bytes__': b64}
    raise TypeError('%s is not JSON-serializable' % type(o).__name__)


def run(request, arm_interrupt, disarm_interrupt):
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
            sys.stdin = saved_stdin
            sys.stdout = saved_stdout
            sys.stderr = saved_stderr
            sys.argv = saved_argv
            os.chdir = saved_chdir
            os.getcwd = saved_getcwd
            saved_chdir(saved_cwd)

    return (out_bytes.to_list(), err_bytes.to_list(), exit_code)


def evaluate(user_code, eval_inputs):
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


def repl(user_code, repl_session_id, repl_inputs):
    sid = repl_session_id
    if sid not in repl_session_globals:
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
