# 豆包网页媒体桥接 0.3.1

通过已登录豆包网页的正常附件和视频控件操作，不读取/导出Cookie，不调用官方付费API。

## 更新生效

在Chrome打开 chrome://extensions，找到 Local Doubao Bridge，点“重新加载”，然后刷新豆包网页。新增的 downloads/storage 权限用于下载成片和固定标签页；如Chrome停用了扩展，按界面提示重新启用。

桥接服务的 /v1/health 应显示 extensionVersion=0.3.1 和 mediaV1。后台脚本与权限不会因保存文件自动更新。

## 调用

MCP工具列表刷新后可使用新工具。当前对话尚未发现新工具时，可以使用同一后端的CLI：

~~~powershell
node .\media-cli.mjs --request .\requests\tabs.json
node .\media-cli.mjs --request .\requests\session.json
~~~

这些 request 文件由调用方创建；例如 tabs.json 内容为 `{"operation":"tabs"}`，session.json 内容为 `{"operation":"session"}`。CLI读取request.json；客户端内部使用已有认证配置，不把密钥放在命令或输出中。

| operation | MCP工具 | 作用 |
| --- | --- | --- |
| tabs | doubao_media_tabs | 列出已打开豆包标签页 |
| session | doubao_media_session | 新开独立后台标签页；可传tabId绑定已有页 |
| inspect | doubao_page | 读取上传控件、按钮、下拉框、真实视频元素 |
| click | doubao_ui_click | 点击检查得到的唯一控件 |
| upload | doubao_upload_images | 上传真实本地图片，确认已加载缩略图 |
| submit | doubao_video_submit | 提交一次带图视频请求，保存jobId |
| status | doubao_video_status | 读取已有任务媒体状态，不发送新消息 |
| adopt | doubao_video_adopt | 明确登记已在网页生成的视频，不重新生成 |
| download | doubao_video_download | 浏览器下载，验证后复制到工作区 |
| tail | doubao_video_tail | 用FFmpeg提取已下载视频的最后一帧 |

创建session后，所有媒体操作固定到其标签页，不跟随用户活跃页。接续已有成片时，可先tabs查明tabId，再session绑定该页。

## 先传图，再生成

先inspect具体session。输入不唯一时，提供检查得到的inputSelector；上传菜单未展开时可提供uploadTriggerSelector。不能猜测未检查的选择器。

~~~json
{
  "operation":"upload",
  "sessionId":"实际返回的sessionId",
  "imagePaths":["D:/video-project/references/character.png"],
  "imageRole":"reference"
}
~~~

上传只有在检测到已加载的附件缩略图后才返回loaded_preview，不会仅因FileList赋值就声称完成。上传不提交视频。普通参考图为reference；first_frame必须找到标为首帧/起始帧的文件输入，不能把普通附件当成锁定首帧。

~~~json
{
  "operation":"submit",
  "sessionId":"实际返回的sessionId",
  "imagePaths":["D:/video-project/references/character.png"],
  "imageRole":"reference",
  "duration":5,
  "ratio":"9:16",
  "idempotencyKey":"episode001-reference-test-attempt01",
  "prompt":"只用参考图左侧的女店主，保持人物和画风，在小店柜台后轻轻翻开空白账本。固定中景、均匀光照，只做一个动作。"
}
~~~

刚刚已经upload时，submit可省略imagePaths，复用当前已确认的附件。编辑框有未发送草稿时会停止，不覆盖草稿。

同一个idempotencyKey与相同参数返回已有jobId；服务重启后仍会加载原任务。未知结果记录为unknown，不能自动新建尝试。只有故意重做时才换新key。

duration/ratio未配置网页控件时是提示词要求，返回parameterControl=prompt_only，不能宣称网页参数已锁定。可先inspect，再传controls，每项包含selector；select使用value，其他下拉框还要提供optionSelector。

