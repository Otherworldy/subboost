# SubBoost v2.8.0

## 中文

### 更新重点

SubBoost v2.8.0 新增基于 mihomo 内核的订阅节点测活：开启自动测活后，保存订阅以及每次手动/定时刷新都会测活，只把延迟合格的节点输出到下游订阅，同时把每个节点的最近延迟保留在“节点管理”中供查看。

### 主要变化

- 订阅/节点源支持自动测活开关：开启后刷新时只保留延迟不超过上限的节点供下游使用，失败的节点仍保留在页面“节点管理”中，不会丢失。
- 提供三级手动测活：源卡片上的立即测活、节点管理里每个节点的单独测活、以及预览区操作栏的“全部测活”；手动测活不受自动开关限制。
- “高级编辑”弹窗可配置测活 URL、最高延迟（100–60000ms）与并发（1–100），默认 URL 为 `https://www.google.com/`、最高延迟 5000ms、并发 20；旧配置默认关闭测活。
- 节点管理列表直接展示最近一次测活结果：通过显示最快延迟，失败/不支持分别标记，并可查看测量时间。
- 生产镜像内置固定版本（v1.19.28）的官方 mihomo 内核，amd64/arm64 均可用；开发环境可用 `MIHOMO_PATH` 指定其他二进制。
- 保存订阅时立即测活，mihomo 本身启动失败不会写入或覆盖订阅；全部节点测活失败时仍保存页面结果，下游下载会提示暂无可用节点。

### 升级说明

- 无需数据库迁移；测活配置与结果随订阅的加密配置/节点一起保存。
- 自动测活默认关闭，升级不会改动现有订阅。
- 自建/非官方镜像部署时，请确保镜像内存在 `mihomo` 可执行文件（或设置 `MIHOMO_PATH`），否则开启自动测活会提示未找到内核。

## English

### Highlights

SubBoost v2.8.0 adds mihomo-kernel-based subscription node health checks. When
auto health checks are enabled, saving a subscription and every manual/scheduled
refresh re-tests nodes, only healthy nodes are published downstream, and the
latest latency for every node stays visible in Node Management.

### Main Changes

- Per-source auto health check toggle: on refresh, only nodes within the latency
  limit are published downstream; failed nodes remain in Node Management.
- Three manual health check entry points: per source, per node, and "Check All"
  in the shared action bar; manual checks ignore the auto toggle.
- The advanced source editor configures the test URL, max latency
  (100–60000 ms), and concurrency (1–100). Defaults: `https://www.google.com/`,
  5000 ms, 20; older configs keep health checks disabled.
- Node Management shows the latest result per node: fastest latency, failed, or
  unsupported, with the measurement time on hover.
- Production images bundle the official mihomo kernel at a pinned version
  (v1.19.28) for amd64/arm64; development can override it via `MIHOMO_PATH`.
- Saving runs health checks first and never persists when the kernel itself
  fails to start; if every node fails, results are still saved and downloads
  respond with a clear "no healthy nodes" message.

### Upgrade Notes

- No database migration is required; health check settings and results are
  stored with the encrypted subscription config/nodes.
- Health checks are off by default; upgrading never rewrites existing
  subscriptions.
- Custom images must include a `mihomo` binary (or set `MIHOMO_PATH`), otherwise
  enabling health checks reports a missing kernel.

---

# SubBoost v2.7.0

## 中文

### 更新重点

SubBoost v2.7.0 新增代理组监听端口和自动节点处理，并加强自部署环境的订阅导入安全、首次初始化、定时任务、更新回滚与备份可靠性。本版本也改进了多处界面交互、可访问性和订阅配置兼容性。

### 主要变化

- 代理组现在可以绑定独立的 mixed 监听端口，让接入该端口的流量固定通过指定代理组。默认只允许本机访问；允许局域网访问时，请务必使用防火墙阻止公网连接。
- 新增自动节点处理，可通过节点名称正则表达式排除不需要的节点。关闭后会恢复原有节点和相关配置，不会永久删除选择。
- 自部署管理员可以显式允许受信任的本机或局域网订阅源；默认仍会阻止本机、私有和保留地址，并继续检查重定向、响应大小和危险 URL。
- 加强首次管理员初始化、登录限流、请求大小限制和定时任务互斥，降低未授权初始化、暴力尝试和重复任务带来的风险。
- v2.7.0 会安装新的事务式更新器；从后续更新开始，它会先准备并验证回滚备份，候选版本失败时恢复旧镜像、配置和数据库。数据库备份失败时也不会再留下看似成功的不完整备份。
- 修复更新后启动定时任务可能重新创建应用容器、导致短暂连接重置的问题。
- 改进表单、弹窗、开关、密码输入、图标按钮和窄屏布局，并修复来源编辑、高级模式和代理组交互中的多处不一致。
- 加强订阅解析、规则配置、导入错误和旧配置读取兼容性，同时更新存在安全公告的运行时依赖。
- amd64 与 arm64 镜像现在使用原生构建环境，减少 QEMU 构建导致的偶发非法指令和长时间卡住。

