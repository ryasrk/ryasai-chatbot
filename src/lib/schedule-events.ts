/**
 * Schedule run events — in-memory EventEmitter for SSE push.
 * ----------------------------------------------------------------------------
 * ponytail: EventEmitter — works for single-instance. For multi-instance,
 * upgrade to Redis pubsub. The API route (GET /api/schedules/stream) should
 * subscribe to scheduleEvents and forward events as SSE.
 */
import { EventEmitter } from 'events'

export interface ScheduleRunEvent {
  runId: string
  name: string
  status: 'success' | 'error'
  answer?: string
  error?: string
  timestamp: Date
  latencyMs: number
}

export const scheduleEvents = new EventEmitter()
scheduleEvents.setMaxListeners(50)

export function emitScheduleRunComplete(event: ScheduleRunEvent): void {
  scheduleEvents.emit('run:complete', event)
}

export function onScheduleRunComplete(
  listener: (event: ScheduleRunEvent) => void,
): () => void {
  scheduleEvents.on('run:complete', listener)
  return () => scheduleEvents.off('run:complete', listener)
}
