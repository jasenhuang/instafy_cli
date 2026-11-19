# instafy

调用 `novel` 机器上 ComfyUI 服务的命令行工具：给一段提示词（可选参考图 / 视频 / 音频、指定工作流），拿到图片或视频。

默认连 `http://127.0.0.1:8188`，也可以把地址写进 `~/.instafy.json`，或用 `--url` / `INSTAFY_COMFY_URL` 临时覆盖。默认地址不是本机时请把 ComfyUI 监听在可访问地址上，或自己先做端口转发。

## 依赖

- Node.js ≥ 20（用到内置 `fetch` / `FormData`）
- 能访问 ComfyUI 的 HTTP 地址（默认 `http://127.0.0.1:8188`，可用 `~/.instafy.json` 或 `--url` 改）
- `sync` 通过 HTTP API 读取工作流，不需要远端 Python 转换脚本

## 安装

```bash
pnpm install
pnpm build
npm link             # 之后可直接使用 instafy 命令（pnpm 全局 bin 目录未初始化时用 npm）
```

不 link 也可以：`node dist/cli.js ...`，或 `pnpm dev ...`（tsx 直接跑源码）。

## 用法

```bash
instafy image "一只戴墨镜的橘猫，棚拍质感"
instafy image --ref ./me.jpg "把背景换成东京夜景，保留人物姿态"
instafy image -r ./a.jpg -r ./b.jpg "让图1的人物穿上图2的外套"
instafy video --prompt "海边日落，镜头缓慢推进" --seconds 5
instafy video --ref ./start.png "人物慢慢转头看向镜头" --width 640 --height 640
instafy video -rv ./pose.mp4 -ra ./bgm.mp3 --ref ./first.png -p "镜头跟随人物"   # 参考视频 + 音频 + 图
instafy run wan/wan_animate2_v2v --ref ./first.png --ref-video ./pose.mp4 -p "人物跳舞"
instafy workflows            # 按远端目录列出工作流及可调参数
instafy run zimage_turbo_t2i -p "雪夜小木屋" --steps 6 --json
```

生成结果默认存到 `./outputs/`（`-o/--out` 可改），成功时 stdout 每行一个文件路径，进度日志走 stderr。

### 异步提交与轮询

`-a/--async` 提交完就退出，不阻塞等结果；stdout 打印 `prompt_id`。之后用 `instafy status <prompt_id>` 查进度，或加 `--wait` 轮询到完成并下载：

```bash
instafy image -p "赛博朋克夜市" -a            # 提交后立刻返回，stdout 是 prompt_id
instafy video -r ./start.png -p "缓慢推进" -a --json   # JSON 里也是 promptId
instafy status 3f1c0d2e                       # 查一次：执行中 / 排队中（第 N 位）/ 已完成
instafy status 3f1c0d2e --wait                # 轮询直到完成，自动下载到 --out
instafy status 3f1c0d2e --wait --json --timeout 600
```

- `status` 不带 `--wait` 只查一次就退出，适合自己写循环轮询（`while` + `sleep`）；带 `--wait` 则内部每 15 秒查一次，到 `--timeout` 还没完成就报错，错误信息里带上 `prompt_id`。
- 任务完成后再查会直接下载结果；同一个 `prompt_id` 重复查不会产生 `-2`、`-3` 副本，已存在的文件直接复用路径。
- `prompt_id` 既不在队列也不在历史时直接报错（id 写错，或 ComfyUI 重启后历史被清理）。

### 参数