### 升级说明

- 升级前仍建议备份 `/opt/subboost/.env` 和数据库。
- 数据库变更是增量 migration，正常升级不需要手工运行 SQL，migration 会在启动时自动执行。
- 官方 v2.6.0 一键安装即使还没有 `LOCAL_SETUP_TOKEN`，也可以通过 v2.7.0 Compose 配置完成第一跳；首次管理员初始化在令牌缺失时仍会拒绝执行。
- 从 v2.6.0 发起的这一跳仍由旧更新器执行，因此本次升级本身还没有新版的事务式回滚保护。升级前请务必单独备份 `/opt/subboost/.env` 和数据库；安装 v2.7.0 后的后续更新才使用新的保护流程。
- 完全手工维护 Docker Compose 的用户：全新初始化前必须在 `.env` 中设置高熵的 `LOCAL_SETUP_TOKEN`。已经初始化的旧实例即使暂时缺少它也能启动和正常登录，但在补齐令牌前不能再次执行首次管理员初始化。
- 自动节点处理、内网订阅源和代理组监听端口默认都不会自动开启，现有订阅、模板、规则和代理组配置不会被升级过程主动改写。
- 代理组监听端口若允许局域网访问，将成为没有账号密码的局域网代理入口；请只在可信网络使用，并确认公网防火墙未开放对应端口。

## English

### Highlights

SubBoost v2.7.0 adds per-group listener ports and automatic node processing, while strengthening subscription-import security, first-time setup, scheduled jobs, update rollback, and backup reliability for self-hosted installations. It also improves interface consistency, accessibility, and subscription configuration compatibility.

### Main Changes

- Proxy groups can now bind a dedicated mixed listener port, routing traffic received on that port through the selected group. Listeners are local-only by default; if LAN access is enabled, use a firewall to prevent public Internet access.
- Added automatic node processing with regular expressions that exclude unwanted node names. Disabling the feature restores the original nodes and related configuration instead of permanently deleting selections.
- Self-hosted administrators can explicitly allow trusted local or LAN subscription sources. Local, private, and reserved addresses remain blocked by default, with redirect, response-size, and unsafe-URL checks still enforced.
- Strengthened first-administrator setup, login throttling, request-size limits, and scheduled-job locking to reduce unauthorized setup, brute-force attempts, and overlapping jobs.
- v2.7.0 installs a new transactional updater. Starting with subsequent updates, it prepares and verifies a rollback backup before activation, then restores the previous image, configuration, and database if the candidate fails. Failed database exports are no longer left behind as apparently successful backups.
- Fixed a case where starting scheduled jobs after an update could recreate the application container and briefly reset connections.
- Improved forms, dialogs, switches, password fields, icon buttons, and narrow-screen layouts, while fixing inconsistencies in source editing, advanced mode, and proxy-group interactions.
- Improved subscription parsing, rule configuration, import errors, and compatibility with older saved configurations, and updated runtime dependencies affected by security advisories.
- amd64 and arm64 images now use native build environments, reducing intermittent illegal-instruction failures and long stalls associated with QEMU builds.

### Upgrade Notes

- Back up `/opt/subboost/.env` and the database before upgrading.
- Database changes use additive migrations. Normal upgrades do not require manually running SQL, and migrations run automatically during startup.
- An official v2.6.0 one-click installation without `LOCAL_SETUP_TOKEN` can pass the v2.7.0 Compose configuration and complete the first hop. First-administrator setup still fails closed while the token is absent.
- The v2.6.0-to-v2.7.0 hop still runs through the old updater, so that upgrade itself does not yet have the new transactional rollback protection. Back up `/opt/subboost/.env` and the database separately before upgrading. Subsequent updates after v2.7.0 is installed use the new protected flow.
- For manually maintained Docker Compose deployments, set a high-entropy `LOCAL_SETUP_TOKEN` in `.env` before a fresh setup. An already-initialized legacy instance can still boot and use normal login without it, but first-administrator setup remains unavailable until the token is configured.
- Automatic node processing, local-network subscription sources, and per-group listener ports remain disabled until explicitly enabled. Existing subscriptions, templates, rules, and proxy-group settings are not automatically rewritten during the upgrade.
- Enabling LAN access for a proxy-group listener creates a LAN proxy port without a username or password. Use it only on a trusted network and make sure the corresponding port is not exposed through the public firewall.
