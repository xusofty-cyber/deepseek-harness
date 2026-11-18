# `@deepseek-ai/dsh-nilm-assets`

[English](README.md) | 中文

把调用方给出的工厂、车间、终端、通道与设备目标解析到租户资产快照，执行调用方允许范围过滤，并选择互不重叠、可安全聚合的计量点集合。本服务只通过带门禁的数据源适配器读取 `nilm_asset_snapshot` 与 `nilm_measurement_binding`。

## 配置

`SourceAssetRepository` 通过 `ctx.nilmSource` 读取本项目数据库；本包不配置端点或凭证。`NilmAssetsDependencies.repository` 可替换该读取接缝，用于测试或替代投影。

## 扩展点

`resolveScope` 依次按标识符、精确路径、精确名称、归一化名称包含关系匹配。并列最高分匹配会以 `ambiguous: true` 返回，而不是任选一个。`getWorkshopChannels` 返回单个车间解析后的计量点集合，`resolveMeterSet` 返回唯一目标的计量点集合。

授权按失败关闭处理。`allowedScope` 缺省表示租户级访问；存在列表时只允许列表中的根节点及其后代。目标超出允许范围抛 `SCOPE_FORBIDDEN`，未知标识抛 `SCOPE_NOT_FOUND`。计量点选择优先为每个终端取一个 `terminal_total` 并排除其分路；只有没有总进线的终端才回退到叶子 `branch` 绑定。`reference` 计量点被排除，设备级范围解析到其父通道并附带估算告警。

## 已知限制与延期工作

- 从上游通道表同步资产快照属于部署任务；本包只消费已投影的行。
- 父子计量数值偏差阈值与 `aggregationWarning` 需要成对电量值，随阶段 1 分析集成提供；本包已返回互不重叠的计量点与确定性的排除告警。
