# `@deepseek-ai/dsh-nilm-scheduler`

[English](README.md) | 中文

运行定时 NILM 任务，数值不交由模型决定：R-07 每日 08:30 晨报、R-06 每月 20/25 日计费功率因数预测，以及 R-08 每日数据质量巡检。晨报包含告警分级总数与未处理数。每次执行都以 `(job_type, tenant_id, business_date)` 写入 `nilm_job_run` 幂等键；同一业务日已完成的键不会重复计算或重复投递。

## 配置

`tickIntervalMs`（默认 60 秒）驱动到期检查。`morningHour`/`morningMinute` 默认 `Asia/Shanghai` 08:30；`qualityHour`/`qualityMinute` 默认在 03:30 低峰时段。`reportChannels` 与 `reportTemplates` 选择投递渠道与供应商模板。`maxAttempts`、`jobLeaseMs`、`jobRetryDelayMs` 约束 Outbox 尝试次数、崩溃租约恢复与失败重试。`summaryModel` 可选：未配置时保留确定性模板；配置后由一次性 Agent 只写摘要文字。R-08 阈值属于部署配置，不内嵌工程常量。

## 扩展点

`SchedulerDependencies` 可替换仓储、数据采集器、接收方策略、摘要写入器、时钟与标识生成器。`SchedulerDataSource` 提供晨报、月度与质量事实；`MonthlyEnergySource` 是月度有功/无功预聚合的显式接缝。`ReportSummaryWriter` 把模型撰写与报表内容分离。报表写入 `nilm_report`，投递行写入 `nilm_notification_outbox` 并携带 `report_id`；共享通知器负责渠道重试，且只在供应商成功后标记 `delivered_at`。R-08 发现只写运维审计，绝不发往客户渠道。

## 已知限制与延期工作

- 已实现 R-07 的昨日电量、分时费用占比、车间排行、告警计数，以及 R-08 的覆盖率与父子计量检查。冷热库一致性在配置冷电量路由前保持停用。
- R-06 预测为确定性算法，但默认部署没有月度有功/无功预聚合：在上游提供 `E_p`/`E_q` 或配置可信汇总前，任务以 `DATA_UNAVAILABLE` 失败，不按逐点功率因数估算。
- 不计算力调奖惩金额。当前输出 `nilm_pf_policy` 的阈值与风险等级；可执行的地方公式仍属部署决策。
- 模型摘要依赖已配置的 provider 与 model。摘要迟到或失败时保留确定性模板，绝不改变报表数值或投递状态。
- G4-1 演练脚本离线验证 20 租户报表重算与幂等；真实 08:35 送达完成率与渠道回执仍需在线 MySQL、接收方配置与供应商沙箱。
- 尚无面向模型的已存报告读取工具。BFF 报告查询路径仍属延期工作；调度器只持久化报告，不把它暴露到对话轮次。
