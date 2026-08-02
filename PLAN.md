# 订阅节点测活功能计划

## Context

当前订阅刷新只负责重新拉取和匹配节点，无法验证节点是否可用。目标是在订阅/节点源维度可选地使用 mihomo 测活：刷新后保留全部节点供“节点管理”查看，但下游生成订阅时只输出测活成功且未超过延迟上限的节点，并在节点列表展示最近一次延迟结果。

已确认现有数据边界：源配置保存在 `encryptedConfig`，节点及其 `_sourceIds` 保存在 `encryptedNodes`，详情 API 会把两者恢复到编辑器；因此配置和结果均可沿用现有加密 JSON，不需要数据库迁移。手动刷新与 cron 刷新最终都经过 `refreshNodeSnapshot` 和 `prepareRefreshCacheResult`，即时下载也统一调用 `buildGenerateOptionsFromConfig`。

## Approach

- 沿用现有订阅源配置、刷新快照和生成链路，不新增独立任务系统。
- 为每个可刷新源保存“自动测活开关 + 可选高级覆盖”，旧配置默认关闭；所有 `url`、`yaml`、`nodes` 源都支持，`proxy-providers` 模式因节点不进入 SubBoost 而禁用。默认 URL 为 `https://www.google.com/`（UI 接受并规范化用户给出的 `www.google.com`），最高延迟 `5000ms`，并发 `20`。
- 在本地服务中提供单一 mihomo 适配层：为一次测活生成最小临时配置，复用现有 `sanitizeMihomoProxyNode`，启动仅监听 Unix socket 的 mihomo 子进程，通过 `/proxies/{name}/delay` 批量测试，结束后关闭进程并清理临时目录。Unix socket 避免端口竞争和控制 API 暴露；同一服务进程内的测活任务串行排队，单个任务内部按设置并发。
- 测活结果按 `sourceId` 附着在节点内部元数据中，记录 `status`、`delayMs`、`checkedAt`；同一节点多来源时，任一未启用自动测活的来源或任一成功来源均可使节点对下游可见。`direct`、`dns`、`relay` 及 mihomo 不支持的节点记录为“不支持”。
- 自动测活在开启后保存订阅时立即运行，并在以后每次手动刷新和 cron 刷新时运行。创建时若 mihomo 系统性失败则不创建记录，更新时失败则不修改旧记录；成功保存响应复用订阅详情序列化并带回含测活元数据的节点，使当前编辑页面无需二次拉取即可展示结果。手动测活不受自动开关限制：源按钮测该源，节点按钮测该节点所属的全部源，整体按钮测当前配置全部源。
- 未测状态不判为失败：未保存草稿刚开启开关时仍可预览当前节点；保存时立即测活后，持久化订阅不会留下未测节点。mihomo 启动、配置装载或控制 API 整体失败时，将自动刷新视为失败并保留旧快照；单节点失败属于正常结果，随全部节点一起持久化。全部节点失败时仍保存结果供页面查看，下游返回“暂无可用节点”，不回退输出已失败节点。
- 刷新缓存结果区分“原始快照节点数”和“生成侧健康节点数”：只要源刷新和原始快照有效，即可成功持久化全部测活结果；健康节点为零不再走现有 `empty_result` 拒绝保存分支。浏览器预览显示空状态，订阅下载返回无可用节点响应。
- 生成下游配置时，在共享的 `buildGenerateOptionsFromConfig` 入口先按源的测活状态过滤，再应用现有名称过滤，并显式剥离测活、来源和原名等内部字段，避免泄漏到 YAML。
- UI 在每个源行提供自动测活开关和手动测活图标按钮，在高级编辑弹窗提供 URL、最高延迟、并发设置；节点管理工具栏提供“全部测活”，每个节点提供单独图标按钮，并展示最快成功延迟、失败、未测或不支持状态及测量时间。

## Files to modify

- `packages/core/src/subscription/node-health.ts`（新增）：测活默认值与设置归一化、结果读写、汇总展示、下游可见性判定和内部字段剥离。
- `packages/core/src/subscription/config-utils.ts`、`packages/ui/src/store/config-store/generated-yaml.ts`：让服务端下游和浏览器预览使用同一测活过滤/清理规则。
- `packages/server-core/src/subscription/saved-sources.ts`：保存并归一化每个源的 `healthCheck` 设置。
- `packages/server-core/src/subscription/refresh-node-snapshot.ts`、`refresh-cache-result.ts`、`manual-refresh-response.ts`：在源节点合并后调用测活回调，拆分原始/健康节点计数，并允许“保存全部失败结果但生成侧无可用节点”。
- `local/src/lib/mihomo-health-check.ts`（新增）：mihomo 子进程、Unix socket API、并发、队列与临时目录生命周期。
- `local/src/lib/subscription-service.ts`、`auto-update-service.ts`：接入保存时、手动刷新和 cron 自动测活；保存响应返回详情节点，下载时严格过滤。
- `local/src/lib/mihomo-health-check.ts` 默认从 `MIHOMO_PATH` 或系统 PATH 寻找内核，方便源码开发和非 Docker 调试。
- `local/app/api/node-health/route.ts`（新增）：受管理员认证的按范围即时测活接口。
- `packages/ui/src/product/api-adapter.tsx`、`local/app/page.tsx`：定义并接入测活 API。
- `packages/ui/src/store/config-store/definitions.ts`、`actions/health-actions.ts`（新增）、`config-store.ts`：保存源字段、调用测活并把结果合并回当前节点。
- `packages/ui/src/product/converter/quick-mode/sources-section.tsx`、`advanced-mode/sections/input-section.tsx`：源开关和源级按钮。
- `packages/ui/src/product/converter/source-editor-dialog.tsx`：高级测活设置及边界校验。
- `packages/ui/src/product/home/use-subscription-link.tsx`、`use-editing-subscription-loader.ts`：保存/恢复设置，并接收保存时的立即测活结果。
- `packages/ui/src/product/home/use-home-actions.ts`、`home-surface.tsx`、`home-layout.tsx`：在快速/高级共用配置操作栏接入“整体测活”按钮和状态。
- `packages/ui/src/product/converter/advanced-mode/sections/node-management-section.tsx`、`node-management/node-list.tsx`：整体、单节点按钮与结果展示。
- `local/Dockerfile`：从固定版本 `metacubex/mihomo:v1.19.28` 的官方多架构镜像复制 `/mihomo`，保留现有 `linux/amd64`、`linux/arm64` 发布矩阵。
- `docs/THIRD_PARTY_NOTICES.md`、`README-CN.md`、`README.md`：声明 mihomo 版本/许可、`MIHOMO_PATH` 与测活部署诊断。
- 对应现有测试文件，以及新增 mihomo 适配层和 API 测试。

