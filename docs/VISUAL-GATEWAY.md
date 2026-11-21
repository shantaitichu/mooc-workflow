# 视觉模型直连与可选网关

默认使用境内火山视觉服务直连；设置 `VISUAL_PROVIDER=gateway` 才使用下方可选机构网关。两条路线均须完成真实素材验收后再加入 `ENABLED_VERIFIED_MODELS`。

## 国内火山直连

服务端配置 `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`，可选 `VOLC_SESSION_TOKEN`。实现使用 Node 原生密码库生成请求签名，并已与官方 Node SDK 1.36.2 的固定请求向量核对一致。无需把密钥发给客户端。

- Dreamactor 使用 `CVSync2AsyncSubmitTask` / `CVSync2AsyncGetResult`。
- OmniHuman 使用 `CVSubmitTask` / `CVGetResult`，采用 1080p、非快速模式；产品首版仍限制单段 30 秒。
- 国内端点为 `visual.volcengineapi.com`；签名区域 `cn-north-1`、服务 `cv`、协议版本 `2022-08-31`。

在火山即梦控制台开通「动作模仿 2.0」，在项目根目录 `.env` 填写上述视觉服务 AK/SK。将 `dreamactor-2.0` 加入 `ENABLED_VERIFIED_MODELS`，保留原有模型。动作视频重新抠像还需启用 `mediakit-matte-portrait-video` 并配置 `VOLC_MEDIAKIT_API_KEY`。本地试用启动脚本会启用 MediaKit 视频人像抠像。

火山需要下载待机参考图和动作模板，可按现有环境选择下列方式。

- **自有服务器中转。** 在服务器部署项目中的素材中转服务并启用公网 HTTPS。在本地后台的 `.env` 填 `MEDIA_RELAY_URL`（中转服务 HTTPS 地址，可带路径前缀）和 `MEDIA_RELAY_TOKEN`（与中转服务一致的高强度令牌），保留本地 `PUBLIC_BASE_URL`。重启后台后，Dreamactor 每次只上传该任务的人物图和自选动作模板，向模型提供有效期一小时的签名读取链接。使用预设动作时沿用预设模板地址。已配置的中转优先用于 Dreamactor，OmniHuman 和 MediaKit 沿用各自的素材传输方式。中转部署文件见 [media-relay](../deploy/media-relay/)。

- **私有对象存储。** 在 `.env` 配置 `S3_BUCKET`、`S3_REGION` 和适用于该存储的 S3 兼容端点及凭据（`S3_ENDPOINT`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`）。后台为需要的对象生成限时读取地址。
- **已有公网 HTTPS 下载服务。** 将 `PUBLIC_BASE_URL` 设为反向代理域名，例如 `https://media.example.org`，把该域名的 `GET /files/:id` 连同签名查询串转发到本地后台。客户端继续连接 `127.0.0.1`。仅填写本机地址时，远端模型无法下载素材。

保存后重启本地后台。动作素材页会根据已登录后台的模型目录提示缺项。查询配置状态本身不会调用生成接口或产生费用。

客户端将所选手势和当前待机组成 6 至 30 秒的动作模板，以待机中的人物画面作为参考图。直连请求把模板 URL 放入 `video_url`、参考图放入 `image_urls`，后台按上传模板的实测时长报价。独立内置预设仍使用对应的六秒 HTTPS 模板地址，截取自己的动作素材可以留空全部 `MOTION_TEMPLATE_*_URL`。

Dreamactor 支持一张图和一段动作视频作为输入。成片的接入与回落由模板引导，输出时应用的首尾过渡使用当前待机。评估自然度时应回放手腕轨迹、站姿和服装边缘。[火山动作模仿 2.0 接口](https://docs.volcengine.com/docs/jimeng-ai/action-imitation-20-interface-documentation?lang=zh)

任务 ID 持久化时带运输方式前缀，避免服务端切换网关后把旧任务发送到错误端点。网络受理不确定时不自动重提；轮询成功但缺少文件也不会交付为空视频。

接口依据（2026-11-17 核对）：[动作模仿 2.0](https://docs.volcengine.com/docs/jimeng-ai/action-imitation-20-interface-documentation?lang=zh)、[OmniHuman 1.5 视频生成](https://docs.volcengine.com/docs/jimeng-ai/call-step3-video-generation?lang=zh)、[火山官方 Node SDK](https://github.com/volcengine/volc-sdk-nodejs)。适配器协议测试使用固定测试响应，不代表真实生成效果或付费验收。

## 可选机构网关

设置 `VISUAL_PROVIDER=gateway`、`VISUAL_GATEWAY_URL`、`VISUAL_GATEWAY_TOKEN` 后，网关负责供应商调用。网关需要能够下载同样的限时素材链接；收到 `videoUrl` 时须以该视频作为动作模板，结果时长应与模板对齐。

## 提交

`POST /jobs`，Bearer 鉴权，JSON：

```json
{
  "requestId": "平台任务 UUID，必须用于幂等",
  "kind": "motion",
  "model": "dreamactor-2.0",
  "preset": "explain",
  "imageUrl": "短时签名 HTTPS 地址",
  "videoUrl": "使用自选动作时，取此地址的待机衔接参考视频",
  "durationMs": 6000
}
```

图片数字人使用 `kind=avatar`、`model=omnihuman-1.5`，另有 `audioUrl` 和音频实际 `durationMs`。网关返回 `{ "task_id": "供应商或网关持久任务 ID" }`。

## 查询

`GET /jobs/:taskId` 返回：

```json
{
  "status": "completed",
  "result": { "video_url": "https://允许的供应商结果域名/result.mp4" }
}
```

处理中返回 `status=running`；失败返回 `status=failed` 和不含密钥或原始素材地址的错误代码。必要的额外结果域名通过 `VISUAL_OUTPUT_HOSTS` 白名单配置。

## 验收记录要求

每个开放的模型版本记录：开通账号/地域、版本、计费规则、样片、实际时长、费用、处理时间、身份与服装一致性、手部检查、口型偏差、动作首尾检查，以及失败处置。

先测试普通话、专名/数字/英文混读、戴眼镜、不同脸部角度、五种低幅度动作、停顿与长课跨页连续性。口型目标 ≤100ms 需要实际测量，不能用接口“成功”状态替代质量验收。
