import glob
import os
from pathlib import Path

root = os.getenv('MIRAGE_TEST_ROOT', '/data')
paths = sorted(path[len(root) + 1:]
               for path in glob.glob(root + '/**/*.txt', recursive=True))
assert paths == sorted(
    str(path)[len(root) + 1:] for path in Path(root).glob('**/*.txt'))
assert glob.glob(root + '/missing-*.txt') == []
print('\n'.join(paths))
