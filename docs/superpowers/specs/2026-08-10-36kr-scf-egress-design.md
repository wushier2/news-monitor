# 36Kr 腾讯云 SCF 国内出口设计

## 目标

解决 Cloudflare 数据中心出口持续被 36Kr 软风控拦截、导致日常采集和过去 24 小时补采均无法取得新数据的问题。

已验证腾讯云广州 SCF 请求 `https://www.36kr.com/newsflashes/catalog/4` 时返回 HTTP 200、112322 字节、包含 `window.__GATEWAY_SIGN__`，且未命中风控特征。因此仅将 36Kr 的上游网络请求迁到 SCF；现有页面、Cloudflare Worker、D1、来源状态、15 分钟调度和补采状态机继续保留。

## 已确认范围

- 36Kr 宏观频道的日常采集和过去 24 小时补采都使用腾讯云 SCF 国内出口。
- 界面新闻两个频道和财联社继续由 Cloudflare 直接采集。
- 36Kr 自动采集间隔继续为 15 分钟；其他来源继续为 5 分钟。
- 手动“立即刷新”仍可立即采集全部来源，其中 36Kr 通过 SCF 执行。
- 不新增 SCF 定时器，不新增 Cloudflare 数据接收接口，不迁移 D1 数据。
- 不改变页面展示、来源名称、去重规则和历史数据保留策略。

## 方案选择

### 采用：Cloudflare 按需调用 SCF

Cloudflare 继续负责调度和持久化。需要请求 36Kr 时，Cloudflare 使用带共享密钥的 HTTPS 请求调用 SCF 函数 URL；SCF 访问 36Kr、解析并规范化单页数据，再把结果同步返回 Cloudflare。

该方案可直接复用现有普通采集编排和 `BackfillPageResult` 分页契约。补采的时间窗口、页数统计、覆盖判断、错误状态和 D1 写入仍由现有 Cloudflare 代码负责。

### 未采用：SCF 定时推送

SCF 每 15 分钟自行采集并推送到 Cloudflare，需要新增入站写接口、重放保护、定时器和第二套补采任务协调机制。职责和状态分散，改动更多。

### 未采用：整体迁移到腾讯云

迁移页面、API 和 D1 会扩大故障面，也不能为当前 36Kr 出口问题带来额外收益。

## 组件边界

### SCF 36Kr 网关

项目保存一份可直接部署到腾讯云事件函数的 `index.mjs`。函数只承担以下职责：

1. 校验请求方法、共享密钥和严格 JSON 请求结构。
2. 首次请求 `www.36kr.com`，读取 `window.__GATEWAY_SIGN__`。
3. 使用 36Kr 当前公开网页采用的签名规则请求官方快讯网关。
4. 根据传入游标请求下一页。
5. 将候选项转换为现有 `NormalizedItem` 字段，并返回下一页游标与耗尽状态。

SCF 不连接 D1、不决定 24 小时时间窗口、不统计补采进度，也不自行定时运行。

### Cloudflare SCF 客户端

新增一个仅面向 36Kr 的客户端，读取两个 Cloudflare secret：

- `KR36_SCF_URL`：腾讯云函数 URL。
- `KR36_SCF_TOKEN`：Cloudflare 与 SCF 共用的高熵随机密钥。

客户端向 SCF 发送 `POST` 请求：

```json
{
  "operation": "fetchPage",
  "cursor": null
}
```

后续页的 `cursor` 是上一页返回的不透明字符串。客户端负责超时、有限重试、响应状态检查和返回结构校验，不记录密钥、36Kr nonce、游标或上游响应正文。

### 日常采集接入

`runIngestion` 和现有来源间隔策略保持不变。`fetchSource` 遇到 `36kr-macro` 时改为调用 SCF 客户端并使用第一页 `items`；其他来源保持现状。

日常采集成功后仍由现有 `upsertItems` 和 `setSourceSuccess` 写入数据及来源状态。SCF 调用失败时仍由 `setSourceFailure` 保存安全截断后的错误。

### 补采接入

36Kr 补采适配器改为把每次 `fetchPage(cursor)` 委托给 SCF 客户端，返回值继续满足现有 `BackfillPageResult`。现有补采服务继续负责：

- 固定 24 小时时间窗口。
- 串行翻页和页面间等待。
- 窗口内筛选、去重及 D1 写入。
- 最早覆盖时间、页数、抓取数、新增数和已有数统计。
- `complete`、`partial`、`failed` 状态判断。

生产路径不再回退到 Cloudflare 直接访问 36Kr。SCF 不可用时如实标记失败或部分完成，避免回退再次触发风控并产生误导状态。

## API 契约

SCF 仅接受 `POST`，请求头必须为：

