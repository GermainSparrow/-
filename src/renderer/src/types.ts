export type NavigationView = "dashboard" | "sanitize" | "restore";

export type SanitizeMode = "irreversible" | "reversible";

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
  source: "auto" | "manual";
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
}

export interface SanitizeOutputPaths {
  sanitizedFile: string;
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
  reportPath: string;
  warnings: string[];
  entitySummary: EntitySummary;
  restoredText: string | null;
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
  previewSanitize: (payload: {
    source: SanitizeSource;
  }) => Promise<ApiResponse<PreviewResult>>;
  runSanitize: (payload: {
    source: SanitizeSource;
    mode: SanitizeMode;
    entities: EntityItem[];
    outputDir: string;
    credential?: Credential;
  }) => Promise<ApiResponse<SanitizeResult>>;
  selectOutputDirectory: () => Promise<ApiResponse<string | null>>;
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
}

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
