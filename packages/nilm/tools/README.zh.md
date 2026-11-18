# `@deepseek-ai/dsh-nilm-tools`

[English](README.md) | 中文

注册面向模型的 NILM 工具：`nilm_scope_resolve`、`nilm_energy_query`、`nilm_appliance_query`、`nilm_power_quality_query`、`nilm_timeseries_analyze` 与 `nilm_safety_query`。所有工具只从 BFF 绑定的不可变调用方上下文中取得租户与允许范围；不接受租户标识、SQL、表名、电价或阈值参数。

## 配置

无。插件消费 `ctx.tools`、`ctx.nilmContext`、`ctx.nilmAssets`、`ctx.nilmTimeseries`、`ctx.nilmTariff`、`ctx.nilmAnalytics` 与 `ctx.nilmSafety`。

## 扩展点

`nilm_scope_resolve` 最多返回 5 个候选，并返回最多 200 个互不重叠计量点。同名歧义返回澄清动作，不自行选择。`nilm_energy_query` 仅在租户电价方案可解析时计价，否则返回电量并明确告警。`nilm_appliance_query` 把上游 `appliance_state` 汇总为运行或停止，不推断空载时长。`nilm_power_quality_query` 报告能量加权功率因数、逐阶谐波含有率、三相不平衡与电压偏差；只报告上游实际提供的阶次，不冒充完整 THD。`nilm_timeseries_analyze` 单次最多接受 4 小时，按每个计量点独立执行 CUSUM，最多返回 20 个事件、循环或隐患；波形图只使用 `annotations`，不使用 `markLine` 或 `markPoint`。`nilm_safety_query` 用已解析的终端与通道标识限定 SQL，租户级会话不会读到其他车间的事件。

每个成功结果都包含确定性 `summaryText`、结构化 `facts`、`dataQuality` 与 `warnings`。模型事实中的电量序列最多 200 个桶、设备行最多 20 条、安全记录最多 20 条、分析事件最多 20 条；发生截断时写入告警，不静默丢行。图表最多 500 点，只放在呈现元数据中，不进入模型内容。电量、设备或安全数据缺失时返回显式空结果，并以 `dataAvailable: false` 或 `totalMatched: 0` 表示，绝不以 0 代替。

## Model Experience

### NILM 工具面

#### What the model sees

模型看到六份 `nilm_*` 工具声明，参数为严格对象。结果是以 JSON 表示的 `summaryText`、`facts`、`dataQuality`、`warnings`，以及可选的 `ChartSpec v1` 图表。标识与记录均受限，单次结果控制在 20 KB 以内。

#### Token effect

每份 Schema 是固定的每请求成本。结果以确定性 JSON 追加在缓存前缀之后；序列与记录上限让单次工具结果保持在 20 KB 左右或更小。

#### KV Cache effect

插件加载期间工具清单与描述不变，形成稳定的请求前缀；结果追加在该前缀之后。加载或卸载插件会改变所有会话的工具清单并使缓存前缀失效。

## Known Limitations and Deferred Work

- `nilm_appliance_query` 只报告运行与停止时长，不报告电气空载；上游状态列没有空载取值。
- 设备电量由 `realtime_power` 在可信区间上积分得到，明确属于估算。
- 设备电费按估算电量分摊汇总电价费用，不是按每台设备各自的电价时段切片计算。
- 电能质量积分只覆盖同时具备有功与无功的区间；将功率因数外推到整个窗口前必须读取 `sampleCoverage`。
- 实时投影没有分相电流，因此在上游提供分相电流前，三相不平衡保持 `null`。
- 秒级分析单次最多 4 小时，并按每个计量点独立执行；多计量点结果按时间合并，不合并为一条波形。
