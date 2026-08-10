# 36Kr 腾讯云 SCF 部署配置

本项目只把 36Kr 的上游请求放到腾讯云广州 SCF。Cloudflare 继续负责调度、D1 入库、来源状态和过去 24 小时补采进度。

## 1. 部署 SCF 正式代码

进入腾讯云 `kr36-probe` 函数，保留以下配置：

- 地域：广州
- 类型：事件函数
- 运行环境：控制台提供的最新 Node.js
- 文件名：`index.mjs`
- 执行方法：`index.main_handler`
- 内存：128 MB
- 执行超时：20 秒
- 网络：允许公网访问
- 固定公网出口 IP：暂不启用
- 定时触发器：不创建

把仓库中的 `scf/kr36/index.mjs` 完整复制到腾讯云的 `index.mjs`，点击“部署”。`index.d.mts` 只用于本地类型检查，不需要上传。

## 2. 生成共享密钥

在本机 PowerShell 运行：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

复制返回值，但不要把它发到聊天、截图、日志、GitHub Issue 或提交记录中。

进入腾讯云函数的“函数配置”，新增环境变量：

```text
KR36_SCF_TOKEN=<刚才生成的密钥>
```

保存配置并重新部署函数。

## 3. 创建函数 URL

在腾讯云函数左侧进入“函数 URL”，新建 URL：

- 访问范围：公网
- CORS：关闭；调用方只有 Cloudflare，不需要浏览器跨域
- 绑定版本：当前正式版本或 `$LATEST`

保存生成的 HTTPS URL。函数 URL 虽然可以从公网访问，但没有正确 Bearer 密钥时只会返回 HTTP 401。

## 4. 验证 SCF 正式接口

在 PowerShell 临时设置两个当前窗口变量：

```powershell
$env:KR36_SCF_URL = "<腾讯云函数 URL>"
$env:KR36_TOKEN = "<共享密钥>"
$headers = @{ Authorization = "Bearer $env:KR36_TOKEN" }
$body = @{ operation = "fetchPage"; cursor = $null } | ConvertTo-Json
Invoke-RestMethod -Uri $env:KR36_SCF_URL -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

正确结果应包含：

- `items`：最多 20 条 `36kr-macro` 信息
- `nextCursor`：非空字符串
- `exhausted`：`false`

不要把 `nextCursor`、共享密钥或完整响应放入公开日志和截图。

## 5. 配置 Cloudflare secrets

进入 Cloudflare 控制台中 GitHub 自动部署所对应的 `news-monitor` Worker：

1. 打开“设置”。
2. 进入“变量和机密”。
3. 新增加密机密 `KR36_SCF_URL`，值为腾讯云函数 URL。
4. 新增加密机密 `KR36_SCF_TOKEN`，值为同一个共享密钥。
5. 保存后重新部署最新 GitHub `main` 分支。

不要把这两个实际值写入 `wrangler.jsonc`、源码、`.env`、`.dev.vars` 或文档。

## 6. 线上验收

部署应用后按顺序验证：

1. 点击“立即刷新”。
2. 确认 36Kr 来源状态恢复正常并出现新信息。
3. 点击“补采过去24小时”。
4. 确认 36Kr 页数和覆盖时间持续推进，不再显示 Cloudflare 风控拦截。
5. 确认界面新闻两个频道和财联社保持原有状态。

如果页面提示“36Kr SCF 配置缺失”，检查 Cloudflare 两个 secret 的名称是否完全一致。如果返回 HTTP 401，检查腾讯云与 Cloudflare 的密钥是否相同。如果返回 `KR36_RISK_PAGE`，先停止重复请求并保留安全诊断信息，再测试腾讯云其他国内地域。
