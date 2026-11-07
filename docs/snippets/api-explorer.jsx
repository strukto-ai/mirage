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
      const text = `${row.dataset.op} ${row.dataset.search}`.toLowerCase()
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
      <div className="not-prose flex flex-wrap items-center gap-2 mb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search endpoints, parameters and fields"
          aria-label="Search API operations"
          className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent"
        />
        <select
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          aria-label="API resource"
          className="max-w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent"
        >
          <option value="">All resources</option>
          {resources.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {(query || resource) && (
          <button
            type="button"
            onClick={() => { setQuery(""); setResource("") }}
            className="px-3 py-2 text-sm rounded-lg underline underline-offset-4"
          >
            Clear filters
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className="not-prose mb-4 text-sm text-zinc-500">
        {count === null ? "" : `${count} ${count === 1 ? "operation" : "operations"}`}
      </p>
      {count === 0 && (
        <div className="not-prose rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 mb-4">
          <p className="font-medium">No matching operations</p>
          <p className="mt-1 text-sm text-zinc-500">Try another term or clear the filters to see every endpoint.</p>
        </div>
      )}
      <div className="not-prose divide-y divide-zinc-200 dark:divide-zinc-800">{children}</div>
    </div>
  )
}

export const Operation = ({ resource, method, path, summary, hosts, href, anchor, search }) => {
  const methodStyles = {
    GET: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    POST: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    DELETE: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    PUT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    PATCH: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  }

  return (
  <div id={anchor} data-op={`${method} ${path} ${summary} ${resource}`} data-resource={resource} data-search={search} className="scroll-mt-32">
    <a href={href} className="group flex min-w-0 items-start gap-3 rounded-lg px-2 py-4 text-inherit no-underline hover:bg-zinc-100 dark:hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${methodStyles[method]}`}>{method}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium group-hover:underline">{summary}</span>
        <span className="mt-1 block break-all font-mono text-xs leading-5 text-zinc-600 dark:text-zinc-400">{path}</span>
        <span className="mt-1 block text-xs text-zinc-500">{resource} · {hosts.includes("hosted") ? "Daemon and hosted" : "Daemon only"}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-zinc-400">→</span>
    </a>
  </div>
  )
}
