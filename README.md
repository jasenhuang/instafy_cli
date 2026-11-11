# instafy

调用 `novel` 机器上 ComfyUI 服务的命令行工具：给一段提示词（可选参考图、指定工作流），拿到图片或视频。

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
instafy video --prompt "海边日落，镜头缓慢推进" --seconds 5
instafy video --ref ./start.png "人物慢慢转头看向镜头" --width 640 --height 640
instafy workflows            # 按远端目录列出工作流及可调参数
instafy run zimage_turbo_t2i -p "雪夜小木屋" --steps 6 --json
```

生成结果默认存到 `./outputs/`（`-o/--out` 可改），成功时 stdout 每行一个文件路径，进度日志走 stderr。

### 参数

| 参数 | 说明 |
| --- | --- |
| `-p, --prompt <文本>` | 提示词，也可以直接跟在 `image` / `video` 后面 |
| `-r, --ref <文件>` | 参考图 / 首帧图，自动上传到 ComfyUI 的 `input/instafy/` |
| `-n, --negative <文本>` | 反向提示词（部分工作流支持，如 Wan 视频、Z-Image） |
| `-w, --workflow <名称\|路径>` | 工作流名称（如 `zimage_turbo_t2i`）、相对路径（如 `wan/wan2_2_14B_t2v`），或 JSON 文件路径 |
| `--width` / `--height` | 输出尺寸；视频要求 16 的倍数 |
| `--seed` | 随机种子，默认随机并打印出来 |
| `--steps` | 采样步数（图像工作流） |
| `--seconds` / `--fps` | 仅视频：时长与帧率，帧数 = seconds × fps + 1 |
| `--timeout <秒>` | 等待上限，默认 1800（可配置） |
| `--url <地址>` | ComfyUI 地址，默认 `http://127.0.0.1:8188`（可配置） |
| `--json` | 输出 JSON（工作流、prompt_id、种子、耗时、文件列表） |

### 配置

`~/.instafy.json` 可以放默认值，只写需要的字段：

```json
{
  "url": "http://127.0.0.1:8188",
  "out": "~/instafy-outputs",
  "timeout": 1800
}
```

| 字段 | 说明 | 默认 | 命令行覆盖 |
| --- | --- | --- | --- |
| `url` | ComfyUI 地址 | `http://127.0.0.1:8188` | `--url`（另有 `INSTAFY_COMFY_URL`，优先级高于配置） |
| `out` | 输出目录，支持 `~` 开头 | `./outputs` | `--out` |
| `timeout` | 等待上限（秒） | `1800` | `--timeout` |

规则：命令行 > 配置 > 默认。配置文件不存在就用全部默认值；JSON 不合法、字段类型不对或地址格式错误会直接报错，并在错误里带上配置文件路径，不会静默回退。

## 默认工作流

工作流全部来自 `instafy sync`（远端 `~/ComfyUI/user/default/workflows`）。不带 `--workflow` 时按类型自动挑一个：

| 场景 | 默认工作流 | 可调参数 |
| --- | --- | --- |
| 文生图 | `zimage_turbo_t2i` | `--negative --steps --seed` |
| 改图（带 `--ref`） | `flux2_klein_i2i` | `--steps --seed` |
| 文生视频 | `wan2_2_14B_t2v` | `--negative --width --height --seconds --fps --seed` |
| 图生视频（带 `--ref`） | `wan2_2_14B_i2v` | `--negative --seconds --fps --seed` |

这几个只是按名称优先挑的；远端改名/删除后会自动退到同类型（且是否要参考图一致）里按名称排序的第一个。想固定用哪个就加 `--workflow`。`instafy workflows` 里 `ref` 列标 `ref` 的工作流必须用 `--ref` 传参考图。

实测（A30 24G，模型已缓存时）：文生图约 9 秒，改图约 20 秒，2 秒 480×480 视频约 25 秒。

## 同步远端工作流

把 ComfyUI `~/ComfyUI/user/default/workflows` 里（含子目录）的 UI 格式工作流，用 CLI 内置的转换器（`src/convert.ts`，等价于原来的 `ui2api.py`）转成 API 格式，自动推断参数绑定后写进 `workflows/`：

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

