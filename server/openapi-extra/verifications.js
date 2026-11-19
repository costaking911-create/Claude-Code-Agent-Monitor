/**
 * @file Supplementary OpenAPI 3.0 fragments for independent task verification ("Verified"):
 * POST /api/sessions/{id}/verify, GET /api/sessions/{id}/verifications and the
 * /api/verifications routes (latest, log, config). See server/routes/verifications.js and
 * server/lib/verify-runner.js. Schemas are prefixed `Verification`/`Verify`.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const tags = [
  {
    name: "Verifications",
    description:
      "Independent verification of a session's work: the dashboard re-runs the project's configured commands in a clean copy of the commit and decides from the exit code and the test count in the log, never from the agent.",
  },
];

const err = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "NOT_CONFIGURED" },
              message: { type: "string" },
              field: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const schemas = {
  Verification: {
    type: "object",
    description: "One verification run of a session's repository at a commit.",
    properties: {
      id: { type: "integer", example: 7 },
      session_id: { type: "string" },
      workflow_run_id: { type: "string", nullable: true },
      project_dir: { type: "string", description: "Git work tree that was verified." },
      commit_sha: { type: "string", nullable: true },
      dirty: {
        type: "integer",
        enum: [0, 1],
        description: "1 when uncommitted changes existed (not included).",
      },
      requirements: { type: "string", nullable: true },
      setup_cmd: { type: "string", nullable: true },
      check_cmd: { type: "string" },
      setup_exit: { type: "integer", nullable: true },
      check_exit: { type: "integer", nullable: true },
      tests_count: { type: "integer", nullable: true },
      has_screenshot: { type: "boolean", description: "The visual check saved a screenshot" },
      review_verdict: {
        type: "string",
        nullable: true,
        enum: ["SHIP", "SHIP_WITH_FIXES", "DONT_SHIP", "error"],
        description: "Blind reviewer verdict (null when not configured)",
      },
      review: {
        type: "object",
        nullable: true,
        description: "Blind reviewer answer per owner request, or { error } when it could not run",
      },
      timed_out: { type: "integer", enum: [0, 1] },
      status: { type: "string", enum: ["queued", "running", "done"] },
      verdict: { type: "string", enum: ["verified", "failed", "error"], nullable: true },
      reason: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      started_at: { type: "string", format: "date-time", nullable: true },
      ended_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  VerifyProject: {
    type: "object",
    required: ["dir", "checkCmd"],
    properties: {
      dir: { type: "string", description: "Absolute path of the repository's main folder." },
      setupCmd: { type: "string", example: "npm ci" },
      checkCmd: { type: "string", example: "npm test" },
      testCountRegex: {
        type: "string",
        description: "Regex with one capture group for the test count.",
      },
      timeoutSec: { type: "integer", minimum: 30, maximum: 3600 },
      autoVerify: {
        type: "boolean",
        default: true,
        description: "Verify automatically two minutes after a turn ends, when the commit is new.",
      },
      blindReview: {
        type: "object",
        description:
          "Optional blind reviewer: a read-only claude -p that sees only the owner's requests and the clean copy.",
        properties: {
          model: { type: "string", default: "sonnet" },
          timeoutSec: { type: "integer", minimum: 60, maximum: 1800, default: 600 },
        },
      },
      visual: {
        type: "object",
        description:
          "Optional visual check: open the clean copy at phone size in a headless Chrome/Edge after the tests pass.",
        properties: {
          path: { type: "string", default: "/" },
          waitMs: { type: "integer", minimum: 0, maximum: 120000, default: 5000 },
          readyExpr: { type: "string", description: "JavaScript that must become true" },
          serveCmd: { type: "string", description: "Own server, started with PORT set" },
          url: { type: "string", description: "http://127.0.0.1:{port}/… (with serveCmd)" },
          width: { type: "integer", minimum: 240, maximum: 1600, default: 390 },
          height: { type: "integer", minimum: 320, maximum: 3000, default: 844 },
          minVariety: { type: "number", minimum: 0, maximum: 1, default: 0.01 },
        },
      },
    },
  },
  VerifyConfig: {
    type: "object",
    properties: {
      path: { type: "string", description: "Location of verify.json." },
      projects: { type: "array", items: { $ref: "#/components/schemas/VerifyProject" } },
    },
  },
};

const json = (ref) => ({ "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } });

const paths = {
  "/api/sessions/{id}/verify": {
    post: {
      tags: ["Verifications"],
      operationId: "verifySession",
      summary: "Queue an independent verification of a session's repository",
      description:
        "Takes no body. The commands come only from verify.json. Returns the existing queued/running verification when one is already active.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        202: {
          description: "Queued",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { verification: { $ref: "#/components/schemas/Verification" } },
              },
            },
          },
        },
        400: err,
        403: err,
        404: err,
        409: err,
      },
    },
  },
  "/api/sessions/{id}/verifications": {
    get: {
      tags: ["Verifications"],
      operationId: "listSessionVerifications",
      summary: "Last 20 verifications of a session plus its repository's current HEAD",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: {
          description: "Verifications, newest first",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  verifications: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Verification" },
                  },
                  current_head: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        404: err,
      },
    },
  },
  "/api/verifications/latest": {
    get: {
      tags: ["Verifications"],
      operationId: "latestVerifications",
      summary: "Latest verification per session (for list badges)",
      parameters: [
        {
          name: "session_ids",
          in: "query",
          required: true,
          description: "Comma-separated session ids (max 200).",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Map of session id to its latest verification",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  latest: {
                    type: "object",
                    additionalProperties: { $ref: "#/components/schemas/Verification" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/verifications/{id}/log": {
    get: {
      tags: ["Verifications"],
      operationId: "getVerificationLog",
      summary: "Verification log (secrets masked, last 5 MB)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      responses: {
        200: { description: "Log text", content: { "text/plain": { schema: { type: "string" } } } },
        400: err,
        404: err,
      },
    },
  },
  "/api/verifications/{id}/screenshot": {
    get: {
      tags: ["Verifications"],
      operationId: "getVerificationScreenshot",
      summary: "Phone-size screenshot from the visual check",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      responses: {
        200: {
          description: "PNG",
          content: { "image/png": { schema: { type: "string", format: "binary" } } },
        },
        400: err,
        404: err,
      },
    },
  },
  "/api/verifications/config": {
    get: {
      tags: ["Verifications"],
      operationId: "getVerifyConfig",
      summary: "Per-project verification commands (verify.json)",
      responses: { 200: { description: "Config", content: json("VerifyConfig") } },
    },
    put: {
      tags: ["Verifications"],
      operationId: "putVerifyConfig",
      summary: "Replace the per-project verification commands",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                projects: { type: "array", items: { $ref: "#/components/schemas/VerifyProject" } },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Saved", content: json("VerifyConfig") },
        400: err,
        403: err,
      },
    },
  },
};

module.exports = { tags, schemas, paths };
