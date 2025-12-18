const assert = require("assert");

const core = require("../core");

assert.strictEqual(core.getByDotPath({ a: { b: 1 } }, "a.b"), 1);
assert.strictEqual(core.getByDotPath({ a: { b: 1 } }, "a.c"), undefined);

assert.strictEqual(
  core.applyTemplate("![]({{url}})", { url: "https://example.com/x.png" }),
  "![](https://example.com/x.png)",
);

assert.strictEqual(core.guessContentType("x.png"), "image/png");
assert.strictEqual(core.guessContentType("x.jpg"), "image/jpeg");
assert.strictEqual(core.guessContentType("x.bin"), "application/octet-stream");

console.log("basic.test.js: ok");
