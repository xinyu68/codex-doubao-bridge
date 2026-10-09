---
name: doubao-chat
description: "通过已登录豆包网页进行问答、独立文本委派，以及参考图和多图分镜视频生成、下载与续接。视频任务包含素材检查、额度控制和成片验收；仅评估时不提交生成。不用于官方豆包 API 集成。"
---

# 豆包网页桥接

安装后读取本技能目录中的 bridge-local.json，取得 bridgeRoot 和 mcpServer；不把发布仓库示例路径当作本机路径。若该文件缺失，按仓库 README 运行 scripts/install.ps1 完成桥接与 Skill 安装，仅复制 Skill 不会安装服务和扩展。
MCP 默认名称：doubao_local。首次实际调用前按下方“连接与按需启动”检查服务。网页使用用户已有登录状态，不读取或输出 extension/config.js 密钥，不通过 Chrome 调试协议绕过扩展。

## 文字任务

- 用户要求问豆包时用 doubao_ask；仅在用户要求独立/新对话时设置 newChat
- 用户明确委派一项独立文本任务时用 doubao_delegate；任务不能访问本地文件或工作区
- 不自行扩展为多轮咨询；不得把首页文案、侧栏或草稿当作回复
- doubao_status 用于连接诊断，不能替代答案

## 图片与视频

用户要求规划、评估、生成、测试或续接豆包视频时，先读 [视频制作流程](references/video-workflow.md)，按当前任务选择准备、生成或验收环节。仅评估不自动上传或提交。实际生成使用媒体接口，不把本地图片路径写入文字当作上传。详细操作和参数见 [媒体操作说明](references/media-tools.md)。

- 用 doubao_media_session 新开固定后台标签页；接续已有视频时，先用 doubao_media_tabs 查明具体标签页，再明确绑定 tabId。媒体操作不跟随用户活跃标签页
- 用 doubao_page 核实上传入口与参数控件。只有从真实页面检查得到的 selector 才可用于 doubao_ui_click 或控件参数
- 用 doubao_upload_images 上传用户提供或任务中制作并已检查的本地图片，确认图片数量、顺序与 loaded_preview。普通参考图与首帧分别使用 reference / first_frame，不能把普通附件当作已锁定首帧
- 生成用 doubao_video_submit，提供固定 sessionId、图片、prompt、时长/比例和该次尝试唯一的 idempotencyKey。先确认已有参考图，再提交；任务结果不明时复用同一个 key 查询，不盲目重发
- 用 doubao_video_status 查询真实视频元素，不发送新提示词，不把“稍后发送”“已经生成”的文字承诺当作成片
- 已在网页生成但不在任务记录里的视频，可用 doubao_video_adopt 明确选取现有视频；这不消耗生成次数
- 用 doubao_video_download 下载、验证成片；未完成时查询同一 jobId。用 doubao_video_tail 提取尾帧，查看人物、光影和道具合格后再用于后续片段，不自动把提取成功当作可续接
- 若未设置实际 UI 参数控件，返回 parameterControl=prompt_only；时长/比例仅为提示词要求，应以下载后的验证值为准
- 只执行用户授权的生成范围，遵守其免费次数或花费约束。调研/检查/上传不自动触发生成；超时后不默认追加一次生成
- 若新 MCP 工具尚未刷新，使用同一目录的 media-cli.mjs --request <JSON文件>，客户端内部使用已有桥接配置，不手工读取密钥

## 连接与按需启动

不依赖 Windows 计划任务，也不创建开机自启。安装目录来自 bridge-local.json；服务辅助脚本内部读取配置，不输出密钥。

1. 每次开始实际豆包操作前，在 bridgeRoot 下执行 `node service.mjs status`；只有 `running=false` 时执行 `node service.mjs start`，或用 PowerShell 运行该目录的 start-bridge.ps1。start 会复用当前服务，在后台隐藏启动，返回状态；仅评估且不需要网页检查时不必启动
2. 401、密钥不匹配、其他安装占用端口或连接超时不等于服务未启动；先报告诊断，不重复启动、不自动改密钥、不调用计划任务
3. 服务运行但 `connected=false` 时，最多等待40秒供 Chrome 扩展心跳重连；仍未恢复时核对扩展启用状态和已登录的豆包页。`node service.mjs doctor` 还可检查 FFmpeg/ffprobe，文字问答不需要它们
4. mediaV1 未连接或版本不一致时，在 chrome://extensions 重新加载 Local Doubao Bridge，再刷新豆包页面。后台标签页隐藏编辑器时，请用户将固定任务页置于前台，不通过私有接口或调试协议绕过
5. 对已授权且确定没有提交的问题最多重试一次。生成结果不明时保留 jobId/idempotencyKey，查原任务；不能自动新建另一生成请求

服务按需启动后保持运行，便于查询长视频任务与下载；不自动注册登录任务、关闭用户 Chrome 或停止其他 Node 服务。启动检查不会发送豆包消息或消耗生成额度。

## 视频制作与复用

- 按任务需要准备角色图、场景图或分镜图，先检查图片，再让模型生成动作；图片数量与镜头数量按内容选择，不作为固定配额
- 识别每张图的用途与顺序，普通多图参考不能声称已严格锁定起止画面。现有桥接只支持 reference / first_frame，不虚构 last_frame 参数；更多网页控制能力先实际检查
- 记录用户说明的额度与网页实际显示的额度及来源，不混为已核验值；免费任务出现次数耗尽或付费要求时停止生成，已授权使用的额度按预算控制
- 技能组织操作与验收；人物、画风、片长、声音、模型、额度和脚本保存在当前视频项目中，沿用用户已表达的选择
- 验证粒度和实际完成范围要写清楚。原计划缺镜或画面待返工时，只交付明确标注的草稿，并保存待办
