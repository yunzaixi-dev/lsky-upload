# lsky-upload (VS Code Extension)

在 Markdown/MDX 文档中拦截粘贴图片：从剪贴板读取图片 → 上传到兰空图床（Lsky）→ 将返回的 Markdown 嵌入链接插入到光标处。

## 功能

- 在 `markdown` / `mdx` 文档内按 `Ctrl+V`（macOS 为 `Cmd+V`）时：
  - 若剪贴板里是图片：上传后插入返回的 Markdown。
  - 若剪贴板里不是图片：自动回退到 VS Code 默认粘贴行为。
- 支持将剪贴板文本识别为本地图片文件路径并上传（例如从文件管理器复制图片文件后粘贴）。
- Token 默认存入 VS Code Secret Storage（命令：`Lsky Upload: Set Token`）。

## 配置

在 VS Code 设置里搜索 `Lsky Upload`：

- `lskyUpload.baseUrl`: 图床地址，例如 `https://img.example.com`
- `lskyUpload.uploadPath`: 默认 `"/api/v1/upload"`
- `lskyUpload.responseMarkdownPath`: 默认 `"data.links.markdown"`
- `lskyUpload.responseUrlPath`: 默认 `"data.links.url"`
- `lskyUpload.enablePasteInterceptor`: 是否拦截 `Ctrl/Cmd+V`（默认开启）

推荐做法：

1. 配好 `lskyUpload.baseUrl`
2. 执行命令 `Lsky Upload: Set Token (Secret Storage)` 保存 token

## 依赖说明（剪贴板取图）

由于 VS Code 扩展 API 不直接暴露“读剪贴板图片字节”的接口，本扩展会调用系统命令取图：

- macOS: 需要安装 `pngpaste`（`brew install pngpaste`）
- Linux:
  - Wayland 优先 `wl-paste`（`wl-clipboard`）
  - 否则使用 `xclip` / `xsel`
- Windows: 使用 PowerShell 读取剪贴板图片

## 本地开发

在此目录打开 VS Code，按 `F5` 启动 Extension Development Host，然后在新的窗口里打开 Markdown 文件测试粘贴上传流程。
