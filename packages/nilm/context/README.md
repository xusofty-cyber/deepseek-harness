# `@deepseek-ai/dsh-nilm-context`

English | [中文](README.zh.md)

Binds each runtime Agent to the BFF-verified, immutable caller context. Bindings live only in process memory and are intentionally absent from Tool arguments and Session JSONL.

## Configuration

None. The service has no schema and no persistent state.

## Extension points

`bind(agentId, callContext)` registers a frozen context and returns an exact-binding disposer; `require(agentId)` reads it; `revoke(agentId)` removes it. Rebinding replaces the previous value, and an older disposer never removes the replacement.

## Known Limitations and Deferred Work

- Caller signature verification belongs to the stage-1 BFF. This package trusts the `CallContext` it receives and enforces only non-empty identity fields and immutability.
