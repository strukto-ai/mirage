import os
from pathlib import Path

root = os.getenv('MIRAGE_TEST_ROOT', '/data')
file = os.stat(root + '/seed.txt')
assert file.st_nlink == 1
assert Path(root + '/seed.txt').stat().st_size == file.st_size
assert Path(root + '/seed.txt').is_file()
assert Path(root + '/sub').is_dir()
print('file', file.st_size, file.st_mode & 0o170000)
print('dir', os.stat(root + '/sub').st_mode & 0o170000)
try:
    os.stat(root + '/missing.txt')
except FileNotFoundError:
    print('missing')
else:
    raise AssertionError('stat accepted a missing file')
