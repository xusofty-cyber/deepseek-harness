# `@deepseek-ai/dsh-nilm-sentinel`

[English](README.md) | 中文

不依赖模型执行主动巡检：增量读取上游 `nilm_unsafe_record`、按租户规则判定、写入告警生命周期，并在同一事务内写入 Outbox。扫描器从不询问模型是否告警，也从不写上游数据。

## Configuration

`pollIntervalMs`（默认 5 秒）驱动安全增量扫描；`energyIntervalMs`（默认 60 秒）驱动用能规则；`bucketMinutes`（默认 5）决定去重与升级窗口；`batchSize` 限制每次上游读取行数；`escalateAfterWindows`（默认 3）要求连续多个窗口加剧后才升级；`maxAttempts` 写入每条 Outbox 记录；`templates` 把 `wx_subscribe`、`wx_template`、`wecom_webhook`、`sms` 映射到渠道模板；`nominalVoltageV` 提供 R-05 回退值；`workerId` 标识扫描器的写入与日志。

租户阈值位于 `nilm_alert_rule.threshold_json`，通知策略位于 `nilm_tenant_config.notification_policy_json`。包内不内置阈值、基线或接收方。

## Extension points

`SentinelDependencies` 可替换存储、上游读取器、信号提供者、接收方策略、时钟与标识生成器，供测试使用。规则函数（`evaluateR01a`、`evaluateR01b`、`evaluateR02`、`evaluateR03`、`evaluateR04`、`evaluateR05`）是纯函数，返回确定性结论。`nilm/alert/created` 仅在告警与 Outbox 事务提交后发布，监听器不得阻塞或回滚该事务。

`nilmSentinel.alerts(caller)` 与 `nilmSentinel.acknowledge(caller, eventId)` 提供 BFF 使用的按调用方告警列表与确认接口。确认写入 `nilm_alert_transition`，不控制任何设备。

## Known Limitations and Deferred Work

- 已实现 R-01a/R-01b/R-02/R-03/R-04/R-05。R-06 力调风险、R-07 晨报、R-08 数据质量摘要仍属阶段 4。
- `SELECT ... FOR UPDATE SKIP LOCKED` 的 Outbox 抢占与“检测到触达 30 秒”SLO 仅完成离线验证；在给出 SLO 结论前仍需真实 MySQL 与渠道网关演练。
- 用能规则依赖热库功率与设备状态的可用性。信号缺失时不产生告警，也不猜测基线。
- R-01b 使用租户配置的 `baseline_kw` 作为基线；按同租户、同星期、同时间段自动计算过去 4 周中位数仍属延期工作。
- R-03 当前只由上游 `nilm_unsafe_record` 的分类触发；实时功率超过额定容量的判定路径尚未实现。
- R-04 在上游提供分相电流列之前保持停用；扫描器按“租户+规则”只记录一次缺失信号，不做不平衡度估算。
- 安全类告警绕过静默窗口。未知的上游 `unsafe_type` 直接忽略，不映射为任何严重度。
- 上游增量查询假设存在 `(asset_id, record_time, record_id)` 或等价索引；DBA 评估仍未完成。