```text
Authorization: Bearer <KR36_SCF_TOKEN>
Content-Type: application/json
```

成功响应：

```json
{
  "items": [
    {
      "sourceId": "36kr-macro",
      "sourceName": "36Kr",
      "channelName": "宏观",
      "title": "示例标题",
      "summary": "示例摘要",
      "url": "https://36kr.com/newsflashes/123",
      "publishedAt": "2026-08-10T00:00:00.000Z"
    }
  ],
  "nextCursor": "opaque-cursor-or-null",
  "exhausted": false
}
```

错误状态：

- `400`：请求 JSON、operation 或 cursor 格式不合法。
- `401`：缺少或错误的共享密钥。
- `405`：非 POST 请求。
- `502`：36Kr 返回风控页、无签名、签名失败或列表结构无效。
- `504`：36Kr 请求超时。

错误正文仅返回稳定、简短的错误代码和安全诊断，不返回上游页面、nonce、签名、游标或共享密钥。

## 安全与配置

- 共享密钥至少使用 32 字节随机值，不写入 Git、`wrangler.jsonc`、代码、日志或前端响应。
- 相同密钥分别配置为 SCF 环境变量 `KR36_SCF_TOKEN` 和 Cloudflare secret `KR36_SCF_TOKEN`。
- SCF 函数 URL 允许公网 HTTPS 调用，但所有业务请求必须先通过 Bearer 密钥校验。
- Cloudflare 端的 `KR36_SCF_URL` 也作为 secret 管理，避免把部署标识固化到仓库。
- SCF 响应设为 `Cache-Control: no-store`。
- 请求体限制在单页游标所需的小体积；拒绝额外字段，减少接口被滥用的空间。

## 超时与错误处理

- Cloudflare 调用 SCF 设置明确超时；网络错误和 5xx 最多进行一次短延迟重试。
- SCF 请求 36Kr 设置明确超时。风控页、无签名和签名错误属于不可恢复错误，本次调用不在 SCF 内切换多个域名或密集重试。
- SCF 首次页只使用已经实测成功的 `www.36kr.com`，不再并发探测主域、www 和移动域。
- 后续页使用首次页得到的 nonce 和网关游标；游标由 Cloudflare 补采状态机作为不透明值保存。
- 日常采集失败只影响 36Kr 来源状态，不阻断其他三个来源。
- 补采中途失败保留已写入数据，并由现有状态机标记为 `partial`；第一页失败标记为 `failed`。

## 测试与验收

自动测试不访问真实 36Kr 或真实 SCF：

- SCF 拒绝错误方法、错误 token、额外字段和非法游标。
- SCF 能从固定 HTML 样本读取 nonce，并从固定网关样本返回规范化分页结果。
- SCF 将风控页、无签名、签名错误和超时转换为安全错误。
- Cloudflare 客户端发送正确的请求头和请求体，校验响应契约，并拒绝畸形响应。
- 日常自动采集仍按 15 分钟调用一次 36Kr SCF，其他来源保持原频率。
- 手动刷新通过 SCF 强制采集 36Kr，不再由 Cloudflare 直接请求 36Kr。
- 36Kr 补采多页游标推进、24 小时边界、去重、完整/部分/失败状态继续符合现有规则。
- 测试断言生产路径没有 36Kr HTML 或网关的 Cloudflare 直连回退。

实施完成后执行完整 Vitest、TypeScript、ESLint 和生产构建。线上验收分两步：

1. 使用 SCF 函数 URL 请求第一页，确认返回宏观频道条目且无敏感字段。
2. 在页面执行一次手动刷新和一次过去 24 小时补采，确认 36Kr 有新数据、状态不再显示 Cloudflare 风控拦截，其他来源行为不变。

## 部署顺序与回滚

1. 先部署并手动验证 SCF 正式函数。
2. 在 Cloudflare 配置 `KR36_SCF_URL` 和 `KR36_SCF_TOKEN` secrets。
3. 再部署调用 SCF 的应用代码。
4. 完成线上手动刷新和补采验收后结束迁移。

若 SCF 集成异常，回滚应用代码即可恢复旧版本；D1 表结构和历史数据不发生迁移。回滚期间 36Kr 可能重新显示风控失败，但不会破坏其他来源或已保存数据。

## 非目标

- 不规避 36Kr 登录、付费或访问权限。
- 不提高 36Kr 采集频率，不并行轰炸上游，不轮换代理 IP。
- 不为其他三个来源引入 SCF。
- 不增加新的数据库表、页面模块或用户可配置采集频率。
- 不承诺第三方平台永不调整页面、签名或风控规则；结构变化必须通过安全错误明确暴露。
