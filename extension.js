const vscode = require("vscode");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const cp = require("child_process");
const http = require("http");
const https = require("https");
const core = require("./core");

function activate(context) {
  registerPasteProvider(context);

  const updateContextKey = () => {
    const config = vscode.workspace.getConfiguration("lskyUpload");
    const enabled = !!config.get("enablePasteInterceptor", true);
    void vscode.commands.executeCommand(
      "setContext",
      "lskyUpload.interceptorEnabled",
      enabled,
    );
  };

  updateContextKey();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lskyUpload.enablePasteInterceptor")) {
        updateContextKey();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lskyUpload.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Set Lsky token (stored in VS Code Secret Storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      await context.secrets.store("lskyUpload.token", token.trim());
      vscode.window.showInformationMessage("Lsky Upload: token saved.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lskyUpload.pasteImage", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const lang = editor.document.languageId;
      const isMarkdown = lang === "markdown" || lang === "mdx";
      if (!isMarkdown) {
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction",
        );
        return;
      }

      const config = vscode.workspace.getConfiguration("lskyUpload");
      const baseUrl = String(config.get("baseUrl", "")).trim();
      if (!baseUrl) {
        vscode.window.showErrorMessage(
          "Lsky Upload: please set 'lskyUpload.baseUrl' first.",
        );
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction",
        );
        return;
      }

      const clipboardImage =
        vscode.env?.uiKind === vscode.UIKind?.Web
          ? null
          : await getClipboardImageAsFile();
      const clipboardImagePath = clipboardImage?.filePath ?? null;

      let uploadFilePath = clipboardImagePath;
      let uploadFilename = clipboardImage?.filename ?? null;

      try {
        if (!uploadFilePath) {
          const text = await vscode.env.clipboard.readText();
          const fromText = coerceSingleLocalFilePath(text);
          if (fromText && looksLikeImageFile(fromText) && fsSync.existsSync(fromText)) {
            uploadFilePath = fromText;
            uploadFilename = path.basename(fromText);
          }
        }

        if (!uploadFilePath) {
          await vscode.commands.executeCommand(
            "editor.action.clipboardPasteAction",
          );
          return;
        }

        const markdown = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Lsky Upload: uploading image…",
            cancellable: false,
          },
          async () => {
            const result = await uploadToLsky({
              context,
              baseUrl,
              uploadPath: String(config.get("uploadPath", "/api/v1/upload")),
              tokenSetting: String(config.get("token", "")),
              useBearerToken: !!config.get("useBearerToken", true),
              fileFieldName: String(config.get("fileFieldName", "file")),
              strategyId: config.get("strategyId", null),
              timeoutMs: Number(config.get("timeoutMs", 30000)),
              responseMarkdownPath: String(
                config.get("responseMarkdownPath", "data.links.markdown"),
              ),
              responseUrlPath: String(config.get("responseUrlPath", "data.links.url")),
              markdownFallbackTemplate: String(
                config.get("markdownFallbackTemplate", "![]({{url}})"),
              ),
              filePath: uploadFilePath,
              filenameHint: uploadFilename,
            });
            return result.markdown;
          },
        );

        await editor.edit((editBuilder) => {
          editBuilder.replace(editor.selection, markdown);
        });
      } catch (error) {
        vscode.window.showErrorMessage(
          `Lsky Upload: ${errorToMessage(error)}`,
        );
      } finally {
        if (clipboardImage?.cleanup) {
          try {
            await clipboardImage.cleanup();
          } catch {
            // ignore
          }
        }
      }
    }),
  );
}

function deactivate() {}

async function getClipboardImageAsFile() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsky-upload-"));
  const filename = `clipboard-${Date.now()}.png`;
  const filePath = path.join(tempDir, filename);

  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  const ok = await tryWriteClipboardImage(filePath);
  if (!ok) {
    await cleanup();
    return null;
  }

  return { filePath, filename, cleanup };
}