## Reuse

- `packages/server-core/src/subscription/refresh-node-snapshot.ts`：复用手动刷新与 cron 刷新的共享快照入口。
- `packages/core/src/subscription/source-node-refresh.ts`：复用按源更新节点且保留 `_` 扩展字段的合并逻辑。
- `packages/core/src/subscription/node-source-state.ts`：复用节点与一个或多个来源的 `_sourceIds` 关联。
- `packages/core/src/mihomo/proxy-sanitizer.ts`：复用现有 mihomo 节点支持判定与清理，运行器只负责覆盖为不含用户数据的唯一临时名称。
- `packages/core/src/subscription/config-utils.ts`：复用所有下游生成共同经过的入口。
- `packages/ui/src/product/converter/source-editor-dialog.tsx`：扩展快速/高级模式共用的“高级编辑”弹窗。
- `packages/ui/src/components/ui/switch-field.tsx`、`Input`、`Badge`：复用现有控件。
- `local/src/lib/subscription-service.ts`：复用手动与自动刷新共用的 callback 注入模式。

## Steps

- [x] 明确 mihomo 运行方式、配置默认值和结果语义。
- [x] 定义源级 `healthCheck` 配置和节点内部结果格式；设置 URL 仅允许 HTTP(S)，最高延迟限制为 `100–60000ms`，并发限制为 `1–100`，旧配置默认关闭。
- [x] 扩展源配置的服务端归一化、编辑器类型、保存和恢复逻辑；`proxy-providers` 模式清除/禁用自动测活。
- [x] 实现最小 mihomo 运行器：复用节点 sanitizer、最小 JSON 配置、Unix socket readiness/延迟 API、单任务并发池、进程级串行队列、超时、终止和临时目录清理。
- [x] 实现共享测活结果逻辑：按来源写入结果、保留其他来源结果、汇总最快延迟、标记失败/不支持，并在节点内容变化时移除过期结果。
- [x] 将自动测活接入订阅创建/更新、手动刷新和 cron 刷新；创建/更新采用“测活成功后再持久化”，系统性内核失败不写入，单节点及全节点失败正常持久化并把详情节点带回 UI。
- [x] 修改刷新缓存语义、共享生成入口和浏览器预览：原始快照有效即可保存，只有通过自动测活的节点可生成，所有内部元数据必须剥离，健康节点为零时预览为空且下载返回明确响应。
- [x] 新增认证测活 API 和 config-store action，支持 `all`、`source`、`node` 三种范围并防止过期响应覆盖已变化节点。
- [x] 在快速/高级源列表增加自动开关与源级按钮，在高级弹窗增加 URL、最高延迟和并发控件。
- [x] 在共用配置操作栏增加整体测活按钮，在高级节点管理列表增加单节点按钮及结果展示；包含加载禁用态、结果摘要 toast 和移动端布局。
- [x] 将固定版本的官方 mihomo 二进制加入多架构生产镜像，支持 `MIHOMO_PATH` 开发覆盖，并更新第三方许可、部署说明、版本信息和故障诊断。
- [x] 补充聚焦测试与端到端验证。

## Verification

- 单元测试：配置默认值/边界/旧数据兼容、未测节点暂时可见、结果按来源合并、共享节点判定、节点内容变化使结果失效、延迟上限、内部字段剥离和零健康节点。
- 运行器测试：注入 mock spawn 与 Unix socket HTTP，覆盖 readiness、临时唯一节点名、URL 编码、逐源并发上限、单节点超时/错误、不支持协议、启动/异常退出、强制终止和临时目录清理。
- 服务/API 测试：覆盖创建/更新时先测后写、保存响应回传节点、手动/cron 刷新、三种即时范围、认证、请求大小/节点数校验、系统失败保留旧快照及全部失败仍保存结果。
- UI 测试：所有源类型的开关与按钮、`proxy-providers` 禁用、高级设置默认值与校验、整体按钮在快速/高级模式均可用、按钮 loading、防过期回写、节点状态及摘要提示。
- 集成验证：用含可用、超时、协议不支持节点的 URL/YAML/节点链接源，分别执行保存、源级、节点级、整体、手动刷新和 cron 刷新，确认页面保留全部节点而预览/下游只包含合格节点。
- 部署验证：分别构建 `linux/amd64`、`linux/arm64` 镜像，运行 `mihomo -v`，执行真实测活，检查非 root 权限、Unix socket、进程退出和临时文件清理。
- 运行 `npm run test:unit`、`npm run lint`、`npm run check:local-app`，并用桌面/移动端截图检查源列表、节点列表和高级弹窗无溢出重叠。
