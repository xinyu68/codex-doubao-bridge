# Codex Doubao Bridge

让 Codex 使用你已经登录的豆包网页：文字问答、独立文本委派、上传参考图、生成和下载视频、提取尾帧辅助续接。现已提供 **Codex 原生插件**，包含 MCP 工具、`doubao-chat` 视频 Skill 和首次设置 Skill；同时保留独立安装方式。

**无需单独启动桥接服务**：MCP 自动准备并管理共享连接，多个 Codex 对话共用一个连接进程；最后一个 MCP 客户端退出且本机操作完成30秒后自动退出。不创建 Windows 计划任务或开机自启。不需要豆包 API Key；使用你的豆包账号现有免费或付费权益，实际可用的模型、次数和时长以账号界面为准，不能保证生成画面的连贯性。

目前安装与启动流程在 **Windows + Chrome + Codex** 上验证。网页自动化会受到豆包界面变化影响；本项目不是豆包官方客户端。

## 安装 Codex 插件（推荐）

准备 Node.js 20 或更新版本、Git、Chrome，以及能够运行 `codex` 命令的 Codex 安装。视频下载验证和尾帧提取还需要 PATH 中有 `ffmpeg` 和 `ffprobe`；文字问答不需要它们。

插件安装流程已在 Codex CLI **0.153.4** 验证，需要支持 `codex plugin` 和 Agent Plugins 格式的 Codex 版本。若命令不存在，请先更新 Codex。在 PowerShell 执行：

```powershell
codex plugin marketplace add xinyu68/codex-doubao-bridge
codex plugin add codex-doubao-bridge@xinyu68
```

重新打开 Codex 任务，然后告诉 Codex：

> 帮我完成豆包桥接插件的首次设置，准备扩展目录并检查连接。

首次设置 Skill 会准备稳定运行目录，返回真实的 `extensionDirectory`，并引导你手动完成：

1. Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载返回的目录
2. 打开 [豆包](https://www.doubao.com/)，登录自己的账号

**安装 Codex 插件仍然需要 Chrome 扩展**。插件安装提供 Skill 和 MCP；不会自动登录账号或加载浏览器扩展。首次设置只准备文件，之后 MCP 初始化或首次工具调用会自动连接，不用打开终端启动服务。

新安装默认将运行文件、密钥和媒体放在 `%LOCALAPPDATA%/codex-doubao-bridge/runtime`，绑定信息保存在同级 `binding.json`。插件代码由 Codex 放在自己的插件缓存中；不在插件缓存存放密钥或生成素材。首次设置检测到旧版独立 Skill 时，优先复用其运行目录，保留扩展路径、密钥和视频记录。

也可手动设置：先运行 `codex mcp list --json`，找到 `doubao_local` 的 `transport.cwd`，然后将下面的 `<插件缓存绝对路径>` 替换为实际路径：

```powershell
node "<插件缓存绝对路径>\scripts\plugin-runtime.mjs" setup
node "<插件缓存绝对路径>\scripts\plugin-runtime.mjs" status
```

CLI 的 `plugin list --json` 返回插件身份和版本，实际目录可由 `codex mcp list --json` 中 `doubao_local` 的 `transport.cwd` 查到。`setup` 准备文件，`status` 只读诊断；在 Codex 调用 `doubao_status` 会自动准备连接，并检查 Chrome 扩展。不发送消息或消耗生成次数。首次设置要指定其他运行目录，可给 setup 加 `--bridge-root <运行目录绝对路径>`；之后复用已保存的绑定，不移动已有媒体。

安装了原生插件后，不需要再运行旧的 `scripts/install.ps1` 或 `codex mcp add`。旧版用户迁移时，先让首次设置复用旧 bridgeRoot，确认 `extensionDirectory` 正确，然后用 `codex mcp remove doubao_local` 移除旧的手工 MCP 配置；插件会提供同名 MCP。将旧的 `~/.codex/skills/doubao-chat` 移到 skills 目录之外备份，避免重复 Skill，再打开新任务检查连接。保留原运行目录、Chrome 扩展和素材；不要删除旧目录。

### 插件更新

```powershell
codex plugin marketplace upgrade xinyu68
codex plugin add codex-doubao-bridge@xinyu68
```

更新源并重新安装最新包后，在新任务中让 Codex 执行插件 setup 同步运行文件。密钥和媒体不被覆盖；扩展目录保持不变。如果扩展代码更新，在 Chrome 重新加载该扩展并刷新豆包页。后端更新时，setup 可以自动结束已核验、没有客户端或本机操作的托管连接。有活跃客户端时，先关闭使用旧版插件的 Codex 对话，等待连接退出，再运行 setup；尚未同步版本的 MCP 不会启动旧后端。

从0.4及更早版本升级时，旧版手工启动的服务不支持自动退出，需要先核对该安装 `.runtime/server.json` 与进程命令行，结束对应旧服务，再执行 setup。不会自动关闭其他 Node 服务或浏览器。

插件卸载仅移除 Codex 中的包，本机运行目录和素材保留。关闭仍在使用它的 Codex 对话后，托管连接会自动退出；正在运行的 MCP 客户端可能随 Codex 任务或应用持续存在，以 `lifecycle.clients` 为准。

## 独立安装（保留兼容）

不采用原生插件时，可在 PowerShell 执行以下命令，目录可自行选择，安装后请保留该目录：

```powershell
git clone https://github.com/xinyu68/codex-doubao-bridge.git
cd codex-doubao-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装脚本会：

- 在 `extension/config.js` 生成本机随机密钥；再次安装会保留原密钥
- 使用 `codex mcp add` 注册 `doubao_local`，保留其他 MCP 配置
- 将 Skill 安装到 `$CODEX_HOME/skills/doubao-chat`，未设置时使用 `~/.codex/skills/doubao-chat`，并生成本机目录绑定 `bridge-local.json`

接下来手动完成两步：

1. Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载本仓库的 `extension` 目录
2. 打开 [豆包](https://www.doubao.com/)，登录自己的账号；重新打开 Codex 任务以刷新 MCP 和 Skill

只安装 Skill 不会安装 MCP 或浏览器扩展。完成安装后告诉 Codex：“用豆包检查连接。”MCP 会自动启动或复用连接，无需运行启动脚本。连接进程正常运行时 `running=true`，扩展连接成功后 `connected=true`。扩展通常在一个心跳周期内重连，最多等待40秒后再检查。

## 使用

在 Codex 中可以这样说：

> 用豆包回答这个问题：……
>
> 把这项独立文字任务交给豆包，在新对话里完成：……
>
> 用豆包规划一条视频，先评估，不生成。
>
> 使用这些参考图，生成一个视频片段。先检查图片和网页参数，完成后下载并检查尾帧。

Skill 包含分镜素材检查、提示词组织、固定会话、生成次数控制、下载验收和续接流程。角色、画风、时长、音轨和字幕由当前视频项目决定，不固定在 Skill 中。

| 工具 | 用途 |
| --- | --- |
| `doubao_ask` / `doubao_delegate` | 问答 / 新对话独立文本任务 |
| `doubao_status` / `doubao_diagnostics` | 连接与版本诊断 |
| `doubao_media_tabs` / `doubao_media_session` | 查找豆包页 / 新建或绑定固定媒体会话 |
| `doubao_page` / `doubao_ui_click` | 检查真实网页控件 / 操作检查到的控件 |
| `doubao_upload_images` | 上传本地图片，核验已解码预览 |
| `doubao_video_submit` / `doubao_video_status` | 提交一次生成 / 查询原任务 |
| `doubao_video_adopt` | 登记网页已有视频，避免重新生成 |
| `doubao_video_download` / `doubao_video_tail` | 下载并验证 / 提取尾帧 |

完整媒体参数与 CLI 示例见 [媒体操作说明](README-media.md)，创作流程见 [视频 Skill](skills/doubao-chat/SKILL.md)。插件工具按 Codex 当前显示的名称调用，可能带插件命名空间。

## 连接原理与排查

```text
Codex → stdio MCP → 自动管理的共享本机连接 → Chrome 扩展 → 豆包网页
```

本机通信仍然存在，由 MCP 自动管理。每个 MCP 客户端保持一条认证连接；进程退出或崩溃时自动释放。客户端共用同一连接进程，网页操作继续串行执行。最后一个客户端离开后，等待正在上传、提交、查询、下载或提取尾帧的本机操作完成，再空闲30秒退出。Chrome 扩展本身不会让连接进程一直驻留。

豆包云端生成独立于本机进程。任务记录保存在 `media/jobs`，固定标签页绑定保存在扩展存储中；再次使用时恢复连接、查询同一 jobId，不会自动重新提交。若本机进程被强制终止，提交结果不明时仍需检查原任务，不能盲目重发。

通常直接让 Codex 调用 `doubao_status` 或 `doubao_diagnostics`。下面的命令仅用于开发和诊断，在真实运行目录下执行：独立安装是原仓库目录，插件安装是 setup/status 返回的 bridgeRoot/root。

```powershell
node .\service.mjs status  # 仅检查，不启动或发送消息
node .\service.mjs doctor  # 连接、版本与 FFmpeg 检查
node .\service.mjs run     # 可选：手工前台调试，用 Ctrl+C 结束
```

`status` 和 `doctor` 不启动连接。没有 MCP 客户端时显示 `running=false` 是正常现象。保留的 `service.mjs start` / `start-bridge.ps1` 仅兼容旧版手工调试，使用它们启动的进程不会随 MCP 自动退出；正常使用插件不需要它们。日志与启动记录保存在运行目录的 `.runtime`，其中 PID 可能属于已经退出的进程，不能直接据此结束进程。

- **`connected=false`**：先在 Codex 调用连接检查，再确认扩展已启用、豆包已登录，等待心跳重连。点击 Chrome 工具栏的 Local Doubao Bridge 图标可查看诊断面板；没有 MCP 客户端时显示未连接是正常现象
- **版本不一致 / 缺少 `mediaV1`**：在扩展管理页重新加载，再刷新豆包页
- **密钥不匹配 / 其他安装占用端口**：不重复启动，先检查已有服务与扩展来源。默认只使用 `127.0.0.1:8765`
- **后台页无法填写或发送**：将该视频会话的固定标签页放到前台；不改用用户另一个对话
- **视频下载验证失败**：检查 FFmpeg/ffprobe；可通过 `FFMPEG_PATH` / `FFPROBE_PATH` 指定程序路径
- **已有其他 `doubao_local`**：安装脚本默认拒绝覆盖。确实迁移时使用 `-ReplaceExisting`，先停掉旧服务，移除旧扩展，再加载新目录。旧 Skill 中被更新的文件会备份到 `.runtime/skill-backups`

自定义 Skill 目录：`scripts/install.ps1 -SkillHome <目录>`。只准备配置与 Skill、手动注册 MCP：加 `-SkipMcpRegister`，再执行 `codex mcp add doubao_local -- node <仓库绝对路径>/mcp-server.mjs`。

老版本如曾注册 `Doubao Chrome Bridge` 登录任务，可以在 PowerShell 禁用并停止该任务：

```powershell
Disable-ScheduledTask -TaskName 'Doubao Chrome Bridge'
Stop-ScheduledTask -TaskName 'Doubao Chrome Bridge'
```

确认旧服务已经退出后，让 MCP 自动连接。当前安装脚本不会注册或自动修改系统计划任务。

## 能力边界

- 通过扩展操作正常网页控件，不导出登录 Cookie，不使用 Chrome 调试端口，不调用付费视频 API
- 图片真正上传并显示已加载预览后才提交。普通多图参考不能替代严格首尾帧锁定；当前只支持 `reference` 和经控件核验的 `first_frame`，没有 `last_frame` 参数
- `duration` / `ratio` 在没有实际 UI 控件确认时属于提示词要求；以真实网页和下载视频为准
- 视频生成结果不明时查询同一任务，不自动新建生成尝试。豆包提示额度不足或拒绝生成时，记录并报告平台提示，不反复提交；用户主动设置的次数或预算上限仍需遵守
- 提示词约束无法保证静音、无字幕或人物一致，必须验收原片和尾帧，保留平台正常 AI 标识
- 只向用户授权的豆包对话发送任务。图片、提示词和网页回复会经过本机服务；上传与发送后也会交给豆包处理

扩展使用 tabs、scripting、storage、alarms 与 downloads 权限，主机范围限于豆包域名和本机回环地址。服务只监听 `127.0.0.1`，凭据由安装脚本生成并内部使用。不要将 `extension/config.js`、生成媒体、请求记录或运行日志上传 GitHub。

## 开发与测试

```powershell
npm test
```

无需 `npm install`，运行代码只依赖 Node.js 内置模块。测试覆盖传输、图片上传预览、固定会话、草稿保护、任务去重、下载和尾帧处理，以及自动连接、多客户端共用、客户端崩溃释放、操作完成后退出、任务恢复、插件设置和升级保留数据。FFmpeg 相关测试需要本机工具可用。测试使用临时目录和独立端口，不向豆包提交生成。

插件入口为根目录 [plugin.json](plugin.json) 和 [mcp.json](mcp.json)，GitHub 插件源为 [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)。目录结构遵循 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。这是通过 GitHub 源分发的本地 Codex 插件；尚未提交到官方公共插件目录，也不能作为 ChatGPT 网页端的远程插件安装。

参考项目：[ai-bridge](https://github.com/SoulChildTc/ai-bridge)、[doubao-mcp](https://github.com/xiaodao00266/doubao-mcp)、[AutoDoubao](https://github.com/linxxcat000/autodoubao)、[browser-bridge](https://github.com/whg517/browser-bridge)。本项目保留自己的扩展与本机服务实现，参考这些项目的连接、会话和诊断设计。

本项目采用 [MIT License](LICENSE)。
