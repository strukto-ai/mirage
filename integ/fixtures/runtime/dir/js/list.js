const root = std.getenv('MIRAGE_TEST_ROOT') || '/data'
const [names, error] = os.readdir(root)
if (error !== 0) throw new Error(`readdir failed: ${error}`)
console.log(
  names
    .filter((name) => name !== '.' && name !== '..')
    .sort()
    .join('\n'),
)
