# `@deepseek-ai/dsh-nilm-core`

English | [中文](README.zh.md)

Database- and model-independent NILM identifiers, scope structures, data-quality metadata, the versioned `ChartSpec` protocol, `AlertCard`, and stable error codes. The package owns no runtime state and performs no IO.

## Configuration

None. All values are types or pure factories supplied by callers.

## Extension points

Consumers construct branded identifiers with `@deepseek-ai/dsh-brand` and throw `NilmError`, `NilmToolError`, or `NilmSourceError` with stable codes. The chart protocol is versioned by the `version: 1` discriminant; a future incompatible protocol adds a new version rather than extending version 1 in place.

## Known Limitations and Deferred Work

- Tool argument schemas and domain validation arrive with `nilm-tools` in stage 1; this package only owns shared structures and errors.
