'use client'

import { MetricCard, type MetricIcon } from '@/components/ui/metric-card'

/** Thin alias kept so this view's imports stay local; layout lives in MetricCard. */
export function StatCard({
  label,
  value,
  icon,
  iconClass,
}: {
  label: string
  value: number
  icon: MetricIcon
  iconClass: string
}) {
  return <MetricCard label={label} value={value} icon={icon} iconClass={iconClass} />
}
