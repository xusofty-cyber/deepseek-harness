/**
 * Sentinel persistence seams. The MySQL implementation owns project-owned
 * writes; upstream reads stay on the guarded read-only source adapter.
 * @module @deepseek-ai/dsh-nilm-sentinel/store
 */

import { randomUUID } from 'node:crypto'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import { parseWorkHours, type WorkRange } from './calendar.ts'
import type {
  AlertScope,
  AlertSeverity,
  AlertSourceType,
  AlertState,
  NotificationChannel,
  SentinelRuleId,
} from './model.ts'
import { SENTINEL_RULE_IDS } from './model.ts'
import { parseThresholds, type RuleThresholds } from './rules.ts'
import type { WindowObservation } from './suppression.ts'

/** Project database surface used by Sentinel. */
export interface LocalDatabase {
  /**
   * @param sql - guarded SELECT over project tables.
   * @param params - bound values.
   * @returns result rows.
   */
  queryLocalReadOnly<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /**
   * @param body - statements to run inside one transaction.
   * @returns the callback result after commit.
   */
  transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T>
}

/** Tenant runtime policy used by the energy rules. */
export interface TenantPolicy {
  /** Tenant boundary. */
  tenantId: string
  /** Tenant display name. */
  tenantName: string
  /** Configured non-work baseline in kW. */
  baselineKw: number
  /** Sustained-window override in minutes; rules may also carry their own window. */
  nonWorkAlertMinutes: number
  /** Parsed working ranges. */
  workHours: readonly WorkRange[]
  /** Raw delivery configuration; no plaintext recipient is stored here. */
  notificationPolicy: unknown
}

/** Resume point for an incremental event source. */
export interface Watermark {
  /** Last processed event instant. */
  recordTimeMs: number
  /** Stable tie-breaker inside one instant. */
  recordId: string
  /**
   * Rows already examined after this point without a usable instant (poison
   * prefix). Persisted so a restart resumes the walk instead of rescanning it.
   * Absent means `0`.
   */
  scanOffset?: number
}

/** One enabled tenant rule row. */
export interface AlertRuleRow {
  /** Tenant boundary. */
  tenantId: string
  /** Supported rule identifier. */
  ruleId: SentinelRuleId
  /** Rule family from `rule_type`. */
  ruleType: string
  /** Scope evaluated by the energy rules. */
  scope: AlertScope
  /** Typed threshold payload. */
  thresholds: RuleThresholds
  /** Base severity. */
  severity: AlertSeverity
  /** Silence window in minutes. */
  silentMinutes: number
  /** Channels requested for this rule. */
  channels: readonly NotificationChannel[]
  /** Optimistic configuration version. */
  version: number
}

/** Tenant ownership and rating for one upstream node. */
export interface ScopeOwnership {
  /** Tenant boundary. */
  tenantId: string
  /** Addressed scope. */
  scope: AlertScope
  /** Nameplate rating in kW when the asset projection provides one. */
  ratedPowerKw?: number
}

/** One alert event ready for transactional persistence. */
export interface AlertEventDraft {
  /** Public event identifier. */
  eventId: string
  /** Tenant boundary. */
  tenantId: string
  /** Rule identifier. */
  ruleId: SentinelRuleId
  /** Event source family. */
  sourceType: AlertSourceType
  /** Addressed scope. */
  scope: AlertScope
  /** Final severity. */
  severity: AlertSeverity
  /** Metric name. */
  metric: string
  /** Observed value. */
  value: number
  /** Threshold value when one applies. */
  threshold: number | null
  /** Metric unit. */
  unit: string
  /** De-duplication bucket start. */
  bucketStartMs: number
  /** Cross-window suppression key. */
  silenceKey: string
  /** Per-bucket de-duplication key. */
  dedupeKey: string
  /** Upstream event or sample instant. */
  rawEventTimeMs: number
  /** Detection instant. */
  detectedAtMs: number
  /** Deterministic summary. */
  summaryText: string
  /** Initial lifecycle state. */
  status: AlertState
  /** Previous event when this event escalated severity. */
  escalatedFrom?: string
  /** Deterministic facts included in the notification payload. */
  facts: Readonly<Record<string, string | number | boolean | null>>
}

