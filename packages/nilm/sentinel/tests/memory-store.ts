import type {
  AcknowledgementOutcome,
  AlertPage,
  AlertQuery,
  AlertRuleRow,
  AlertView,
  AlertWrite,
  SentinelStore,
  TenantPolicy,
  Watermark,
} from '../src/index.ts'
import type { ScopeOwnership } from '../src/store.ts'
import type { WindowObservation } from '../src/suppression.ts'

interface StoredEvent extends AlertView {
  tenantId: string
  silenceKey: string
  dedupeKey: string
  bucketStartMs: number
  severityValue: number
  stateValue: string
  userRefs: Set<string>
}

interface StoredOutbox {
  tenantId: string
  eventId: string
  userRef: string
  dedupeKey: string
  sentAtMs?: number
}

export class MemorySentinelStore implements SentinelStore {
  readonly tenants = new Map<string, TenantPolicy>()
  readonly rules = new Map<string, AlertRuleRow[]>()
  readonly scopes = new Map<string, ScopeOwnership[]>()
  readonly watermarks = new Map<string, Watermark>()
  readonly events: StoredEvent[] = []
  readonly outbox: StoredOutbox[] = []

  async loadWatermark(sourceName: string): Promise<Watermark | undefined> {
    return this.watermarks.get(sourceName)
  }

  async saveWatermark(sourceName: string, watermark: Watermark): Promise<void> {
    this.watermarks.set(sourceName, watermark)
  }

  async listTenants(): Promise<TenantPolicy[]> {
    return [...this.tenants.values()]
  }

  async listRules(tenantId: string): Promise<AlertRuleRow[]> {
    return this.rules.get(tenantId) ?? []
  }

  async resolveScopes(nodeIds: readonly string[]): Promise<ScopeOwnership[]> {
    return nodeIds.flatMap(nodeId => this.scopes.get(nodeId) ?? [])
  }

  async recentObservations(
    tenantId: string,
    silenceKey: string,
    sinceMs: number,
    limit: number,
  ): Promise<WindowObservation[]> {
    return this.events
      .filter(event => event.tenantId === tenantId && event.silenceKey === silenceKey && event.bucketStartMs >= sinceMs)
      .slice(-limit)
      .map(event => ({
        eventId: event.id,
        bucketStartMs: event.bucketStartMs,
        value: event.severityValue,
        severity: event.severity,
        state: event.stateValue,
      }))
  }

  async lastNotificationAt(tenantId: string, silenceKey: string): Promise<number | undefined> {
    const sent = this.outbox
      .filter(item => item.tenantId === tenantId && item.dedupeKey.startsWith(`${silenceKey}:`) && item.sentAtMs !== undefined)
      .map(item => item.sentAtMs as number)
    return sent.length === 0 ? undefined : Math.max(...sent)
  }

  async insertAlert(write: AlertWrite): Promise<'inserted' | 'duplicate'> {
    if (this.events.some(event => event.tenantId === write.event.tenantId && event.dedupeKey === write.event.dedupeKey)) {
      return 'duplicate'
    }
    const userRefs = new Set<string>()
    for (const item of write.outbox) {
      userRefs.add(item.userRef)
      this.outbox.push({
        tenantId: item.tenantId,
        eventId: item.eventId,
        userRef: item.userRef,
        dedupeKey: item.dedupeKey,
      })
    }
    this.events.push({
      id: write.event.eventId,
      tenantId: write.event.tenantId,
      silenceKey: write.event.silenceKey,
      dedupeKey: write.event.dedupeKey,
      bucketStartMs: write.event.bucketStartMs,
      severityValue: write.event.value,
      stateValue: write.event.status,
      userRefs,
      severity: write.event.severity,
      status: write.event.status,
      ruleId: write.event.ruleId,
      scopeLevel: write.event.scope.level,
      scopeId: write.event.scope.id,
      scopeName: write.event.scope.name,
      metric: write.event.metric,
      value: write.event.value,
      threshold: write.event.threshold,
      unit: write.event.unit,
      detectedAt: new Date(write.event.detectedAtMs).toISOString(),
      occurredAt: new Date(write.event.rawEventTimeMs).toISOString(),
      finding: write.event.summaryText,
    })
    return 'inserted'
  }

  async listAlerts(tenantId: string, userRef: string, query: AlertQuery): Promise<AlertPage> {
    const visible = this.events
      .filter(event => event.tenantId === tenantId && event.userRefs.has(userRef))
      .filter(event => query.status === undefined || event.status === query.status)
      .filter(event => query.severity === undefined || event.severity === query.severity)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return {
      alerts: visible.slice(offset, offset + limit).map(toView),
      total: visible.length,
    }
  }

  async acknowledge(tenantId: string, userRef: string, eventId: string, atMs: number): Promise<AcknowledgementOutcome> {
    const event = this.events.find(item => item.tenantId === tenantId && item.id === eventId && item.userRefs.has(userRef))
    if (event === undefined) throw new Error('alert event not found for this caller')
    if (event.status === 'acknowledged' || event.status === 'resolved' || event.status === 'false_positive') return 'already-final'
    event.status = 'acknowledged'
    event.stateValue = 'acknowledged'
    event.detectedAt = new Date(atMs).toISOString()
    return 'acknowledged'
  }
}

function toView(event: StoredEvent): AlertView {
  return {
    id: event.id,
    severity: event.severity,
    status: event.status,
    ruleId: event.ruleId,
    scopeLevel: event.scopeLevel,
    scopeId: event.scopeId,
    scopeName: event.scopeName,
    metric: event.metric,
    value: event.value,
    threshold: event.threshold,
    unit: event.unit,
    detectedAt: event.detectedAt,
    occurredAt: event.occurredAt,
    finding: event.finding,
  }
}
