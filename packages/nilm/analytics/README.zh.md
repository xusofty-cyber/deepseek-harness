# `@deepseek-ai/dsh-nilm-analytics`

[English](README.md) | 中文

对已授权、已取数的 NILM 值执行确定性计算：电量与分时电费、去抖后的运行/空载时长、周期对比、能量加权电能质量与 CUSUM 台阶特征，并给出覆盖率说明。本包不执行 IO、不调用模型，也不判定租户权限。

## 配置

无。所有输入值、阈值与窗口都由调用方提供；随部署变化的阈值属于上层读取的租户配置。

## 扩展点

`ctx.nilmAnalytics` 暴露 `calculateEnergyCosts`、`calculateRunningAndIdleTime`、`calculateCompareTrends`、`analyzePowerQuality` 与 `detectTimeSeriesFeatures`；同样的操作也以纯函数导出。`energyWeightedPowerFactor`、`phaseUnbalancePct`、`detectPowerEdges`、`pairCycles` 与 `diagnoseMicroHazards` 也可单独组合使用。

电价切片边界落在电量桶内部时，按时间比例均匀分摊，粗粒度区间不会静默套用单一电价。落在所有切片之外的电量保持未定价，并使 `precise` 为 false。运行与空载状态按 `minDwellMs` 去抖；未知缺口保持未知并降低 `validRatio`，不会当作空载。两期覆盖率均达到 95% 时对比标记 `precise`，覆盖率差不超过两个百分点时标记 `comparable`。电能质量对相邻有功与无功样本积分，绝不把上游 `power_factor` 当作计费值；谐波含有率只对具备正基波与对应阶次的样本计算。CUSUM 会把同一滑动均值过渡期的重复检出合并，配对对称启停台阶，并诊断高频启停、启动迟滞、三相不平衡与谐波谐振。

## 已知限制与延期工作

- 数据库驱动的查询入口位于 `nilm-timeseries`；本包只负责纯计算，不执行 IO，也无法取得上游未暴露的分相电流或谐波列。
- 电能质量不计算完整 THD；CUSUM 假设秒级有功样本，粗粒度样本应由调用方拒绝或改用更粗的阈值。
- 均匀分摊假设电量在桶内均匀分布；需要区间精确归集的调用方应按电价边界或更细粒度取数。