| 参数 | 说明 |
| --- | --- |
| `-p, --prompt <文本>` | 提示词，也可以直接跟在 `image` / `video` 后面 |
| `-r, --ref <文件>` | 参考文件，可重复；按扩展名自动分流成图片 / 视频 / 音频（`.mp4`/`.mov`/`.webm` 等算视频，`.mp3`/`.wav`/`.m4a` 等算音频，其余算图片）。顺序对应工作流声明的 `image1..image10`，统一上传到 `input/instafy/`；没传到的槽位会连同对应 `LoadImage` 一起剪掉，不会回退到工作流里的默认图 |
| `--ref-video <文件>`（`-rv`） | 参考视频，可重复，最多 3 个（顺序对应 `video1..video3`，写进 `LoadVideo` 的 `file` 字段） |
| `--ref-audio <文件>`（`-ra`） | 参考音频，可重复，最多 3 个（顺序对应 `audio1..audio3`，写进 `LoadAudio` 的 `audio` 字段） |
| `-n, --negative <文本>` | 反向提示词（部分工作流支持，如 Wan 视频、Z-Image） |
| `-w, --workflow <名称\|路径>` | 工作流名称（如 `zimage_turbo_t2i`）、相对路径（如 `wan/wan2_2_14B_t2v`），或 JSON 文件路径 |
| `--width` / `--height` | 输出尺寸；视频要求 16 的倍数 |
| `--seed` | 随机种子，默认随机并打印出来 |
| `--steps` | 采样步数（图像工作流） |
| `--cfg` | CFG 强度（工作流声明了 `instafy:cfg` 才生效） |
| `--seconds` / `--fps` | 仅视频：时长与帧率，帧数 = seconds × fps + 1 |
| `--timeout <秒>` | 等待上限，默认 1800（可配置） |
| `--url <地址>` | ComfyUI 地址，默认 `http://127.0.0.1:8188`（可配置） |
| `--json` | 输出 JSON（工作流、prompt_id、种子、耗时、文件列表；`--async` 时只有 `status: "queued"`） |
| `-a, --async` | 提交后立即返回，不等结果；stdout 打印 `prompt_id` |
| `--wait` | 仅 `status`：轮询直到完成并下载 |

### 配置

`~/.instafy.json` 可以放默认值，只写需要的字段：

```json
{
  "url": "http://127.0.0.1:8188",
  "out": "~/instafy-outputs",
  "workflowsDir": "~/instafy-workflows",
  "timeout": 1800,
  "defaults": {
    "image": "qwen_image_2_1_t2i",
    "imageRef": "qwen_image_2_1_image_edit",
    "video": "minimax_h3_i2v",
    "videoRef": "minimax_h3_i2v"
  }
}
```

| 字段 | 说明 | 默认 | 命令行覆盖 |
| --- | --- | --- | --- |
| `url` | ComfyUI 地址 | `http://127.0.0.1:8188` | `--url`（另有 `INSTAFY_COMFY_URL`，优先级高于配置） |
| `out` | 输出目录，支持 `~` 开头 | `./outputs` | `--out` |
| `workflowsDir` | 工作流目录（`sync` 写入、运行时加载），支持 `~` 开头 | `./workflows`（CLI 执行目录） | — |
| `timeout` | 等待上限（秒） | `1800` | `--timeout` |
| `defaults` | 默认工作流，见下方 | 见「默认工作流」 | `--workflow` |

`defaults` 的四个键对应四种场景：`image`（无 `--ref`）、`imageRef`（带 `--ref`）、`video`、`videoRef`。配置的名字不存在或类型不对（比如给 `video` 配了个 image 工作流），会在 stderr 提示一句然后退回内置默认；名字存在但需要参考图时照常选中；不带 `--ref` 时参考槽位会被剪掉直接跑，只有剪完连输出节点都没了才报错。

规则：命令行 > 配置 > 默认。配置文件不存在就用全部默认值；JSON 不合法、字段类型不对或地址格式错误会直接报错，并在错误里带上配置文件路径，不会静默回退。

## 默认工作流

工作流全部来自 `instafy sync`（远端 `~/ComfyUI/user/default/workflows`）。不带 `--workflow` 时按类型自动挑一个：