/** One state transition to append with an alert write. */
export interface AlertTransitionDraft {
  /** Event whose state changed. */
  eventId: string
  /** Previous state, absent for a new event. */
  fromStatus?: AlertState
  /** Destination state. */
  toStatus: AlertState
  /** Actor family. */
  operatorType: 'sentinel' | 'notifier' | 'user' | 'scheduler'
  /** Opaque actor reference. */
  operatorRef?: string
  /** Stable reason. */
  reason: string
  /** Channel involved in the transition, when applicable. */
  channel?: NotificationChannel
  /** Transition instant. */
  atMs: number
}

/** One Outbox row written in the same transaction as its alert event. */
export interface OutboxDraft {
  /** Public notification identifier shared by all channels of one alert. */
  notificationId: string
  /** Tenant boundary. */
  tenantId: string
  /** Receiving caller-side user reference. */
  userRef: string
  /** Alert event identifier. */
  eventId: string
  /** Delivery channel. */
  channel: NotificationChannel
  /** Provider template identifier when configured. */
  templateId?: string
  /** Encrypted recipient material copied from the tenant policy. */
  recipientCiphertext?: Uint8Array
  /** Masked recipient hint for troubleshooting. */
  recipientMasked?: string
  /** Deterministic template parameters; never contains a secret or plaintext recipient. */
  payloadJson: string
  /** Per-channel de-duplication key. */
  dedupeKey: string
  /** Maximum attempts before dead-lettering. */
  maxAttempts: number
  /** First eligible delivery instant. */
  nextRetryAtMs: number
}

/** Complete transactional alert write. */
export interface AlertWrite {
  /** Alert event. */
  event: AlertEventDraft
  /** Initial transition. */
  transition: AlertTransitionDraft
  /** Notifications to enqueue; empty for a suppressed finding. */
  outbox: readonly OutboxDraft[]
}

/** Filter accepted by the BFF alert list. */
export interface AlertQuery {
  /** Optional lifecycle state. */
  status?: AlertState
  /** Optional severity. */
  severity?: AlertSeverity
  /** Maximum rows; clamped by the store implementation. */
  limit?: number
  /** Rows to skip. */
  offset?: number
}

/** One alert projection returned to the caller application. */
export interface AlertView {
  /** Public event identifier. */
  id: string
  /** Severity. */
  severity: AlertSeverity
  /** Lifecycle state. */
  status: AlertState
  /** Rule identifier. */
  ruleId: SentinelRuleId
  /** Scope level. */
  scopeLevel: AlertScope['level']
  /** Scope identifier. */
  scopeId: string
  /** Scope display name. */
  scopeName: string
  /** Metric name. */
  metric: string
  /** Observed value. */
  value: number
  /** Threshold when one applies. */
  threshold: number | null
  /** Metric unit. */
  unit: string
  /** Detection instant in business time. */
  detectedAt: string
  /** Upstream event instant in business time. */
  occurredAt: string
  /** Deterministic summary. */
  finding: string
  /** Optional asynchronous diagnosis. */
  agentDiagnosis?: string
}

/** One page of alert projections. */
export interface AlertPage {
  /** Projected alerts. */
  alerts: AlertView[]
  /** Total visible rows matching the filter. */
  total: number
}

/** Acknowledgement outcome without revealing whether an invisible event exists. */
export type AcknowledgementOutcome = 'acknowledged' | 'already-final'

