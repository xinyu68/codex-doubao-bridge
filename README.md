# Codex Doubao Bridge

让 Codex 使用你已经登录的豆包网页：文字问答、独立文本委派、上传参考图、生成和下载视频、提取尾帧辅助续接。包含 Chrome 扩展、本机桥接服务、MCP 工具和 `doubao-chat` Skill。

服务按需启动，不创建 Windows 计划任务或开机自启。不需要豆包 API Key；使用你的豆包账号现有权益，支持免费账号和已开通付费权益的账号。实际可用的模型、次数和时长以账号界面为准，桥接不限制为免费模式，也不能保证生成画面的连贯性。

目前安装与启动流程在 **Windows + Chrome + Codex** 上验证。网页自动化会受到豆包界面变化影响；本项目不是豆包官方客户端。

## 安装

准备 Node.js 20 或更新版本、Git、Chrome，以及能够运行 `codex` 命令的 Codex 安装。视频下载验证和尾帧提取还需要 PATH 中有 `ffmpeg` 和 `ffprobe`；文字问答不需要它们。

在 PowerShell 执行，目录可自行选择，安装后请保留该目录：

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

只安装 Skill 不会安装桥接服务或浏览器扩展。首次安装不启动服务；需要连接检查时可运行：

```powershell
.\start-bridge.ps1
node .\service.mjs doctor
```

也可以告诉 Codex：“用豆包检查连接，服务没启动就先启动。”Skill 会先检查，再按需启动。服务正常运行时 `running=true`，扩展连接成功后 `connected=true`。扩展通常在一个心跳周期内重连，最多等待40秒后再检查。

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

完整媒体参数与 CLI 示例见 [媒体操作说明](README-media.md)，创作流程见 [视频 Skill](skills/doubao-chat/SKILL.md)。

## 启动与排查

```powershell
node .\service.mjs status  # 仅检查，不启动或发送消息
node .\service.mjs start   # 已运行则复用，未运行才隐藏启动
node .\service.mjs doctor  # 连接、版本与 FFmpeg 检查
node .\service.mjs run     # 前台运行，可用 Ctrl+C 结束
```

后台启动的服务保持运行，以便等待长任务和下载；退出 Codex 不自动停止服务，Windows 重启后不会自行启动。日志与启动 PID 保存在 `.runtime`，需要手动结束时先核对启动返回的 PID 和进程路径；不要批量结束 Node 进程。

- **`connected=false`**：确认扩展已启用，豆包已登录，等待心跳重连。点击 Chrome 工具栏的 Local Doubao Bridge 图标可查看诊断面板
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

确认旧服务已经退出后，再按需启动。当前安装脚本不会注册或自动修改系统计划任务。

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

无需 `npm install`，运行代码只依赖 Node.js 内置模块。测试覆盖传输、图片上传预览、固定会话、草稿保护、任务去重、下载和尾帧处理，以及按需启动和安装配置。FFmpeg 相关测试需要本机工具可用。测试使用临时目录和独立端口，不向豆包提交生成。

参考项目：[ai-bridge](https://github.com/SoulChildTc/ai-bridge)、[doubao-mcp](https://github.com/xiaodao00266/doubao-mcp)、[AutoDoubao](https://github.com/linxxcat000/autodoubao)、[browser-bridge](https://github.com/whg517/browser-bridge)。本项目保留自己的扩展与本机服务实现，参考这些项目的连接、会话和诊断设计。

本项目采用 [MIT License](LICENSE)。
