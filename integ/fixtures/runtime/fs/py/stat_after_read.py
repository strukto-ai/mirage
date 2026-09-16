import os
from pathlib import Path

root = os.getenv('MIRAGE_TEST_ROOT', '/data')
before = os.stat(root + '/sub')
try:
    Path(root + '/sub').read_text()
    raise AssertionError('a directory answered read_text')
except IsADirectoryError:
    pass
except FileNotFoundError:
    pass
after = os.stat(root + '/sub')
assert before.st_mode == after.st_mode
assert before.st_mtime == after.st_mtime
assert before.st_size == after.st_size
print('row survived', oct(after.st_mode))
print('is_dir', Path(root + '/sub').is_dir())
print('exists', Path(root + '/sub').exists())
