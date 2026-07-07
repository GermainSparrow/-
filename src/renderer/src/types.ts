export type NavigationView = "dashboard" | "sanitize" | "restore";

export type SanitizeMode = "irreversible" | "reversible";

export type CredentialMethod = "password" | "keyFile";

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
  docId: string;
  entitySummary: EntitySummary;
  warnings: string[];
  outputs: SanitizeOutputPaths;
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
  outputPath: string;
  reportPath: string;
  warnings: string[];
  entitySummary: EntitySummary;
}

export interface DesktopApi {
  getVersion: () => Promise<string>;
  importDocuments: (options: {
    purpose: "sanitize" | "restore" | "mapping" | "keyFile";
    multi?: boolean;
  }) => Promise<ApiResponse<DocumentSummary[]>>;
  previewSanitize: (payload: {
    files: Array<{ path: string; docId?: string }>;
  }) => Promise<ApiResponse<PreviewResult>>;
  runSanitize: (payload: {
    files: Array<{ path: string; docId?: string }>;
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
    filePath: string;
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

