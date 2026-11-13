export const UseCaseTerminal = ({ services, steps, extras = [], fanout = null, reads = "The agent reads and writes", terminal = "Runs in one terminal", server = "on a Mirage server of its own, or embedded in your agent's server" }) => {
  const [pos, setPos] = useState({ step: steps.length, chars: 0, output: true })

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined
    }
    let timer
    let step = 0
    let chars = 0
    const tick = () => {
      if (step >= steps.length) {
        setPos({ step: steps.length, chars: 0, output: true })
        timer = setTimeout(() => {
          step = 0
          chars = 0
          tick()
        }, 3500)
        return
      }
      const cmd = steps[step].cmd
      if (chars < cmd.length) {
        chars += 1
        setPos({ step, chars, output: false })
        timer = setTimeout(tick, 26)
        return
      }
      setPos({ step, chars, output: true })
      timer = setTimeout(() => {
        step += 1
        chars = 0
        tick()
      }, 1500)
    }
    setPos({ step: 0, chars: 0, output: false })
    timer = setTimeout(tick, 700)
    return () => clearTimeout(timer)
  }, [])

  const running = pos.step < steps.length && pos.output ? steps[pos.step].cli : null
  const typing = pos.step < steps.length ? steps[pos.step].cli : null
  const fanStep = steps.findIndex((step) => step.fanout)
  const fanState = fanStep < 0 || pos.step > fanStep ? "done" : pos.step === fanStep && pos.output ? "filling" : "empty"
  const flow = (service) => {
    const step = pos.step < steps.length ? steps[pos.step] : null
    return (step && step.cli === service.cli && step.dir) || service.dir || "in"
  }

  return (
    <div className="use-case-terminal not-prose my-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4">
      <style>{`
        .use-case-terminal { --uct-accent: #2a78d6; --uct-line: #d4d4d8; }
        html.dark .use-case-terminal { --uct-accent: #3987e5; --uct-line: #3f3f46; }
        .use-case-terminal .uct-grid { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
        .use-case-terminal .uct-server { order: -1; }
        .use-case-terminal .uct-wire { display: none; }
        .use-case-terminal .uct-card { transition: border-color .25s, background-color .25s, box-shadow .25s; }
        .use-case-terminal .uct-card.uct-on {
          border-color: var(--uct-accent);
          box-shadow: 0 0 0 1px var(--uct-accent);
          background-color: color-mix(in srgb, var(--uct-accent) 8%, transparent);
        }
        .use-case-terminal .uct-tag.uct-on { background-color: var(--uct-accent); color: #fff; }
        .use-case-terminal .uct-wire-line { position: absolute; left: 0; right: 0; top: 50%; border-top: 1.5px dashed var(--uct-line); transition: border-color .25s; }
        .use-case-terminal .uct-wire.uct-on .uct-wire-line { border-top-style: solid; border-color: var(--uct-accent); }
        .use-case-terminal .uct-dot { position: absolute; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 9999px; background: var(--uct-accent); opacity: 0; }
        .use-case-terminal .uct-wire.uct-on.uct-in .uct-dot { animation: uct-in .7s linear infinite; }
        .use-case-terminal .uct-wire.uct-on.uct-out .uct-dot { animation: uct-out .7s linear infinite; }
        @keyframes uct-in { 0% { left: 0; opacity: 1; } 100% { left: calc(100% - 8px); opacity: 1; } }
        @keyframes uct-out { 0% { left: calc(100% - 8px); opacity: 1; } 100% { left: 0; opacity: 1; } }
        .use-case-terminal .uct-caret { display: inline-block; width: 7px; height: 14px; margin-left: 1px; vertical-align: -2px; background: #e4e4e7; animation: uct-blink 1s steps(1) infinite; }
        @keyframes uct-blink { 50% { opacity: 0; } }
        .use-case-terminal .uct-later { visibility: hidden; }
        .use-case-terminal .uct-extra { transition: background-color .25s, color .25s; }
        .use-case-terminal .uct-extra.uct-on { background-color: var(--uct-accent); color: #fff; }
        .use-case-terminal .uct-none { display: flex; flex-direction: column; gap: 2px; }
        .use-case-terminal .uct-none-name { white-space: nowrap; }
        .use-case-terminal .uct-fan { display: grid; grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 3px; }
        .use-case-terminal .uct-cell { aspect-ratio: 1; border-radius: 2px; border: 1px solid var(--uct-line); }
        .use-case-terminal .uct-fan.uct-done .uct-cell { background: var(--uct-accent); border-color: var(--uct-accent); }
        .use-case-terminal .uct-fan.uct-filling .uct-cell { animation: uct-fill .2s ease-out both; }
        @keyframes uct-fill { from { background: transparent; } to { background: var(--uct-accent); border-color: var(--uct-accent); } }
        @media (min-width: 640px) {
          .use-case-terminal .uct-grid {
            grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1.75fr);
            grid-auto-rows: auto;
            align-items: center;
            column-gap: 0;
          }
          .use-case-terminal .uct-head { grid-column: 1; grid-row: 1; }
          .use-case-terminal .uct-server { order: 0; grid-column: 3; grid-row: 1 / span var(--uct-span); align-self: stretch; }
          .use-case-terminal .uct-wire { display: block; position: relative; height: 12px; grid-column: 2; grid-row: var(--uct-row); }
          .use-case-terminal .uct-card { grid-column: 1; grid-row: var(--uct-row); }
          .use-case-terminal .uct-none { flex-direction: row; align-items: center; gap: 12px; }
        }
      `}</style>

      <div className="uct-grid">
        <div className="uct-head mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          {reads}
        </div>
        {services.map((service, index) => (
          [
            <div
              key={service.cli + "-card"}
              className={"uct-card rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2" + (running === service.cli ? " uct-on" : "")}
              style={{ "--uct-row": index + 2 }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{service.name}</span>
                <span className={"uct-tag rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" + (typing === service.cli ? " uct-on" : "")}>
                  {service.cli}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                {service.text || (service.dir === "out" ? "writes " : "reads ") + service.detail}
              </div>
            </div>,
            <div
              key={service.cli + "-wire"}
              className={"uct-wire " + (flow(service) === "out" ? "uct-out" : "uct-in") + (running === service.cli ? " uct-on" : "")}
              style={{ "--uct-row": index + 2 }}
              aria-hidden="true"
            >
              <div className="uct-wire-line" />
              <div className="uct-dot" />
            </div>,
          ]
        ))}

        <div className="uct-server rounded-xl border-2 p-3" style={{ borderColor: "var(--uct-accent)", "--uct-span": services.length + 1 }}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{terminal}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{server}</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 dark:bg-black">
            <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5">
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
            </div>
            <div className="px-3 py-2 font-mono text-xs leading-5 text-zinc-100">
              {steps.map((step, index) => {
                const later = index > pos.step
                const current = index === pos.step
                const text = current ? step.cmd.slice(0, pos.chars) : step.cmd
                const showOut = index < pos.step || (current && pos.output)
                return (
                  <div key={step.cmd} className={later ? "uct-later" : ""}>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">
                      <span className="select-none text-zinc-500">$ </span>
                      {later ? step.cmd : text}
                      {current && !pos.output && <span className="uct-caret" />}
                    </div>
                    <div className={"overflow-hidden text-ellipsis whitespace-nowrap text-zinc-400" + (showOut || later ? "" : " uct-later")}>
                      {step.out}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          {fanout && (
            <div className="mt-2">
              <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{fanout.label}</div>
              <div className={"uct-fan uct-" + fanState}>
                {Array.from({ length: fanout.count }, (_, index) => (
                  <span key={index} className="uct-cell" style={{ animationDelay: index * 25 + "ms" }} />
                ))}
              </div>
            </div>
          )}
          {extras.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {extras.map((extra) => (
                <span
                  key={extra.text}
                  className={"uct-extra rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" + (extra.cli && running === extra.cli ? " uct-on" : "")}
                >
                  {extra.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="uct-none mt-4 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-2">
        <span className="uct-none-name text-sm text-zinc-400 line-through dark:text-zinc-500">Sandbox, container or VM</span>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Not needed: the terminal runs inside the server process.</span>
      </div>
    </div>
  )
}