async function tryWriteClipboardImage(outputFilePath) {
  const platform = process.platform;
  const dir = path.dirname(outputFilePath);
  await fs.mkdir(dir, { recursive: true });

  if (platform === "darwin") {
    // Requires `pngpaste` (brew install pngpaste).
    return runClipboardCommand("pngpaste", ["-"], outputFilePath);
  }

  if (platform === "win32") {
    return runPowerShellClipboardImage(outputFilePath);
  }

  // linux
  if (process.env.WAYLAND_DISPLAY) {
    const ok = await runClipboardCommand(
      "wl-paste",
      ["--no-newline", "--type", "image/png"],
      outputFilePath,
    );
    if (ok) return true;
  }

  const ok = await runClipboardCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "image/png", "-o"],
    outputFilePath,
  );
  if (ok) return true;

  return runClipboardCommand(
    "xsel",
    ["--clipboard", "--output", "--target", "image/png"],
    outputFilePath,
  );
}

function runClipboardCommand(command, args, outputFilePath) {
  return new Promise((resolve) => {
    const child = cp.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    const out = fsSync.createWriteStream(outputFilePath);
    child.stdout.pipe(out);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      out.end();
      if (code === 0) return resolve(true);
      if (stderr.toLowerCase().includes("image")) return resolve(false);
      resolve(false);
    });
  });
}

function runPowerShellClipboardImage(outputFilePath) {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$img=[System.Windows.Forms.Clipboard]::GetImage();",
      "if ($null -eq $img) { exit 2 }",
      `$out='${outputFilePath.replace(/'/g, "''")}';`,
      "$img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png);",
    ].join(" ");

    const child = cp.spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function coerceSingleLocalFilePath(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  // VS Code / terminals may wrap file paths like: file:///... or "...".
  const unquoted = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

  try {
    if (unquoted.startsWith("file://")) {
      const url = new URL(unquoted);
      const p = decodeURIComponent(url.pathname);
      if (process.platform === "win32" && p.startsWith("/")) return p.slice(1);
      return p;
    }
  } catch {
    // ignore
  }

  return unquoted;
}

function looksLikeImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
}

function registerPasteProvider(context) {
  const register = vscode.languages?.registerDocumentPasteEditProvider;
  if (typeof register !== "function") return;

  const provider = {
    provideDocumentPasteEdits: async (document, ranges, dataTransfer) => {
      const config = vscode.workspace.getConfiguration("lskyUpload");
      const enabled = !!config.get("enablePasteInterceptor", true);
      if (!enabled) return;

      const baseUrl = String(config.get("baseUrl", "")).trim();
      if (!baseUrl) return;

      const image = await extractImageFromDataTransfer(dataTransfer);
      if (!image) return;

      const markdown = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Lsky Upload: uploading image…",
          cancellable: false,
        },
        async () => {
          const result = await uploadToLsky({
            context,
            baseUrl,
            uploadPath: String(config.get("uploadPath", "/api/v1/upload")),
            tokenSetting: String(config.get("token", "")),
            useBearerToken: !!config.get("useBearerToken", true),
            fileFieldName: String(config.get("fileFieldName", "file")),
            strategyId: config.get("strategyId", null),
            timeoutMs: Number(config.get("timeoutMs", 30000)),
            responseMarkdownPath: String(
              config.get("responseMarkdownPath", "data.links.markdown"),
            ),
            responseUrlPath: String(config.get("responseUrlPath", "data.links.url")),
            markdownFallbackTemplate: String(
              config.get("markdownFallbackTemplate", "![]({{url}})"),
            ),
            fileBuffer: image.buffer,
            filenameHint: image.filename,
          });
          return result.markdown;
        },
      );

      const PasteEdit = vscode.DocumentPasteEdit;
      if (typeof PasteEdit === "function") {
        const edit = new PasteEdit(markdown);
        edit.label = "Upload image to Lsky";
        return [edit];
      }

      return [{ insertText: markdown, label: "Upload image to Lsky" }];
    },
  };

  context.subscriptions.push(
    register(
      [
        { language: "markdown" },
        { language: "mdx" },
      ],
      provider,
    ),
  );
}

async function extractImageFromDataTransfer(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.get !== "function") return null;

  const candidates = [
    { mime: "image/png", fallbackFilename: "pasted-image.png" },
    { mime: "image/jpeg", fallbackFilename: "pasted-image.jpg" },
    { mime: "image/jpg", fallbackFilename: "pasted-image.jpg" },
    { mime: "image/webp", fallbackFilename: "pasted-image.webp" },
    { mime: "image/gif", fallbackFilename: "pasted-image.gif" },
  ];

  for (const candidate of candidates) {
    const item = dataTransfer.get(candidate.mime);
    if (!item) continue;

    const fromFile = await tryReadDataTransferItemAsFile(item);
    if (fromFile) return fromFile;

    const fromValue = await tryReadDataTransferItemValue(item);
    if (fromValue) {
      return {
        buffer: fromValue,
        filename: candidate.fallbackFilename,
      };
    }
  }

  return null;
}