- **目录结构原样保留**：远端 `flux/xxx.json` 同步到 `workflows/flux/xxx.json`，`minimax_h3/`、`wan/` 等子目录一一对应，`workflows/` 根目录也可以直接放自己的 JSON。工作流名默认取文件名，跨目录重名时自动加父目录前缀，也可以用相对路径（`wan/wan2_2_14B_t2v`）指定。
- **转换发生在 `instafy sync` 时，由 CLI 自己完成**：通过 ComfyUI 的 HTTP 接口 `GET /api/userdata?dir=workflows&recurse=true` 递归列文件、`GET /api/userdata/<path>` 读内容，再拉一次 `/object_info` 拿节点 schema，在本地把 UI 格式（子图、mute/bypass、widgets 位置映射）展开成 `/prompt` 的 API 格式。不再依赖服务器上的 Python 脚本。
- 本地存下来的已经是 API 格式（`graph` 字段），运行 `instafy image/video` 时不再做任何格式转换；远端本来就是 API 格式的文件会原样保留。
- 每次同步先用 HTTP 列出远端工作流并算 sha1（文件不大，直接拉下来算），未变化的不重新转换。
- 同步记录存在 `workflows/.instafy-sync.json`，记录 `远端相对路径 → 本地文件 / 工作流名 / sha1 / 同步时间`。手工新建的同名文件不会被默默覆盖（提示跳过），需要 `--force`。
- 转换后会按 `object_info` 的默认值补齐 UI 格式里缺失的必填控件（例如 `SaveImageAdvanced` 的 `format.bit_depth`），否则 `/prompt` 会校验失败。
- 自动推断 `prompt` / `negative` / `image` / `width` / `height` / `seed` / `steps` / `seconds` / `fps` / `output` 绑定：顺着采样器的 conditioning 链找文本节点（含 `PrimitiveString`、`MiniMaxH3ImageToVideo.prompt` 这类连线输入），按 `CreateVideo.fps` 与时长数学表达式反推秒数。推断不出来的参数不会绑定，`instafy sync` 会在 stderr 里提示，可手工编辑生成的工作流 JSON 补齐。
- 少数工作流本身不产出文件（如 `qwen3vl_i2t` 只有 `PreviewAny`），或者采样封装在自定义节点里（`MiniMaxH3Director`），同步仍会照常写入，跑之前看一眼 bindings 是否合理。
- 转换器对动态下拉（如 `SaveVideo` 的 `format` → `format.codec`、`SaveImageAdvanced` 的 `format.bit_depth`）会按选中的选项展开子控件，并按 `object_info` 默认值补齐缺失必填项。

## 自定义工作流

`workflows/*.json` 就是 ComfyUI 的 API 格式（`/prompt` 请求里的 `prompt`），外面包一层元信息：

```json
{
  "name": "my-workflow",
  "kind": "image",
  "description": "说明",
  "bindings": {
    "prompt": ["节点id", "输入名"],
    "image": ["LoadImage节点id", "image"],
    "width": ["节点id", "width"],
    "height": ["节点id", "height"],
    "seed": ["KSampler节点id", "seed"],
    "steps": ["KSampler节点id", "steps"],
    "output": ["SaveImage节点id", "filename_prefix"]
  },
  "graph": { "节点id": { "class_type": "...", "inputs": { ... } } }
}
```

- `bindings` 里出现 `image` 就会被视为“需要参考图”，CLI 会先上传文件再把返回值写成 `instafy/<文件名>`。
- `prompt` / `negative` / `width` / `height` / `seed` / `steps` / `seconds` / `fps` 只对声明了 binding 的参数生效，其余参数会提示“不支持，已忽略”。
- `output` 会把保存节点的 `filename_prefix` 改成 `instafy/<工作流名>`，方便在远端输出目录里定位。
- 图可以从 ComfyUI 网页端“导出（API 格式）”直接拿到 `graph` 部分；UI 格式的工作流用 `instafy sync` 同步即可（CLI 内置转换，会展开子图、跳过 mute/bypass 分支）。

改完工作流文件直接生效，不需要重新编译；只有改 TypeScript 源码才需要 `pnpm build`。

## 常见问题

- **提示连不上**：先确认 ComfyUI 在跑（`curl http://127.0.0.1:8188/system_stats`）；地址不对就改 `~/.instafy.json`，或用 `--url` 临时指定。
- **`--ref` 不生效**：所选工作流没有 `image` binding，例如 `zimage_turbo_t2i` 只支持文生图。
- **视频尺寸报错**：宽高需要是 16 的倍数；`--seconds` 与 `--fps` 决定帧数，帧数需要满足 `4n+1`（工作流里的数学节点已处理，改 fps 时注意）。
- **首次跑某个视频工作流很慢**：14B 双模型要从磁盘加载并换入显存，后续任务会快很多。
