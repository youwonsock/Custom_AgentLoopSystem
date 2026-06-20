const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");

const distPath = path.join(__dirname, "..", "dist", "loop_orchestrator.js");
const src = fs.readFileSync(distPath, "utf8");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    fail++;
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    fail++;
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function extractFn(srcCode, fnName) {
  const match = srcCode.match(new RegExp(`function ${fnName}\\b[\\s\\S]*?\\n}`));
  if (!match) throw new Error(`Cannot find function ${fnName}`);
  return match[0];
}

const stripAnsiCode = extractFn(src, "stripAnsi");
const stripAnsi = new Function(`${stripAnsiCode}; return stripAnsi;`)();

const normalizeSigCode = extractFn(src, "normalizeSignature");
const normalizeSignature = new Function(`${normalizeSigCode}; return normalizeSignature;`)();

const parseTestResultCode = extractFn(src, "parseTestResult");
const parseTestResult = new Function(`${parseTestResultCode}; return parseTestResult;`)();

const extractFailureDigestCode = extractFn(src, "extractFailureDigest");
const extractFailureDigest = new Function("stripAnsi", "path", `${extractFailureDigestCode}; return extractFailureDigest;`)(stripAnsi, path);

const pushOscCode = extractFn(src, "pushAndCheckOscillation");
const pushAndCheckOscillation = new Function(`${pushOscCode}; return pushAndCheckOscillation;`)();

const LineBufferCode = src.match(/class LineBuffer \{[\s\S]*?\n\}/)[0];
const LineBuffer = new Function(`${LineBufferCode}; return LineBuffer;`)();

console.log("=== stripAnsi ===");

test("removes CSI sequences", () => {
  const input = "\x1b[31mRed Text\x1b[0m";
  assert.strictEqual(stripAnsi(input), "Red Text");
});

test("removes OSC sequences", () => {
  const input = "\x1b]0;Window Title\x07Normal";
  assert.strictEqual(stripAnsi(input), "Normal");
});

test("removes control chars", () => {
  const input = "Hello\x00World\x07!";
  assert.strictEqual(stripAnsi(input), "HelloWorld!");
});

test("preserves normal text", () => {
  assert.strictEqual(stripAnsi("plain text 123"), "plain text 123");
});

console.log("\n=== normalizeSignature ===");

test("normalizes absolute paths", () => {
  const sig = normalizeSignature("Error at C:\\repo\\src\\file.ts:10:5");
  assert.ok(sig.includes("<path>"), `Expected <PATH> token, got: ${sig}`);
  assert.ok(!sig.includes("c:\\repo"), `Path not normalized: ${sig}`);
});

test("extracts error type from Error: prefix", () => {
  const sig = normalizeSignature("Error: TypeError: cannot read property 'x' of undefined");
  assert.ok(sig.includes("typeerror"), `Expected typeerror, got: ${sig}`);
});

test("normalizes line numbers", () => {
  const sig = normalizeSignature("at foo (file.ts:42:7)");
  assert.ok(sig.includes("<ln>"), `Expected <LN> token, got: ${sig}`);
});

test("normalizes hex addresses", () => {
  const sig = normalizeSignature("at 0x7ffe1234abcd");
  assert.ok(sig.includes("<hex>"), `Expected <HEX> token, got: ${sig}`);
});

console.log("\n=== pushAndCheckOscillation ===");

function makeErr(sig, phase) {
  return { signature: sig, rawMessage: sig, timestamp: Date.now(), phase: phase || "VERIFICATION" };
}

test("no oscillation on distinct errors", () => {
  const queue = [];
  const r1 = pushAndCheckOscillation(queue, makeErr("err-a"));
  assert.strictEqual(r1.oscillation, false);
  const r2 = pushAndCheckOscillation(r1.queue, makeErr("err-b"));
  assert.strictEqual(r2.oscillation, false);
});

test("detects freq>=3 oscillation", () => {
  let q = [];
  q = pushAndCheckOscillation(q, makeErr("same-sig")).queue;
  q = pushAndCheckOscillation(q, makeErr("diff-sig")).queue;
  q = pushAndCheckOscillation(q, makeErr("same-sig")).queue;
  const r = pushAndCheckOscillation(q, makeErr("same-sig"));
  assert.strictEqual(r.oscillation, true, "Expected oscillation on 3rd same-sig");
});

test("queue capped at 5", () => {
  let q = [];
  for (let i = 0; i < 10; i++) {
    q = pushAndCheckOscillation(q, makeErr(`err-${i}`)).queue;
  }
  assert.strictEqual(q.length, 5, `Queue should be capped at 5, got ${q.length}`);
});

test("detects ABAB cycle pattern", () => {
  let q = [];
  q = pushAndCheckOscillation(q, makeErr("a")).queue;
  q = pushAndCheckOscillation(q, makeErr("b")).queue;
  q = pushAndCheckOscillation(q, makeErr("a")).queue;
  const r = pushAndCheckOscillation(q, makeErr("b"));
  assert.strictEqual(r.oscillation, true, "Expected ABAB cycle detection");
});

console.log("\n=== parseTestResult ===");

test("passing: 0 fail", () => {
  assert.strictEqual(parseTestResult("5 passing, 0 failing"), true);
});

test("failing: 2 failing", () => {
  assert.strictEqual(parseTestResult("3 passing, 2 failing"), false);
});

test("passing: all tests passed", () => {
  assert.strictEqual(parseTestResult("All tests passed."), true);
});

