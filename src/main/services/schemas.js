const { z } = require("zod");
const { AppError } = require("./app-error");

const entitySchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  filePath: z.string().min(1),
  type: z.string().min(1),
  originalValue: z.string().min(1),
  maskedValue: z.string().min(1),
  stableId: z.string().min(1),
  contextHash: z.string().optional().default(""),
  locations: z.array(z.object({
    segmentId: z.string().min(1),
    index: z.number().int().nonnegative(),
    length: z.number().int().positive()
  })).default([]),
  enabled: z.boolean().default(true),
  source: z.enum(["auto", "manual"]).default("auto")
});

const documentImportSchema = z.object({
  purpose: z.enum(["sanitize", "restore", "mapping", "keyFile"]).default("sanitize"),
  multi: z.boolean().default(false)
}).default({});

const previewSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    docId: z.string().min(1).optional()
  })).min(1)
});

const credentialSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("password"),
    password: z.string().min(1)
  }),
  z.object({
    method: z.literal("keyFile"),
    keyFilePath: z.string().min(1)
  })
]);

const sanitizeRunSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    docId: z.string().min(1).optional()
  })).min(1),
  mode: z.enum(["irreversible", "reversible"]),
  entities: z.array(entitySchema),
  outputDir: z.string().min(1),
  credential: credentialSchema.optional()
}).superRefine((value, context) => {
  if (value.mode === "reversible" && !value.credential) {
    context.addIssue({
      code: "custom",
      path: ["credential"],
      message: "可恢复脱敏必须提供口令或密钥文件"
    });
  }
});

const unlockMappingSchema = z.object({
  mappingPath: z.string().min(1),
  credential: credentialSchema
});

const restoreRunSchema = z.object({
  filePath: z.string().min(1),
  mappingPath: z.string().min(1),
  outputDir: z.string().min(1),
  credential: credentialSchema
});

function parseWithSchema(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError("INVALID_ARGUMENT", "参数校验失败", result.error.issues);
  }
  return result.data;
}

module.exports = {
  documentImportSchema,
  previewSchema,
  sanitizeRunSchema,
  unlockMappingSchema,
  restoreRunSchema,
  parseWithSchema
};
