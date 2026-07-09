const { z } = require("zod");
const { AppError } = require("./app-error");

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const entitySchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  filePath: z.string().min(1),
  type: z.string().min(1).optional().default("entity"),
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
  source: z.enum(["auto", "manual", "custom"]).default("auto")
});

const entitySetItemSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1).optional().default("entity"),
  canonicalName: z.string().optional().default(""),
  aliases: z.array(z.string()).default([]),
  maskedValue: z.string().optional().default(""),
  enabled: z.boolean().default(true),
  sourceName: z.string().optional().default(""),
  sourceUrl: z.string().optional().default(""),
  notes: z.string().optional().default("")
});

const entitySetSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  version: z.string().optional().default("1.0.0"),
  updatedAt: z.string().optional(),
  items: z.array(entitySetItemSchema).default([])
});

const documentImportSchema = z.object({
  purpose: z.enum(["sanitize", "restore", "mapping", "keyFile"]).default("sanitize"),
  multi: z.boolean().default(false)
}).default({});

const acknowledgementSchema = z.object({
  imageContentUnmodified: z.boolean().optional().default(false),
  imageHandling: z.enum(["keep", "delete"]).optional()
}).default({});

const wordSourceSchema = z.object({
  kind: z.literal("word"),
  path: z.string().min(1),
  docId: z.string().min(1).optional()
});

const textSourceSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1),
  docId: z.string().min(1).optional()
});

const sourceSchema = z.discriminatedUnion("kind", [
  wordSourceSchema,
  textSourceSchema
]);

const previewSchema = z.object({
  source: sourceSchema
});

const batchWordSourceSchema = z.object({
  kind: z.literal("word"),
  path: z.string().min(1),
  docId: z.string().min(1).optional()
});

const previewBatchSchema = z.object({
  sources: z.array(batchWordSourceSchema.omit({ docId: true })).min(1)
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
  source: sourceSchema,
  mode: z.enum(["irreversible", "reversible"]),
  entities: z.array(entitySchema),
  outputDir: optionalNonEmptyString,
  textOutputMode: z.enum(["file", "copy"]).optional().default("file"),
  credential: credentialSchema.optional(),
  acknowledgements: acknowledgementSchema
}).superRefine((value, context) => {
  if (value.mode === "reversible" && !value.credential) {
    context.addIssue({
      code: "custom",
      path: ["credential"],
      message: "可恢复脱敏必须提供口令或密钥文件"
    });
  }
  const outputDirectoryRequired = value.source.kind === "word" ||
    value.mode === "reversible" ||
    value.textOutputMode === "file";
  if (outputDirectoryRequired && !value.outputDir) {
    context.addIssue({
      code: "custom",
      path: ["outputDir"],
      message: "请选择输出目录"
    });
  }
});

const sanitizeBatchRunSchema = z.object({
  sources: z.array(batchWordSourceSchema.extend({
    docId: z.string().min(1)
  })).min(1),
  mode: z.enum(["irreversible", "reversible"]),
  entities: z.array(entitySchema),
  outputDir: z.string().min(1),
  credential: credentialSchema.optional(),
  acknowledgements: acknowledgementSchema
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
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("word"),
      path: z.string().min(1)
    }),
    z.object({
      kind: z.literal("text"),
      text: z.string().min(1)
    })
  ]),
  mappingPath: z.string().min(1),
  outputDir: z.string().min(1),
  credential: credentialSchema
});

const outputFileActionSchema = z.object({
  filePath: z.string().min(1)
});

const entitySetSaveSchema = z.object({
  entitySet: entitySetSchema
});

const entitySetDeleteSchema = z.object({
  id: z.string().min(1)
});

const entitySetImportSchema = z.object({
  format: z.enum(["json", "csv"]),
  content: z.string().min(1)
});

const entitySetExportSchema = z.object({
  id: z.string().min(1),
  format: z.enum(["json", "csv"])
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
  previewBatchSchema,
  sanitizeRunSchema,
  sanitizeBatchRunSchema,
  outputFileActionSchema,
  unlockMappingSchema,
  restoreRunSchema,
  entitySetSaveSchema,
  entitySetDeleteSchema,
  entitySetImportSchema,
  entitySetExportSchema,
  parseWithSchema
};
