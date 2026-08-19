/**
 * Classical Greek-motif line icons — Neo-Olympian's replacement for the
 * lucide set on dashboard stat cards. Same stroke-based API as lucide
 * (fill="none", stroke="currentColor", accepts className) so they drop into
 * any spot typed for a lucide icon without touching the consumer's styling.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

/** Temple — Queries. Pediment + fluted columns + stepped base. */
export function TempleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 2 21 8H3Z" />
      <path d="M4 8v11M8 8v11M12 8v11M16 8v11M20 8v11" />
      <path d="M3 19h18M2 21h20" />
    </Base>
  )
}

/** Laurel wreath — Success Rate. Two curved branches with leaf ticks. */
export function LaurelIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 21c-4-1.5-7-5.5-7-10.5A7 7 0 0 1 7 5" />
      <path d="M12 21c4-1.5 7-5.5 7-10.5A7 7 0 0 0 17 5" />
      <path d="M6.2 8.5 8.3 7M5.6 12l2.3-1M6.4 15.5l2.2-1.3M8.3 18.5l1.9-1.6" />
      <path d="M17.8 8.5 15.7 7M18.4 12l-2.3-1M17.6 15.5l-2.2-1.3M15.7 18.5l-1.9-1.6" />
    </Base>
  )
}

/** Single fluted column — Integrations (infrastructure). */
export function ColumnIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 3h12" />
      <path d="M7 5h10l-1 2H8Z" />
      <path d="M9 7v12M12 7v12M15 7v12" />
      <path d="M7 19h10l1 2H6Z" />
      <path d="M5 21h14" />
    </Base>
  )
}

/** Medallion coin — LLM Tokens. */
export function CoinIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 9v6M10 11h4M10 13h4" />
    </Base>
  )
}

/** Zeus's bolt — LLM Calls (power/energy). */
export function ThunderboltIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M13 2 5 13h5l-1 9 9-13h-5z" />
    </Base>
  )
}

/** Radial gear — Plugin Calls (precision engineering). */
export function GearMotifIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
      <path d="M5 5l2.5 2.5M16.5 16.5 19 19M5 19l2.5-2.5M16.5 7.5 19 5" />
    </Base>
  )
}

/** Hourglass — Active Schedules. */
export function HourglassIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 2h12M6 22h12" />
      <path d="M7 2c0 6 5 8 5 10s-5 4-5 10M17 2c0 6-5 8-5 10s5 4 5 10" />
    </Base>
  )
}

/** Shield with spine — Guardrail Blocks. */
export function ShieldMotifIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5Z" />
      <path d="M12 5v17" />
    </Base>
  )
}