async function tryReadDataTransferItemAsFile(item) {
  if (!item || typeof item.asFile !== "function") return null;
  const file = item.asFile();
  if (!file) return null;

  const filename = String(file.name || "pasted-image");

  if (file.uri && vscode.workspace?.fs?.readFile) {
    const bytes = await vscode.workspace.fs.readFile(file.uri);
    return { buffer: Buffer.from(bytes), filename };
  }

  if (typeof file.data === "function") {
    const bytes = await file.data();
    return { buffer: normalizeToBuffer(bytes), filename };
  }

  if (file.data !== undefined) {
    const bytes = await file.data;
    return { buffer: normalizeToBuffer(bytes), filename };
  }

  return null;
}

async function tryReadDataTransferItemValue(item) {
  if (!item) return null;

  if (item.value !== undefined) {
    const v = await item.value;
    return normalizeToBuffer(v);
  }

  if (typeof item.asString === "function") {
    const s = await item.asString();
    const fromDataUrl = parseImageDataUrl(s);
    if (fromDataUrl) return fromDataUrl;
  }

  return null;
}

function normalizeToBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer));
  return null;
}

function parseImageDataUrl(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("data:image/")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;

  const meta = value.slice(0, comma);
  const data = value.slice(comma + 1);
  if (!/;base64$/i.test(meta)) return null;

  try {
    return Buffer.from(data, "base64");
  } catch {
    return null;
  }
}

async function uploadToLsky(options) {
  const {
    context,
    baseUrl,
    uploadPath,
    tokenSetting,
    useBearerToken,
    fileFieldName,
    strategyId,
    timeoutMs,
    responseMarkdownPath,
    responseUrlPath,
    markdownFallbackTemplate,
    fileBuffer,
    filePath,
    filenameHint,
  } = options;

  const tokenFromSecret = await context.secrets.get("lskyUpload.token");
  const token = (tokenSetting && tokenSetting.trim()) || (tokenFromSecret || "").trim();

  const url = new URL(uploadPath, baseUrl);
  const client = url.protocol === "http:" ? http : https;

  const fileBufferResolved =
    fileBuffer !== undefined && fileBuffer !== null
      ? Buffer.from(fileBuffer)
      : await fs.readFile(filePath);
  const filename = filenameHint || (filePath ? path.basename(filePath) : null) || "image.png";
  const contentType = core.guessContentType(filename);

  const fields = [];
  if (strategyId !== null && strategyId !== undefined && String(strategyId).trim() !== "") {
    fields.push({ name: "strategy_id", value: String(strategyId) });
  }

  const boundary = `----lskyupload${Math.random().toString(16).slice(2)}${Date.now()}`;
  const body = core.buildMultipartBody({
    boundary,
    fields,
    fileFieldName,
    filename,
    contentType,
    fileBuffer: fileBufferResolved,
  });

  const headers = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(body.length),
    Accept: "application/json",
  };

  if (token) {
    headers.Authorization = useBearerToken ? `Bearer ${token}` : token;
  }

  const requestOptions = {
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers,
  };

  const responseText = await new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
          return;
        }
        reject(
          new Error(
            `upload failed: HTTP ${res.statusCode || "?"} ${res.statusMessage || ""} ${core.truncate(
              text,
              400,
            )}`.trim(),
          ),
        );
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });

  let json;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`response is not JSON: ${core.truncate(responseText, 400)}`);
  }

  const markdown = core.getByDotPath(json, responseMarkdownPath);
  if (typeof markdown === "string" && markdown.trim()) {
    return { markdown: markdown.trim(), json };
  }

  const urlValue = core.getByDotPath(json, responseUrlPath);
  if (typeof urlValue === "string" && urlValue.trim()) {
    const built = core.applyTemplate(markdownFallbackTemplate, {
      url: urlValue.trim(),
      filename,
    });
    return { markdown: built, json };
  }

  throw new Error(
    `cannot find markdown/url in response (paths: '${responseMarkdownPath}', '${responseUrlPath}')`,
  );
}

function errorToMessage(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

exports.activate = activate;
exports.deactivate = deactivate;