/** Persistence consumed by the scanner and the BFF alert API. */
export interface SentinelStore {
  /** @param sourceName - incremental source identity. @returns the persisted resume point. */
  loadWatermark(sourceName: string): Promise<Watermark | undefined>
  /** @param sourceName - incremental source identity. @param watermark - last processed record. */
  saveWatermark(sourceName: string, watermark: Watermark): Promise<void>
  /** @returns enabled tenant policies. */
  listTenants(): Promise<TenantPolicy[]>
  /** @param tenantId - tenant boundary. @returns enabled rule rows. */
  listRules(tenantId: string): Promise<AlertRuleRow[]>
  /**
   * @param sourceId - configured upstream source identity.
   * @param sourceTenantId - upstream tenant key carried by that source.
   * @returns the single project tenant mapped to the source tenant, or undefined when unmapped.
   */
  resolveSourceTenant(sourceId: string, sourceTenantId: string): Promise<string | undefined>
  /**
   * @param nodeIds - upstream node identifiers.
   * @param tenantId - optional mapped tenant that bounds the lookup.
   * @returns tenant ownership rows.
   */
  resolveScopes(nodeIds: readonly string[], tenantId?: string): Promise<ScopeOwnership[]>
  /**
   * @param tenantId - tenant boundary.
   * @param silenceKey - cross-window key.
   * @param sinceMs - earliest bucket.
   * @param limit - maximum observations.
   * @returns observations ascending by bucket.
   */
  recentObservations(tenantId: string, silenceKey: string, sinceMs: number, limit: number): Promise<WindowObservation[]>
  /** @param tenantId - tenant boundary. @param silenceKey - cross-window key. @returns latest successful send instant. */
  lastNotificationAt(tenantId: string, silenceKey: string): Promise<number | undefined>
  /** @param write - complete transactional write. @returns `duplicate` when the de-duplication key already exists. */
  insertAlert(write: AlertWrite): Promise<'inserted' | 'duplicate'>
  /**
   * @param tenantId - tenant boundary.
   * @param userRef - receiving caller.
   * @param query - filter.
   * @returns visible alerts and total.
   */
  listAlerts(tenantId: string, userRef: string, query: AlertQuery): Promise<AlertPage>
  /**
   * @param tenantId - tenant boundary.
   * @param userRef - receiving caller.
   * @param eventId - alert identifier.
   * @param atMs - acknowledgement instant.
   * @throws NilmError with `SCOPE_NOT_FOUND` when the event is not visible to the caller.
   * @returns the outcome.
   */
  acknowledge(tenantId: string, userRef: string, eventId: string, atMs: number): Promise<AcknowledgementOutcome>
}

/** MySQL-backed store over the project database. */
export class MysqlSentinelStore implements SentinelStore {
  /**
   * @param database - lazily resolved project database service.
   */
  constructor(private readonly database: () => LocalDatabase) {}

