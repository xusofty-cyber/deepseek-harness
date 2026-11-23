-- Project-owned NILM system database. Never points at the upstream business DB.
-- Table definitions follow docs/nilm-ai-agent-high-level-design.md section 2.
-- Support tables add only the documented technical columns `id` and `created_at`.

CREATE TABLE `nilm_tenant_config` (
  `tenant_id` VARCHAR(64) NOT NULL COMMENT '调用方签名上下文中的租户标识',
  `tenant_name` VARCHAR(128) NOT NULL COMMENT '工厂企业名称',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '0=停用, 1=正常',
  `time_zone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  `work_calendar_type` VARCHAR(32) NOT NULL DEFAULT 'standard_industrial',
  `work_hours_json` JSON NOT NULL COMMENT '工作时段，如 {"ranges":[["08:00","12:00"],["13:00","17:00"]]}',
  `non_work_baseline_kw` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '非工作时段基载阈值(kW)',
  `non_work_alert_minutes` INT NOT NULL DEFAULT 10 COMMENT '用能类告警持续判定分钟数；Critical 安全告警不受此值限制',
  `tariff_plan_id` VARCHAR(64) DEFAULT NULL COMMENT '当前生效电价方案',
  `calendar_id` VARCHAR(64) DEFAULT NULL COMMENT '工作日历',
  `pf_policy_id` VARCHAR(64) DEFAULT NULL COMMENT '功率因数考核政策',
  `notification_policy_json` JSON DEFAULT NULL COMMENT '渠道、免打扰、级别下限；不含联系人明文',
  `config_version` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '缓存失效版本',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='租户运行策略与基线配置';

CREATE TABLE `nilm_asset_snapshot` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `level` ENUM('factory', 'workshop', 'terminal', 'channel', 'appliance') NOT NULL,
  `node_id` VARCHAR(64) NOT NULL COMMENT '上游节点ID',
  `parent_id` VARCHAR(64) DEFAULT NULL,
  `node_name` VARCHAR(128) NOT NULL,
  `path_name` VARCHAR(512) NOT NULL COMMENT '完整路径，用于名称匹配与展示',
  `path_ids_json` JSON DEFAULT NULL COMMENT '从根到当前节点的ID链',
  `rated_power_kw` DECIMAL(10, 2) DEFAULT NULL COMMENT '额定功率/变压器容量',
  `channel_type` VARCHAR(32) DEFAULT NULL COMMENT 'main=总进线, sub=分路',
  `appliance_category_id` INT DEFAULT NULL COMMENT 'NILM 设备品类',
  `is_active` TINYINT NOT NULL DEFAULT 1,
  `source_contract_version` VARCHAR(32) NOT NULL DEFAULT 'v0' COMMENT '上游适配契约版本',
  `source_updated_at` DATETIME DEFAULT NULL COMMENT '上游记录更新时间',
  `synced_at` DATETIME NOT NULL COMMENT '同步时间；超过阈值视为 stale',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_level_node` (`tenant_id`, `level`, `node_id`),
  KEY `idx_tenant_parent` (`tenant_id`, `parent_id`),
  KEY `idx_tenant_name` (`tenant_id`, `node_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='五级资产拓扑投影';

CREATE TABLE `nilm_source_tenant_map` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_id` VARCHAR(64) NOT NULL COMMENT '上游数据源标识，如 upstream_unsafe',
  `source_tenant_id` VARCHAR(128) NOT NULL COMMENT '上游租户键',
  `tenant_id` VARCHAR(64) NOT NULL COMMENT '本项目租户边界',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_source_tenant` (`source_id`, `source_tenant_id`),
  KEY `idx_source_tenant_target` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='上游租户到本项目租户的唯一映射；缺失时 Sentinel 拒绝处理上游记录';

CREATE TABLE `nilm_measurement_binding` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `terminal_id` VARCHAR(64) NOT NULL,
  `channel_id` VARCHAR(64) NOT NULL,
  `role` ENUM('terminal_total', 'branch', 'appliance', 'reference') NOT NULL,
  `parent_channel_id` VARCHAR(64) DEFAULT NULL,
  `effective_from` DATETIME NOT NULL,
  `effective_to` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_meter_effective` (`tenant_id`, `terminal_id`, `channel_id`, `effective_from`),
  KEY `idx_tenant_parent` (`tenant_id`, `parent_channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='计量角色与父子关系';

CREATE TABLE `nilm_conversation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` VARCHAR(64) NOT NULL COMMENT '服务端签发的不透明ID',
  `tenant_id` VARCHAR(64) NOT NULL,
  `user_ref` VARCHAR(64) NOT NULL COMMENT '调用方用户引用，仅用于审计、限流与通知定位',
  `session_id` VARCHAR(128) NOT NULL COMMENT 'dsh Session ID',
  `shard_id` VARCHAR(32) NOT NULL COMMENT '会话所属 agent 分片',
  `title` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '可由调用方命名；不使用模型生成',
  `last_active_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active/archived/closed',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_user_conv` (`tenant_id`, `user_ref`, `conversation_id`),
  UNIQUE KEY `uk_session_id` (`session_id`),
  KEY `idx_tenant_user_active` (`tenant_id`, `user_ref`, `last_active_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI会话索引；查找必须带 tenant_id + user_ref';

CREATE TABLE `nilm_turn_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `turn_id` VARCHAR(64) NOT NULL,
  `conversation_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `user_ref` VARCHAR(64) NOT NULL,
  `client_message_id` VARCHAR(64) NOT NULL COMMENT '客户端消息幂等ID',
  `user_query_ciphertext` VARBINARY(4096) DEFAULT NULL COMMENT 'AES-GCM 密文；不存用户提问明文',
  `user_query_digest` CHAR(64) DEFAULT NULL COMMENT 'SHA-256 摘要，用于幂等与审计',
  `model_name` VARCHAR(64) DEFAULT NULL,
  `total_tokens` INT UNSIGNED NOT NULL DEFAULT 0,
  `tools_called_json` JSON DEFAULT NULL COMMENT 'Tool 名称、参数摘要、耗时；不含 SQL',
  `latency_ms` INT UNSIGNED NOT NULL DEFAULT 0,
  `data_quality_json` JSON DEFAULT NULL,
  `error_code` VARCHAR(64) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_turn_id` (`turn_id`),
  UNIQUE KEY `uk_client_msg` (`tenant_id`, `user_ref`, `client_message_id`),
  KEY `idx_conv_user_time` (`tenant_id`, `user_ref`, `conversation_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话轮次审计';

CREATE TABLE `nilm_security_audit` (
  `audit_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `user_ref` VARCHAR(64) DEFAULT NULL,
  `session_id` VARCHAR(128) DEFAULT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `tool` VARCHAR(64) DEFAULT NULL,
  `query_template` VARCHAR(255) DEFAULT NULL,
  `scope` VARCHAR(512) DEFAULT NULL,
  `time_range` VARCHAR(128) DEFAULT NULL,
  `row_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `latency_ms` INT UNSIGNED NOT NULL DEFAULT 0,
  `result_hash` CHAR(64) DEFAULT NULL,
  `error_code` VARCHAR(64) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`audit_id`),
  KEY `idx_tenant_time` (`tenant_id`, `created_at`),
  KEY `idx_tenant_event` (`tenant_id`, `event_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Tool/SQL/越权/通知审计；保留至少一年';

CREATE TABLE `nilm_alert_rule` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `rule_id` VARCHAR(64) NOT NULL COMMENT '如 R-01a/R-01b/R-02/R-03/R-06',
  `rule_type` VARCHAR(32) NOT NULL,
  `scope_level` ENUM('factory', 'workshop', 'terminal', 'channel', 'appliance') NOT NULL,
  `scope_id` VARCHAR(64) NOT NULL,
  `threshold_json` JSON NOT NULL,
  `severity` ENUM('info', 'warning', 'critical') NOT NULL DEFAULT 'warning',
  `silent_minutes` INT NOT NULL DEFAULT 30,
  `notify_channels_json` JSON NOT NULL COMMENT 'wx_subscribe/wx_template/wecom_webhook/sms',
  `is_enabled` TINYINT NOT NULL DEFAULT 1,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_rule` (`tenant_id`, `rule_id`),
  KEY `idx_tenant_type` (`tenant_id`, `rule_type`, `is_enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='主动巡检规则配置';

CREATE TABLE `nilm_alert_event` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `rule_id` VARCHAR(64) NOT NULL,
  `source_type` ENUM('sentinel_rule', 'upstream_unsafe', 'scheduler_check') NOT NULL,
  `scope_level` ENUM('factory', 'workshop', 'terminal', 'channel', 'appliance') NOT NULL,
  `scope_id` VARCHAR(64) NOT NULL,
  `scope_name` VARCHAR(128) NOT NULL,
  `severity` ENUM('info', 'warning', 'critical') NOT NULL,
  `metric_name` VARCHAR(64) NOT NULL,
  `metric_value` DECIMAL(12, 4) NOT NULL,
  `threshold_value` DECIMAL(12, 4) DEFAULT NULL,
  `unit` VARCHAR(16) NOT NULL,
  `bucket_start` DATETIME NOT NULL COMMENT '去重时间桶起点',
  `silence_key` VARCHAR(191) NOT NULL COMMENT 'tenant_id+rule_id+scope_id+metric，跨窗口抑制键',
  `dedupe_key` VARCHAR(191) NOT NULL COMMENT 'tenant_id+rule_id+scope_id+metric+bucket_start',
  `raw_event_time` DATETIME NOT NULL COMMENT '上游事件或采样时间',
  `detected_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `summary_text` VARCHAR(1024) NOT NULL COMMENT '确定性模板摘要',
  `agent_diagnosis` TEXT DEFAULT NULL COMMENT '异步增强诊断；不决定告警级别与投递',
  `agent_model` VARCHAR(64) DEFAULT NULL,
  `agent_prompt_version` VARCHAR(32) DEFAULT NULL,
  `agent_generated_at` DATETIME DEFAULT NULL,
  `status` ENUM('detected', 'confirmed', 'notified', 'acknowledged', 'resolved', 'suppressed', 'false_positive') NOT NULL DEFAULT 'detected',
  `escalated_from` VARCHAR(64) DEFAULT NULL COMMENT '升级来源事件ID',
  `acknowledged_at` DATETIME DEFAULT NULL,
  `acknowledged_by` VARCHAR(64) DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_event_id` (`event_id`),
  UNIQUE KEY `uk_tenant_dedupe` (`tenant_id`, `dedupe_key`),
  KEY `idx_tenant_silence_bucket` (`tenant_id`, `silence_key`, `bucket_start`),
  KEY `idx_tenant_status` (`tenant_id`, `status`, `created_at`),
  KEY `idx_tenant_rule_bucket` (`tenant_id`, `rule_id`, `bucket_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='告警事件';

CREATE TABLE `nilm_alert_transition` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` VARCHAR(64) NOT NULL,
  `from_status` VARCHAR(32) DEFAULT NULL,
  `to_status` VARCHAR(32) NOT NULL,
  `operator_type` VARCHAR(32) NOT NULL,
  `operator_ref` VARCHAR(64) DEFAULT NULL,
  `reason` VARCHAR(512) DEFAULT NULL,
  `channel` VARCHAR(32) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_event_time` (`event_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='告警状态流转审计';

CREATE TABLE `nilm_notification_outbox` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `notification_id` VARCHAR(64) NOT NULL COMMENT '对外通知ID，客户端按此去重',
  `tenant_id` VARCHAR(64) NOT NULL,
  `user_ref` VARCHAR(64) DEFAULT NULL COMMENT '接收主体引用；实际渠道标识见 recipient_ciphertext',
  `event_id` VARCHAR(64) DEFAULT NULL,
  `report_id` VARCHAR(64) DEFAULT NULL,
  `channel` ENUM('wx_subscribe', 'wx_template', 'wecom_webhook', 'sms') NOT NULL,
  `template_id` VARCHAR(128) DEFAULT NULL,
  `recipient_ciphertext` VARBINARY(1024) DEFAULT NULL COMMENT 'openid/手机号/webhook 的加密值',
  `recipient_masked` VARCHAR(64) DEFAULT NULL COMMENT '仅用于排障展示，不可反推',
  `payload_json` JSON NOT NULL COMMENT '模板参数；不含密钥与完整个人信息',
  `dedupe_key` VARCHAR(191) NOT NULL,
  `status` ENUM('pending', 'sending', 'sent', 'failed', 'dead') NOT NULL DEFAULT 'pending',
  `attempt_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
  `next_retry_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `claimed_by` VARCHAR(64) DEFAULT NULL COMMENT 'worker 标识',
  `lease_expires_at` DATETIME DEFAULT NULL COMMENT '领取租约到期时间',
  `provider_message_id` VARCHAR(128) DEFAULT NULL,
  `last_error` VARCHAR(512) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sent_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_notification_user_channel` (`tenant_id`, `notification_id`, `user_ref`, `channel`),
  UNIQUE KEY `uk_tenant_dedupe_user_channel` (`tenant_id`, `dedupe_key`, `user_ref`, `channel`),
  KEY `idx_claim` (`status`, `next_retry_at`, `lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知 Outbox';

CREATE TABLE `nilm_notification_record` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `notification_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `user_ref` VARCHAR(64) DEFAULT NULL COMMENT '接收主体引用',
  `channel` ENUM('wx_subscribe', 'wx_template', 'wecom_webhook', 'sms') NOT NULL,
  `recipient_masked` VARCHAR(64) DEFAULT NULL,
  `event_id` VARCHAR(64) DEFAULT NULL,
  `status` ENUM('pending', 'sending', 'sent', 'failed', 'dead') NOT NULL,
  `provider_message_id` VARCHAR(128) DEFAULT NULL,
  `error_code` VARCHAR(64) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_notification_user_channel` (`tenant_id`, `notification_id`, `user_ref`, `channel`),
  KEY `idx_tenant_time` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='渠道投递审计；保留至少180天';

CREATE TABLE `nilm_sentinel_watermark` (
  `source_name` VARCHAR(64) NOT NULL COMMENT '增量事件源名称，如 upstream_unsafe',
  `record_time` DATETIME NOT NULL COMMENT '已处理记录的事件时间',
  `record_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '同一事件时间内的稳定排序ID；二进制排序，水位单调比较按字节序',
  `scan_offset` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '水位线之后已检查的无效时间行数（毒记录前缀），重启续扫用',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`source_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Sentinel 增量扫描水位线';

CREATE TABLE `nilm_job_run` (
  `job_run_id` VARCHAR(64) NOT NULL,
  `job_type` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `scheduled_at` DATETIME NOT NULL,
  `started_at` DATETIME DEFAULT NULL,
  `finished_at` DATETIME DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `idempotency_key` VARCHAR(191) NOT NULL,
  `attempt` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_code` VARCHAR(64) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`job_run_id`),
  UNIQUE KEY `uk_job_idempotency` (`job_type`, `idempotency_key`),
  KEY `idx_tenant_schedule` (`tenant_id`, `scheduled_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定时任务执行与幂等';

CREATE TABLE `nilm_report` (
  `report_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `report_type` VARCHAR(32) NOT NULL,
  `report_date` DATE NOT NULL,
  `payload_json` JSON NOT NULL,
  `chart_json` JSON DEFAULT NULL,
  `summary_text` VARCHAR(2048) DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `generated_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`report_id`),
  UNIQUE KEY `uk_tenant_report_date` (`tenant_id`, `report_type`, `report_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='晨报/力调预测结构化结果';

CREATE TABLE `nilm_tariff_plan` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE DEFAULT NULL,
  `region` VARCHAR(64) DEFAULT NULL,
  `voltage_level` VARCHAR(32) DEFAULT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_plan` (`tenant_id`, `plan_id`),
  KEY `idx_tenant_effective` (`tenant_id`, `effective_from`, `effective_to`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='电价方案';

CREATE TABLE `nilm_tariff_period` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `plan_id` VARCHAR(64) NOT NULL,
  `season` VARCHAR(16) NOT NULL,
  `day_type` VARCHAR(16) NOT NULL,
  `period_type` ENUM('sharp', 'peak', 'flat', 'valley') NOT NULL COMMENT '尖/峰/平/谷',
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL,
  `price` DECIMAL(10, 4) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_plan_period` (`tenant_id`, `plan_id`, `season`, `day_type`, `period_type`, `start_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='分时电价时段';

CREATE TABLE `nilm_calendar_day` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `date` DATE NOT NULL,
  `day_type` VARCHAR(16) NOT NULL,
  `season` VARCHAR(16) NOT NULL DEFAULT 'all-year' COMMENT '用于选择分时电价季节时段',
  `shift_json` JSON DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_date` (`tenant_id`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作日、节假日与班次';

CREATE TABLE `nilm_pf_policy` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` VARCHAR(64) NOT NULL,
  `effective_from` DATE NOT NULL,
  `threshold` DECIMAL(5, 4) NOT NULL DEFAULT 0.9000,
  `reward_rule_json` JSON DEFAULT NULL,
  `penalty_rule_json` JSON DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenant_effective` (`tenant_id`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='功率因数考核线与力调规则';
