# `@deepseek-ai/dsh-nilm-notify`

English | [中文](README.zh.md)

Delivers committed alerts through a MySQL Outbox and enriches them asynchronously. Delivery is independent of the model: a slow or failed diagnosis never delays or rolls back a notification.

## Configuration

`pollIntervalMs`, `batchSize`, `leaseMs`, `channelTimeoutMs`, `retentionDays`, and `workerId` control the dispatcher. `wxSubscribeUrl`, `wxTemplateUrl`, `wecomWebhookUrl`, and `smsUrl` select the service-provider gateway for each channel; the matching `*Token` fields add a bearer token. A channel without a URL is mounted as `UnconfiguredChannelTransport`, which dead-letters instead of retrying.

`enrichProvider`, `enrichModel`, `enrichPromptVersion`, `enrichTimeoutMs` (default 8 s), `enrichConcurrency`, and `enrichCwd` control diagnosis. Leaving `enrichModel` empty disables enrichment while keeping delivery.

## Extension points

`NotifyDependencies` replaces the Outbox store, channel transports, diagnosis agent, fetch implementation, and clock. `ChannelTransport` is the one required adapter seam: a new provider implements `send(task, signal)` and returns a provider message id or throws `DeliveryFailureError` with a retry classification. `DiagnosisAgent` separates the Cordis one-shot session from queue behavior.

The gateway request contains the encrypted recipient material, its masked hint, deterministic template parameters, and `notificationId`. It never contains plaintext recipients or vendor credentials.

## Known Limitations and Deferred Work

- The gateway contract is fixed, but no real WeChat, WeCom, or SMS vendor is integrated yet; the SMS provider remains decision D-12.
- Offline tests prove retry, dead-letter, enrichment timeout, and de-duplication behavior. Live `SKIP LOCKED` contention, gateway latency, and end-to-end 30-second SLO still need a staged rehearsal.
- Delivery is at least once. A crash after provider acceptance and before `markSent` can duplicate a send; clients de-duplicate by `notificationId`.
- Enrichment writes only when `agent_diagnosis` is still empty and the alert is not final. A late model answer is discarded.
- A diagnosis timeout keeps the deterministic summary. No retry of enrichment is scheduled in this stage.
