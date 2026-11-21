# 慕课工坊 / MOOC Studio

Windows 数字人课程制作客户端。以 PPT 页面组织讲稿、配音、人物素材、字幕与合成版本；本地保存课件和成片，通过自建云服务统一调用模型与管理额度。

当前版本 **0.1.0：可运行的制作闭环与试点服务**。已实现本地真实视频合成、桌面编辑和云端任务/计费基础。真实人物模型未用客户素材验证，默认不开放购买。功能边界和验收状态见 [实施记录](docs/IMPLEMENTATION.md)。

## 启动

已有本地试用包时，可以直接打开 `win-unpacked` 文件夹中的「慕课工坊.exe」。从源码使用一键启动脚本时，请先按下文安装依赖和媒体工具，然后运行 `npm run package:dir` 和 `npm run build:server`。

### 在本机试做一页 AI 配音和口型样片

双击 [启动客户端和本地后台.bat](启动客户端和本地后台.bat)。这个入口使用已打包的客户端和本机 Node.js 24+，需要保留项目的 `node_modules` 和 `dist-server`。首次运行会在项目根目录生成 `.env` 和随机管理员密码。后台只监听本机，生成期间保持命令窗口打开。按 Ctrl+C 可停止后台。

| 服务 | 填入项目根目录 `.env` 的字段 | 用途 |
| --- | --- | --- |
| 阿里云百炼，华北 2（北京） | `DASHSCOPE_API_KEY` 填百炼 Key，`SFM_WORKSPACE_ID` 填同一个业务空间详情里的 ID | CosyVoice 3.5 Flash 用参考录音复刻音色，再用逐页讲稿生成配音。[创建百炼密钥](https://help.aliyun.com/zh/model-studio/get-api-key) · [声音复刻](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api) |
| 火山引擎 AI MediaKit | `VOLC_MEDIAKIT_API_KEY` 填 AI MediaKit 控制台创建的专用 Key | “视频口型对齐”接收单人人物视频和配音。后台使用官方临时上传地址传送素材，无需公网服务器、对象存储或火山 AK/SK。[创建 MediaKit 密钥](https://console.volcengine.com/imp/ai-mediakit/settings) · [口型指南](https://docs.volcengine.com/docs/intelligent-processing/lip-sync-guide?lang=zh) |

1. 保存 `.env`，关闭原后台窗口并重新双击 BAT。此测试入口默认在当前进程放行 Flash 和 MediaKit，启动本身不提交模型任务。
2. 在客户端“设置与连接”连接 `http://127.0.0.1:8787`（如修改过端口，以启动窗口为准），用 `.env` 中的 `BOOTSTRAP_ADMIN_EMAIL` 和初始 `BOOTSTRAP_ADMIN_PASSWORD` 登录。在“额度与账单 → 试点额度管理”给本机构分配测试额度。该额度用于本地预算，两家供应商会按各自账号的用量单独结算。
3. 新建一页课程，导入一张课件图片，粘贴一两句讲稿。在“讲师档案”导入10–20 秒清晰单人录音和正脸 MP4，另外导入有呼吸或眨眼的动态待机视频。选 CosyVoice Flash，点击“创建专属音色”。
4. 在课程页面选择“左右分栏”和 MediaKit 口型模型，点击“生成本页样片”确认预算。后台将讲稿交给百炼配音，再将音频与人物视频交给火山对口型。客户端在本地合入课件和字幕。播放检查后点“确认本页样片”，即可导出成片。

环境：Windows x64、Node.js 24+、npm。课件渲染使用已安装的 PowerPoint 或 LibreOffice；PDF 和图片可直接导入。

```powershell
npm ci
npx install-electron --no
npm run setup:media
npm run dev
```

如果 Electron 下载连接慢，可以在当前 PowerShell 会话设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试安装；安装器会核对包内 SHA256。应用不会静默安装 Office 或其他系统软件。

当前本地试用包随附经过 SHA256 校验的 FFmpeg / FFprobe 9.0.2，启动时自动发现；设置中仍可指定其他工具路径。源代码不提交二进制，`npm run setup:media` 可恢复固定版本；第三方原始许可证与构建来源随包保存。未运行此脚本的开发环境可回退到 npm 测试工具。

```powershell
npm run build
npm start
npm run package:dir
npm run package:win
```

`package:dir` 在 `package.json` 的 `build.directories.output` 目录下生成 `win-unpacked/慕课工坊.exe`。`package:win` 生成 NSIS 安装包。当前打包配置输出未签名试用包，正式签名需要发行方证书，见部署说明。

## 讲师、版式与成片

在「课程制作 → 画面设置」中，直接拖动预览里的 PPT 调整位置，拖动任一角点等比缩放。新课程默认使用白色画布。「画布底色」可选择颜色，「从预览取色」可直接点击课件上的颜色。将 PPT 缩小靠左后，可以把讲师拖入右侧留白。保存后用于当前页，也可以保存为版式或应用到全课。

旧版生成的含讲师或烧录字幕的页面需要重新合成。在对应页面点击「生成本页样片」，报价窗口会列出可复用的音频和人物视频。原配音和口型素材仍有效时，新增费用为 0 元，本机即可生成修正后的成片。

讲师档案分别接受人物照片、人物动作视频、动态待机视频和音色。两类视频均先导入本地，最长 5 分钟。已有透明背景的 VP9 WebM 直接使用原文件，其他受支持的透明视频在本地按原尺寸转换。普通视频导入后，如需用于透明人物合成，在对应卡片点「移除视频背景」，确认费用后才会上传到火山 MediaKit。建议为动态待机选择首尾姿态相近、带轻微呼吸或眨眼的 3–8 秒循环镜头，可在卡片中循环预览。待机参考与讲师照片来自不同人时，可点「用照片与参考生成待机」，让照片中的讲师复现参考动作。单页 MediaKit 口型支持最长 5 分钟。

打开「动作素材」，剪辑器会载入当前讲师档案中已抠像的「人物动作视频」。在时间线上设置入点、出点，循环预览并命名选段；也可从识别建议开始微调。点击「保存选段」将原视频和入点、出点保存在当前讲师档案里。可以连续截取多段，稍后在下方「已保存选段」逐段预览。选段的「打开保存位置」会在首次使用时提取原尺寸透明 WebM 到本工程的「动作选段」文件夹，并在资源管理器中选中。讲师档案和动作库的同名按钮直接定位到对应的本地素材。选择其中一段，点击「生成动作素材」并确认预算，客户端会按选区生成包含待机起势和收势的动作参考，交给 Dreamactor 驱动，再处理透明背景与首尾衔接。成功后即可在「课程制作 → 动作库」将它拖到人物动作轨，或点击插入播放头位置。更换待机后，需要针对新待机重新衔接。火山需要能读取限时有效的参考图和动作视频链接。详见 [视觉模型配置](docs/VISUAL-GATEWAY.md)。

整页口型生成后，MediaKit 对返回的人物视频再抠像，客户端验证实际透明度和时长后将人物叠到课件上。人物口型上传沿用待机视频的原始画幅。抠像按视频短边分档，720p、1080p、1440p、2160p 档的试用报价依次为每分钟 1、1.5、3、4 元，复用已有透明素材不重复提交。后台启用 mediakit-matte-portrait-video、mediakit-lipsync 和 mediakit-remove-image-background，使用同一 VOLC_MEDIAKIT_API_KEY；本地联合启动器已包含这三个模型。更新后请关闭旧后台再运行 BAT。图片驱动路线也对最终人物片段抠像。[火山视频抠像接口](https://docs.volcengine.com/docs/intelligent-processing/matte-portrait-video?lang=zh)

课程制作的实时预览支持直接拖动讲师，移出画布后可在画面设置中移回中央。预览下的多轨工作台显示全课视频主轨、逐句口播和人物动作。拖动主轨页面可调整页序；合成配音的句子可在句间或跨页插入，句子会自动靠齐。拖动时间尺可定位，播放键同步预览画面和已有声音，双击句子单独预听。尚未生成配音的句子按估时静音预演。整页真人录音和演示原声连续播放，句界为估算，保留原声顺序。可以切换当前页、缩放时间轴或展开工作台。把动作库中的成品拖到口播对应位置可安排手势；删除动作库条目会同时清除本工程引用它的标记。

画面设置提供独立版式和自定义版式，保存后可在同一课程中复用。预览和导出共用 1920 × 1080 布局坐标。课件页可多选删除或只保留所选页。讲稿换行取“换行气口”，整页音频只驱动一次人物生成。整课导出的页间转场默认 240 毫秒，可设为 0–2000 毫秒，音轨和章节时间保持连续。

## 无云账号也能验证本地闭环

1. 新建课程，导入 PPTX、PDF 或图片。PPT 备注会绑定到对应页面。
2. 在“画面设置”选择“纯课件配音”；导入本页真人录音。
3. 生成单页样片，试听后确认本页样片并保存。
4. 批量制作其余页面，逐页审核，再导出 MP4、SRT、WAV、章节表和 `.mooc` 工程包。

未连接云端时，AI 生成不会伪装成成功。浏览器的 `npm run dev:web` 只是可编辑设计预览，不具备桌面文件和模型能力。

## 云端服务

```powershell
npm run setup:cloud
# 在编辑器中配置 .env；不要把 API Key 发到聊天或提交到 Git。
npm run server
```

初始管理员邮箱默认 `admin@example.local`，随机密码保存在 `.env`。桌面端连接 `http://127.0.0.1:8787` 后登录。管理员可建立作者账号并分配试点机构额度。

本机开发使用 SQLite；生产通过 `DATABASE_URL` 使用 PostgreSQL，并要求 HTTPS `PUBLIC_BASE_URL`。模型密钥只放服务端。生产部署与接口见 [部署文档](docs/DEPLOYMENT.md)。

配好服务端凭据并开通服务权限后，按试点验收情况在 `ENABLED_VERIFIED_MODELS` 启用相应模型。声音复刻和 TTS 使用百炼，口型与视频人像抠图使用 MediaKit。Dreamactor 和 OmniHuman 支持火山直连或机构网关。直连需要视觉服务 AK/SK 和可访问的素材链接。自选动作使用从课程素材生成的参考视频，内置预设读取对应的六秒动作模板。见 [视觉模型接入](docs/VISUAL-GATEWAY.md)。

## 测试

首次从源码运行导入测试前，请用 Python 安装 `python-pptx` 并执行 `python tests/fixtures/create_lesson.py`，在本机生成两页示例课件。

```powershell
npm run typecheck
npm test
npm run build
npm run test:ui
```

- 单元与集成测试：分段指纹、依赖失效、SSML、报价/冻结/结算/退款幂等、预算、账户权限与素材隔离、任务不确定状态、SQLite 与工程恢复。
- 媒体测试：真实 1080p/25fps 视频、字幕、音频、无字幕版本和工程包；需要测试二进制。
- 导入测试：合成测试 PPTX 的备注、PDF 实际渲染和本机 Office/LibreOffice 导入。测试课件没有真人信息。
- 桌面测试：Playwright 启动隐藏 Electron 窗口，通过真实 IPC 验证编辑、保存、重新打开与讲师档案。同时实际导入 PPT 与录音、制作、审核、播放并导出课程。截图保存于 `.data/desktop-workspace.png` 与 `.data/desktop-production.png`。

长课时序测试已单独执行：100 页 × 36 秒，1080p/25fps，90,000 个视频包；最终实测 3,600.021 秒，偏差 21ms。它验证合成时序，不代表真实数字人质量验收。重跑命令：`$env:MOOC_LONG_TEST="1"; npx tsx --test tests/long-course.test.ts`。

## 工程组织

| 目录 | 内容 |
| --- | --- |
| `src` | React 桌面界面、浏览器设计预览 |
| `shared` | 领域类型、版本指纹、分段、SSML、价格与校验 |
| `desktop` | Electron 安全桥、本地 SQLite、导入、FFmpeg 和生产编排 |
| `server` | 鉴权、账户、事务计费、持久任务、对象存储和模型适配 |
| `tests` | 核心、HTTP、媒体、导入与桌面自动化 |
| `deploy` | 云端 Docker 与 PostgreSQL 部署配置 |

本地工程默认位于 Electron 用户数据目录下的 `workspace`，可用 `MOOC_DATA_DIR` 指定开发/测试数据目录。课程删除是归档，历史素材不立即销毁。
