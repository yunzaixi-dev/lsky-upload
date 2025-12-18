const path = require("path");

function buildMultipartBody({
  boundary,
  fields,
  fileFieldName,
  filename,
  contentType,
  fileBuffer,
}) {
  const chunks = [];

  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(
          field.name,
        )}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(
        fileFieldName,
      )}"; filename="${escapeQuotes(filename)}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

  return Buffer.concat(chunks);
}

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function getByDotPath(obj, dotPath) {
  const pathString = String(dotPath || "").trim();
  if (!pathString) return undefined;

  const parts = pathString.split(".").filter(Boolean);
  let current = obj;
  for (const key of parts) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
      continue;
    }
    return undefined;
  }
  return current;
}

function applyTemplate(template, vars) {
  const t = String(template || "");
  return t
    .replaceAll("{{url}}", String(vars.url ?? ""))
    .replaceAll("{{filename}}", String(vars.filename ?? ""));
}

function escapeQuotes(value) {
  return String(value).replaceAll('"', '\\"');
}

function truncate(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

module.exports = {
  applyTemplate,
  buildMultipartBody,
  getByDotPath,
  guessContentType,
  truncate,
};

