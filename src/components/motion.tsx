/**
 * Shared framer-motion primitives for the immersive UI.
 * - AnimatedNumber: count-up that respects reduced-motion
 * - Stagger / StaggerItem / FadeIn: declarative entrance animations
 * Keep imports light; framer-motion v12 is already a dependency.
 */
'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { motion, useInView, useReducedMotion, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils'

const EASE = [0.22, 1, 0.36, 1] as const

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
}

export function Stagger({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div className={className} variants={staggerParent} initial="hidden" animate="show">
      {children}
    </motion.div>
  )
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div className={className} variants={fadeUp}>
      {children}
    </motion.div>
  )
}

export function FadeIn({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString('id-ID')

/**
 * Count-up number. Animates from 0 → value the first time it scrolls into view.
 * Falls back to the final value immediately when the user prefers reduced motion.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 1.1,
  className,
}: {
  value: number
  format?: (n: number) => string
  duration?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-8%' })
  const reduce = useReducedMotion()

  // ponytail: the rAF loop writes textContent instead of calling setState. The
  // dashboard renders 8 of these at once — one setState per frame per card was
  // ~500 React renders in 1.1s, which was most of its Lighthouse TBT.
  useEffect(() => {
    const el = ref.current
    if (!el || !inView) return
    const fmt = format ?? defaultFormat
    if (reduce) {
      el.textContent = fmt(value)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 1000))
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      el.textContent = fmt(t < 1 ? value * eased : value)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, value, reduce, duration, format])

  return (
    <span ref={ref} className={cn(className)}>
      {(format ?? defaultFormat)(0)}
    </span>
  )
}
