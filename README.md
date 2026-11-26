# RedisPal

RedisPal 是一款使用 Go、Wails 3.1 和 Vue 3 开发的 Redis 桌面客户端。通过连接侧栏、键树和多标签工作区管理 Redis 连接与数据，连接与命令由 Go 后端处理。

## Windows 构建

需要 Go 1.27 或更新版、Node.js 22.12 或更新版，以及 Microsoft Edge WebView2 Runtime。从本目录运行以下命令。

```powershell
.\build.ps1
.\bin\RedisPal.exe
```

构建脚本通过锁文件安装 Vue 依赖，将 Vite 产物嵌入 EXE。首次启动时可新建连接，也可从 JSON 文件导入已有连接配置。应用升级后可继续使用已保存的连接与界面设置。导出的连接配置为 JSON 格式，包含已保存的密码。

安装 NSIS 后，使用 `.\build.ps1 -Installer` 同时生成免安装版 `bin/RedisPal.exe` 和安装包 `bin/RedisPal-windows-x64-setup.exe`。安装版默认写入 `%LOCALAPPDATA%\Programs\RedisPal`，提供开始菜单快捷方式和 Windows 卸载入口。已有安装可在原目录覆盖升级，连接和设置保存在用户配置目录。[NSIS 下载页](https://nsis.sourceforge.io/Download)

修改 `frontend/public/logo.png` 后，可用 Wails CLI 重新生成安装包和可执行文件的图标资源。[Wails 图标与打包文档](https://v3.wails.io/concepts/build-system/#icons-and-packaging)

```powershell
wails3 generate icons -input frontend/public/logo.png -windowsfilename build/windows/RedisPal.ico -macfilename=
foreach ($arch in 'amd64', 'arm64') {
    wails3 generate syso -arch $arch -icon build/windows/RedisPal.ico -manifest build/windows/RedisPal.manifest -out "redispal_windows_$arch.syso"
}
```

## 功能

- 单机、Cluster、Sentinel、ACL、SSH 和 TLS 连接，支持分组、克隆、连通性测试和只读模式。可将已有连接拖到左侧分组标题。SSH 使用系统或指定的 `known_hosts` 文件验证主机密钥。
- 数据库切换和命名、键的精确及通配符搜索、树形及平铺视图、分页、批量删除、导入导出。键列表默认每批加载 10,000 个键，可停止并继续加载，树形目录显示已加载的后代键数。键备份可导出为 JSON，也可从 JSON 或兼容的 CSV 备份文件导入。支持将键复制到同一连接的其他数据库，或通过备份迁移到其他连接。
- String、Hash、List、Set、ZSet、Stream、RedisJSON、TimeSeries、Vector Set 和 Array 的可视化编辑。扩展类型及 Hash 字段 TTL 需要 Redis 服务器支持对应命令。
- Redis CLI 支持历史、补全和命令文件。工作区侧栏可打开 Pub/Sub、Redis Search、实时监控、慢日志和内存分析。Pub/Sub 支持普通、模式和分片订阅。内存分析分批显示已扫描批次、匹配键数和已测量键数。
- Redis Search 支持浏览和创建索引、字段补全、查询收藏、Explain 和 Profile，需要 Redis 服务端提供 `FT.*`。Stream 详情支持实时刷新、消费组和待处理消息管理。
- 实时监控支持筛选和导出，Cluster 连接观察一个主节点。慢日志支持自动刷新以及按主节点读取和修改阈值与日志长度，依赖服务端 ACL 权限。
- Text、JSON、Hex、Binary、MessagePack、PHP、Java、Pickle、Protobuf 和压缩格式视图。自定义格式化器直接启动指定程序，将值通过标准输入传入。
- 浅色、深色和跟随系统模式，默认使用 Naive UI 配色，支持自选配色、字体和缩放。「帮助」菜单提供使用指南、快捷键、检查更新和版本信息。界面支持简体中文和英文，首次启动及旧语言设置回退时使用简体中文。

## 测试

```powershell
.\build.ps1 -DesktopTest
$env:REDIS_TEST_ADDR = '127.0.0.1:6379'
$env:REDIS_TEST_PASSWORD = Read-Host 'Redis test password'
go test -race -cover ./...
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run test:desktop
```

Playwright 连接独立测试版 EXE 的 WebView2，直接操作界面并通过 Wails 调用 Redis。生产版构建不包含该测试接口。测试创建带有 `ardm-wails-` 前缀的临时键，并清理本轮创建的键。Go 的 TLS 和 SSH 测试会启动临时本地代理。

可选环境变量 `REDIS_TEST_CLUSTER` 指向测试 Cluster，`REDIS_TEST_SENTINEL` 指向主节点名为 `ardm` 的 Sentinel。设置 `REDIS_TEST_MODULES` 和 `REDIS_TEST_NATIVE` 可运行 RedisJSON、TimeSeries、Vector Set 和 Array 的桌面测试。

使用支持 Search 和 JSON 的临时测试实例时，可将 `REDIS_TEST_ADDR` 指向该实例，并设置 `REDIS_TEST_ISOLATED=1` 来验证索引与示例数据创建、慢日志配置写入。运行完成后销毁临时实例。

## GitHub Actions 与标签发布

推送 `main` 或提交 Pull Request 会运行前端和 Redis 集成测试。准备发布时，请在包含本次改动的提交上创建 `vX.Y.Z` 标签并推送到 GitHub。

```powershell
git tag -a v0.0.7 -m "RedisPal v0.0.7"
git push origin v0.0.7
```

标签推送会触发测试、Windows x64 构建和 GitHub Release。软件显示的版本直接取自标签，可通过「帮助 → 关于 RedisPal」查看版本或打开项目的 GitHub 仓库。

[GitHub Releases](https://github.com/zhanggc2019/RedisPal/releases) 提供免安装版 `RedisPal-windows-x64.exe`、安装包 `RedisPal-windows-x64-setup.exe`、`SHA256SUMS` 和签名更新清单 `update-manifest.json`。RedisPal 启动时和运行期间每六小时检查正式版本，发现新版时在「帮助」入口显示提示。也可通过「帮助 → 检查更新」手动检查。签名版点击「安装更新」会下载并验签，成功后可选择「立即重启」或「稍后」。选择「稍后」后，可在本次运行期间重新检查更新以打开重启提示。v0.0.7 及更早提供「查看并下载」的版本需要从发布页手动升级一次。

首次发布签名版前，在仓库根目录运行以下 PowerShell 命令。先安装并登录有仓库管理权限的 GitHub CLI，再将密钥生成到仓库外。私钥文件请妥善保管。

```powershell
$privateKeyFile = Join-Path $env:USERPROFILE 'redispal-update.key'
$publicKey = go run ./.github/scripts/update-manifest.go keygen $privateKeyFile
if ($LASTEXITCODE -ne 0) { throw 'RedisPal update key generation failed' }
Get-Content -Raw -LiteralPath $privateKeyFile | gh secret set REDISPAL_UPDATE_PRIVATE_KEY --repo zhanggc2019/RedisPal
gh variable set REDISPAL_UPDATE_PUBLIC_KEY --body $publicKey --repo zhanggc2019/RedisPal
```

发布流水线将公钥嵌入应用，用私钥签署免安装版 EXE 并生成更新清单。已发布的签名版使用内置公钥验证后续更新，请保留对应的私钥备份。

## 启动参数和自定义更新源

可通过 `--host`、`--port`、`--auth`、`--username`、`--cluster`、`--readonly`、`--ssh-*`、`--ssl-*` 和 `--sentinel-*` 等启动参数配置连接。加上 `--save` 可保存通过命令行创建的连接。

如需自托管签名更新源，可通过 `build.ps1 -AppVersion <版本> -UpdateManifestURL <HTTPS 地址> -UpdatePublicKey <Base64 公钥>` 接入 Wails 更新清单。配置成功后，可通过「帮助 → 检查更新」检查该更新源。[Wails 更新清单协议](https://v3.wails.io/reference/update-manifest/)