  /** @param sourceName - incremental source identity. @returns the persisted resume point. */
  async loadWatermark(sourceName: string): Promise<Watermark | undefined> {
    const rows = await this.database().queryLocalReadOnly<{ recordTime: string | Date; recordId: string; scanOffset: number | string | null }>(
      `SELECT record_time AS recordTime, record_id AS recordId, scan_offset AS scanOffset
         FROM nilm_sentinel_watermark
        WHERE source_name = ?`,
      [sourceName],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const scanOffset = Number(row.scanOffset ?? 0)
    return {
      recordTimeMs: dateMs(row.recordTime),
      recordId: row.recordId,
      scanOffset: Number.isSafeInteger(scanOffset) && scanOffset > 0 ? scanOffset : 0,
    }
  }

  /** @param sourceName - incremental source identity. @param watermark - last processed record. */
  async saveWatermark(sourceName: string, watermark: Watermark): Promise<void> {
    const time = new Date(watermark.recordTimeMs)
    const id = watermark.recordId
    const offset = clampScanOffset(watermark.scanOffset)
    // Bound parameters replace the VALUES() function, deprecated since MySQL 8.0.20.
    // MySQL evaluates these assignments left to right against the updated row, so
    // scan_offset must be decided before record_id/record_time move.
    const advances = '(? > record_time OR (? = record_time AND ? > record_id))'
    await this.database().transaction(async tx => {
      await tx.query(
        `INSERT INTO nilm_sentinel_watermark (source_name, record_time, record_id, scan_offset)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           scan_offset = IF(${advances}, ?,
             IF(? = record_time AND ? = record_id AND ? > scan_offset, ?, scan_offset)),
           record_id = IF(${advances}, ?, record_id),
           record_time = IF(${advances}, ?, record_time)`,
        [
          sourceName, time, id, offset,
          time, time, id, offset, time, id, offset, offset,
          time, time, id, id,
          time, time, id, time,
        ],
      )
    })
  }

  /** @returns enabled tenant policies. */
  async listTenants(): Promise<TenantPolicy[]> {
    const rows = await this.database().queryLocalReadOnly<{
      tenantId: string
      tenantName: string
      baselineKw: string | number
      nonWorkAlertMinutes: number
      workHoursJson: unknown
      notificationPolicyJson: unknown
    }>(
      `SELECT tenant_id AS tenantId, tenant_name AS tenantName,
              non_work_baseline_kw AS baselineKw,
              non_work_alert_minutes AS nonWorkAlertMinutes,
              work_hours_json AS workHoursJson,
              notification_policy_json AS notificationPolicyJson
         FROM nilm_tenant_config
        WHERE status = 1
        ORDER BY tenant_id`,
    )
    return rows.map(row => ({
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      baselineKw: numberOrZero(row.baselineKw),
      nonWorkAlertMinutes: row.nonWorkAlertMinutes,
      workHours: parseWorkHours(row.workHoursJson),
      notificationPolicy: decodeJson(row.notificationPolicyJson),
    }))
  }

  /** @param tenantId - tenant boundary. @returns enabled supported rule rows. */
  async listRules(tenantId: string): Promise<AlertRuleRow[]> {
    const rows = await this.database().queryLocalReadOnly<{
      tenantId: string
      ruleId: string
      ruleType: string
      scopeLevel: AlertScope['level']
      scopeId: string
      thresholdJson: unknown
      severity: AlertSeverity
      silentMinutes: number
      notifyChannelsJson: unknown
      version: number
    }>(
      `SELECT tenant_id AS tenantId, rule_id AS ruleId, rule_type AS ruleType,
              scope_level AS scopeLevel, scope_id AS scopeId,
              threshold_json AS thresholdJson, severity,
              silent_minutes AS silentMinutes,
              notify_channels_json AS notifyChannelsJson, version
         FROM nilm_alert_rule
        WHERE tenant_id = ? AND is_enabled = 1`,
      [tenantId],
    )
    return rows.flatMap(row => {
      if (!isRuleId(row.ruleId)) return []
      return [{
        tenantId: row.tenantId,
        ruleId: row.ruleId,
        ruleType: row.ruleType,
        scope: { level: row.scopeLevel, id: row.scopeId, name: row.scopeId },
        thresholds: parseThresholds(row.ruleId, row.thresholdJson),
        severity: row.severity,
        silentMinutes: row.silentMinutes,
        channels: parseChannels(row.notifyChannelsJson),
        version: row.version,
      }]
    })
  }

  /**
   * @param sourceId - configured upstream source identity.
   * @param sourceTenantId - upstream tenant key carried by that source.
   * @returns the single project tenant mapped to the source tenant, or undefined when unmapped.
   */
  async resolveSourceTenant(sourceId: string, sourceTenantId: string): Promise<string | undefined> {
    const rows = await this.database().queryLocalReadOnly<{ tenantId: string }>(
      `SELECT tenant_id AS tenantId
         FROM nilm_source_tenant_map
        WHERE source_id = ? AND source_tenant_id = ?
        LIMIT 2`,
      [sourceId, sourceTenantId],
    )
    if (rows.length > 1) throw new NilmError('AMBIGUOUS_SCOPE', 'source tenant maps to multiple project tenants')
    return rows[0]?.tenantId
  }

  /**
   * @param nodeIds - upstream node identifiers.
   * @param tenantId - optional mapped tenant that bounds the lookup.
   * @returns tenant ownership rows.
   */
  async resolveScopes(nodeIds: readonly string[], tenantId?: string): Promise<ScopeOwnership[]> {
    const unique = [...new Set(nodeIds.filter(id => id.length > 0))]
    if (unique.length === 0) return []
    if (unique.length > 500) throw new NilmError('INVALID_ARGUMENT', 'scope resolution exceeds 500 identifiers')
    const placeholders = unique.map(() => '?').join(', ')
    const rows = await this.database().queryLocalReadOnly<{
      tenantId: string
      level: AlertScope['level']
      nodeId: string
      nodeName: string
      ratedPowerKw: string | number | null
    }>(
      `SELECT tenant_id AS tenantId, level, node_id AS nodeId, node_name AS nodeName,
              rated_power_kw AS ratedPowerKw
         FROM nilm_asset_snapshot
        WHERE is_active = 1 AND node_id IN (${placeholders})${tenantId === undefined ? '' : ' AND tenant_id = ?'}`,
      tenantId === undefined ? unique : [...unique, tenantId],
    )
    return rows.map(row => ({
      tenantId: row.tenantId,
      scope: { level: row.level, id: row.nodeId, name: row.nodeName },
      ...(row.ratedPowerKw === null ? {} : { ratedPowerKw: numberOrZero(row.ratedPowerKw) }),
    }))
  }

  /** @param tenantId - tenant boundary. @param silenceKey - cross-window key. @param sinceMs - earliest bucket. @param limit - maximum rows. @returns observations ascending. */
  async recentObservations(
    tenantId: string,
    silenceKey: string,
    sinceMs: number,
    limit: number,
  ): Promise<WindowObservation[]> {
    const rows = await this.database().queryLocalReadOnly<{
      eventId: string
      bucketStart: string | Date
      metricValue: string | number
      severity: AlertSeverity
      status: string
    }>(
      `SELECT event_id AS eventId, bucket_start AS bucketStart,
              metric_value AS metricValue, severity, status
         FROM nilm_alert_event
        WHERE tenant_id = ? AND silence_key = ? AND bucket_start >= ?
        ORDER BY bucket_start DESC, event_id DESC
        LIMIT ${String(Math.max(1, Math.min(limit, 50)))}`,
      [tenantId, silenceKey, new Date(sinceMs)],
    )
    return rows.reverse().map(row => ({
      eventId: row.eventId,
      bucketStartMs: dateMs(row.bucketStart),
      value: numberOrZero(row.metricValue),
      severity: row.severity,
      state: row.status,
    }))
  }

  /** @param tenantId - tenant boundary. @param silenceKey - cross-window key. @returns latest successful send instant. */
  async lastNotificationAt(tenantId: string, silenceKey: string): Promise<number | undefined> {
    const rows = await this.database().queryLocalReadOnly<{ sentAt: string | Date | null }>(
      `SELECT MAX(sent_at) AS sentAt
         FROM nilm_notification_outbox
        WHERE tenant_id = ? AND status = ? AND dedupe_key LIKE ?`,
      [tenantId, 'sent', `${escapeLike(silenceKey)}:%`],
    )
    const sentAt = rows[0]?.sentAt
    if (sentAt === undefined || sentAt === null) return undefined
    const ms = dateMs(sentAt)
    return Number.isFinite(ms) ? ms : undefined
  }

  /** @param write - complete transactional write. @returns `duplicate` when the event already exists. */
  async insertAlert(write: AlertWrite): Promise<'inserted' | 'duplicate'> {
    try {
      await this.database().transaction(async tx => {
        const event = write.event
        await tx.query(
          `INSERT INTO nilm_alert_event
            (event_id, tenant_id, rule_id, source_type, scope_level, scope_id, scope_name,
             severity, metric_name, metric_value, threshold_value, unit, bucket_start,
             silence_key, dedupe_key, raw_event_time, detected_at, summary_text, status,
             escalated_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.eventId, event.tenantId, event.ruleId, event.sourceType, event.scope.level,
            event.scope.id, event.scope.name, event.severity, event.metric, event.value,
            event.threshold, event.unit, new Date(event.bucketStartMs), event.silenceKey,
            event.dedupeKey, new Date(event.rawEventTimeMs), new Date(event.detectedAtMs),
            event.summaryText, event.status, event.escalatedFrom ?? null,
          ],
        )
        const transition = write.transition
        await tx.query(
          `INSERT INTO nilm_alert_transition
            (event_id, from_status, to_status, operator_type, operator_ref, reason, channel, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transition.eventId, transition.fromStatus ?? null, transition.toStatus,
            transition.operatorType, transition.operatorRef ?? null, transition.reason,
            transition.channel ?? null, new Date(transition.atMs),
          ],
        )
        for (const outbox of write.outbox) {
          await tx.query(
            `INSERT INTO nilm_notification_outbox
              (notification_id, tenant_id, user_ref, event_id, channel, template_id,
               recipient_ciphertext, recipient_masked, payload_json, dedupe_key, status,
               attempt_count, max_attempts, next_retry_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
            [
              outbox.notificationId, outbox.tenantId, outbox.userRef, outbox.eventId,
              outbox.channel, outbox.templateId ?? null, outbox.recipientCiphertext ?? null,
              outbox.recipientMasked ?? null, outbox.payloadJson, outbox.dedupeKey,
              outbox.maxAttempts, new Date(outbox.nextRetryAtMs),
            ],
          )
        }
      })
      return 'inserted'
    } catch (error) {
      if (isDuplicateKey(error)) return 'duplicate'
      throw error
    }
  }

  /** @param tenantId - tenant boundary. @param userRef - receiving caller. @param query - filter. @returns visible alerts and total. */
  async listAlerts(tenantId: string, userRef: string, query: AlertQuery): Promise<AlertPage> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200))
    const offset = Math.max(0, query.offset ?? 0)
    const status = query.status ?? null
    const severity = query.severity ?? null
    const rows = await this.database().queryLocalReadOnly<{
      eventId: string
      severity: AlertSeverity
      status: AlertState
      ruleId: SentinelRuleId
      scopeLevel: AlertScope['level']
      scopeId: string
      scopeName: string
      metricName: string
      metricValue: string | number
      thresholdValue: string | number | null
      unit: string
      detectedAt: string | Date
      rawEventTime: string | Date
      summaryText: string
      agentDiagnosis: string | null
    }>(
      `${visibleAlertSelect()}
        AND (? IS NULL OR e.status = ?)
        AND (? IS NULL OR e.severity = ?)
        ORDER BY e.detected_at DESC, e.event_id DESC
        LIMIT ${String(limit)} OFFSET ${String(offset)}`,
      [tenantId, userRef, status, status, severity, severity],
    )
    const totalRows = await this.database().queryLocalReadOnly<{ total: string | number }>(
      `SELECT COUNT(*) AS total
         FROM nilm_alert_event e
        WHERE ${visibleAlertWhere()}
          AND (? IS NULL OR e.status = ?)
          AND (? IS NULL OR e.severity = ?)`,
      [tenantId, userRef, status, status, severity, severity],
    )
    return {
      alerts: rows.map(row => ({
        id: row.eventId,
        severity: row.severity,
        status: row.status,
        ruleId: row.ruleId,
        scopeLevel: row.scopeLevel,
        scopeId: row.scopeId,
        scopeName: row.scopeName,
        metric: row.metricName,
        value: numberOrZero(row.metricValue),
        threshold: row.thresholdValue === null ? null : numberOrZero(row.thresholdValue),
        unit: row.unit,
        detectedAt: row.detectedAt instanceof Date ? row.detectedAt.toISOString() : row.detectedAt,
        occurredAt: row.rawEventTime instanceof Date ? row.rawEventTime.toISOString() : row.rawEventTime,
        finding: row.summaryText,
        ...(row.agentDiagnosis === null ? {} : { agentDiagnosis: row.agentDiagnosis }),
      })),
      total: Number(totalRows[0]?.total ?? 0),
    }
  }

  /** @param tenantId - tenant boundary. @param userRef - receiving caller. @param eventId - alert identifier. @param atMs - acknowledgement instant. @returns the acknowledgement outcome. */
  async acknowledge(
    tenantId: string,
    userRef: string,
    eventId: string,
    atMs: number,
  ): Promise<AcknowledgementOutcome> {
    return this.database().transaction(async tx => {
      const visible = await tx.query<{ visible: number }>(
        `SELECT 1 AS visible
           FROM nilm_alert_event e
          WHERE ${visibleAlertWhere()} AND e.event_id = ?
          LIMIT 1`,
        [tenantId, userRef, eventId],
      )
      if (visible.length === 0) throw new NilmError('SCOPE_NOT_FOUND', 'alert event not found for this caller')
      const rows = await tx.query<{ status: AlertState }>(
        `SELECT status
           FROM nilm_alert_event
          WHERE tenant_id = ? AND event_id = ?
          FOR UPDATE`,
        [tenantId, eventId],
      )
      const current = rows[0]?.status
      if (current === undefined) throw new NilmError('SCOPE_NOT_FOUND', 'alert event not found for this caller')
      if (current === 'acknowledged' || current === 'resolved' || current === 'false_positive') return 'already-final'
      await tx.affected(
        `UPDATE nilm_alert_event
            SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
          WHERE tenant_id = ? AND event_id = ?`,
        [new Date(atMs), userRef, tenantId, eventId],
      )
      await tx.query(
        `INSERT INTO nilm_alert_transition
          (event_id, from_status, to_status, operator_type, operator_ref, reason, created_at)
         VALUES (?, ?, 'acknowledged', 'user', ?, 'user-acknowledged', ?)`,
        [eventId, current, userRef, new Date(atMs)],
      )
      return 'acknowledged'
    })
  }
}

/**
 * Build a new public identifier.
 * @returns a prefixed random identifier.
 */
export function newAlertId(): string {
  return `alert_${randomUUID().replaceAll('-', '')}`
}

/**
 * Build a new public notification identifier.
 * @returns a prefixed random identifier.
 */
export function newNotificationId(): string {
  return `notif_${randomUUID().replaceAll('-', '')}`
}

/** @param value - driver value. @returns a finite number or zero. */
function numberOrZero(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** @param value - driver timestamp. @returns epoch milliseconds. */
function dateMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/** @param value - JSON column value. @returns decoded JSON or `undefined`. */
function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const decoded: unknown = JSON.parse(value)
    return decoded
  } catch {
    return undefined
  }
}

/** @param value - candidate rule identifier. @returns true for stage-3 rules. */
function isRuleId(value: string): value is SentinelRuleId {
  return (SENTINEL_RULE_IDS as readonly string[]).includes(value)
}

/** @param value - `notify_channels_json`. @returns supported channels in stable order. */
export function parseChannels(value: unknown): NotificationChannel[] {
  const decoded = decodeJson(value)
  if (!Array.isArray(decoded)) return []
  const allowed = new Set<NotificationChannel>(['wx_subscribe', 'wx_template', 'wecom_webhook', 'sms'])
  return [...new Set(decoded.filter((item): item is NotificationChannel => typeof item === 'string' && allowed.has(item as NotificationChannel)))]
}

/** @param text - literal LIKE prefix. @returns escaped prefix without wildcard expansion. */
function escapeLike(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** @returns the fixed SELECT projection and visibility predicate preamble. */
function visibleAlertSelect(): string {
  return `SELECT e.event_id AS eventId, e.severity, e.status, e.rule_id AS ruleId,
                 e.scope_level AS scopeLevel, e.scope_id AS scopeId, e.scope_name AS scopeName,
                 e.metric_name AS metricName, e.metric_value AS metricValue,
                 e.threshold_value AS thresholdValue, e.unit,
                 e.detected_at AS detectedAt, e.raw_event_time AS rawEventTime,
                 e.summary_text AS summaryText, e.agent_diagnosis AS agentDiagnosis
            FROM nilm_alert_event e
           WHERE ${visibleAlertWhere()}`
}

/** @returns the tenant and recipient visibility predicate. */
function visibleAlertWhere(): string {
  return `e.tenant_id = ?
      AND EXISTS (
        SELECT 1 FROM nilm_notification_outbox o
         WHERE o.tenant_id = e.tenant_id AND o.event_id = e.event_id AND o.user_ref = ?
      )`
}

/** @param error - driver or wrapped failure. @returns true for a duplicate-key failure. */
function isDuplicateKey(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown; cause?: unknown }
    if (record.code === 'ER_DUP_ENTRY' || record.errno === 1062) return true
    current = record.cause
  }
  return false
}

/** Largest value `nilm_sentinel_watermark.scan_offset` (INT UNSIGNED) can hold. */
const MAX_SCAN_OFFSET = 4_294_967_295

/** @param value - requested poison-prefix offset. @returns a non-negative integer within the column range. */
function clampScanOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), MAX_SCAN_OFFSET)
}
