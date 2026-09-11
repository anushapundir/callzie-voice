import { cn } from "@/lib/utils"

/*
  The product, drawn at rest.

  This is the emotional centre of the landing page: a Tuesday that has already
  been handled. It shows the Overview's real shapes — the figures row, the
  ledger of appointments, one row lit because Maya is on that call right now —
  and nothing the product does not have. The version this replaced was a
  browser-chrome mock with a gauge, a trend arrow, a "This week" control and a
  segmented switch, none of which exist anywhere in the app.

  It is a separate presentational component rather than the app's own
  components with fixture props, because those read the signed-in Business and
  render Server Actions. A marketing page that imports them couples the front
  door to the dashboard's data layer, and the first refactor of either breaks
  the other.

  Keeping it honest is a maintenance job: when the Overview changes shape, this
  changes with it.
*/

const FIGURES = [
  { label: "Confirmed", value: "23" },
  { label: "Rescheduled", value: "6" },
  { label: "Needs attention", value: "1" },
  { label: "Calls today", value: "31" },
] as const

const ROWS: {
  name: string
  time: string
  service: string
  status: string
  dot: string
  live?: boolean
}[] = [
  {
    name: "Elena Popescu",
    time: "09:30",
    service: "Colour",
    status: "Confirmed",
    dot: "bg-confirmed",
  },
  {
    name: "Ravi Menon",
    time: "10:15",
    service: "Cut and finish",
    status: "Confirmed",
    dot: "bg-confirmed",
  },
  {
    name: "Amara Nwosu",
    time: "11:00",
    service: "Colour",
    status: "Calling",
    dot: "bg-live",
    live: true,
  },
  {
    name: "Jonah Feldman",
    time: "14:00",
    service: "Trim",
    status: "Moved to 16:15",
    dot: "bg-rescheduled",
  },
  {
    name: "Theo Lindqvist",
    time: "15:30",
    service: "Cut and finish",
    status: "No answer",
    dot: "bg-unreachable",
  },
]

export function ProductFrame({ className }: { className?: string }) {
  return (
    <div
      /*
        The frame carries the light ground on purpose, inside the ink band. The
        product is paper; seeing it as paper is the point of showing it here.
      */
      className={cn(
        "overflow-hidden rounded-soft border border-line bg-bg text-text",
        className
      )}
      /* Decorative: a screen reader gets the words from the section itself. */
      aria-hidden
    >
      <div className="border-b border-line-strong px-5 py-4">
        <p className="font-display text-[18px] leading-none font-semibold tracking-[-0.02em]">
          Overview
        </p>
      </div>

      {/*
        Two by two on a phone. Four 87px columns turn every label into two
        lines and the picture stops looking like a product.
      */}
      <dl className="grid grid-cols-2 divide-x divide-line border-b border-line-strong sm:grid-cols-4">
        {FIGURES.map((figure) => (
          <div
            key={figure.label}
            className="border-b border-line px-4 py-4 last:border-b-0 sm:border-b-0 [&:nth-child(2)]:border-b sm:[&:nth-child(2)]:border-b-0"
          >
            <dt className="text-[11px] tracking-[0.06em] text-text-muted uppercase">
              {figure.label}
            </dt>
            <dd
              className={cn(
                "mt-1.5 text-[26px] leading-none font-medium",
                figure.label === "Needs attention" && "text-attention"
              )}
            >
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* A long name must scroll the table, never the page. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line text-[11px] tracking-[0.06em] text-text-muted uppercase">
            <th className="px-5 py-2 font-medium">Name</th>
            <th className="px-5 py-2 font-medium">Time</th>
            <th className="hidden px-5 py-2 font-medium sm:table-cell">
              Service
            </th>
            <th className="px-5 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr
              key={row.name}
              className={cn(
                "border-b border-line last:border-0 text-table",
                /*
                  The one animated thing in the picture, and the only place
                  cobalt appears: the row Maya is on. Everything else on this
                  page is still, so a single row breathing reads as the product
                  working rather than as decoration.
                */
                row.live && "animate-row-shimmer"
              )}
            >
              <td className="px-5 py-3 font-medium whitespace-nowrap">
                {row.name}
              </td>
              <td className="px-5 py-3 font-mono text-text-muted">{row.time}</td>
              <td className="hidden px-5 py-3 text-text-muted sm:table-cell">
                {row.service}
              </td>
              <td className="px-5 py-3">
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      row.dot,
                      row.live && "animate-live-pulse"
                    )}
                  />
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  )
}
