/**
 * Branded identifiers shared by every NILM package.
 * @module @deepseek-ai/dsh-nilm-core/ids
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Tenant selected by the BFF-signed call context. */
export type TenantId = Branded<'TenantId'>
/** Workshop under a tenant. */
export type WorkshopId = Branded<'WorkshopId'>
/** Metering terminal. */
export type TerminalId = Branded<'TerminalId'>
/** Channel below a terminal. */
export type ChannelId = Branded<'ChannelId'>
/** Identified appliance. */
export type ApplianceId = Branded<'ApplianceId'>
/** Public conversation identifier. */
export type ConversationId = Branded<'ConversationId'>
/** Durable dsh session identifier. */
export type SessionId = Branded<'SessionId'>
/** One user turn. */
export type TurnId = Branded<'TurnId'>