| 场景 | 默认工作流 | 可调参数 |
| --- | --- | --- |
| 文生图 | `qwen_image_2_1_t2i` | `--negative --steps --cfg --seed` |
| 改图（带 `--ref`） | `qwen_image_2_1_image_edit` | `--negative --width --height --steps --cfg --seed`（最多 10 张参考图） |
| 视频 | `minimax_h3_i2v`（需 `--ref`） | `--seconds --fps --steps --seed` |

`minimax_h3_i2v` 不带 `--ref` 时会剪掉参考槽，这类工作流剪完通常跑不通（会提示输出节点被牵连删除），不会退到 Wan。想在无参考图时跑纯文生视频，用 `--workflow wan2_2_14B_t2v`（或把 `defaults.video` 改成它）。想用 `minimax_h3_r2v`（参考图生视频）把 `defaults.videoRef` 改成 `"minimax_h3_r2v"`。

这几个只是按名称优先挑的；远端改名/删除后会自动退到同类型（且参考文件种类/数量能对上的）里按名称排序的第一个。想固定用哪个就加 `--workflow`，或在 `~/.instafy.json` 的 `defaults` 里改。

`instafy workflows` 的 `img` / `vid` / `aud` 列是工作流声明的参考槽位数（`×N` 表示多路）。没传的槽位在提交前直接剪掉（不会回退到工作流里的默认文件），某类一个都没传时 stderr 会提示一句；整份参考文件都没传也允许提交：自动增长型输入组（qwen 文本编码节点的 `images.*`）缺省即 0 张参考图；剪掉参考槽后输出节点被牵连删除时才会报错。图片最多 10 张，视频/音频各最多 3 个。比如 `minimax_h3_r2v` 显示 `img×9 aud×3`，可以只给一张图，音频槽位会被剪掉。

实测（A30 24G）：Qwen 文生图约 1.5 分钟，改图约 40 秒；Wan 2.2 的 2 秒 480×480 视频约 25 秒；MiniMax H3 的 2 秒视频约 6 分钟（模型很重，首次还要加载）。

## 同步远端工作流

把 ComfyUI `~/ComfyUI/user/default/workflows` 里（含子目录）的 UI 格式工作流，用 CLI 内置的转换器（`src/convert.ts`，等价于原来的 `ui2api.py`）转成 API 格式，按节点标题解析参数后写进工作流目录：

工作流目录默认为 **运行 `instafy` 时所在目录下的 `workflows/`**，也可以在 `~/.instafy.json` 里用 `"workflowsDir"` 指定（支持 `~`，相对路径按运行目录解析）。加载时以发布包内置的 `workflows/` 为基底，再叠加这个目录，同名工作流以后者为准。

```bash
instafy sync --dry-run      # 先看会新增/更新哪些
instafy sync                # 同步（只转换有变化的工作流）
instafy sync --force        # 忽略变更检测，全部重新转换
instafy sync --prune        # 同时删除远端已不存在的工作流文件
```

| 选项 | 说明 |
| --- | --- |
| `--dir <相对目录>` | ComfyUI `user/default` 下的目录，默认 `workflows`（即 `~/ComfyUI/user/default/workflows`，也可直接写这个绝对路径） |
| `--dry-run` | 只打印计划，不写文件 |
| `--force` | 强制重新转换覆盖（包括绕过“本地已有同名文件”的保护） |
| `--prune` | 删除远端已删除、但本地还在的同步文件 |

机制说明：

