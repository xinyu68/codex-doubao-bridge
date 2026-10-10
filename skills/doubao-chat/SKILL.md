---
name: doubao-chat
description: "通过已登录豆包网页进行问答、独立文本委派，以及参考图和多图分镜视频生成、下载与续接。视频任务包含素材检查、生成任务跟踪和成片验收；仅评估时不提交生成。不用于官方豆包 API 集成。"
---

# 豆包网页桥接

先确定安装方式：本技能目录有 bridge-local.json 时读取其中的 bridgeRoot 和 mcpServer，这是旧版独立安装；没有该文件时，从本 SKILL.md 的真实绝对路径取两级父目录作为 pluginRoot，确认存在 plugin.json 和 scripts/plugin-runtime.mjs，执行 `node <pluginRoot>/scripts/plugin-runtime.mjs status` 取得 bridgeRoot（返回字段 root）。configured=false 时运行插件中的 doubao-setup Skill；needsSetup=true 时重新执行 setup，保留稳定运行目录。不把发布仓库示例路径或插件缓存当作运行目录。只有单独复制的 Skill、没有完整插件时，按仓库 README 运行 scripts/install.ps1。
MCP 基础名称：doubao_local；插件会添加命名空间，按当前工具列表选择对应的 doubao_* 工具，不重复注册 standalone MCP。首次实际调用前按下方“自动连接与诊断”检查连接。网页使用用户已有登录状态，不读取或输出 extension/config.js 密钥，不通过 Chrome 调试协议绕过扩展。

## 文字任务

- 用户要求问豆包时用 doubao_ask；仅在用户要求独立/新对话时设置 newChat
- 用户明确委派一项独立文本任务时用 doubao_delegate；任务不能访问本地文件或工作区
- 不自行扩展为多轮咨询；不得把首页文案、侧栏或草稿当作回复
- doubao_status 用于连接诊断，不能替代答案

## Windows 中文传参

