export const MachineBenchmark = ({ kind }) => {
  const money = (value) => `$${value.toPrecision(2)}`
  const saved = (part, whole) => `${Math.round((1 - part / whole) * 100)}%`
  const fanOutSetup = () => {
    const lite = 0.25 * 0.0000025 + 2 * 0.00000007 + 0.00002 / 16
    const monty = [2.77, 2.88, 3.31, 3.2]
    const montyEnd = Math.max(...monty)
    const single = { python: 11.7, numpy: 4.1 }
    const numpy = 4.4
    const montyCpu = 0.36
    const singleTime = single.python + single.numpy
    const mirageTime = montyEnd + numpy
    const singleCost = singleTime * lite
    const mirageCost = montyCpu * 0.00002 + numpy * lite
    return {
      span: 16,
      ticks: [0, 4, 8, 12, 16],
      timeSaved: saved(mirageTime, singleTime),
      costSaved: saved(mirageCost, singleCost),
      legend: [
        ["var(--tm-b)", "Monty"],
        ["var(--tm-base)", "Python on Cloudflare Sandbox"],
        ["var(--tm-a)", "NumPy on Cloudflare Sandbox"],
      ],
      groups: [
        {
          title: "Cloudflare Sandbox only",
          icon: "/images/cloudflare-logo.svg",
          tip: `One lite Cloudflare Sandbox, with 1/16 vCPU, 0.25 GiB of memory and 2 GB of disk, counts the four quarters with Python and then runs NumPy. It costs ${money(lite)} a second while it runs, ${money(singleCost)} for this task.`,
          lanes: [
            {
              label: "Cloudflare Sandbox",
              icon: "/images/cloudflare-logo.svg",
              segments: [
                { from: 0, to: single.python, fill: "var(--tm-base)", text: "Python", ink: true },
                { from: single.python, to: singleTime, fill: "var(--tm-a)", text: "NumPy" },
              ],
            },
          ],
        },
        {
          title: "Mirage",
          icon: "mirage",
          tip: `Four Monty runs inside Mirage count the quarters in parallel, and only NumPy runs on the lite Cloudflare Sandbox. Monty is priced at a full vCPU's $0.000020 a second for the ${montyCpu} CPU-seconds it uses, so the task costs ${money(mirageCost)}.`,
          lanes: [
            ...monty.map((to, index) => ({
              label: `Monty ${index + 1}`,
              icon: "/images/pydantic-logo.svg",
              segments: [{ from: 0, to, fill: "var(--tm-b)" }],
            })),
            {
              label: "Cloudflare Sandbox",
              icon: "/images/cloudflare-logo.svg",
              segments: [{ from: montyEnd, to: mirageTime, fill: "var(--tm-a)", text: "NumPy" }],
            },
          ],
        },
      ],
    }
  }
  const gpuSetup = () => {
    const rate = 0.526 / 3600
    const e2b = 2 * 0.000014 + 1 * 0.0000045
    const alone = { pandas: 15.6, torch: 14.1 }
    const split = { pandas: 14.3, torch: 13.4 }
    const aloneTime = alone.pandas + alone.torch
    const splitTime = split.pandas + split.torch
    const aloneCost = aloneTime * rate
    const splitCost = split.pandas * e2b + split.torch * rate
    return {
      span: 30,
      ticks: [0, 10, 20, 30],
      timeSaved: saved(splitTime, aloneTime),
      costSaved: saved(splitCost, aloneCost),
      legend: [
        ["var(--tm-b)", "pandas on E2B"],
        ["var(--tm-base)", "pandas on the GPU"],
        ["var(--tm-a)", "PyTorch on the GPU"],
      ],
      groups: [
        {
          title: "GPU only",
          icon: "/images/ec2-logo.svg",
          tip: `One EC2 g4dn.xlarge with an NVIDIA T4 builds the features with pandas and then trains with PyTorch. It costs $0.526 an hour on demand, ${money(aloneCost)} for this task.`,
          lanes: [
            {
              label: "EC2 GPU",
              icon: "/images/ec2-logo.svg",
              segments: [
                { from: 0, to: alone.pandas, fill: "var(--tm-base)", text: "pandas", ink: true },
                { from: alone.pandas, to: aloneTime, fill: "var(--tm-a)", text: "PyTorch" },
              ],
            },
          ],
        },
        {
          title: "Mirage",
          icon: "mirage",
          tip: `pandas builds the features on an E2B sandbox with 2 vCPU and 1 GiB, at ${money(e2b)} a second, and only the training runs on the GPU. Each machine is counted for the seconds it runs, so the task costs ${money(splitCost)}.`,
          lanes: [
            {
              label: "E2B sandbox",
              icon: "/images/e2b-logo.svg",
              segments: [{ from: 0, to: split.pandas, fill: "var(--tm-b)", text: "pandas" }],
            },
            {
              label: "EC2 GPU",
              icon: "/images/ec2-logo.svg",
              segments: [{ from: split.pandas, to: splitTime, fill: "var(--tm-a)", text: "PyTorch" }],
            },
          ],
        },
      ],
    }
  }
  const { groups, span, ticks, legend, timeSaved, costSaved } = kind === "gpu" ? gpuSetup() : fanOutSetup()
  const end = Math.max(...groups.flatMap((group) => group.lanes.flatMap((lane) => lane.segments.map((segment) => segment.to))))
  const [run, setRun] = useState(0)
  const [now, setNow] = useState(end)
  useEffect(() => {
    if (run === 0) return undefined
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setNow(end)
      return undefined
    }
    const started = performance.now()
    let frame = requestAnimationFrame(function tick(at) {
      const next = Math.min(end, ((at - started) / 4000) * end)
      setNow(next)
      if (next < end) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [run])
  useEffect(() => {
    setNow(0)
    setRun(1)
  }, [])
  const replay = () => {
    setNow(0)
    setRun((value) => value + 1)
  }

  const [box, setBox] = useState(null)
  const [boxWidth, setBoxWidth] = useState(680)
  useEffect(() => {
    if (box === null || typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  const view = Math.max(320, Math.round(boxWidth))
  const labels = view < 520 ? 130 : 150
  const plot = { x: labels, w: view - labels - 14 }
  const at = (time) => plot.x + (time / span) * plot.w
  const bar = 16
  const rowGap = 6
  const top = 30
  const placed = []
  let y = top
  groups.forEach((group, index) => {
    if (index > 0) y += 48 - rowGap
    const heading = y - 8
    const lanes = group.lanes.map((lane) => {
      const row = { ...lane, y }
      y += bar + rowGap
      return row
    })
    placed.push({ ...group, heading, lanes })
  })
  const axisY = y - rowGap + 18
  const height = axisY + 16

  const segment = (key, { from, to, fill, text, ink }, row) => {
    const stop = Math.min(to, now)
    if (stop <= from) return null
    const width = at(stop) - at(from)
    return (
      <g key={key}>
        <rect x={at(from)} y={row} width={Math.max(0, width - 1.5)} height={bar} rx="3" fill={fill} />
        {text && width > 40 && (
          <text x={at(from) + 6} y={row + 12} fontSize="10" fill={ink ? "var(--tm-ink)" : "var(--tm-surface)"}>
            {text}
          </text>
        )}
      </g>
    )
  }
  const icon = (name, y, size) => {
    const props = { x: "0", y, width: size, height: size }
    if (name === "mirage") {
      return (
        <g>
          <image href="/images/mirage-icon-light.svg" {...props} className="tm-light-only" />
          <image href="/images/mirage-icon-dark.svg" {...props} className="tm-dark-only" />
        </g>
      )
    }
    return <image href={name} {...props} />
  }
  const card = (label, value) => (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--tm-edge)" }}>
      <div className="tm-muted text-xs">{label}</div>
      <div className="tm-ink mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )

  return (
    <div className="terminal-model not-prose my-6 rounded-2xl border p-4">
      <style>{`
        .terminal-model {
          --tm-surface: #faf8f2; --tm-edge: #cec6b3; --tm-edge-soft: #e2dccd;
          --tm-ink: #0a0a0a; --tm-muted: #5b5647; --tm-reserved: #cbc5b7; --tm-base: #a39a86;
          --tm-a: #455a64; --tm-b: #b08a2e;
          background: var(--tm-surface); border-color: var(--tm-edge); color: var(--tm-ink);
        }
        html.dark .terminal-model {
          --tm-surface: #1a1a1d; --tm-edge: #3f3f46; --tm-edge-soft: #2a2a2f;
          --tm-ink: #ffffff; --tm-muted: #a1a1aa; --tm-reserved: #3a3a40; --tm-base: #71717a;
          --tm-a: #8aa4b1; --tm-b: #c9a03e;
        }
        .terminal-model .tm-ink { color: var(--tm-ink); }
        .terminal-model .tm-muted { color: var(--tm-muted); }
        .terminal-model .tm-btn { border-color: var(--tm-edge); color: var(--tm-muted); }
        .terminal-model .tm-btn:hover { border-color: var(--tm-muted); }
        .terminal-model .tm-dark-only { display: none; }
        html.dark .terminal-model .tm-dark-only { display: inline; }
        html.dark .terminal-model .tm-light-only { display: none; }
        .terminal-model .tm-tip { position: absolute; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border: 1px solid var(--tm-edge); border-radius: 9999px; font-size: 9px; line-height: 1; color: var(--tm-muted); cursor: help; }
        .terminal-model .tm-pop { display: none; position: absolute; top: 18px; left: -8px; width: min(260px, 70vw); padding: 8px 10px; border: 1px solid var(--tm-edge); border-radius: 8px; background: var(--tm-surface); color: var(--tm-ink); font-size: 11px; line-height: 1.45; z-index: 10; }
        .terminal-model .tm-tip:hover .tm-pop, .terminal-model .tm-tip:focus .tm-pop { display: block; }
      `}</style>

      <div className="flex items-start gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3">
          {card("Time Saved", timeSaved)}
          {card("Cost Saved", costSaved)}
        </div>
        <button
          type="button"
          onClick={replay}
          aria-label="Replay"
          title="Replay"
          className="tm-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>

      <div className="relative mt-4" ref={setBox}>
        <svg
          viewBox={`0 0 ${view} ${height}`}
          role="img"
          aria-label={groups.map((group) => `${group.title}: ${group.tip}`).join(" ")}
          className="w-full"
        >
          {placed.map((group) => (
            <g key={group.title}>
              {icon(group.icon, group.heading - 12, 14)}
              <text x="20" y={group.heading} fontSize="11" fontWeight="600" fill="currentColor" className="tm-ink">
                {group.title}
              </text>
            </g>
          ))}
          <g fontSize="11" fill="currentColor" className="tm-muted">
            {placed.flatMap((group) =>
              group.lanes.map((lane) => (
                <g key={`${group.title}-${lane.label}`}>
                  {icon(lane.icon, lane.y + 2, 12)}
                  <text x="18" y={lane.y + 12}>
                    {lane.label}
                  </text>
                </g>
              )),
            )}
          </g>
          <g stroke="var(--tm-edge-soft)" strokeWidth="1">
            {ticks.map((tick) => (
              <line key={tick} x1={at(tick)} y1={top - 4} x2={at(tick)} y2={axisY - 10} />
            ))}
          </g>
          <g fontSize="10" fill="currentColor" className="tm-muted">
            {ticks.map((tick) => (
              <text key={tick} x={at(tick)} y={axisY} textAnchor="middle">
                {tick} s
              </text>
            ))}
          </g>
          {placed.flatMap((group) =>
            group.lanes.flatMap((lane) =>
              lane.segments.map((part, index) => segment(`${group.title}-${lane.label}-${index}`, part, lane.y)),
            ),
          )}
          {now < end && (
            <line x1={at(now)} y1={top - 4} x2={at(now)} y2={axisY - 10} stroke="currentColor" strokeWidth="1.5" className="tm-ink" />
          )}
        </svg>
        {placed.map((group) => (
          <span
            key={group.title}
            className="tm-tip"
            tabIndex={0}
            aria-label={group.tip}
            style={{ left: `${((26 + group.title.length * 5.9) / view) * 100}%`, top: `${((group.heading - 10) / height) * 100}%` }}
          >
            ?
            <span className="tm-pop" role="tooltip">
              {group.tip}
            </span>
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs tm-muted">
        {legend.map(([color, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