- **目录结构原样保留**：远端 `flux/xxx.json` 同步到工作流目录的 `flux/xxx.json`，`minimax_h3/`、`wan/` 等子目录一一对应，目录根下也可以直接放自己的 JSON。工作流名默认取文件名，跨目录重名时自动加父目录前缀，也可以用相对路径（`wan/wan2_2_14B_t2v`）指定。
- **转换发生在 `instafy sync` 时，由 CLI 自己完成**：通过 ComfyUI 的 HTTP 接口 `GET /api/userdata?dir=workflows&recurse=true` 递归列文件、`GET /api/userdata/<path>` 读内容，再拉一次 `/object_info` 拿节点 schema，在本地把 UI 格式（子图、mute/bypass、widgets 位置映射）展开成 `/prompt` 的 API 格式。不再依赖服务器上的 Python 脚本。
- 本地存下来的已经是 API 格式（`graph` 字段），运行 `instafy image/video` 时不再做任何格式转换；远端本来就是 API 格式的文件会原样保留。
- 每次同步先用 HTTP 列出远端工作流并算 sha1（文件不大，直接拉下来算），未变化的不重新转换。
- 同步记录存在工作流目录下的 `.instafy-sync.json`，记录 `远端相对路径 → 本地文件 / 工作流名 / sha1 / 同步时间`。同步只管理这个目录；内置目录里的文件不会被 `--prune` 删掉。手工新建的同名文件不会被默默覆盖（提示跳过），需要 `--force`。
- 转换后会按 `object_info` 的默认值补齐 UI 格式里缺失的必填控件（例如 `SaveImageAdvanced` 的 `format.bit_depth`），否则 `/prompt` 会校验失败。
- **参数由节点标题声明**（见下一节）：同步时只认标题，不做图结构推断。没有标题的参数不会绑定，`instafy sync` 会在 stderr 里提示哪些参数缺失。
- 少数工作流本身不产出文件（如 `qwen3vl_i2t` 只有 `PreviewAny`），同步仍会照常写入；`output` 取保存节点的 `filename_prefix`，没有保存节点就只出预览。
- 转换器对动态下拉（如 `SaveVideo` 的 `format` → `format.codec`、`SaveImageAdvanced` 的 `format.bit_depth`）会按选中的选项展开子控件，并按 `object_info` 默认值补齐缺失必填项。

## 参数标题约定

在 ComfyUI 里给节点设置 Title，同步时按标题绑定参数（标题会随工作流存进 `_meta.title`）：

| 标题 | 节点示例 | 读取字段（按顺序尝试） |
| --- | --- | --- |
| `instafy:prompt` | 文本编码 / `PrimitiveString` | `prompt` / `text` / `positive_prompt` / `manual_prompt` / `global_prompt` / `value` |
| `instafy:negative` | 反向文本节点 | `negative_prompt` / `negative` / `text` |
| `instafy:image1` … `instafy:image10` | `LoadImage` | `image` |
| `instafy:video1` … `instafy:video3` | `LoadVideo` / `VHS_LoadVideo` | `file` / `video` / `filename` |
| `instafy:audio1` … `instafy:audio3` | `LoadAudio` / `VHS_LoadAudio` | `audio` / `file` / `filename` |
| `instafy:size` | `EmptyLatentImage` 之类 | `width` + `height` |
| `instafy:seed` | 采样器 / `RandomNoise` | `seed` / `noise_seed` |
| `instafy:steps` | 采样器 / `BasicScheduler` / `PrimitiveInt` | `steps` / `value` |
| `instafy:cfg` | `CFGGuider` / `PrimitiveFloat` | `cfg` / `value` |
| `instafy:fps` | `CreateVideo` / `PrimitiveFloat` | `fps` / `frame_rate` / `value` |
| `instafy:seconds` | 喂给时长数学节点的 `PrimitiveFloat` | `value` / `seconds` |

规则很简单：

