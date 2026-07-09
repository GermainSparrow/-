export type NavigationView = "dashboard" | "sanitize" | "restore" | "entitySets";

export type SanitizeMode = "irreversible" | "reversible";

export type TextOutputMode = "file" | "copy";

export type ImageHandling = "keep" | "delete";

export type CredentialMethod = "password" | "keyFile";

export type InputSourceKind = "word" | "text";

export interface PublicError {
  code?: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  ok: boolean;
  data: T | null;
  error: PublicError | null;
}

export interface DocumentSummary {
  path: string;
  name: string;
  extension: string;
  size: number;
  docId: string;
}

export interface PreviewFileSummary {
  path: string;
  docId: string;
  kind: string;
  sourceKind: InputSourceKind;
  sourceLabel: string;
  warnings: string[];
  textLength: number;
}

export interface EntityLocation {
  segmentId: string;
  index: number;
  length: number;
}

export interface EntityItem {
  id: string;
  docId: string;
  filePath: string;
  type: string;
  originalValue: string;
  maskedValue: string;
  stableId: string;
  contextHash?: string;
  locations: EntityLocation[];
  enabled: boolean;
  source: "auto" | "manual" | "custom";
}

export interface EntitySetItem {
  id: string;
  type: string;
  canonicalName: string;
  aliases: string[];
  maskedValue: string;
  enabled: boolean;
  sourceName: string;
  sourceUrl: string;
  notes: string;
}

export interface EntitySet {
  id: string;
  name: string;
  enabled: boolean;
  version: string;
  updatedAt: string;
  items: EntitySetItem[];
}

export interface EntitySetExportResult {
  fileName: string;
  content: string;
}

export interface PreviewBlockedFile {
  path: string;
  error: PublicError;
}

export interface PreviewResult {
  sourceKind: InputSourceKind;
  sourceLabel: string;
  files: PreviewFileSummary[];
  blocked: PreviewBlockedFile[];
  entities: EntityItem[];
}

export type Credential =
  | { method: "password"; password: string }
  | { method: "keyFile"; keyFilePath: string };

export interface EntitySummary {
  total: number;
  byType: Record<string, number>;
  bySource?: Record<string, number>;
}

export interface SanitizeOutputPaths {
  sanitizedFile: string | null;
  mappingFile: string | null;
  reportFile: string | null;
}

export interface SanitizeResultItem {
  sourcePath: string;
  sourceKind: InputSourceKind;
  sourceLabel: string;
  docId: string;
  entitySummary: EntitySummary;
  warnings: string[];
  outputs: SanitizeOutputPaths;
  sanitizedText: string | null;
}

export interface SanitizeResult {
  results: SanitizeResultItem[];
}

export interface MappingUnlockResult {
  sessionId: string;
  docId: string;
  sourceLabel: string;
  createdAt: string;
  entitySummary: EntitySummary;
}

export interface RestoreResult {
  sourceKind: InputSourceKind;
  sourceLabel: string;
  outputPath: string;
  reportPath: string | null;
  warnings: string[];
  entitySummary: EntitySummary;
  restoredText: string | null;
}

export interface OutputFilePreview {
  filePath: string;
  content: string;
  warnings: string[];
  truncated: boolean;
}

export type SanitizeSource =
  | { kind: "word"; path: string; docId?: string }
  | { kind: "text"; text: string; docId?: string };

export type RestoreSource =
  | { kind: "word"; path: string }
  | { kind: "text"; text: string };

export interface DesktopApi {
  getVersion: () => Promise<string>;
  importDocuments: (options: {
    purpose: "sanitize" | "restore" | "mapping" | "keyFile";
    multi?: boolean;
  }) => Promise<ApiResponse<DocumentSummary[]>>;
  importDroppedDocuments: (options: {
    purpose: "sanitize" | "restore";
    files: File[];
  }) => Promise<ApiResponse<DocumentSummary[]>>;
  previewSanitize: (payload: {
    source: SanitizeSource;
  }) => Promise<ApiResponse<PreviewResult>>;
  runSanitize: (payload: {
    source: SanitizeSource;
    mode: SanitizeMode;
    entities: EntityItem[];
    outputDir?: string;
    textOutputMode?: TextOutputMode;
    credential?: Credential;
    acknowledgements?: {
      imageContentUnmodified?: boolean;
      imageHandling?: ImageHandling;
    };
  }) => Promise<ApiResponse<SanitizeResult>>;
  getLastOutputDirectory: () => Promise<ApiResponse<string | null>>;
  selectOutputDirectory: () => Promise<ApiResponse<string | null>>;
  openOutputFile: (payload: {
    filePath: string;
  }) => Promise<ApiResponse<null>>;
  previewOutputFile: (payload: {
    filePath: string;
  }) => Promise<ApiResponse<OutputFilePreview>>;
  revealOutputFile: (payload: {
    filePath: string;
  }) => Promise<ApiResponse<null>>;
  deleteOutputFile: (payload: {
    filePath: string;
  }) => Promise<ApiResponse<null>>;
  unlockMapping: (payload: {
    mappingPath: string;
    credential: Credential;
  }) => Promise<ApiResponse<MappingUnlockResult>>;
  runRestore: (payload: {
    source: RestoreSource;
    mappingPath: string;
    outputDir: string;
    credential: Credential;
  }) => Promise<ApiResponse<RestoreResult>>;
  listEntitySets: () => Promise<ApiResponse<EntitySet[]>>;
  saveEntitySet: (payload: {
    entitySet: EntitySet;
  }) => Promise<ApiResponse<EntitySet>>;
  deleteEntitySet: (payload: {
    id: string;
  }) => Promise<ApiResponse<EntitySet[]>>;
  importEntitySet: (payload: {
    format: "json" | "csv";
    content: string;
  }) => Promise<ApiResponse<EntitySet[]>>;
  exportEntitySet: (payload: {
    id: string;
    format: "json" | "csv";
  }) => Promise<ApiResponse<EntitySetExportResult>>;
}

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
