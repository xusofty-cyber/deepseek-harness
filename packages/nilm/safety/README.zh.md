# `@deepseek-ai/dsh-nilm-safety`

[English](README.md) | 中文

为已验证租户读取上游 `nilm_unsafe_record`，并投影为确定性安全事实。上游缺失字段保持 `null`；本服务不会用 0 补齐，也不会猜测阈值。

## 配置

无。`SourceSafetyRepository` 通过 `ctx.nilmSource` 使用参数化时间与资产过滤读取，排除上游 `unsafe_type='10'`，并将结果限制在 500 行。`NilmSafetyDependencies.repository` 可替换测试读取接缝。

## 扩展点

`ctx.nilmSafety.queryUnsafeRecords(callContext, input)` 接收左闭右开的 `TimeRangeSpec`、可选终端/通道过滤、可选严重级别与正整数行数上限。终端与通道过滤在 SQL 中执行；严重级别在确定性投影后过滤。已知过载、不平衡、电压与冲击类型映射为 `warning` 或 `critical`；未确认的上游类型保持 `unknown` 并如实反馈。

## 已知限制与延期工作

- 已确认的上游列不提供 `asset_path`、`phase`、`threshold` 或 `duration`；这些字段随行返回 `null`，不从描述文本推断。
- 基于秒级事件的微观隐患研判随阶段 2 提供；本包当前只投影已存储的安全记录。