- 只读标题节点上的**字面值**，不跟连线；标题不存在或没有对应字段，该参数就不绑定。
- 一个节点只能有一个标题。采样器同时有 `seed`/`steps` 时标 `instafy:seed`，`--steps` 会自动从同一节点取；`MiniMaxH3Director` 这种把 prompt/seed/fps 放在一个节点里的，标 `instafy:prompt` 即可，其余参数从同一节点找。
- 同一节点上的 positive/negative（Qwen 的文本编码）标 `instafy:prompt`，`--negative` 会回退到同节点的 `negative_prompt` 字段。
- 需要多张参考图时，按 `instafy:image1`、`instafy:image2`… 给多个 `LoadImage` 打标题，`--ref` 按这个顺序依次填入（最多 10 张）；参考视频/音频同理，用 `instafy:video1..3` / `instafy:audio1..3` 配 `--ref-video` / `--ref-audio`（各最多 3 个）。有视频/音频载入节点但没打标题时，`instafy sync` 会提示对应参数不可用。传得比声明的少时，多出来的槽位在提交前直接删除，不会带默认图进去；因删节点而缺少必填输入的后续节点也会一并清掉（例如 Flux2 的第二个参考图分支）。工作流实际支持几张，取决于它自己有几个对应种类的载入节点：比如 `qwen_image_2_1_image_edit` 接了 10 张图，`instafy workflows` 会显示 `img×10`。
- 保存节点不用标，`output` 自动取；`width`/`height` 绑到 `instafy:size` 后，`instafy workflows` 里就会显示 `--width --height`。

现在 `workflows/` 里 22 个工作流已经按这套约定打好标题；新增工作流时，在 ComfyUI 里给对应节点改名即可，`instafy sync` 后立即生效。

## 自定义工作流

`workflows/*.json`（工作流目录下，默认为 `./workflows`）就是 ComfyUI 的 API 格式（`/prompt` 请求里的 `prompt`），外面包一层元信息：

```json
{
  "name": "my-workflow",
  "kind": "image",
  "description": "说明",
  "bindings": {
    "prompt": ["节点id", "输入名"],
    "image1": ["LoadImage节点id", "image"],
    "video1": ["LoadVideo节点id", "file"],
    "audio1": ["LoadAudio节点id", "audio"],
    "width": ["节点id", "width"],
    "height": ["节点id", "height"],
    "seed": ["KSampler节点id", "seed"],
    "steps": ["KSampler节点id", "steps"],
    "cfg": ["KSampler节点id", "cfg"],
    "output": ["SaveImage节点id", "filename_prefix"]
  },
  "graph": { "节点id": { "class_type": "...", "inputs": { ... } } }
}
```

- `bindings` 里出现 `image`/`image1`（或 `video1`、`audio1`）就会被视为参考槽位，CLI 先上传到 `input/instafy/`，再把返回值写成 `instafy/<文件名>`。
- 同步生成的文件，`bindings` 来自节点标题；手工写的 JSON 直接用 `bindings`，不需要标题（`instafy run/path` 不经过同步逻辑）。
- `prompt` / `negative` / `width` / `height` / `seed` / `steps` / `cfg` / `seconds` / `fps` 只对声明了 binding 的参数生效，其余参数会提示“不支持，已忽略”。
- `output` 会把保存节点的 `filename_prefix` 改成 `instafy/<工作流名>`，方便在远端输出目录里定位。
- 图可以从 ComfyUI 网页端“导出（API 格式）”直接拿到 `graph` 部分；UI 格式的工作流用 `instafy sync` 同步即可（CLI 内置转换，会展开子图、跳过 mute/bypass 分支）。

改完工作流文件直接生效，不需要重新编译；只有改 TypeScript 源码才需要 `pnpm build`。

## 常见问题

- **提示连不上**：先确认 ComfyUI 在跑（`curl http://127.0.0.1:8188/system_stats`）；地址不对就改 `~/.instafy.json`，或用 `--url` 临时指定。
- **`--ref` / `--ref-video` / `--ref-audio` 不生效**：所选工作流没有对应种类的 binding（`zimage_turbo_t2i` 只支持文生图，`wan_animate2_v2v` 同时需要参考图和参考视频）。`instafy workflows` 里对应列是 `-` 就说明它不接这类文件。
- **视频尺寸报错**：宽高需要是 16 的倍数；`--seconds` 与 `--fps` 决定帧数，帧数需要满足 `4n+1`（工作流里的数学节点已处理，改 fps 时注意）。
- **首次跑某个视频工作流很慢**：14B 双模型要从磁盘加载并换入显存，后续任务会快很多。
