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

export const PYTHON_REPL_WRAPPER = `
import codeop, sys, io, traceback

try:
    _repl_session_globals
except NameError:
    _repl_session_globals = {}

_sid = _repl_session_id
if _sid not in _repl_session_globals:
    _repl_session_globals[_sid] = {
        '__name__': '__main__',
        '__doc__': None,
        '__package__': None,
        '__loader__': None,
        '__spec__': None,
        '__annotations__': {},
        '__builtins__': __builtins__,
    }
_repl_globals = _repl_session_globals[_sid]
_repl_globals.update(dict(_repl_inputs))

_out_bytes = io.BytesIO()
_err_bytes = io.BytesIO()
_out_text  = io.TextIOWrapper(_out_bytes, encoding='utf-8', errors='replace',
                              write_through=True, line_buffering=True)
_err_text  = io.TextIOWrapper(_err_bytes, encoding='utf-8', errors='replace',
                              write_through=True, line_buffering=True)

_status = 'complete'
_exit_code = 0
_codeobj = None

try:
    _codeobj = codeop.compile_command(_user_code, '<repl>', 'single')
except (SyntaxError, ValueError, OverflowError):
    traceback.print_exc(file=_err_text)
    _exit_code = 1
    _codeobj = False

if _codeobj is None:
    _status = 'incomplete'
elif _codeobj is not False:
    _saved_stdout = sys.stdout
    _saved_stderr = sys.stderr
    _saved_stdin = sys.stdin
    sys.stdout = _out_text
    sys.stderr = _err_text
    sys.stdin = io.TextIOWrapper(io.BytesIO(b''), encoding='utf-8', errors='replace')
    try:
        exec(_codeobj, _repl_globals)
    except SystemExit as _e:
        _code = _e.code
        if _code is None:
            _exit_code = 0
        elif isinstance(_code, bool):
            _exit_code = int(_code)
        elif isinstance(_code, int):
            _exit_code = _code
        else:
            _err_text.write(str(_code) + '\\n')
            _exit_code = 1
        _status = 'exit'
    except BaseException:
        traceback.print_exc(file=_err_text)
        _exit_code = 1
    finally:
        _out_text.flush()
        _err_text.flush()
        sys.stdout = _saved_stdout
        sys.stderr = _saved_stderr
        sys.stdin = _saved_stdin

_repl_result = (_out_bytes.getvalue(), _err_bytes.getvalue(), _exit_code, _status)
`

// One-shot eval: bind _eval_inputs as globals, run the code, capture
// the LAST EXPRESSION (monty semantics). The value crosses the
// JS/WASM boundary as JSON, which is the Evaluator contract's honest
// transport for pyodide; bytes values ride as a tagged base64 object
// that the JS side restores to Uint8Array (see EVAL_BYTES_TAG).
export const PYTHON_EVAL_WRAPPER = `
import ast, base64, io, json, sys, traceback

def _eval_enc(_o):
    if isinstance(_o, (bytes, bytearray)):
        _b64 = base64.b64encode(bytes(_o)).decode('ascii')
        return {'__mirage_bytes__': _b64}
    raise TypeError('%s is not JSON-serializable' % type(_o).__name__)

_out_bytes = io.BytesIO()
_err_bytes = io.BytesIO()
_out_text = io.TextIOWrapper(_out_bytes, encoding='utf-8', errors='replace',
                             write_through=True, line_buffering=True)
_err_text = io.TextIOWrapper(_err_bytes, encoding='utf-8', errors='replace',
                             write_through=True, line_buffering=True)

_ok = True
_syntax = False
_value_json = 'null'
try:
    _tree = ast.parse(_user_code)
except SyntaxError:
    _ok = False
    _syntax = True
    traceback.print_exc(file=_err_text)
else:
    _last = None
    if _tree.body and isinstance(_tree.body[-1], ast.Expr):
        _last = ast.Expression(_tree.body[-1].value)
        _tree.body = _tree.body[:-1]
    _g = dict(_eval_inputs)
    _g.setdefault('__builtins__', __builtins__)
    _saved_stdout, _saved_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _out_text, _err_text
    try:
        exec(compile(_tree, '<eval>', 'exec'), _g)
        _value = None
        if _last is not None:
            _value = eval(compile(_last, '<eval>', 'eval'), _g)
        try:
            _value_json = json.dumps(_value, default=_eval_enc)
        except TypeError:
            _ok = False
            _err_text.write('eval: result of type %s is not JSON-serializable\\n'
                            % type(_value).__name__)
    except BaseException:
        _ok = False
        traceback.print_exc(file=_err_text)
    finally:
        _out_text.flush()
        _err_text.flush()
        sys.stdout, sys.stderr = _saved_stdout, _saved_stderr

_eval_result = (_value_json, _out_bytes.getvalue(), _err_bytes.getvalue(), _ok, _syntax)
`

export const PYTHON_WRAPPER = `
import os, sys, io, traceback

_saved_env    = dict(os.environ)
_saved_path   = list(sys.path)
_saved_stdin  = sys.stdin
_saved_stdout = sys.stdout
_saved_stderr = sys.stderr
_saved_argv   = sys.argv

_out_bytes = io.BytesIO()
_err_bytes = io.BytesIO()
_out_text  = io.TextIOWrapper(_out_bytes, encoding='utf-8', errors='replace',
                              write_through=True, line_buffering=True)
_err_text  = io.TextIOWrapper(_err_bytes, encoding='utf-8', errors='replace',
                              write_through=True, line_buffering=True)

_stdin_buf  = io.BytesIO(bytes(_stdin_bytes) if _stdin_bytes is not None else b'')
_stdin_text = io.TextIOWrapper(_stdin_buf, encoding='utf-8', errors='replace')

_exit_code = 0
try:
    os.environ.clear()
    os.environ.update(dict(_merged_env))
    sys.stdin  = _stdin_text
    sys.stdout = _out_text
    sys.stderr = _err_text
    sys.argv   = list(_argv)
    try:
        exec(compile(_user_code, '<string>', 'exec'), dict(_user_globals))
    except SystemExit as _e:
        _code = _e.code
        if _code is None:
            _exit_code = 0
        elif isinstance(_code, bool):
            _exit_code = int(_code)
        elif isinstance(_code, int):
            _exit_code = _code
        else:
            _err_text.write(str(_code) + '\\n')
            _exit_code = 1
    except BaseException:
        traceback.print_exc(file=_err_text)
        _exit_code = 1
finally:
    _out_text.flush()
    _err_text.flush()
    os.environ.clear()
    os.environ.update(_saved_env)
    sys.path[:]  = _saved_path
    sys.stdin    = _saved_stdin
    sys.stdout   = _saved_stdout
    sys.stderr   = _saved_stderr
    sys.argv     = _saved_argv

_result = (_out_bytes.getvalue(), _err_bytes.getvalue(), _exit_code)
`