~~~json
{"operation":"status","jobId":"实际返回的jobId"}
{"operation":"download","jobId":"实际返回的jobId"}
{"operation":"tail","jobId":"实际返回的jobId"}
~~~

status的ready依据是新增、带真实源且元数据可读的视频元素，不是“稍后发送”的文字。切换对话返回conversation_mismatch。仅有封面时先inspect，再click实际播放入口展开播放器。

download使用Chrome正常下载，先保存到Downloads/DoubaoBridge，再经ffprobe验证并复制到media/jobs/<jobId>/video.mp4。下载尚未完成时继续调用同一jobId，不重复下载。返回实际时长/尺寸及其与请求是否匹配。

tail生成media/jobs/<jobId>/tail.png，可上传到下一段的真实首帧入口。提取末帧不会自动保证它清晰、人物无变形，续接前仍需查看。

已有视频可登记后下载，不消耗生成次数：

~~~json
{"operation":"adopt","sessionId":"实际返回的sessionId","videoIndex":0}
~~~

videoIndex来自inspect的videos顺序。

## 验收边界

代码不购买服务、不点击支付控件、不自动追加失败生成重试。提示词要求仅使用每日免费次数，但不能据此声称已核验免费额度；剩余次数及扣减方式仍以账号实际界面为准。

原有文字问答与委派保留。新媒体能力的本地测试涵盖大图片传输、真实File字节、附件预览、串线、不覆盖草稿、并发重试、未知结果和实际尾帧提取。网页上传控件和视频卡片需要重载扩展后的实测，本地测试不能替代真实网页验收。

Chrome权限依据：[下载API](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[存储API](https://developer.chrome.com/docs/extensions/reference/api/storage)。图片使用[DataTransfer文件列表](https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer/files)进入正常文件输入控件。

## 0.3.1 的开源改造

参考开源项目的连接与诊断思路完善了固定会话、版本核对和图片预览验证；参见仓库 README 的参考项目。

先创建内容为 `{"operation":"diagnostics"}` 的请求文件，再运行 `node .\media-cli.mjs --request <该文件路径>` 核对版本与目录；工具列表刷新后也可调用 `doubao_diagnostics`。该操作只读，不上传、不发送提示词。即使仍连接旧扩展，它也能返回版本差异和正确加载目录。

工具栏新增诊断面板，可查看扩展/后台/网页版本。以后更新已采用版本控制的网页脚本，可通过“更新网页脚本”重新注入；从 0.2.x 升级需要刷新豆包页一次，避免旧消息监听器重复响应。更新后台文件仍需重载扩展。

上传自动选择器优先使用聊天输入区中的唯一图片输入，页面检查会标注 `inComposer`。参考图片预览也限定到输入区域。仍需在真实网页确认 `loaded_preview`，再提交视频任务。
0.3.1 的附件确认会排除 SVG 占位图和界面图标，并触发后台标签页中真实缩略图的延迟加载。`attachments` 返回实际尺寸、加载方式与占位分类，便于复核。只有真实图片已解码，才返回 `loaded_preview`。

网页修订值位于 `extension/build.json` 与 `extension/version.js`，两者更新时保持一致。同版本的网页适配更新可自动重新注入；后台脚本或 manifest 的更新仍需 Chrome 重载扩展。
## 专用视频界面与免费限制

时长滑块的上限不代表当前账号的免费上限。每次生成前核验模型、免费额度、时长和画幅；以当前账号实际界面为准。出现超出授权的会员或付费要求时停止，不自动开通服务。请求参数不替代实际 UI 确认。

专用视频模式在后台标签页可能将编辑器设为 visibility:hidden，需要将固定测试页切到Chrome前台。页面检查新增 composerControls、panels，用于读取真实输入区与参数弹层；uiClick 适配弹出菜单需要的指针事件。

CLI click可附带 key=ArrowLeft/ArrowRight/Home/End，但仅限真实检查到的role=slider控件。当前网页键盘调整只更新滑块临时值，主时长设置仍需用户拖动并核对，不能声称已自动应用。