- 优先调用 MCP 工具的结构化参数，不用临时 PowerShell 管道手写 MCP stdin，也不把复杂中文提示词拼进 `node -e`。现有 MCP 和媒体 CLI 按 UTF-8 读写，不能恢复在进入 Node.js 前已变成问号的文字
- Windows PowerShell 5.1 的 `$OutputEncoding` 默认可能为 ASCII，`中文 JSON | node ...` 会把中文替换为 `?`；仅设置 `chcp 65001` 或 `[Console]::OutputEncoding` 不能代替管道输入编码。必须用原生命令管道时，在该次调用内将 `$OutputEncoding` 设为 `[System.Text.UTF8Encoding]::new($false)`，并在 finally 恢复原值，不修改系统设置或用户 profile
- 媒体 CLI 备用调用采用 UTF-8 JSON 请求文件：读文件显式指定 UTF-8，写文件显式使用 UTF-8，再执行 `media-cli.mjs --request <绝对路径>`；不用默认 `>` / Out-File 写请求文件。具体示例见 [媒体操作说明](references/media-tools.md#windows-中文请求文件)。简单文字备用调用可用 `node <bridgeRoot>/cli.mjs $taskPrompt` 直接传参数，避免管道
- 已知原文包含中文时，发送前对比原始字符串与本地回读结果。发现字符被替换为问号或乱码就先修复，不能把损坏内容发给豆包；用户原文中的正常问号不属于编码错误
- 连通性测试与中文测试分别记录：纯数字或英文的正确回复不证明中文传输正常。修复编码先离线验证；只有用户已授权中文问答测试时才实际发送，不为编码检查追加视频生成或其他消息

## 图片与视频

用户要求规划、评估、生成、测试或续接豆包视频时，先读 [视频制作流程](references/video-workflow.md)，按当前任务选择准备、生成或验收环节。仅评估不自动上传或提交。实际生成使用媒体接口，不把本地图片路径写入文字当作上传。详细操作和参数见 [媒体操作说明](references/media-tools.md)。

- 用 doubao_media_session 新开固定后台标签页；接续已有视频时，先用 doubao_media_tabs 查明具体标签页，再明确绑定 tabId。媒体操作不跟随用户活跃标签页
- 后台页面隐藏编辑器时先用 doubao_media_focus 激活固定任务页；它会选中该标签页并聚焦 Chrome 窗口，不切换对话、不刷新、不发送。只读检查和等待状态不反复抢占前台
- 用 doubao_page 核实上传入口与参数控件，默认返回精简信息；需要深查 DOM 时指定 detail=full。只有从真实页面检查得到的 selector 才可用于 doubao_ui_click 或控件参数；该工具不点击生成/发送或支付按钮
- 优先使用 doubao_video_prepare：激活固定页，应用检查得到的 controls，读回实际模型/时长/比例，再上传参考图。只有返回 prepared 才能声称参数已核验；needs_manual_settings 时按返回页面检查控件、设置后再准备。自动画幅无法读出具体比例时不当作已锁定 9:16
- 用 doubao_upload_images 上传用户提供或任务中制作并已检查的本地图片，确认图片数量、顺序与 loaded_preview。普通参考图与首帧分别使用 reference / first_frame，不能把普通附件当作已锁定首帧
- 生成用 doubao_video_submit，提供固定 sessionId、prompt、时长/比例和该次尝试唯一的 idempotencyKey。已 prepare 后沿用相同设置、model 和图片，设置 requirePrepared=true，通常无需再传 imagePaths。检查与提交分开，只在用户授权生成时提交
- 明确 preflight_failed 且 sendAttempted=false、retrySafe=true 时，先修复草稿、前台或参数问题；最多用原 key、原参数加 retryPreflight=true 继续一次，不新建尝试。unknown 或其他结果不明时查询原 jobId；retryPreflight 不会重发 unknown 任务
- silent=true / noText=true 仅在用户或当前项目要求静音、无字时传入，默认不追加这些限制。声音和文字仍是提示词偏好，不能当作成片保证
- 用 doubao_video_status 查询真实视频元素，不发送新提示词，不把“稍后发送”“已经生成”的文字承诺当作成片
- quota_exhausted、rejected、failed 时停止生成和自动重试，记录平台原因；多条新视频不明确属于哪条任务时返回 needs_recovery，明确选取后 adopt，不能随意取第一条
- 用 doubao_video_jobs 读取任务概览，可按 sessionId 筛选；它区分提交确认、采用旧片和已下载，返回真实原片时长，不推算剩余额度。概览不能替代逐镜验收，也不能把 adopted 当作本次新生成
- 已在网页生成但不在任务记录里的视频，可用 doubao_video_adopt 明确选取现有视频；这不消耗生成次数
- 用 doubao_video_download 下载、验证成片；未完成时查询同一 jobId。用 doubao_video_tail 提取尾帧，查看人物、光影和道具合格后再用于后续片段，不自动把提取成功当作可续接
- 若未设置实际 UI 参数控件，返回 parameterControl=prompt_only；时长/比例仅为提示词要求，应以下载后的验证值为准
- 只执行用户要求的生成范围，使用当前账号现有权益；不默认要求只用免费额度，也不要求用户先声明免费或付费账号。用户主动设置次数或预算上限时遵守。调研/检查/上传不自动触发生成；超时后不默认追加一次生成
- 若新 MCP 工具尚未刷新，使用同一目录的 media-cli.mjs --request <JSON文件>，客户端内部使用已有桥接配置，不手工读取密钥

## 自动连接与诊断

MCP 自动启动或复用共享连接，多个 Codex 对话使用同一进程。不要要求用户启动桥接服务或运行 start 脚本，不创建计划任务或开机自启。配置目录来自独立安装的 bridge-local.json 或插件 status 返回的 root；状态命令只读诊断，running=false 在没有 MCP 客户端时是正常状态。

1. 每次开始实际豆包操作前调用 doubao_status，连接由 MCP 自动准备。仅评估且不需要网页检查时无需调用。当前工具尚未刷新时可用同一运行目录的 media-cli.mjs 执行只读媒体操作，其 MCP 客户端也会自动连接
2. 401、密钥不匹配、其他安装占用端口或连接超时先报告诊断，不自动改密钥、不手工启动第二份服务。若提示旧版服务尚在运行，核对该安装的进程路径，只处理它并重新执行 setup
3. `connected=false` 时，最多等待40秒供 Chrome 扩展心跳重连；仍未恢复时核对扩展启用状态和已登录的豆包页。`node service.mjs doctor` 还可检查 FFmpeg/ffprobe，文字问答不需要它们
4. mediaV1 未连接或版本不一致时，在 chrome://extensions 重新加载 Local Doubao Bridge，再刷新豆包页面。focus/prepare 需要扩展 0.4.0 的 mediaWorkflowV2 能力；未连接该能力先更新。后台页面先用 doubao_media_focus，仍隐藏编辑器时再说明观察到的问题，不通过私有接口或调试协议绕过
5. 对已授权且确定没有提交的问题最多重试一次。生成结果不明时保留 jobId/idempotencyKey，查原任务；不能自动新建另一生成请求

MCP 退出或崩溃会释放自己的连接；最后一个客户端离开且本机操作完成30秒后共享进程自动退出。已提交的豆包云端生成继续运行，jobId/idempotencyKey 保存在运行目录，固定标签页绑定保存在扩展中。重新连接后查询原任务，不重新提交。连接检查不会发送豆包消息或消耗生成额度；不关闭用户 Chrome 或其他 Node 服务。

## 视频制作与复用

- 按任务需要准备角色图、场景图或分镜图，先检查图片，再让模型生成动作；图片数量与镜头数量按内容选择，不作为固定配额
- 识别每张图的用途与顺序，普通多图参考不能声称已严格锁定起止画面。现有桥接只支持 reference / first_frame，不虚构 last_frame 参数；更多网页控制能力先实际检查
- 提示词不自动添加“仅使用免费额度”等限制；豆包提示额度不足或拒绝生成时，记录并报告平台提示，不反复提交。已有付费权益可以直接使用，不自行购买、充值或开通会员
- 技能组织操作与验收；人物、画风、片长、声音、模型、额度和脚本保存在当前视频项目中，沿用用户已表达的选择
- 验证粒度和实际完成范围要写清楚。原计划缺镜或画面待返工时，只交付明确标注的草稿，并保存待办
