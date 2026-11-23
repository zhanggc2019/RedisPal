# RedisPal

这是原 Redis 桌面客户端的独立重构目录，使用 Go、Wails 3.1 和 Vue 3。界面保留连接侧栏、键树和多标签工作区，Redis 连接与命令由 Go 后端执行。

## Windows 构建

需要 Go 1.26.10 或更新版、Node.js 22.12 或更新版，以及 Microsoft Edge WebView2 Runtime。从本目录运行以下命令。

```powershell
.\build.ps1
.\bin\RedisPal.exe
```

构建脚本通过锁文件安装 Vue 依赖，将 Vite 产物嵌入 EXE。首次启动可选择新建连接，也可导入 Electron 版本导出的连接 JSON。RedisPal 会继续读取改名前保存的连接与界面设置。导出的连接 JSON 包含该配置中已保存的密码。

修改 `frontend/public/logo.png` 后，可用 Wails CLI 重新生成 Windows 图标资源。生成的 `.syso` 会在构建时嵌入可执行文件。[Wails 图标与打包文档](https://v3.wails.io/concepts/build-system/#icons-and-packaging)

```powershell
wails3 generate icons -input frontend/public/logo.png -windowsfilename bin/RedisPal.ico -macfilename=
foreach ($arch in 'amd64', 'arm64') {
    wails3 generate syso -arch $arch -icon bin/RedisPal.ico -manifest build/windows/RedisPal.manifest -out "redispal_windows_$arch.syso"
}
```

## 功能

- 单机、Cluster、Sentinel、ACL、SSH 和 TLS 连接，支持分组、克隆、连通性测试和只读模式。SSH 使用系统或指定的 `known_hosts` 文件验证主机密钥。
- 数据库切换和命名、键的精确及通配符搜索、树形及平铺视图、分页、批量删除、导入导出。键备份读取新版 JSON 和原 Electron 版 CSV，支持将键复制到同连接的其他库或通过备份迁移到其他连接。
- String、Hash、List、Set、ZSet、Stream、RedisJSON、TimeSeries、Vector Set 和 Array 的可视化编辑。扩展类型及 Hash 字段 TTL 需要 Redis 服务器支持对应命令。
- Redis CLI、历史、补全、命令文件、Pub/Sub、MONITOR、命令日志、慢日志和内存分析。Cluster 的 MONITOR 观察一个主节点。
- Text、JSON、Hex、Binary、MessagePack、PHP、Java、Pickle、Protobuf 和压缩格式视图。自定义格式化器直接启动指定程序，将值通过标准输入传入。
- 浅色、深色、系统主题，字体、缩放和快捷键。界面支持简体中文和英文，首次启动及旧语言设置回退时使用简体中文。

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

## 启动参数和更新

支持原项目的 `--host`、`--port`、`--auth`、`--username`、`--cluster`、`--readonly`、`--ssh-*`、`--ssl-*` 和 `--sentinel-*` 连接参数。加 `--save` 时会保存由命令行创建的连接。

签名发布版可通过 `build.ps1 -AppVersion <版本> -UpdateManifestURL <HTTPS 地址> -UpdatePublicKey <Base64 公钥>` 接入 Wails 更新清单。配置后可从 App 菜单手动检查，也会定期检查。当前本地构建未配置发布源。[Wails 更新清单协议](https://v3.wails.io/reference/update-manifest/)
