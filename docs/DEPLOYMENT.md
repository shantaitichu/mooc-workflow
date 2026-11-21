# 云端与发行配置

## 环境变量

以 `.env.example` 为准。`npm run setup:cloud` 只在 `.env` 不存在时创建随机服务密钥和初始管理员密码，不覆盖已有设置。

- `DATABASE_URL`：生产 PostgreSQL 连接；未设置时仅用于本机 SQLite 试点。
- `PUBLIC_BASE_URL`：客户端可访问的 HTTPS 服务根地址。反向代理须允许受控的大文件上传，并配置 TLS、请求超时和速率限制。
- `SESSION_SECRET`：至少 32 字符，用于临时文件签名。登录 token 在服务端只存摘要，桌面使用系统安全存储。
- `DASHSCOPE_API_KEY`、`SFM_WORKSPACE_ID`：北京地域百炼凭据及业务空间，TTS 和音色复刻必须使用同模型。
- `VOLC_MEDIAKIT_API_KEY`：口型生成与讲师照片背景移除服务。平台向供应商提交私有对象的短时签名 URL。
- `VOLC_ACCESS_KEY_ID`、`VOLC_SECRET_ACCESS_KEY`：国内火山视觉服务直连。动作预设另需 `MOTION_TEMPLATE_*_URL`；参考素材须为经平台验收的 6 秒片段，见视觉接入文档。
- `ENABLED_VERIFIED_MODELS`：经过真实素材验收的模型 ID，逗号分隔。默认为空。
- `FFPROBE_PATH`：服务端重新测量上传音频的实际时长，报价不信任客户端声明时长。
- `S3_*`：可选私有 S3 兼容存储。未配置时服务端使用本地对象目录及签名下载链接；正式部署需要备份、容量限制及到期清理监控。

## 生产部署

```powershell
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

另需在 `.env` 设置 URL 安全的 `POSTGRES_PASSWORD`，并将 HTTPS 反向代理指向本机 8787 端口。Compose 不自动部署公网域名、TLS 证书或云资源。容器配置已经提供，但本轮未在此 Windows 主机实际部署 PostgreSQL、S3 或公网服务。

任务队列直接持久化在数据库。生产进程通过行锁/租约协调队列；当前建议先使用单服务实例，完成 PostgreSQL 多实例压力测试后再扩容。云端任务独立于桌面进程执行，桌面重启后查询已有任务。

## API

除登录、健康检查和带签名的文件 URL 外均需 `Authorization: Bearer <session>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/auth/login`、`/auth/logout` | 登录和退出 |
| GET | `/me`、`/overview`、`/ledger?page=0` | 当前作者、机构余额、模型目录及分页完整账单 |
| GET/DELETE | `/voices/:id` | 查询本人音色、删除供应商音色 |
| POST | `/admin/users`、`/admin/grants` | 创建同机构作者、幂等分配试点额度 |
| POST | `/assets` | 预登记受限大小/格式的素材 |
| PUT/GET | `/assets/:id/content` | 本人素材上传、下载 |
| POST | `/quotes` | 固定输入快照、测量时长、产生 10 分钟有效报价 |
| POST | `/jobs` | 使用报价和幂等键冻结额度并入队 |
| GET | `/jobs`、`/jobs/:id` | 查询任务与交付结果 |
| POST | `/jobs/:id/cancel` | 取消队列任务；运行任务只记录停止请求 |
| POST | `/admin/jobs/:id/reconcile` | 核查网络超时导致的上游受理不确定状态 |

重试提交必须复用 `quoteId` 和 `idempotencyKey`。系统也限制一份报价只能建立一个任务。未知受理状态不会自动退费后再提交：管理员可填供应商任务 ID 继续查询，或确认上游未受理后释放额度。

没有未经认证的供应商回调接口：本版轮询供应商状态并落库。成功结算/失败释放在事务内执行，重复通知不会重复结算。

## 数据生命周期

临时输入默认 24 小时，仍被活动任务引用的对象不清理；完成后延长到完成时间加 24 小时。结果保留 7 天；临时下载 URL 有效期 1 小时。清理任务每小时执行。上传大小限制 256MB、每个作者临时配额 5GB。

音色属于持久云资产，不随临时文件自动删除。讲师档案可显式删除云端音色，服务端拒绝删除仍被活动任务使用的音色。已保留的本地音视频不随之删除；删除本地课程也不删除供应商音色。机构注销治理仍需完成。

## 发布签名

目前 `win.signAndEditExecutable=false` 用于生成未签名试用包。正式发行须改为 `true`，配置发行方 `CSC_LINK` 和 `CSC_KEY_PASSWORD`（或符合机构要求的签名服务），并验证安装包签名。无签名证书时不能声称正式签名完成。

本地试用包随附 `resources/bin` 中经过 SHA256 校验的 FFmpeg / FFprobe 9.0.2，应用自动发现；原始许可证、README 与来源记录一并保存。源代码中的 `npm run setup:media` 可重新获取固定版本。公开再分发前还需准备对应源码分发材料，详见该目录 NOTICE。当前默认图标为 Electron 图标，品牌图标与安装包签名属于发行收尾事项。
