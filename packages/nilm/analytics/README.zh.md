# `@deepseek-ai/dsh-nilm-analytics`

[English](README.md) | 中文

对已授权、已取数的 NILM 值执行确定性计算：电量与分时电费、去抖后的运行/空载时长，以及带覆盖率说明的周期对比。本包不执行 IO、不调用模型，也不判定租户权限。

## 配置

无。所有输入值、阈值与窗口都由调用方提供；随部署变化的阈值属于上层读取的租户配置。

## 扩展点

`ctx.nilmAnalytics` 暴露 `calculateEnergyCosts`、`calculateRunningAndIdleTime` 与 `calculateCompareTrends`；同样的操作也以纯函数导出。

电价切片边界落在电量桶内部时，按时间比例均匀分摊，粗粒度区间不会静默套用单一电价。落在所有切片之外的电量保持未定价，并使 `precise` 为 false。运行与空载状态按 `minDwellMs` 去抖；未知缺口保持未知并降低 `validRatio`，不会当作空载。两期覆盖率均达到 95% 时对比标记 `precise`，覆盖率差不超过两个百分点时标记 `comparable`。

## 已知限制与延期工作

- 数据库驱动的 `queryEnergy`、`queryAppliances`、`queryPowerQuality` 与 `analyzeTimeseries` 入口，以及功率因数与 CUSUM 特征提取，随后续阶段 1/2 工作提供；本包当前只负责纯计算核心。
- 均匀分摊假设电量在桶内均匀分布；需要区间精确归集的调用方应按电价边界或更细粒度取数。
