/**
 * @file Supplementary OpenAPI 3.0 fragments for the automatic disk cleanup routes mounted at
 * `/api/disk` (see server/routes/disk.js and server/lib/disk-janitor.js). Schemas are prefixed
 * `Disk`.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const tags = [
  {
    name: "Disk",
    description:
      "Automatic disk cleanup below a free-space floor: only temporary or re-creatable data, never code, repositories, transcripts or personal files.",
  },
];

const schemas = {
  DiskConfig: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      floorGb: { type: "number", default: 3, minimum: 0.5, maximum: 100 },
      targetGb: { type: "number", default: 5, minimum: 0.5, maximum: 200 },
    },
  },
  DiskCleanupEntry: {
    type: "object",
    properties: {
      at: { type: "string", format: "date-time" },
      reason: { type: "string", enum: ["auto", "manual", "preview"] },
      dry_run: { type: "boolean" },
      free_before: { type: "number", nullable: true },
      free_after: { type: "number", nullable: true },
      freed: { type: "number" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            freed: { type: "number" },
            removed: { type: "integer" },
            kept: { type: "integer" },
            error: { type: "string" },
          },
        },
      },
    },
  },
  DiskStatus: {
    type: "object",
    properties: {
      path: { type: "string" },
      free_bytes: { type: "number", nullable: true },
      total_bytes: { type: "number", nullable: true },
      config: { $ref: "#/components/schemas/DiskConfig" },
      below_floor: { type: "boolean" },
      running: { type: "boolean" },
      history: { type: "array", items: { $ref: "#/components/schemas/DiskCleanupEntry" } },
      suggestions: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" }, hint: { type: "string" } } },
      },
    },
  },
};

const status = {
  200: {
    description: "Disk status",
    content: { "application/json": { schema: { $ref: "#/components/schemas/DiskStatus" } } },
  },
};

const paths = {
  "/api/disk": {
    get: {
      tags: ["Disk"],
      operationId: "getDiskStatus",
      summary: "Free space, settings, recent runs",
      responses: status,
    },
  },
  "/api/disk/cleanup": {
    post: {
      tags: ["Disk"],
      operationId: "runDiskCleanup",
      summary: "Run the cleanup now (dryRun previews without deleting)",
      requestBody: {
        content: {
          "application/json": {
            schema: { type: "object", properties: { dryRun: { type: "boolean" } } },
          },
        },
      },
      responses: { ...status, 403: { description: "Cross-site request refused" } },
    },
  },
  "/api/disk/config": {
    put: {
      tags: ["Disk"],
      operationId: "putDiskConfig",
      summary: "Save cleanup settings",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/DiskConfig" } } },
      },
      responses: { ...status, 403: { description: "Cross-site request refused" } },
    },
  },
};

module.exports = { tags, schemas, paths };
