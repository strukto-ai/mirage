import os
from pathlib import Path

root = os.getenv('MIRAGE_TEST_ROOT', '/data')
names = sorted(os.listdir(root))
assert names == sorted(
    str(path).split('/')[-1] for path in Path(root).iterdir())
print('\n'.join(names))
