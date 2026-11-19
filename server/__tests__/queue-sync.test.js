/**
 * @file Tests for connecting "Verified" to the owner's task queue (server/lib/queue-sync.js):
 * only rows waiting for verification (🔎) that mention the commit are flipped — ✅ when verified,
 * ⛔ with the reason when the check failed — an "error" verdict leaves them waiting, line endings
 * and every other line are kept, and a missing or odd file is ignored.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { markQueue } = require("../lib/queue-sync");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
process.env.DASHBOARD_VERIFY_CONFIG = path.join(TMP, "verify.json");
const verifyConfig = require("../lib/verify-config");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HEAD = [
  "# תור משימות",
  "",
  "| # | פרויקט | משימה | מצב | נוסף | תוצאה |",
  "|---|---------|-------|-----|------|-------|",
];
function queue(name, rows, eol = "\n") {
  const f = path.join(TMP, `${name}.md`);
  fs.writeFileSync(f, [...HEAD, ...rows, ""].join(eol));
  return f;
}

describe("markQueue", () => {
  it("flips only the waiting rows of this commit", () => {
    const f = queue("a", [
      "| 1 | Monitor | x | 🔎 | 19/11 | נשמר (abc1234) |",
      "| 2 | Monitor | y | 🔎 | 19/11 | נשמר (fff0000) |",
      "| 3 | Monitor | z | ✅ | 19/11 | abc1234 |",
      "| 4 | Monitor | w | ⏳ | 19/11 | |",
    ]);
    assert.deepEqual(markQueue({ file: f, commitSha: "abc1234deadbeef", verdict: "verified" }), {
      changed: 1,
    });
    const lines = fs.readFileSync(f, "utf8").split("\n");
    assert.equal(lines[4], "| 1 | Monitor | x | ✅ | 19/11 | נשמר (abc1234) · אומת ✔ |");
    assert.equal(lines[5], "| 2 | Monitor | y | 🔎 | 19/11 | נשמר (fff0000) |");
    assert.equal(lines[6], "| 3 | Monitor | z | ✅ | 19/11 | abc1234 |");
    assert.equal(lines[7], "| 4 | Monitor | w | ⏳ | 19/11 | |");
    assert.equal(lines[0], "# תור משימות");
  });

  it("marks a failed check with its reason, keeping CRLF and the table intact", () => {
    const f = queue("b", ["| 7 | שורש | t | 🔎 | 19/11 | (fff0000) |"], "\r\n");
    markQueue({
      file: f,
      commitSha: "fff0000",
      verdict: "failed",
      reason: "tests failed | exit 1",
    });
    const text = fs.readFileSync(f, "utf8");
    assert.ok(text.includes("\r\n"));
    assert.ok(!/[^\r]\n/.test(text), "no bare LF introduced");
    const row = text.split("\r\n")[4];
    assert.match(
      row,
      /^\| 7 \| שורש \| t \| ⛔ \| 19\/11 \| \(fff0000\) · האימות נכשל: tests failed\s+exit 1 \|$/
    );
    assert.equal(row.split("|").length, 8, "a | in the reason does not add a column");
  });

  it("leaves rows waiting on an error verdict and ignores missing files and bad shas", () => {
    const f = queue("c", ["| 1 | A | x | 🔎 | 19/11 | abc1234 |"]);
    assert.equal(markQueue({ file: f, commitSha: "abc1234", verdict: "error" }).changed, 0);
    assert.equal(markQueue({ file: f, commitSha: "zz", verdict: "verified" }).changed, 0);
    assert.equal(
      markQueue({ file: path.join(TMP, "none.md"), commitSha: "abc1234", verdict: "verified" })
        .changed,
      0
    );
    assert.equal(markQueue({ file: TMP, commitSha: "abc1234", verdict: "verified" }).changed, 0);
    assert.match(fs.readFileSync(f, "utf8"), /\| 🔎 \|/);
  });
});

describe("queueFile in verify.json", () => {
  it("is validated, and kept when the settings screen saves only the projects", () => {
    const q = path.join(TMP, "queue.md");
    const project = { dir: TMP, checkCmd: "npm test" };
    assert.throws(
      () => verifyConfig.validateConfig({ projects: [], queueFile: "relative.md" }),
      verifyConfig.ConfigError
    );
    assert.throws(
      () => verifyConfig.validateConfig({ projects: [], queueFile: path.join(TMP, "q.txt") }),
      verifyConfig.ConfigError
    );
    verifyConfig.writeConfig({ projects: [project], queueFile: q });
    assert.equal(verifyConfig.readConfig().queueFile, q);
    verifyConfig.writeConfig({ projects: [project] });
    assert.equal(verifyConfig.readConfig().queueFile, q, "kept");
    verifyConfig.writeConfig({ projects: [project], queueFile: "" });
    assert.equal(verifyConfig.readConfig().queueFile, undefined, "cleared on purpose");
  });
});