test("failing: contains x mark", () => {
  assert.strictEqual(parseTestResult("ok 1 test\nx 2 failing"), false);
});

test("passing: exit 0", () => {
  assert.strictEqual(parseTestResult("EXIT: 0"), true);
});

test("failing: exit 1", () => {
  assert.strictEqual(parseTestResult("EXIT: 1"), false);
});

test("passing: 0 fail literal", () => {
  assert.strictEqual(parseTestResult("0 fail"), true);
});

console.log("\n=== extractFailureDigest ===");

test("extracts failure messages", () => {
  const log = "FAIL src/test.ts\n  AssertionError: expected 5 got 3\n  at line 42\n1 failing";
  const digest = extractFailureDigest(log);
  assert.ok(digest.includes("Failures:"), `Expected Failures section: ${digest}`);
  assert.ok(digest.includes("expected 5 got 3"), `Expected assertion text: ${digest}`);
});

test("extracts affected files", () => {
  const log = "Error in src/auth.ts\n  at src/utils.ts:10\nFAIL";
  const digest = extractFailureDigest(log);
  assert.ok(digest.includes("Affected files:"), `Expected files section: ${digest}`);
  assert.ok(digest.includes("auth.ts"), `Expected auth.ts: ${digest}`);
});

test("falls back to last lines on no matches", () => {
  const log = "some output\nmore output\nlast line here";
  const digest = extractFailureDigest(log);
  assert.ok(digest.length > 0, "Expected non-empty digest");
  assert.ok(digest.includes("last line"), `Expected fallback to last lines: ${digest}`);
});

test("caps at 5 failures", () => {
  let log = "";
  for (let i = 0; i < 10; i++) {
    log += `FAIL test-${i}: error message ${i}\n`;
  }
  const digest = extractFailureDigest(log);
  const failureLines = digest.split("\n").filter((l) => l.startsWith("  - "));
  assert.ok(failureLines.length <= 5, `Expected <= 5 failures, got ${failureLines.length}`);
});

console.log("\n=== LineBuffer ===");

test("splits on newlines", () => {
  const buf = new LineBuffer();
  const lines = buf.push("line1\nline2\nline3\n");
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], "line1");
  assert.strictEqual(lines[2], "line3");
});

test("buffers incomplete line", () => {
  const buf = new LineBuffer();
  const lines1 = buf.push("partial");
  assert.strictEqual(lines1.length, 0);
  const lines2 = buf.push(" line\n");
  assert.strictEqual(lines2.length, 1);
  assert.strictEqual(lines2[0], "partial line");
});

test("handles CRLF", () => {
  const buf = new LineBuffer();
  const lines = buf.push("line1\r\nline2\r\n");
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], "line1");
  assert.strictEqual(lines[1], "line2");
});

test("flush returns remaining", () => {
  const buf = new LineBuffer();
  buf.push("no newline");
  const remaining = buf.flush();
  assert.strictEqual(remaining, "no newline");
  assert.strictEqual(buf.flush(), null);
});

async function runAsyncTests() {
  console.log("\n=== atomicWriteJson / atomicReadJson ===");

  const fse = require("fs-extra");
  const crypto = require("node:crypto");

  const tmpDir = path.join(os.tmpdir(), `agent-loop-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fse.ensureDir(tmpDir);

  const atomicWriteJson = async (filePath, data) => {
    await fse.ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
    await fse.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fse.rename(tmpPath, filePath);
        return;
      } catch (err) {
        lastErr = err;
        if (["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
          await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  const atomicReadJson = async (filePath) => {
    try {
      const content = await fse.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      return null;
    }
  };

  await asyncTest("write and read JSON", async () => {
    const fp = path.join(tmpDir, "test.json");
    await atomicWriteJson(fp, { name: "test", value: 42 });
    const data = await atomicReadJson(fp);
    assert.strictEqual(data.name, "test");
    assert.strictEqual(data.value, 42);
  });

  await asyncTest("read non-existent returns null", async () => {
    const data = await atomicReadJson(path.join(tmpDir, "nope.json"));
    assert.strictEqual(data, null);
  });

  await asyncTest("read corrupted returns null", async () => {
    const fp = path.join(tmpDir, "corrupt.json");
    await fse.writeFile(fp, "{invalid json}", "utf8");
    const data = await atomicReadJson(fp);
    assert.strictEqual(data, null);
  });

  await asyncTest("concurrent writes preserve atomicity (with retry)", async () => {
    const fp = path.join(tmpDir, "concurrent.json");
    const writes = [];
    for (let i = 0; i < 10; i++) {
      writes.push(atomicWriteJson(fp, { index: i }));
    }
    await Promise.all(writes);
    const data = await atomicReadJson(fp);
    assert.ok(data !== null, "Expected valid JSON after concurrent writes");
    assert.ok(typeof data.index === "number", `Expected numeric index, got: ${data.index}`);
  });

  await asyncTest("sequential writes are consistent", async () => {
    const fp = path.join(tmpDir, "sequential.json");
    for (let i = 0; i < 50; i++) {
      await atomicWriteJson(fp, { index: i });
    }
    const data = await atomicReadJson(fp);
    assert.strictEqual(data.index, 49, `Expected last write to win, got: ${data.index}`);
  });

  await fse.remove(tmpDir);
}

async function runAll() {
  await runAsyncTests();

  console.log(`\n=== RESULTS ===\nPass: ${pass}\nFail: ${fail}`);
  if (fail > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
