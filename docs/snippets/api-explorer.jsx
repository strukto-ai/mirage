export const ApiExplorer = ({ children }) => {
  const [query, setQuery] = useState("")
  const [resource, setResource] = useState("")
  const [count, setCount] = useState(null)
  const [resources, setResources] = useState([])
  const root = useRef(null)

  useEffect(() => {
    const rows = Array.from(root.current.querySelectorAll("[data-op]"))
    setResources(Array.from(new Set(rows.map((row) => row.dataset.resource))).sort())
  }, [])

  useEffect(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    let shown = 0
    for (const row of root.current.querySelectorAll("[data-op]")) {
      const text = row.dataset.op.toLowerCase()
      const match =
        (!resource || row.dataset.resource === resource) &&
        words.every((word) => text.includes(word))
      row.hidden = !match
      if (match) shown += 1
    }
    setCount(shown)
  }, [query, resource])

  return (
    <div ref={root}>
      <div className="not-prose flex flex-wrap items-center gap-2 mb-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search API operations"
          aria-label="Search API operations"
          className="flex-1 min-w-48 px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent"
        />
        <select
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          aria-label="API resource"
          className="px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent"
        >
          <option value="">All resources</option>
          {resources.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <span className="text-sm text-zinc-500">{count === null ? "" : `${count} ${count === 1 ? "operation" : "operations"}`}</span>
      </div>
      {children}
    </div>
  )
}

export const Operation = ({ resource, method, path, summary, hosts, children }) => (
  <div data-op={`${method} ${path} ${summary} ${resource}`} data-resource={resource}>
    <Accordion
      title={`${method} ${path}`}
      description={hosts && hosts.includes("hosted") ? `${summary} · daemon and hosted` : summary}
    >
      {children}
    </Accordion>
  </div>
)
