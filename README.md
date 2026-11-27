# RedisPal

RedisPal 是一款 Windows Redis 桌面客户端。你可以在侧栏管理连接、按树形浏览键，并在多标签工作区中编辑数据、运行 Redis 命令和查看服务器状态。

> 目前仅在 Windows 上实际使用过 RedisPal。尚未在 macOS 上安装体验，界面是否与 Windows 版一致仍有待验证。

[下载 Windows x64 版](https://github.com/zhanggc2019/RedisPal/releases/latest) · [快速上手](#快速上手) · [提交记录](https://github.com/zhanggc2019/RedisPal/commits/main/) · [从源码构建](#从源码构建)

## 下载与安装

| 发行形式 | 下载文件 | 安装与使用 |
| --- | --- | --- |
| 免安装版 | [RedisPal-windows-x64.exe](https://github.com/zhanggc2019/RedisPal/releases/latest/download/RedisPal-windows-x64.exe) | 直接运行 EXE，适合试用或手动管理程序位置。运行需要 Microsoft Edge WebView2 Runtime。 |
| 安装版 | [RedisPal-windows-x64-setup.exe](https://github.com/zhanggc2019/RedisPal/releases/latest/download/RedisPal-windows-x64-setup.exe) | 安装程序会检查并按需安装 WebView2 Runtime，默认目录为 `%LOCALAPPDATA%\Programs\RedisPal`，并提供开始菜单快捷方式和卸载入口。 |

两种发行形式使用同一个应用程序。连接和界面设置存放在 Windows 用户配置目录，覆盖升级后可以继续使用。每个 [GitHub Release](https://github.com/zhanggc2019/RedisPal/releases) 提供对应的下载文件，近期版本还提供 `SHA256SUMS` 和签名更新清单。

## 快速上手

1. 点击「新建连接」，填写 Redis 地址，例如 `127.0.0.1:6379`。服务器要求认证时，填写用户名和密码。已有连接配置也可通过「导入连接」从 JSON 文件恢复。
2. 点击「测试连接」，确认后选择「保存连接」，再点击侧栏中的连接名称。
3. 选择数据库，通过键树或搜索框找到键。打开键可以查看数据类型、值和 TTL。切换侧栏的「工具」可打开 Redis CLI、实时监控和其他数据库工具。

导出的连接 JSON 包含连接中已保存的密码。左侧栏底部的「帮助」提供使用指南、快捷键、更新检查和版本信息。

## 功能概览

| 功能 | 支持内容 |
| --- | --- |
| 连接管理 | 单机、Cluster、Sentinel、ACL、SSH 和 TLS。支持连接测试、分组、克隆和只读模式，可拖动连接调整分组。SSH 使用系统或指定的 `known_hosts` 文件验证主机密钥。 |
| 键浏览与迁移 | 数据库切换和命名、精确及通配符搜索、树形和平铺视图、批量删除。默认每批加载 10,000 个键，可停止并继续加载，树形目录显示已加载的后代键数。可复制键到同一连接的其他数据库，或通过 JSON 备份迁移到其他连接。支持导入 JSON 或兼容的 CSV 备份。 |
| 数据编辑 | 可视化编辑 String、Hash、List、Set、ZSet、Stream、RedisJSON、TimeSeries、Vector Set 和 Array。Stream 支持实时刷新、消费组和待处理消息管理。扩展类型和 Hash 字段 TTL 需要服务器支持对应命令。 |
| 命令与诊断 | Redis CLI 提供历史、补全和命令文件。工具包含服务器概览、Pub/Sub、Redis Search、实时监控、命令日志、慢日志和内存分析。 |
| 值的查看格式 | 支持 Text、JSON、Hex、Binary、MessagePack、PHP、Java、Pickle、Protobuf 和压缩格式。自定义格式化器启动指定程序，并通过标准输入传入值。 |
| 工作区与外观 | 多标签工作区。支持浅色、深色和跟随系统，提供简体中文和英文界面，以及配色、字体、缩放和快捷键。 |

Redis Search 提供索引浏览和创建、字段补全、查询收藏、Explain 和 Profile，需要服务端支持 `FT.*`。Pub/Sub 支持普通、模式和分片订阅。实时监控支持筛选和导出，Cluster 下观察一个主节点。慢日志支持自动刷新，修改阈值和日志长度需要相应 ACL 权限。内存分析会分批显示扫描批次、匹配键数和已测量键数。

## 检查更新

RedisPal 启动时和运行期间每六小时检查更新，也可在「帮助 → 检查更新」手动检查。签名版点击「安装更新」后会下载并验签，然后可选择「立即重启」或「稍后」。选择「稍后」后，可在本次运行中再次打开更新窗口继续操作。

从 v0.0.7 或更早版本升级时，先到 [GitHub Releases](https://github.com/zhanggc2019/RedisPal/releases/latest) 下载并覆盖升级一次，即可使用后续签名版本的应用内更新功能。

支持应用内更新日志的版本可以在「帮助 → 检查更新」预览新版说明，或在「关于 RedisPal」离线查看当前版本说明。

## 从源码构建

RedisPal 使用 Go、Wails 3.1、Vue 3 和 Vite。Windows 构建需要 Go 1.27 或更新版和 Node.js 22.12 或更新版。运行应用需要 Microsoft Edge WebView2 Runtime。

在仓库根目录运行以下命令。

```powershell
.\build.ps1
.\bin\RedisPal.exe
```

构建脚本按锁文件安装前端依赖，并将 Vite 产物嵌入 EXE。安装 [NSIS](https://nsis.sourceforge.io/Download) 后，`.\build.ps1 -Installer` 同时生成 `bin/RedisPal.exe` 和 `bin/RedisPal-windows-x64-setup.exe`。

### 启动参数

可以通过 `--host`、`--port`、`--auth`、`--username`、`--cluster`、`--readonly`、`--ssh-*`、`--ssl-*` 和 `--sentinel-*` 配置连接。加上 `--save` 可保存该连接。

```powershell
.\bin\RedisPal.exe --host 127.0.0.1 --port 6379
```

### 测试

使用独立的 Redis 测试实例，在仓库根目录运行以下命令。

```powershell
.\build.ps1 -DesktopTest
$env:REDIS_TEST_ADDR = '127.0.0.1:6379'
$env:REDIS_TEST_PASSWORD = Read-Host 'Redis test password'
go test -race -cover ./...
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run test:desktop
```

Playwright 通过测试版 EXE 的 WebView2 操作界面。测试会创建并清理临时键，Go 的 TLS 和 SSH 测试会启动临时本地代理。

- `REDIS_TEST_CLUSTER` 和 `REDIS_TEST_SENTINEL` 分别指定 Cluster 与 Sentinel 实例，Sentinel 主节点名为 `ardm`。
- `REDIS_TEST_MODULES` 和 `REDIS_TEST_NATIVE` 用于验证 RedisJSON、TimeSeries、Vector Set 和 Array。
- 只在可销毁的测试实例上设置 `REDIS_TEST_ISOLATED=1`，以运行大批量键、Search 和服务器配置相关测试。

## 发布与维护

推送 `main` 或提交 Pull Request 会运行前端和 Redis 集成测试。推送 `vX.Y.Z` 格式的稳定标签会触发测试、Windows x64 构建、签名和 GitHub Release。应用显示的版本来自该标签。

发布前可把说明写入 `release-notes/vX.Y.Z.md`。使用 `## 中文` 和可选的 `## English` 标题，每项改动写成一个列表项。[v0.1.1 的说明](release-notes/v0.1.1.md)可作为示例。未填写说明时，流程会列出从上一个稳定标签到本次标签的提交。GitHub Release、更新清单和应用使用同一份说明，应用优先使用界面语言对应的内容。

在待发布的提交上创建标签，将 `vX.Y.Z` 替换为本次版本号。

```powershell
$releaseTag = 'vX.Y.Z'
git tag -a $releaseTag -m "RedisPal $releaseTag"
git push origin "refs/tags/$releaseTag"
```

<details>
<summary>配置签名与自托管更新源</summary>

首次配置签名发布时，登录具有仓库管理权限的 GitHub CLI，在仓库外生成密钥。

```powershell
$privateKeyFile = Join-Path $env:USERPROFILE 'redispal-update.key'
$publicKey = go run ./.github/scripts/update-manifest.go keygen $privateKeyFile
if ($LASTEXITCODE -ne 0) { throw 'RedisPal update key generation failed' }
Get-Content -Raw -LiteralPath $privateKeyFile | gh secret set REDISPAL_UPDATE_PRIVATE_KEY --repo zhanggc2019/RedisPal
gh variable set REDISPAL_UPDATE_PUBLIC_KEY --body $publicKey --repo zhanggc2019/RedisPal
```

流水线将公钥嵌入应用，使用私钥签署更新用的 EXE 并生成更新清单。已发布的应用使用内置公钥验证后续更新，请保留私钥备份。

自托管构建可用 `build.ps1 -AppVersion <版本> -UpdateManifestURL <HTTPS 地址> -UpdatePublicKey <Base64 公钥>` 指定更新源。更新清单的字段与签名方式可参考[清单生成脚本](.github/scripts/update-manifest.go)。

</details>

<details>
<summary>重新生成 Windows 图标</summary>

修改 `frontend/public/logo.png` 后，可用 Wails CLI 重新生成 Windows 应用和安装包图标。

```powershell
wails3 generate icons -input frontend/public/logo.png -windowsfilename build/windows/RedisPal.ico -macfilename=
foreach ($arch in 'amd64', 'arm64') {
    wails3 generate syso -arch $arch -icon build/windows/RedisPal.ico -manifest build/windows/RedisPal.manifest -out "redispal_windows_$arch.syso"
}
```

</details>

## 许可证

[MIT](LICENSE)
