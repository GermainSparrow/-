import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Copy,
  Eye,
  FileCheck2,
  FileText,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
  XCircle,
  type LucideIcon
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { defaultMaskedValue as createDefaultMaskedValue } from "../../shared/person-masking";
import type {
  ApiResponse,
  BatchSanitizeSource,
  Credential,
  CredentialMethod,
  DesktopApi,
  DocumentSummary,
  EntityItem,
  EntitySet,
  EntitySetItem,
  ImageHandling,
  InputSourceKind,
  NavigationView,
  OutputFilePreview,
  PreviewBlockedFile,
  PreviewResult,
  RestoreResult,
  RestoreSource,
  SanitizeMode,
  SanitizeSource,
  SanitizeResultItem,
  EntitySetExportResult,
  TextOutputMode
} from "./types";

type StatusTone = "info" | "success" | "warning" | "error";

const IMAGE_WARNING_MARKER = "图片内内容无法修改";

interface StatusMessage {
  tone: StatusTone;
  title: string;
  body?: string;
  details?: string[];
}

interface OutputDocumentActionHandlers {
  onPreviewDocument: (filePath: string, title: string) => void;
  onOpenDocument: (filePath: string) => void;
  onRevealDocument: (filePath: string) => void;
  onDeleteDocument: (filePath: string) => void;
}

interface OutputPreviewState extends OutputFilePreview {
  title: string;
}

interface SanitizeState {
  inputKind: InputSourceKind;
  files: DocumentSummary[];
  pastedText: string;
  mode: SanitizeMode;
  credentialMethod: CredentialMethod;
  password: string;
  keyFile: DocumentSummary | null;
  outputDir: string;
  textOutputMode: TextOutputMode;
  preview: PreviewResult | null;
  entities: EntityItem[];
  results: SanitizeResultItem[];
  resultBlocked: PreviewBlockedFile[];
  running: boolean;
  previewing: boolean;
  imageHandling: ImageHandling | null;
}

interface RestoreState {
  inputKind: InputSourceKind;
  file: DocumentSummary | null;
  pastedText: string;
  mappingFile: DocumentSummary | null;
  credentialMethod: CredentialMethod;
  password: string;
  keyFile: DocumentSummary | null;
  outputDir: string;
  result: RestoreResult | null;
  running: boolean;
}

const GENERIC_ENTITY_TYPE = "entity";
const GENERIC_ENTITY_PREFIX = "ENTITY";

const INITIAL_SANITIZE_STATE: SanitizeState = {
  inputKind: "word",
  files: [],
  pastedText: "",
  mode: "irreversible",
  credentialMethod: "password",
  password: "",
  keyFile: null,
  outputDir: "",
  textOutputMode: "file",
  preview: null,
  entities: [],
  results: [],
  resultBlocked: [],
  running: false,
  previewing: false,
  imageHandling: null
};

const INITIAL_RESTORE_STATE: RestoreState = {
  inputKind: "word",
  file: null,
  pastedText: "",
  mappingFile: null,
  credentialMethod: "password",
  password: "",
  keyFile: null,
  outputDir: "",
  result: null,
  running: false
};

interface ManualEntityDraft {
  originalValue: string;
  maskedValue: string;
  docId: string;
}

interface ManualDocOption {
  docId: string;
  label: string;
  path: string;
}

const EMPTY_MANUAL_ENTITY: ManualEntityDraft = {
  originalValue: "",
  maskedValue: "",
  docId: ""
};

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function App() {
  const [activeView, setActiveView] = useState<NavigationView>("dashboard");
  const [version, setVersion] = useState("...");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [outputPreview, setOutputPreview] = useState<OutputPreviewState | null>(null);
  const [sanitize, setSanitize] = useState<SanitizeState>(INITIAL_SANITIZE_STATE);
  const [restore, setRestore] = useState<RestoreState>(INITIAL_RESTORE_STATE);
  const [manualEntity, setManualEntity] = useState(EMPTY_MANUAL_ENTITY);
  const [entitySets, setEntitySets] = useState<EntitySet[]>([]);
  const [selectedEntitySetId, setSelectedEntitySetId] = useState("");

  useEffect(() => {
    if (!window.desktopApi) {
      setVersion("browser");
      return;
    }

    window.desktopApi
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
    loadEntitySets();
    loadLastOutputDirectory();
  }, []);

  const sanitizeStep = useMemo(() => {
    const hasInput = sanitize.inputKind === "word"
      ? sanitize.files.length > 0
      : sanitize.pastedText.trim().length > 0;
    if (sanitize.results.length) return 4;
    if (sanitize.entities.length || sanitize.preview) return 3;
    if (hasInput) return 2;
    return 1;
  }, [
    sanitize.entities.length,
    sanitize.files.length,
    sanitize.inputKind,
    sanitize.pastedText,
    sanitize.preview,
    sanitize.results.length
  ]);

  async function callDesktop<T>(task: (api: DesktopApi) => Promise<ApiResponse<T>>): Promise<T> {
    if (!window.desktopApi) {
      throw new Error("当前页面未运行在 Electron 安全桥接环境中");
    }

    const response = await task(window.desktopApi);
    if (!response.ok) {
      throw new Error(formatApiError(response.error));
    }
    return response.data as T;
  }

  async function openOutputDocument(filePath: string) {
    try {
      await callDesktop((api) => api.openOutputFile({ filePath }));
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function previewOutputDocument(filePath: string, title: string) {
    try {
      const preview = await callDesktop((api) => api.previewOutputFile({ filePath }));
      setOutputPreview({
        ...preview,
        title
      });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function revealOutputDocument(filePath: string) {
    try {
      await callDesktop((api) => api.revealOutputFile({ filePath }));
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function deleteOutputDocument(filePath: string) {
    if (!window.confirm("确定删除该文档吗？文件将移至系统回收站。")) {
      return;
    }

    try {
      await callDesktop((api) => api.deleteOutputFile({ filePath }));
      setSanitize((current) => ({
        ...current,
        results: current.results.map((result) =>
          result.outputs.sanitizedFile === filePath
            ? {
              ...result,
              outputs: {
                ...result.outputs,
                sanitizedFile: null
              }
            }
            : result
        )
      }));
      setRestore((current) => (
        current.result?.outputPath === filePath
          ? { ...current, result: null }
          : current
      ));
      setStatus({ tone: "success", title: "文档已删除", body: "文件已移至系统回收站。" });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function loadEntitySets() {
    try {
      const sets = await callDesktop((api) => api.listEntitySets());
      setEntitySets(sets);
      setSelectedEntitySetId((current) => current || sets[0]?.id || "");
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function loadLastOutputDirectory() {
    try {
      const outputDir = await callDesktop((api) => api.getLastOutputDirectory());
      if (!outputDir) return;

      setSanitize((current) => ({
        ...current,
        outputDir: current.outputDir || outputDir
      }));
      setRestore((current) => ({
        ...current,
        outputDir: current.outputDir || outputDir
      }));
    } catch {
      // Missing or stale directory history should not block the workspace.
    }
  }

  async function saveEntitySet(entitySet: EntitySet) {
    try {
      const saved = await callDesktop((api) => api.saveEntitySet({ entitySet }));
      setEntitySets((current) => {
        const index = current.findIndex((item) => item.id === saved.id);
        if (index < 0) return [...current, saved];
        return current.map((item) => (item.id === saved.id ? saved : item));
      });
      setSelectedEntitySetId(saved.id);
      setStatus({ tone: "success", title: "实体集已保存", body: saved.name });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function deleteSelectedEntitySet(id: string) {
    try {
      const sets = await callDesktop((api) => api.deleteEntitySet({ id }));
      setEntitySets(sets);
      setSelectedEntitySetId(sets[0]?.id || "");
      setStatus({ tone: "success", title: "实体集已删除" });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function importEntitySet(format: "json" | "csv", content: string) {
    try {
      const imported = await callDesktop((api) => api.importEntitySet({ format, content }));
      await loadEntitySets();
      setSelectedEntitySetId(imported[0]?.id || "");
      setStatus({ tone: "success", title: "实体集已导入", body: `导入 ${imported.length} 个实体集` });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function exportEntitySet(id: string, format: "json" | "csv") {
    try {
      const exported = await callDesktop((api) => api.exportEntitySet({ id, format }));
      downloadTextFile(exported);
      setStatus({ tone: "success", title: "实体集已导出", body: exported.fileName });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  function docIdForSanitizeFile(file: DocumentSummary, state = sanitize) {
    return state.preview?.files.find((item) => item.path === file.path)?.docId || file.docId || "";
  }

  function sanitizeDocOptions(state = sanitize) {
    return state.inputKind === "word"
      ? state.files
        .map((file) => ({
          docId: docIdForSanitizeFile(file, state),
          label: file.name,
          path: file.path
        }))
        .filter((item) => Boolean(item.docId))
      : state.preview?.files.map((file) => ({
        docId: file.docId,
        label: file.sourceLabel,
        path: file.path
      })) ?? [];
  }

  function currentSanitizeDocId(state = sanitize) {
    if (manualEntity.docId) return manualEntity.docId;
    return sanitizeDocOptions(state)[0]?.docId || "";
  }

  function currentSanitizeSources(includeDocId: boolean): BatchSanitizeSource[] {
    if (sanitize.inputKind !== "word") return [];
    return sanitize.files
      .map((file) => {
        const docId = docIdForSanitizeFile(file);
        return {
          kind: "word" as const,
          path: file.path,
          ...(includeDocId && docId ? { docId } : {})
        };
      })
      .filter((source) => !includeDocId || Boolean(source.docId));
  }

  function currentSanitizeSource(includeDocId: boolean): SanitizeSource | null {
    if (sanitize.inputKind === "word") {
      const file = sanitize.files[0];
      if (!file) return null;
      const docId = docIdForSanitizeFile(file);
      return {
        kind: "word",
        path: file.path,
        ...(includeDocId && docId ? { docId } : {})
      };
    }

    if (!sanitize.pastedText.trim()) return null;
    const docId = currentSanitizeDocId();
    return {
      kind: "text",
      text: sanitize.pastedText,
      ...(includeDocId && docId ? { docId } : {})
    };
  }

  function currentRestoreSource(): RestoreSource | null {
    if (restore.inputKind === "word") {
      return restore.file ? { kind: "word", path: restore.file.path } : null;
    }

    return restore.pastedText.trim() ? { kind: "text", text: restore.pastedText } : null;
  }

  async function selectSanitizeFiles() {
    await importSanitizeFiles((api) => api.importDocuments({ purpose: "sanitize", multi: true }));
  }

  async function importSanitizeFiles(loader: (api: DesktopApi) => Promise<ApiResponse<DocumentSummary[]>>) {
    try {
      const files = await callDesktop(loader);
      if (!files.length) return;

      setSanitize((current) => ({
        ...current,
        inputKind: "word",
        files,
        preview: null,
        entities: [],
        results: [],
        resultBlocked: [],
        imageHandling: null
      }));
      setManualEntity(EMPTY_MANUAL_ENTITY);
      setStatus({
        tone: "info",
        title: "已导入文档",
        body: files.map((file) => file.name).join(", ")
      });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  function changeSanitizeInputKind(inputKind: InputSourceKind) {
    setSanitize((current) => ({
      ...current,
      inputKind,
      preview: null,
      entities: [],
      results: [],
      resultBlocked: [],
      imageHandling: null
    }));
    setManualEntity(EMPTY_MANUAL_ENTITY);
  }

  function changeSanitizeText(pastedText: string) {
    setSanitize((current) => ({
      ...current,
      inputKind: "text",
      pastedText,
      preview: null,
      entities: [],
      results: [],
      resultBlocked: [],
      imageHandling: null
    }));
  }

  function clearSanitizeText() {
    setSanitize((current) => ({
      ...current,
      inputKind: "text",
      pastedText: "",
      preview: null,
      entities: [],
      results: [],
      resultBlocked: [],
      imageHandling: null
    }));
    setManualEntity(EMPTY_MANUAL_ENTITY);
  }

  async function selectSanitizeOutput() {
    try {
      const outputDir = await callDesktop((api) => api.selectOutputDirectory());
      if (!outputDir) return;

      setSanitize((current) => ({
        ...current,
        outputDir
      }));
      setStatus({ tone: "info", title: "已选择输出目录", body: outputDir });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function selectSanitizeKeyFile() {
    try {
      const files = await callDesktop((api) => api.importDocuments({ purpose: "keyFile", multi: false }));
      if (!files.length) return;

      setSanitize((current) => ({
        ...current,
        keyFile: files[0]
      }));
      setStatus({ tone: "info", title: "已选择密钥文件", body: files[0].name });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function previewEntities() {
    const source = currentSanitizeSource(false);
    if (!source) {
      setStatus({ tone: "error", title: "请先输入待脱敏内容" });
      return;
    }

    try {
      setSanitize((current) => ({ ...current, previewing: true, results: [], resultBlocked: [] }));
      const preview = await callDesktop((api) =>
        sanitize.inputKind === "word"
          ? api.previewSanitizeBatch({
            sources: currentSanitizeSources(false)
          })
          : api.previewSanitize({
            source
          })
      );

      setSanitize((current) => {
        const previewDocIds = preview.files.map((file) => file.docId);
        return {
          ...current,
          files: current.inputKind === "word"
            ? current.files.map((file) => {
              const previewFile = preview.files.find((item) => item.path === file.path);
              return previewFile ? { ...file, docId: previewFile.docId } : file;
            })
            : current.files,
          preview,
          entities: mergePreviewEntities(preview.entities, current.entities, previewDocIds),
          previewing: false,
          resultBlocked: [],
          imageHandling: null
        };
      });
      setManualEntity((current) => ({
        ...current,
        docId: preview.files.some((file) => file.docId === current.docId)
          ? current.docId
          : preview.files[0]?.docId || ""
      }));

      if (preview.blocked.length) {
        setStatus({
          tone: "warning",
          title: "部分文件已阻断",
          body: `识别到 ${preview.entities.length} 个实体，${preview.blocked.length} 个文件未进入脱敏。`,
          details: preview.blocked.map((item) => `${fileNameFromPath(item.path)}: ${item.error.message}`)
        });
      } else if (preview.entities.length) {
        setStatus({
          tone: "success",
          title: "实体识别完成",
          body: `已识别 ${preview.entities.length} 个实体，请复核后执行导出。`
        });
      } else {
        setStatus({
          tone: "warning",
          title: "未识别到自动实体",
          body: "可手动补充实体后继续。"
        });
      }
    } catch (error) {
      setSanitize((current) => ({ ...current, previewing: false }));
      setStatus(errorStatus(error));
    }
  }

  function updateEntity(index: number, patch: Partial<EntityItem>) {
    setSanitize((current) => ({
      ...current,
      entities: current.entities.map((entity, entityIndex) =>
        entityIndex === index ? { ...entity, ...patch } : entity
      )
    }));
  }

  function removeEntity(index: number) {
    setSanitize((current) => ({
      ...current,
      entities: current.entities.filter((_entity, entityIndex) => entityIndex !== index)
    }));
  }

  function addManualEntity() {
    const docId = currentSanitizeDocId();
    const originalValue = manualEntity.originalValue.trim();
    const targetFile = sanitize.files.find((file) => docIdForSanitizeFile(file) === docId);
    if (!docId) {
      setStatus({ tone: "error", title: "请先预览识别当前输入" });
      return;
    }
    if (!originalValue) {
      setStatus({ tone: "error", title: "请填写手动实体原文值" });
      return;
    }

    const stableId = nextStableId(docId, sanitize.entities);
    const maskedValue = manualEntity.maskedValue.trim() || defaultMaskedValue(originalValue, stableId, sanitize.entities);
    const entity: EntityItem = {
      id: `manual-${Date.now()}`,
      docId,
      filePath: sanitize.inputKind === "word" ? targetFile?.path || "" : "pasted-text",
      type: GENERIC_ENTITY_TYPE,
      originalValue,
      maskedValue,
      stableId,
      contextHash: "",
      locations: [],
      enabled: true,
      source: "manual"
    };

    setSanitize((current) => ({
      ...current,
      entities: [...current.entities, entity]
    }));
    setManualEntity((current) => ({
      ...EMPTY_MANUAL_ENTITY,
      docId: current.docId
    }));
    setStatus({
      tone: "success",
      title: "已添加手动实体",
      body: `${originalValue} -> ${maskedValue}`
    });
  }

  async function runSanitize() {
    const source = currentSanitizeSource(true);
    const batchSources = sanitize.inputKind === "word" ? currentSanitizeSources(true) : [];
    if (!source || (sanitize.inputKind === "word" && !batchSources.length)) {
      setStatus({ tone: "error", title: "请先输入待脱敏内容" });
      return;
    }
    const textOutputMode = sanitize.textOutputMode || "file";
    const outputDirectoryRequired = source.kind === "word" ||
      sanitize.mode === "reversible" ||
      textOutputMode === "file";
    if (outputDirectoryRequired && !sanitize.outputDir) {
      setStatus({ tone: "error", title: "请选择输出目录" });
      return;
    }
    if (requiresImageAcknowledgement(sanitize.preview) && !sanitize.imageHandling) {
      setStatus({
        tone: "warning",
        title: "请选择图片处理方式",
        body: "图片内内容无法脱敏，请选择保留图片或删除全部图片后继续。"
      });
      return;
    }

    const enabledEntities = sanitize.entities
      .filter((entity) => entity.enabled)
      .map((entity) => ({
        ...entity,
        originalValue: entity.originalValue.trim(),
        maskedValue: entity.maskedValue.trim()
      }));

    if (!enabledEntities.length) {
      setStatus({ tone: "error", title: "至少启用一个实体后才能导出" });
      return;
    }
    if (enabledEntities.some((entity) => !entity.originalValue || !entity.maskedValue)) {
      setStatus({ tone: "error", title: "启用实体必须包含原文值和脱敏值" });
      return;
    }

    let credential: Credential | undefined;
    if (sanitize.mode === "reversible") {
      const reversibleCredential = getSanitizeCredential();
      if (!reversibleCredential) return;
      credential = reversibleCredential;
    }

    try {
      setSanitize((current) => ({ ...current, running: true, results: [], resultBlocked: [] }));
      const result = await callDesktop((api) =>
        sanitize.inputKind === "word"
          ? api.runSanitizeBatch({
            sources: batchSources as Array<BatchSanitizeSource & { docId: string }>,
            mode: sanitize.mode,
            entities: enabledEntities,
            outputDir: sanitize.outputDir,
            credential,
            acknowledgements: {
              imageHandling: sanitize.imageHandling || undefined,
              imageContentUnmodified: sanitize.imageHandling === "keep"
            }
          })
          : api.runSanitize({
            source,
            mode: sanitize.mode,
            entities: enabledEntities,
            ...(outputDirectoryRequired ? { outputDir: sanitize.outputDir } : {}),
            textOutputMode,
            credential,
            acknowledgements: {
              imageHandling: sanitize.imageHandling || undefined,
              imageContentUnmodified: sanitize.imageHandling === "keep"
            }
          })
      );

      setSanitize((current) => ({
        ...current,
        running: false,
        results: result.results,
        resultBlocked: result.blocked || []
      }));
      const outputFileCount = result.results.reduce((count, item) =>
        count + (item.outputs.sanitizedFile ? 1 : 0) + (item.outputs.mappingFile ? 1 : 0),
      0);
      setStatus({
        tone: result.blocked?.length ? "warning" : "success",
        title: result.blocked?.length ? "部分文件导出失败" : outputFileCount ? "脱敏导出完成" : "脱敏文本已生成",
        body: result.blocked?.length
          ? outputFileCount
            ? `已生成 ${outputFileCount} 个输出文件，${result.blocked.length} 个文件失败。`
            : `${result.blocked.length} 个文件失败，未生成输出文件。`
          : outputFileCount
            ? `已生成 ${outputFileCount} 个输出文件。`
            : "已在结果区生成可复制的脱敏文本。",
        details: result.blocked?.map((item) => `${fileNameFromPath(item.path)}: ${item.error.message}`)
      });
    } catch (error) {
      setSanitize((current) => ({ ...current, running: false }));
      setStatus(errorStatus(error));
    }
  }

  async function selectRestoreFile() {
    await importRestoreFile((api) => api.importDocuments({ purpose: "restore", multi: false }));
  }

  async function importRestoreFile(loader: (api: DesktopApi) => Promise<ApiResponse<DocumentSummary[]>>) {
    try {
      const files = await callDesktop(loader);
      if (!files.length) return;

      setRestore((current) => ({
        ...current,
        inputKind: "word",
        file: files[0],
        result: null
      }));
      setStatus({ tone: "info", title: "已选择待还原文件", body: files[0].name });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  function changeRestoreInputKind(inputKind: InputSourceKind) {
    setRestore((current) => ({
      ...current,
      inputKind,
      result: null
    }));
  }

  function changeRestoreText(pastedText: string) {
    setRestore((current) => ({
      ...current,
      inputKind: "text",
      pastedText,
      result: null
    }));
  }

  function clearRestoreText() {
    setRestore((current) => ({
      ...current,
      inputKind: "text",
      pastedText: "",
      result: null
    }));
  }

  async function selectMappingFile() {
    try {
      const files = await callDesktop((api) => api.importDocuments({ purpose: "mapping", multi: false }));
      if (!files.length) return;

      setRestore((current) => ({
        ...current,
        mappingFile: files[0],
        result: null
      }));
      setStatus({ tone: "info", title: "已选择加密映射文件", body: files[0].name });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function selectRestoreOutput() {
    try {
      const outputDir = await callDesktop((api) => api.selectOutputDirectory());
      if (!outputDir) return;

      setRestore((current) => ({
        ...current,
        outputDir
      }));
      setStatus({ tone: "info", title: "已选择还原输出目录", body: outputDir });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function selectRestoreKeyFile() {
    try {
      const files = await callDesktop((api) => api.importDocuments({ purpose: "keyFile", multi: false }));
      if (!files.length) return;

      setRestore((current) => ({
        ...current,
        keyFile: files[0]
      }));
      setStatus({ tone: "info", title: "已选择密钥文件", body: files[0].name });
    } catch (error) {
      setStatus(errorStatus(error));
    }
  }

  async function runRestore() {
    const source = currentRestoreSource();
    if (!source || !restore.mappingFile || !restore.outputDir) {
      setStatus({ tone: "error", title: "请选择待还原内容、映射文件和输出目录" });
      return;
    }

    const credential = getRestoreCredential();
    if (!credential) return;

    try {
      setRestore((current) => ({ ...current, running: true, result: null }));
      const result = await callDesktop((api) =>
        api.runRestore({
          source,
          mappingPath: restore.mappingFile!.path,
          outputDir: restore.outputDir,
          credential
        })
      );

      setRestore((current) => ({
        ...current,
        running: false,
        result
      }));
      setStatus({
        tone: "success",
        title: "内容还原完成",
        body: result.outputPath
      });
    } catch (error) {
      setRestore((current) => ({ ...current, running: false }));
      setStatus(errorStatus(error));
    }
  }

  function getSanitizeCredential(): Credential | null {
    if (sanitize.credentialMethod === "password") {
      if (!sanitize.password.trim()) {
        setStatus({ tone: "error", title: "请输入可恢复映射口令" });
        return null;
      }
      return { method: "password", password: sanitize.password };
    }

    if (!sanitize.keyFile) {
      setStatus({ tone: "error", title: "请选择密钥文件" });
      return null;
    }
    return { method: "keyFile", keyFilePath: sanitize.keyFile.path };
  }

  function getRestoreCredential(): Credential | null {
    if (restore.credentialMethod === "password") {
      if (!restore.password.trim()) {
        setStatus({ tone: "error", title: "请输入映射口令" });
        return null;
      }
      return { method: "password", password: restore.password };
    }

    if (!restore.keyFile) {
      setStatus({ tone: "error", title: "请选择密钥文件" });
      return null;
    }
    return { method: "keyFile", keyFilePath: restore.keyFile.path };
  }

  function openView(view: NavigationView) {
    setActiveView(view);
    setStatus(null);
  }

  const outputActions: OutputDocumentActionHandlers = {
    onPreviewDocument: (filePath, title) => void previewOutputDocument(filePath, title),
    onOpenDocument: (filePath) => void openOutputDocument(filePath),
    onRevealDocument: (filePath) => void revealOutputDocument(filePath),
    onDeleteDocument: (filePath) => void deleteOutputDocument(filePath)
  };

  return (
    <div className="h-screen bg-background text-on-background font-sans">
      <Sidebar activeView={activeView} version={version} onNavigate={openView} />
      <main className="ml-[260px] h-screen overflow-y-auto app-scrollbar">
        <div className="mx-auto max-w-6xl px-8 py-7">
          {activeView === "dashboard" && (
            <Dashboard
              onStartSanitize={() => openView("sanitize")}
              onStartRestore={() => openView("restore")}
              sanitizeResults={sanitize.results}
              restoreResult={restore.result}
              outputActions={outputActions}
            />
          )}

          {activeView === "sanitize" && (
            <SanitizeWorkflow
              state={sanitize}
              step={sanitizeStep}
              manualEntity={manualEntity}
              manualDocOptions={sanitizeDocOptions()}
              onManualEntityChange={setManualEntity}
              onBack={() => openView("dashboard")}
              onInputKindChange={changeSanitizeInputKind}
              onTextChange={changeSanitizeText}
              onClearText={clearSanitizeText}
              onSelectFiles={selectSanitizeFiles}
              onPreview={previewEntities}
              onSelectOutput={selectSanitizeOutput}
              onSelectKeyFile={selectSanitizeKeyFile}
              onRun={runSanitize}
              onModeChange={(mode) => setSanitize((current) => ({ ...current, mode }))}
              onTextOutputModeChange={(textOutputMode) =>
                setSanitize((current) => ({ ...current, textOutputMode }))
              }
              onCredentialMethodChange={(credentialMethod) =>
                setSanitize((current) => ({ ...current, credentialMethod }))
              }
              onPasswordChange={(password) => setSanitize((current) => ({ ...current, password }))}
              onAddManualEntity={addManualEntity}
              onEntityChange={updateEntity}
              onRemoveEntity={removeEntity}
              onImageHandlingChange={(imageHandling) =>
                setSanitize((current) => ({ ...current, imageHandling }))
              }
              outputActions={outputActions}
            />
          )}

          {activeView === "restore" && (
            <RestoreWorkflow
              state={restore}
              onBack={() => openView("dashboard")}
              onInputKindChange={changeRestoreInputKind}
              onTextChange={changeRestoreText}
              onClearText={clearRestoreText}
              onSelectFile={selectRestoreFile}
              onSelectMappingFile={selectMappingFile}
              onSelectOutput={selectRestoreOutput}
              onSelectKeyFile={selectRestoreKeyFile}
              onRun={runRestore}
              onCredentialMethodChange={(credentialMethod) =>
                setRestore((current) => ({ ...current, credentialMethod }))
              }
              onPasswordChange={(password) => setRestore((current) => ({ ...current, password }))}
              outputActions={outputActions}
            />
          )}

          {activeView === "entitySets" && (
            <EntitySetManager
              entitySets={entitySets}
              selectedId={selectedEntitySetId}
              onSelect={setSelectedEntitySetId}
              onSave={saveEntitySet}
              onDelete={deleteSelectedEntitySet}
              onImport={importEntitySet}
              onExport={exportEntitySet}
              onBack={() => openView("dashboard")}
            />
          )}
        </div>
      </main>
      {outputPreview && (
        <OutputPreviewModal preview={outputPreview} onClose={() => setOutputPreview(null)} />
      )}
      {status && <StatusPanel status={status} onClose={() => setStatus(null)} />}
    </div>
  );
}

function Sidebar({
  activeView,
  version,
  onNavigate
}: {
  activeView: NavigationView;
  version: string;
  onNavigate: (view: NavigationView) => void;
}) {
  return (
    <nav className="fixed left-0 top-0 z-40 flex h-screen w-[260px] flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-6 py-7">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-surface">
          <img src="./app-logo.png" alt="" className="h-10 w-10 object-contain" />
        </div>
        <div>
          <h1 className="text-base font-bold leading-tight text-primary">脱敏助手</h1>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-on-surface-muted">
            Local De-ID
          </p>
        </div>
      </div>

      <div className="flex-1 px-4 py-5">
        <NavItem
          icon={LayoutDashboard}
          label="工作台"
          active={activeView === "dashboard"}
          onClick={() => onNavigate("dashboard")}
        />
        <NavItem
          icon={FileCheck2}
          label="文档脱敏"
          active={activeView === "sanitize"}
          onClick={() => onNavigate("sanitize")}
        />
        <NavItem
          icon={RotateCcw}
          label="内容还原"
          active={activeView === "restore"}
          onClick={() => onNavigate("restore")}
        />
        <NavItem
          icon={FileText}
          label="实体集"
          active={activeView === "entitySets"}
          onClick={() => onNavigate("entitySets")}
        />
      </div>

      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-3 rounded-lg bg-surface-muted px-3 py-3">
          <LockKeyhole size={18} className="text-success" />
          <div>
            <p className="text-xs font-semibold text-on-surface">本地脱敏还原</p>
            <p className="font-mono text-[10px] text-on-surface-muted">v{version}</p>
          </div>
        </div>
      </div>
    </nav>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mb-1 flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-semibold transition",
        active ? "bg-primary-muted text-primary" : "text-on-surface-muted hover:bg-surface-muted hover:text-on-surface"
      )}
    >
      <Icon size={19} strokeWidth={2.2} />
      <span>{label}</span>
    </button>
  );
}

function Dashboard({
  onStartSanitize,
  onStartRestore,
  sanitizeResults,
  restoreResult,
  outputActions
}: {
  onStartSanitize: () => void;
  onStartRestore: () => void;
  sanitizeResults: SanitizeResultItem[];
  restoreResult: RestoreResult | null;
  outputActions: OutputDocumentActionHandlers;
}) {
  return (
    <div className="space-y-7">
      <PageHeader
        title="工作台"
        description="本地文档脱敏与实体级还原"
        aside={
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-success">
            <span className="h-2 w-2 rounded-full bg-success" />
            Main process ready
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ActionCard
          icon={FileCheck2}
          title="文档脱敏"
          description="不可恢复脱敏或生成加密映射文件的可恢复脱敏。"
          actionLabel="新建脱敏任务"
          tone="primary"
          onClick={onStartSanitize}
        />
        <ActionCard
          icon={KeyRound}
          title="内容还原"
          description="使用脱敏文件、加密映射文件和凭据执行实体级还原。"
          actionLabel="发起还原"
          tone="success"
          onClick={onStartRestore}
        />
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
        <Panel title="最近输出" icon={FileText}>
          {sanitizeResults.length || restoreResult ? (
            <div className="space-y-3">
              {sanitizeResults.map((result) => (
                <OutputGroup key={sanitizeResultKey(result)} result={result} outputActions={outputActions} />
              ))}
              {restoreResult && (
                <div className="rounded-lg border border-border bg-surface-muted p-4">
                  <PathList
                    rows={[
                      ["还原文件", restoreResult.outputPath]
                    ]}
                  />
                  <DocumentActionButtons
                    filePath={restoreResult.outputPath}
                    previewTitle="还原后内容预览"
                    actions={outputActions}
                  />
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              title="暂无输出"
              body="完成一次脱敏或还原后会显示本次会话的输出路径。"
            />
          )}
        </Panel>

        <Panel title="安全边界" icon={ShieldCheck}>
          <ul className="space-y-3 text-sm text-on-surface-muted">
            <li className="flex gap-2">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
              <span>文件处理、映射加密和还原均在 main process 执行。</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
              <span>renderer 只展示文件摘要、实体表和输出路径。</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
              <span>不接入外部 AI 请求。</span>
            </li>
          </ul>
        </Panel>
      </section>
    </div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  description,
  actionLabel,
  tone,
  onClick
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  tone: "primary" | "success";
  onClick: () => void;
}) {
  const toneClass = tone === "success"
    ? "text-success bg-success-muted border-success/20 group-hover:border-success"
    : "text-primary bg-primary-muted border-primary/20 group-hover:border-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[190px] flex-col items-start rounded-lg border border-border bg-surface p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className={cn("mb-5 flex h-12 w-12 items-center justify-center rounded-lg border", toneClass)}>
        <Icon size={24} strokeWidth={2.3} />
      </div>
      <h2 className="text-lg font-bold text-on-surface">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-on-surface-muted">{description}</p>
      <span className={cn("mt-auto flex items-center gap-2 text-sm font-semibold", tone === "success" ? "text-success" : "text-primary")}>
        {actionLabel}
        <ArrowRight size={16} />
      </span>
    </button>
  );
}

function SanitizeWorkflow({
  state,
  step,
  manualEntity,
  manualDocOptions,
  onManualEntityChange,
  onBack,
  onInputKindChange,
  onTextChange,
  onClearText,
  onSelectFiles,
  onPreview,
  onSelectOutput,
  onSelectKeyFile,
  onRun,
  onModeChange,
  onTextOutputModeChange,
  onCredentialMethodChange,
  onPasswordChange,
  onAddManualEntity,
  onEntityChange,
  onRemoveEntity,
  onImageHandlingChange,
  outputActions
}: {
  state: SanitizeState;
  step: number;
  manualEntity: typeof EMPTY_MANUAL_ENTITY;
  manualDocOptions: ManualDocOption[];
  onManualEntityChange: (value: typeof EMPTY_MANUAL_ENTITY) => void;
  onBack: () => void;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFiles: () => void;
  onPreview: () => void;
  onSelectOutput: () => void;
  onSelectKeyFile: () => void;
  onRun: () => void;
  onModeChange: (mode: SanitizeMode) => void;
  onTextOutputModeChange: (mode: TextOutputMode) => void;
  onCredentialMethodChange: (method: CredentialMethod) => void;
  onPasswordChange: (password: string) => void;
  onAddManualEntity: () => void;
  onEntityChange: (index: number, patch: Partial<EntityItem>) => void;
  onRemoveEntity: (index: number) => void;
  onImageHandlingChange: (imageHandling: ImageHandling) => void;
  outputActions: OutputDocumentActionHandlers;
}) {
  const enabledCount = state.entities.filter((entity) => entity.enabled).length;
  const hasInput = state.inputKind === "word" ? state.files.length > 0 : state.pastedText.trim().length > 0;
  const canAddManualEntity = manualDocOptions.length > 0;
  const imageAckRequired = requiresImageAcknowledgement(state.preview);
  const isTextInput = state.inputKind === "text";
  const textOutputMode = state.textOutputMode || "file";
  const outputDirectoryRequired = state.inputKind === "word" ||
    state.mode === "reversible" ||
    textOutputMode === "file";

  return (
    <div className="space-y-6">
      <StickyPageTop>
        <PageHeader
          title="文档脱敏"
          description="导入、识别、复核并导出脱敏文件"
          aside={<BackButton onClick={onBack} />}
        />
        <Stepper
          current={step}
          steps={["输入内容", "确认脱敏内容", "选择模式", "导出结果"]}
        />
      </StickyPageTop>

      <section className="grid grid-cols-12 gap-5">
        <div className="col-span-12 space-y-5 xl:col-span-8">
          <Panel title="输入内容" icon={UploadCloud}>
            <InputSourcePanel
              inputKind={state.inputKind}
              files={state.files}
              pastedText={state.pastedText}
              preview={state.preview}
              onInputKindChange={onInputKindChange}
              onTextChange={onTextChange}
              onClearText={onClearText}
              onSelectFiles={onSelectFiles}
            />
          </Panel>

          <Panel
            title="确认脱敏内容"
            icon={FileCheck2}
            right={
              <Button icon={RefreshCw} variant="secondary" onClick={onPreview} disabled={state.previewing || !hasInput}>
                {state.previewing ? "识别中" : "预览识别"}
              </Button>
            }
          >
            <ManualEntityForm
              value={manualEntity}
              docOptions={manualDocOptions}
              onChange={onManualEntityChange}
              onAdd={onAddManualEntity}
              disabled={!canAddManualEntity}
            />
            <EntityTable
              entities={state.entities}
              docOptions={manualDocOptions}
              onChange={onEntityChange}
              onRemove={onRemoveEntity}
            />
            {imageAckRequired ? (
              <div className="mt-5">
                <ImageHandlingSelector
                  value={state.imageHandling}
                  onChange={onImageHandlingChange}
                />
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="col-span-12 space-y-5 xl:col-span-4">
          <Panel title="模式与输出" icon={ShieldCheck}>
            <div className="space-y-4">
              <ModeSelector mode={state.mode} onChange={onModeChange} />

              {isTextInput && state.mode === "irreversible" ? (
                <TextOutputModeSelector
                  value={textOutputMode}
                  onChange={onTextOutputModeChange}
                />
              ) : null}

              {state.mode === "reversible" && (
                <CredentialFields
                  method={state.credentialMethod}
                  password={state.password}
                  keyFile={state.keyFile}
                  onMethodChange={onCredentialMethodChange}
                  onPasswordChange={onPasswordChange}
                  onSelectKeyFile={onSelectKeyFile}
                />
              )}

              {isTextInput && state.mode === "reversible" ? (
                <div className="rounded-lg border border-primary/20 bg-primary-muted px-3 py-3 text-xs leading-5 text-primary">
                  可恢复文本会导出加密映射文件，并在结果区生成可复制的脱敏文本。
                </div>
              ) : null}

              <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-on-surface-muted">启用实体</span>
                  <span className="font-mono font-semibold text-on-surface">{enabledCount}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-on-surface-muted">输出模式</span>
                  <span className="font-semibold text-on-surface">
                    {state.mode === "reversible" ? "可恢复" : "不可恢复"}
                  </span>
                </div>
                {isTextInput ? (
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-on-surface-muted">文本输出</span>
                    <span className="font-semibold text-on-surface">
                      {state.mode === "reversible"
                        ? "映射文件 + 可复制文本"
                        : textOutputMode === "file"
                          ? "导出文件"
                          : "可复制文本"}
                    </span>
                  </div>
                ) : null}
              </div>

              {outputDirectoryRequired ? (
                <OutputSelector outputDir={state.outputDir} onSelect={onSelectOutput} />
              ) : null}

              <Button icon={FileCheck2} block onClick={onRun} disabled={state.running || (imageAckRequired && !state.imageHandling)}>
                {state.running ? "处理中" : "执行脱敏"}
              </Button>
            </div>
          </Panel>

          <Panel title="导出结果" icon={FolderOpen}>
            {state.results.length || state.resultBlocked.length ? (
              <div className="space-y-4">
                {state.results.map((result) => (
                  <OutputGroup key={sanitizeResultKey(result)} result={result} outputActions={outputActions} />
                ))}
                {state.resultBlocked.length ? <OutputBlockedList blocked={state.resultBlocked} /> : null}
              </div>
            ) : (
              <EmptyState icon={FolderOpen} title="等待导出" body="输出路径会在任务完成后显示。" />
            )}
          </Panel>
        </div>
      </section>
    </div>
  );
}

function RestoreWorkflow({
  state,
  onBack,
  onInputKindChange,
  onTextChange,
  onClearText,
  onSelectFile,
  onSelectMappingFile,
  onSelectOutput,
  onSelectKeyFile,
  onRun,
  onCredentialMethodChange,
  onPasswordChange,
  outputActions
}: {
  state: RestoreState;
  onBack: () => void;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFile: () => void;
  onSelectMappingFile: () => void;
  onSelectOutput: () => void;
  onSelectKeyFile: () => void;
  onRun: () => void;
  onCredentialMethodChange: (method: CredentialMethod) => void;
  onPasswordChange: (password: string) => void;
  outputActions: OutputDocumentActionHandlers;
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="内容还原"
        description="按映射文件执行实体级还原"
        aside={<BackButton onClick={onBack} />}
      />

      <section className="grid grid-cols-12 gap-5">
        <div className="col-span-12 space-y-5 xl:col-span-8">
          <Panel title="还原输入" icon={RotateCcw}>
            <RestoreInputPanel
              inputKind={state.inputKind}
              file={state.file}
              pastedText={state.pastedText}
              onInputKindChange={onInputKindChange}
              onTextChange={onTextChange}
              onClearText={onClearText}
              onSelectFile={onSelectFile}
            />
            <div className="mt-3">
              <FilePickCard
                icon={KeyRound}
                title="加密映射文件"
                file={state.mappingFile}
                buttonLabel="选择映射"
                onSelect={onSelectMappingFile}
              />
            </div>
          </Panel>

          <Panel title="凭据与输出" icon={LockKeyhole}>
            <div className="space-y-4">
              <CredentialFields
                method={state.credentialMethod}
                password={state.password}
                keyFile={state.keyFile}
                onMethodChange={onCredentialMethodChange}
                onPasswordChange={onPasswordChange}
                onSelectKeyFile={onSelectKeyFile}
              />
              <OutputSelector outputDir={state.outputDir} onSelect={onSelectOutput} />
              <Button icon={RotateCcw} block onClick={onRun} disabled={state.running}>
                {state.running ? "还原中" : "执行还原"}
              </Button>
            </div>
          </Panel>
        </div>

        <div className="col-span-12 space-y-5 xl:col-span-4">
          <Panel title="还原结果" icon={FileCheck2}>
            {state.result ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-muted px-4 py-3 text-sm font-semibold text-success">
                  <CheckCircle2 size={18} />
                  内容还原完成
                </div>
                <PathList
                  rows={[
                    ["还原文件", state.result.outputPath]
                  ]}
                />
                <DocumentActionButtons
                  filePath={state.result.outputPath}
                  previewTitle="还原后内容预览"
                  actions={outputActions}
                />
                {state.result.restoredText ? (
                  <TextResult title="还原文本" value={state.result.restoredText} />
                ) : null}
                {state.result.warnings.length > 0 && (
                  <WarningList warnings={state.result.warnings} />
                )}
              </div>
            ) : (
              <EmptyState icon={RotateCcw} title="等待还原" body="还原文件路径会在任务完成后显示。" />
            )}
          </Panel>

          <Panel title="还原规则" icon={ShieldCheck}>
            <ul className="space-y-3 text-sm text-on-surface-muted">
              <li className="flex gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
                <span>只按映射中的脱敏值和稳定标签还原。</span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
                <span>被删除的实体不会被凭空补回。</span>
              </li>
            </ul>
          </Panel>
        </div>
      </section>
    </div>
  );
}

function PageHeader({
  title,
  description,
  aside
}: {
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
      <div>
        <h2 className="text-xl font-bold tracking-normal text-on-surface">{title}</h2>
        <p className="mt-1 text-sm text-on-surface-muted">{description}</p>
      </div>
      {aside}
    </header>
  );
}

function StickyPageTop({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-30 -mx-8 -mt-7 bg-background px-8 pt-7">
      <div className="space-y-6">{children}</div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-surface-muted"
    >
      <ArrowLeft size={16} />
      返回工作台
    </button>
  );
}

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-border bg-surface">
      {steps.map((step, index) => {
        const number = index + 1;
        const active = current === number;
        const complete = current > number;
        return (
          <div
            key={step}
            className={cn(
              "flex min-h-[54px] flex-1 items-center justify-center gap-2 border-r border-border px-4 text-sm last:border-r-0",
              active ? "bg-primary-muted font-semibold text-primary" : "text-on-surface-muted",
              complete && "text-success"
            )}
          >
            {complete ? <CheckCircle2 size={17} /> : <CircleDot size={17} />}
            <span>{step}</span>
          </div>
        );
      })}
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  right,
  children
}: {
  title: string;
  icon: LucideIcon;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex min-h-[56px] items-center justify-between gap-3 border-b border-border px-5">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-primary" />
          <h3 className="text-sm font-bold text-on-surface">{title}</h3>
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Button({
  children,
  icon: Icon,
  variant = "primary",
  block = false,
  disabled = false,
  onClick
}: {
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "danger";
  block?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition",
        block && "w-full",
        variant === "primary"
          ? "bg-primary text-white hover:bg-primary-strong disabled:bg-border-strong"
          : variant === "danger"
            ? "border border-danger/30 bg-danger-muted text-danger hover:bg-danger/10 disabled:text-on-surface-muted"
            : "border border-border bg-surface text-on-surface hover:bg-surface-muted disabled:text-on-surface-muted"
      )}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

function EntitySetManager({
  entitySets,
  selectedId,
  onSelect,
  onSave,
  onDelete,
  onImport,
  onExport,
  onBack
}: {
  entitySets: EntitySet[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSave: (entitySet: EntitySet) => void;
  onDelete: (id: string) => void;
  onImport: (format: "json" | "csv", content: string) => void;
  onExport: (id: string, format: "json" | "csv") => void;
  onBack: () => void;
}) {
  const selected = entitySets.find((entitySet) => entitySet.id === selectedId) || entitySets[0] || null;
  const [draft, setDraft] = useState<EntitySet | null>(selected ? cloneEntitySet(selected) : null);

  useEffect(() => {
    setDraft(selected ? cloneEntitySet(selected) : null);
  }, [selected?.id, selected?.updatedAt, entitySets.length]);

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const format = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
    onImport(format, await file.text());
  }

  function updateItem(index: number, patch: Partial<EntitySetItem>) {
    if (!draft) return;
    setDraft({
      ...draft,
      items: draft.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)
    });
  }

  function addItem() {
    if (!draft) return;
    setDraft({
      ...draft,
      items: [...draft.items, createBlankEntitySetItem()]
    });
  }

  function removeItem(index: number) {
    if (!draft) return;
    setDraft({
      ...draft,
      items: draft.items.filter((_item, itemIndex) => itemIndex !== index)
    });
  }

  const enabledItems = draft?.items.filter((item) => item.enabled).length || 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="实体集管理"
        description="维护常见需脱敏词库，预览识别时自动加入实体确认表"
        aside={<BackButton onClick={onBack} />}
      />

      <section className="grid grid-cols-12 gap-5">
        <div className="col-span-12 space-y-4 xl:col-span-4">
          <Panel
            title="实体集"
            icon={FileText}
            right={
              <Button
                icon={Plus}
                variant="secondary"
                onClick={() => onSave(createBlankEntitySet())}
              >
                新建
              </Button>
            }
          >
            <div className="space-y-2">
              {entitySets.map((entitySet) => (
                <button
                  type="button"
                  key={entitySet.id}
                  onClick={() => onSelect(entitySet.id)}
                  className={cn(
                    "w-full rounded-lg border px-4 py-3 text-left transition",
                    selected?.id === entitySet.id
                      ? "border-primary bg-primary-muted text-primary"
                      : "border-border bg-surface hover:bg-surface-muted"
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold">{entitySet.name}</span>
                    <StatusBadge tone={entitySet.enabled ? "success" : "warning"}>
                      {entitySet.enabled ? "启用" : "停用"}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-on-surface-muted">
                    {entitySet.items.length} 条，版本 {entitySet.version}
                  </p>
                </button>
              ))}
              {!entitySets.length && (
                <EmptyState icon={FileText} title="暂无实体集" body="新建或导入实体集后显示。" />
              )}
            </div>
          </Panel>

          <Panel title="导入导出" icon={UploadCloud}>
            <div className="space-y-3">
              <input
                id="entity-set-import"
                type="file"
                accept=".json,.csv,application/json,text/csv"
                className="hidden"
                onChange={handleImport}
              />
              <Button
                icon={UploadCloud}
                variant="secondary"
                block
                onClick={() => document.getElementById("entity-set-import")?.click()}
              >
                导入 JSON/CSV
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  disabled={!selected}
                  onClick={() => selected && onExport(selected.id, "json")}
                >
                  导出 JSON
                </Button>
                <Button
                  variant="secondary"
                  disabled={!selected}
                  onClick={() => selected && onExport(selected.id, "csv")}
                >
                  导出 CSV
                </Button>
              </div>
            </div>
          </Panel>
        </div>

        <div className="col-span-12 xl:col-span-8">
          <Panel
            title="词库条目"
            icon={FileCheck2}
            right={
              <div className="flex gap-2">
                <Button icon={Plus} variant="secondary" disabled={!draft} onClick={addItem}>
                  添加条目
                </Button>
                <Button icon={CheckCircle2} disabled={!draft} onClick={() => draft && onSave(draft)}>
                  保存
                </Button>
              </div>
            }
          >
            {draft ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_110px_130px]">
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                    placeholder="实体集名称"
                  />
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                      className="h-4 w-4 accent-primary"
                    />
                    启用
                  </label>
                  <div className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-on-surface-muted">
                    启用条目 {enabledItems}/{draft.items.length}
                  </div>
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                  <div className="max-h-[560px] overflow-auto app-scrollbar">
                    <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-surface-muted text-xs font-bold uppercase text-on-surface-muted">
                        <tr>
                          <th className="w-16 border-b border-border px-3 py-3">启用</th>
                          <th className="w-56 border-b border-border px-3 py-3">实体名称</th>
                          <th className="w-52 border-b border-border px-3 py-3">别名</th>
                          <th className="w-44 border-b border-border px-3 py-3">默认脱敏值</th>
                          <th className="w-40 border-b border-border px-3 py-3">来源</th>
                          <th className="border-b border-border px-3 py-3">备注</th>
                          <th className="w-16 border-b border-border px-3 py-3 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border bg-surface">
                        {draft.items.map((item, index) => (
                          <tr key={item.id}>
                            <td className="px-3 py-3">
                              <input
                                type="checkbox"
                                checked={item.enabled}
                                onChange={(event) => updateItem(index, { enabled: event.target.checked })}
                                className="h-4 w-4 accent-primary"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={item.canonicalName}
                                onChange={(event) => updateItem(index, { canonicalName: event.target.value })}
                                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 outline-none focus:border-primary"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={item.aliases.join("|")}
                                onChange={(event) => updateItem(index, { aliases: splitAliases(event.target.value) })}
                                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 outline-none focus:border-primary"
                                placeholder="用 | 分隔"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={item.maskedValue}
                                onChange={(event) => updateItem(index, { maskedValue: event.target.value })}
                                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
                                placeholder="留空自动生成"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={item.sourceName}
                                onChange={(event) => updateItem(index, { sourceName: event.target.value })}
                                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 outline-none focus:border-primary"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={item.notes}
                                onChange={(event) => updateItem(index, { notes: event.target.value })}
                                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 outline-none focus:border-primary"
                              />
                            </td>
                            <td className="px-3 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => removeItem(index)}
                                className="rounded-lg p-2 text-on-surface-muted transition hover:bg-danger-muted hover:text-danger"
                                title="移除此条目"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="flex justify-between">
                  <Button variant="secondary" onClick={() => selected && setDraft(cloneEntitySet(selected))}>
                    撤销未保存修改
                  </Button>
                  <Button variant="secondary" disabled={!selected} onClick={() => selected && onDelete(selected.id)}>
                    删除实体集
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState icon={FileText} title="暂无实体集" body="新建或导入实体集后开始维护。" />
            )}
          </Panel>
        </div>
      </section>
    </div>
  );
}

function InputSourcePanel({
  inputKind,
  files,
  pastedText,
  preview,
  onInputKindChange,
  onTextChange,
  onClearText,
  onSelectFiles
}: {
  inputKind: InputSourceKind;
  files: DocumentSummary[];
  pastedText: string;
  preview: PreviewResult | null;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFiles: () => void;
}) {
  return (
    <div className="space-y-4">
      <SegmentedControl
        value={inputKind}
        options={[
          { value: "word", label: "Word 文件" },
          { value: "text", label: "粘贴文本" }
        ]}
        onChange={(value) => onInputKindChange(value as InputSourceKind)}
      />

      {inputKind === "word" ? (
        <div className="space-y-3">
          <DocxUploadBox
            title="点击上传 DOCX"
            description="支持一次选择多个 Word DOCX。旧版 DOC 请另存为 DOCX 后处理。"
            onSelect={onSelectFiles}
          />
          <FileList files={files} preview={preview} />
        </div>
      ) : (
        <TextInputArea
          value={pastedText}
          placeholder="粘贴待脱敏文本"
          onChange={onTextChange}
          onClear={onClearText}
        />
      )}
    </div>
  );
}

function RestoreInputPanel({
  inputKind,
  file,
  pastedText,
  onInputKindChange,
  onTextChange,
  onClearText,
  onSelectFile
}: {
  inputKind: InputSourceKind;
  file: DocumentSummary | null;
  pastedText: string;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFile: () => void;
}) {
  return (
    <div className="space-y-4">
      <SegmentedControl
        value={inputKind}
        options={[
          { value: "word", label: "Word 文件" },
          { value: "text", label: "粘贴文本" }
        ]}
        onChange={(value) => onInputKindChange(value as InputSourceKind)}
      />

      {inputKind === "word" ? (
        <div className="space-y-3">
          <DocxUploadBox
            title="点击上传 DOCX"
            description="选择需要按映射还原的 DOCX 文件。"
            onSelect={onSelectFile}
          />
          <SelectedDocxFile file={file} />
        </div>
      ) : (
        <TextInputArea
          value={pastedText}
          placeholder="粘贴待还原文本"
          onChange={onTextChange}
          onClear={onClearText}
        />
      )}
    </div>
  );
}

function TextInputArea({
  value,
  placeholder,
  readOnly = false,
  onChange,
  onClear
}: {
  value: string;
  placeholder?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="space-y-2">
      <textarea
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        className="min-h-[220px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-3 text-sm leading-6 text-on-surface outline-none focus:border-primary"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-muted">
        <span>{value.length} 字符</span>
        {onClear ? (
          <Button icon={Trash2} variant="secondary" disabled={!value} onClick={onClear}>
            清空
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TextResult({ title, value }: { title: string; value: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-on-surface">{title}</p>
        <Button icon={Copy} variant="secondary" onClick={() => void navigator.clipboard?.writeText(value)}>
          复制
        </Button>
      </div>
      <TextInputArea value={value} readOnly />
    </div>
  );
}

function DocxUploadBox({
  title,
  description,
  onSelect
}: {
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className="flex min-h-[148px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-muted px-4 py-8 text-center text-on-surface-muted transition hover:border-primary hover:bg-primary-muted/45"
    >
      <UploadCloud size={28} className="text-on-surface-muted" />
      <p className="mt-3 text-sm font-bold text-on-surface">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-on-surface-muted">{description}</p>
      <div className="mt-4">
        <span className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-on-surface">
          <FolderOpen size={16} />
          上传 DOCX
        </span>
      </div>
    </div>
  );
}

function SelectedDocxFile({ file }: { file: DocumentSummary | null }) {
  if (!file) {
    return <EmptyState icon={UploadCloud} title="尚未上传文件" body="点击上传 DOCX 文件。" />;
  }

  return (
    <div className="grid grid-cols-[54px_1fr] items-center gap-3 rounded-lg border border-border bg-surface-muted px-3 py-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface font-mono text-[11px] font-bold text-primary">
        {file.extension}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-on-surface">{file.name}</p>
          <span className="font-mono text-[11px] text-on-surface-muted">{formatBytes(file.size)}</span>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] text-on-surface-muted" title={file.path}>
          {file.path}
        </p>
      </div>
    </div>
  );
}

function ImageHandlingSelector({
  value,
  onChange
}: {
  value: ImageHandling | null;
  onChange: (imageHandling: ImageHandling) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-warning/25 bg-warning-muted px-3 py-3 text-sm leading-6 text-warning">
        Word 文档包含图片，图片内内容无法修改；请确认图片中不包含需要脱敏的敏感信息后继续。
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SelectableOption
          selected={value === "keep"}
          title="保留图片"
          description="图片原样保留，图片内文字不会被脱敏。"
          tone="warning"
          onClick={() => onChange("keep")}
        />
        <SelectableOption
          selected={value === "delete"}
          title="删除全部图片"
          description="导出文件会移除所有图片及其引用。"
          tone="success"
          onClick={() => onChange("delete")}
        />
      </div>
    </div>
  );
}

function FileList({ files, preview }: { files: DocumentSummary[]; preview: PreviewResult | null }) {
  if (!files.length) {
    return <EmptyState icon={UploadCloud} title="尚未上传文件" body="点击上传 DOCX 文件。" />;
  }

  const blockedByPath = new Map(preview?.blocked.map((item) => [item.path, item]) ?? []);
  const previewByPath = new Map(preview?.files.map((file) => [file.path, file]) ?? []);

  return (
    <div className="mt-4 space-y-3">
      {files.map((file) => {
        const blocked = blockedByPath.get(file.path);
        const previewFile = previewByPath.get(file.path);
        return (
          <div key={file.path} className="grid grid-cols-[54px_1fr_auto] items-center gap-3 rounded-lg border border-border bg-surface-muted px-3 py-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface font-mono text-[11px] font-bold text-primary">
              {file.extension}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold text-on-surface">{file.name}</p>
                <span className="font-mono text-[11px] text-on-surface-muted">{formatBytes(file.size)}</span>
              </div>
              <p className="mt-1 truncate font-mono text-[11px] text-on-surface-muted" title={file.path}>
                {blocked ? blocked.error.message : file.path}
              </p>
              {previewFile?.warnings.length ? <WarningList warnings={previewFile.warnings} compact /> : null}
            </div>
            <StatusBadge tone={blocked ? "error" : previewFile ? "success" : "info"}>
              {blocked ? "已阻断" : previewFile ? "可处理" : "待识别"}
            </StatusBadge>
          </div>
        );
      })}
    </div>
  );
}

function ManualEntityForm({
  value,
  docOptions,
  onChange,
  onAdd,
  disabled
}: {
  value: typeof EMPTY_MANUAL_ENTITY;
  docOptions: ManualDocOption[];
  onChange: (value: typeof EMPTY_MANUAL_ENTITY) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className={cn(
      "mb-4 grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted p-3",
      docOptions.length > 1
        ? "md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        : "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
    )}>
      {docOptions.length > 1 ? (
        <select
          value={value.docId || docOptions[0]?.docId || ""}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, docId: event.target.value })}
          className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
        >
          {docOptions.map((option) => (
            <option key={option.docId} value={option.docId}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      <input
        value={value.originalValue}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, originalValue: event.target.value })}
        placeholder="原文值"
        className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
      />
      <input
        value={value.maskedValue}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, maskedValue: event.target.value })}
        placeholder="脱敏值，留空自动生成"
        className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
      />
      <Button icon={Plus} variant="secondary" disabled={disabled} onClick={onAdd}>
        添加
      </Button>
    </div>
  );
}

function EntityTable({
  entities,
  docOptions,
  onChange,
  onRemove
}: {
  entities: EntityItem[];
  docOptions: ManualDocOption[];
  onChange: (index: number, patch: Partial<EntityItem>) => void;
  onRemove: (index: number) => void;
}) {
  if (!entities.length) {
    return <EmptyState icon={FileCheck2} title="暂无实体" body="预览识别或手动添加后显示实体表。" />;
  }

  const knownDocIds = new Set(docOptions.map((option) => option.docId));
  const groups = [
    ...docOptions.map((option) => ({
      docId: option.docId,
      label: option.label,
      rows: entities
        .map((entity, index) => ({ entity, index }))
        .filter((row) => row.entity.docId === option.docId)
    })),
    {
      docId: "__unknown__",
      label: "未分组",
      rows: entities
        .map((entity, index) => ({ entity, index }))
        .filter((row) => !knownDocIds.has(row.entity.docId))
    }
  ].filter((group) => group.rows.length);
  const showGroupHeaders = groups.length > 1;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="max-h-[430px] overflow-auto app-scrollbar">
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface-muted text-xs font-bold uppercase text-on-surface-muted">
            <tr>
              <th className="w-16 border-b border-border px-4 py-3">启用</th>
              <th className="border-b border-border px-4 py-3">原文值</th>
              <th className="border-b border-border px-4 py-3">脱敏值</th>
              <th className="w-36 border-b border-border px-4 py-3">稳定 ID</th>
              <th className="w-24 border-b border-border px-4 py-3">来源</th>
              <th className="w-16 border-b border-border px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-surface text-sm">
            {groups.flatMap((group) => [
              showGroupHeaders ? (
                <tr key={`${group.docId}-header`} className="bg-surface-muted/80">
                  <td colSpan={6} className="px-4 py-2 text-xs font-bold text-on-surface-muted">
                    {group.label} · {group.rows.length} 个实体
                  </td>
                </tr>
              ) : null,
              ...group.rows.map(({ entity, index }) => (
                <tr key={entity.id} className={cn(!entity.enabled && "opacity-55")}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={entity.enabled}
                      onChange={(event) => onChange(index, { enabled: event.target.checked })}
                      className="h-4 w-4 accent-primary"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={entity.originalValue}
                      onChange={(event) => onChange(index, { originalValue: event.target.value })}
                      className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={entity.maskedValue}
                      onChange={(event) => onChange(index, { maskedValue: event.target.value })}
                      className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <code className="rounded bg-surface-muted px-2 py-1 font-mono text-xs text-primary">
                      {entity.stableId}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={entitySourceTone(entity.source)}>
                      {entitySourceLabel(entity.source)}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(index)}
                      className="rounded-lg p-2 text-on-surface-muted transition hover:bg-danger-muted hover:text-danger"
                      title="移除此实体"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextOutputModeSelector({
  value,
  onChange
}: {
  value: TextOutputMode;
  onChange: (mode: TextOutputMode) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-muted p-3">
      <p className="text-xs font-semibold text-on-surface-muted">文本输出方式</p>
      <SegmentedControl
        value={value}
        options={[
          { value: "file", label: "导出文件" },
          { value: "copy", label: "仅生成文本" }
        ]}
        onChange={(nextValue) => onChange(nextValue as TextOutputMode)}
      />
    </div>
  );
}

function ModeSelector({ mode, onChange }: { mode: SanitizeMode; onChange: (mode: SanitizeMode) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      <SelectableOption
        selected={mode === "irreversible"}
        title="不可恢复脱敏"
        description="导出文件不含原始敏感信息，不写原文映射。"
        tone="primary"
        onClick={() => onChange("irreversible")}
      />
      <SelectableOption
        selected={mode === "reversible"}
        title="可恢复实体脱敏"
        description="导出脱敏文件和加密映射文件。"
        tone="success"
        onClick={() => onChange("reversible")}
      />
    </div>
  );
}

function SelectableOption({
  selected,
  title,
  description,
  tone,
  onClick
}: {
  selected: boolean;
  title: string;
  description: string;
  tone: "primary" | "success" | "warning";
  onClick: () => void;
}) {
  const selectedToneClass = {
    primary: "border-primary bg-primary-muted",
    success: "border-success bg-success-muted",
    warning: "border-warning bg-warning-muted"
  }[tone];
  const selectedDotClass = {
    primary: "border-primary bg-primary",
    success: "border-success bg-success",
    warning: "border-warning bg-warning"
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-left transition",
        selected ? selectedToneClass : "border-border bg-surface hover:bg-surface-muted"
      )}
    >
      <span
        className={cn(
          "mt-0.5 h-4 w-4 rounded-full border",
          selected ? selectedDotClass : "border-border-strong"
        )}
      />
      <span>
        <span className="block text-sm font-bold text-on-surface">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-on-surface-muted">{description}</span>
      </span>
    </button>
  );
}

function CredentialFields({
  method,
  password,
  keyFile,
  onMethodChange,
  onPasswordChange,
  onSelectKeyFile
}: {
  method: CredentialMethod;
  password: string;
  keyFile: DocumentSummary | null;
  onMethodChange: (method: CredentialMethod) => void;
  onPasswordChange: (password: string) => void;
  onSelectKeyFile: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-muted p-3">
      <SegmentedControl
        value={method}
        options={[
          { value: "password", label: "口令" },
          { value: "keyFile", label: "密钥文件" }
        ]}
        onChange={(value) => onMethodChange(value as CredentialMethod)}
      />

      {method === "password" ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-on-surface-muted">口令</span>
          <input
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            placeholder="输入口令"
          />
        </label>
      ) : (
        <div className="space-y-2">
          <Button icon={KeyRound} variant="secondary" block onClick={onSelectKeyFile}>
            选择密钥文件
          </Button>
          <p className="truncate font-mono text-[11px] text-on-surface-muted" title={keyFile?.path}>
            {keyFile ? keyFile.name : "未选择"}
          </p>
        </div>
      )}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 rounded-lg border border-border bg-surface p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-2 text-xs font-semibold transition",
            value === option.value ? "bg-primary text-white" : "text-on-surface-muted hover:bg-surface-muted"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function OutputSelector({ outputDir, onSelect }: { outputDir: string; onSelect: () => void }) {
  return (
    <div className="space-y-2">
      <Button icon={FolderOpen} variant="secondary" block onClick={onSelect}>
        选择输出目录
      </Button>
      <p className="truncate rounded-lg bg-surface-muted px-3 py-2 font-mono text-[11px] text-on-surface-muted" title={outputDir}>
        {outputDir || "未选择"}
      </p>
    </div>
  );
}

function FilePickCard({
  icon: Icon,
  title,
  file,
  buttonLabel,
  onSelect
}: {
  icon: LucideIcon;
  title: string;
  file: DocumentSummary | null;
  buttonLabel: string;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} className="text-primary" />
        <h4 className="text-sm font-bold text-on-surface">{title}</h4>
      </div>
      {file ? (
        <div className="mb-4 rounded-lg bg-surface px-3 py-3">
          <p className="truncate text-sm font-semibold text-on-surface">{file.name}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-on-surface-muted" title={file.path}>
            {file.path}
          </p>
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-dashed border-border-strong px-3 py-7 text-center text-sm text-on-surface-muted">
          未选择
        </div>
      )}
      <Button icon={FolderOpen} variant="secondary" block onClick={onSelect}>
        {buttonLabel}
      </Button>
    </div>
  );
}

function OutputGroup({
  result,
  outputActions
}: {
  result: SanitizeResultItem;
  outputActions: OutputDocumentActionHandlers;
}) {
  const sourceTitle = result.sourceKind === "word" ? fileNameFromPath(result.sourceLabel) : result.sourceLabel;

  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-on-surface">{sourceTitle}</p>
          <p className="mt-1 text-xs text-on-surface-muted">
            实体 {result.entitySummary.total} 个
          </p>
        </div>
        <StatusBadge tone="success">已完成</StatusBadge>
      </div>
      <PathList
        rows={[
          result.outputs.sanitizedFile ? ["脱敏文件", result.outputs.sanitizedFile] : null,
          result.outputs.mappingFile ? ["映射文件", result.outputs.mappingFile] : null
        ].filter((row): row is [string, string] => Boolean(row))}
      />
      {result.outputs.sanitizedFile ? (
        <DocumentActionButtons
          filePath={result.outputs.sanitizedFile}
          previewTitle="脱敏后内容预览"
          actions={outputActions}
        />
      ) : null}
      {result.sanitizedText ? <div className="mt-4"><TextResult title="脱敏文本" value={result.sanitizedText} /></div> : null}
      {result.warnings.length > 0 && <WarningList warnings={result.warnings} />}
    </div>
  );
}

function OutputBlockedList({ blocked }: { blocked: PreviewBlockedFile[] }) {
  return (
    <div className="rounded-lg border border-danger/20 bg-danger-muted p-4 text-danger">
      <div className="mb-3 flex items-center gap-2">
        <XCircle size={16} />
        <p className="text-sm font-bold">导出失败 {blocked.length} 个文件</p>
      </div>
      <ul className="space-y-2 text-xs">
        {blocked.map((item) => (
          <li key={`${item.path}-${item.error.message}`} className="rounded border border-danger/15 bg-surface/70 px-3 py-2">
            <p className="font-semibold">{fileNameFromPath(item.path)}</p>
            <p className="mt-1 break-words opacity-90">{item.error.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentActionButtons({
  filePath,
  previewTitle,
  actions
}: {
  filePath: string;
  previewTitle: string;
  actions: OutputDocumentActionHandlers;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button icon={Eye} variant="secondary" onClick={() => actions.onPreviewDocument(filePath, previewTitle)}>
        预览
      </Button>
      <Button icon={FileText} variant="secondary" onClick={() => actions.onOpenDocument(filePath)}>
        打开文档
      </Button>
      <Button icon={FolderOpen} variant="secondary" onClick={() => actions.onRevealDocument(filePath)}>
        打开所在文件夹
      </Button>
      <Button icon={Trash2} variant="danger" onClick={() => actions.onDeleteDocument(filePath)}>
        删除文档
      </Button>
    </div>
  );
}

function PathList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={`${label}-${value}`} className="grid grid-cols-[74px_1fr] gap-2 text-xs">
          <span className="font-semibold text-on-surface-muted">{label}</span>
          <span className="truncate font-mono text-on-surface" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function OutputPreviewModal({
  preview,
  onClose
}: {
  preview: OutputPreviewState;
  onClose: () => void;
}) {
  const displayContent = preview.content || "未抽取到可预览文本。";

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-5 py-6"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[min(86vh,820px)] w-[min(100%,900px)] flex-col rounded-lg border border-border bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Eye size={18} className="text-primary" />
              <h3 className="text-sm font-bold text-on-surface">{preview.title}</h3>
            </div>
            <p className="mt-2 truncate font-mono text-[11px] text-on-surface-muted" title={preview.filePath}>
              {preview.filePath}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-on-surface-muted hover:bg-surface-muted hover:text-on-surface"
          >
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5 app-scrollbar">
          {preview.warnings.length > 0 ? <WarningList warnings={preview.warnings} compact /> : null}
          <textarea
            readOnly
            value={displayContent}
            className="h-[min(54vh,520px)] min-h-[280px] w-full resize-none rounded-lg border border-border bg-surface-muted px-3 py-3 font-mono text-xs leading-6 text-on-surface outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4 text-xs text-on-surface-muted">
          <span>
            {preview.content.length} 字符{preview.truncated ? "，已截断" : ""}
          </span>
          <Button icon={Copy} variant="secondary" onClick={() => void navigator.clipboard?.writeText(preview.content)}>
            复制内容
          </Button>
        </div>
      </div>
    </div>
  );
}

function WarningList({ warnings, compact = false }: { warnings: string[]; compact?: boolean }) {
  return (
    <ul className={cn("space-y-1 text-xs text-warning", compact ? "mt-2" : "mt-3")}>
      {warnings.map((warning) => (
        <li key={warning} className="flex gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-[132px] flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-muted px-4 py-8 text-center">
      <Icon size={26} className="text-on-surface-muted" />
      <p className="mt-3 text-sm font-bold text-on-surface">{title}</p>
      <p className="mt-1 text-xs text-on-surface-muted">{body}</p>
    </div>
  );
}

function StatusPanel({ status, onClose }: { status: StatusMessage; onClose: () => void }) {
  const styles: Record<StatusTone, string> = {
    info: "border-primary/20 bg-primary-muted text-primary",
    success: "border-success/20 bg-success-muted text-success",
    warning: "border-warning/20 bg-warning-muted text-warning",
    error: "border-danger/20 bg-danger-muted text-danger"
  };
  const Icon = status.tone === "success"
    ? CheckCircle2
    : status.tone === "error"
      ? XCircle
      : status.tone === "warning"
        ? AlertTriangle
        : ShieldCheck;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "fixed right-6 top-6 z-50 w-[min(calc(100vw-32px),440px)] rounded-lg border px-4 py-3 shadow-xl",
        styles[status.tone]
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-3">
          <Icon size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold">{status.title}</p>
            {status.body && <p className="mt-1 whitespace-pre-wrap text-sm opacity-90">{status.body}</p>}
            {status.details?.length ? (
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto pr-1 text-xs opacity-90 app-scrollbar">
                {status.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 opacity-70 transition hover:bg-white/40 hover:opacity-100"
          title="关闭"
        >
          <XCircle size={16} />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const styles: Record<StatusTone, string> = {
    info: "bg-primary-muted text-primary",
    success: "bg-success-muted text-success",
    warning: "bg-warning-muted text-warning",
    error: "bg-danger-muted text-danger"
  };

  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold", styles[tone])}>
      {children}
    </span>
  );
}

function nextStableId(docId: string, entities: EntityItem[], ignoreIndex = -1) {
  const count = entities.filter((entity, index) =>
    index !== ignoreIndex && entity.docId === docId
  ).length + 1;
  return `${GENERIC_ENTITY_PREFIX}_${String(count).padStart(3, "0")}`;
}

function incrementalPlaceholderFallback(stableId: string, occupiedValues: Set<string>, usedMaskedValues: Set<string>) {
  let index = 1;
  let candidate = `<${stableId}_MASKED_${index}>`;
  while (occupiedValues.has(candidate) || usedMaskedValues.has(candidate)) {
    index += 1;
    candidate = `<${stableId}_MASKED_${index}>`;
  }
  return candidate;
}

function defaultMaskedValue(originalValue: string, stableId: string, existingEntities: EntityItem[] = []) {
  const occupiedValues = new Set([
    originalValue,
    ...existingEntities.map((entity) => entity.originalValue.trim()).filter(Boolean)
  ]);
  const usedMaskedValues = new Set(
    existingEntities.map((entity) => entity.maskedValue.trim()).filter(Boolean)
  );
  return createDefaultMaskedValue(originalValue, stableId, {
    occupiedValues,
    usedMaskedValues,
    createPlaceholderFallback: incrementalPlaceholderFallback
  });
}

function uniqueClientId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createBlankEntitySet(): EntitySet {
  const now = new Date().toISOString();
  return {
    id: uniqueClientId("entity-set"),
    name: "新建实体集",
    enabled: true,
    version: "1.0.0",
    updatedAt: now,
    items: [createBlankEntitySetItem()]
  };
}

function createBlankEntitySetItem(): EntitySetItem {
  return {
    id: uniqueClientId("entity-item"),
    type: GENERIC_ENTITY_TYPE,
    canonicalName: "",
    aliases: [],
    maskedValue: "",
    enabled: true,
    sourceName: "",
    sourceUrl: "",
    notes: ""
  };
}

function cloneEntitySet(entitySet: EntitySet): EntitySet {
  return JSON.parse(JSON.stringify(entitySet)) as EntitySet;
}

function splitAliases(value: string) {
  const seen = new Set<string>();
  return value
    .split("|")
    .map((alias) => alias.trim())
    .filter((alias) => {
      if (!alias || seen.has(alias)) return false;
      seen.add(alias);
      return true;
    });
}

function entitySourceLabel(source: EntityItem["source"]) {
  if (source === "manual") return "手动";
  if (source === "custom") return "词库";
  return "自动";
}

function entitySourceTone(source: EntityItem["source"]): StatusTone {
  if (source === "manual") return "info";
  if (source === "custom") return "warning";
  return "success";
}

function downloadTextFile(file: EntitySetExportResult) {
  const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function mergePreviewEntities(previewEntities: EntityItem[], currentEntities: EntityItem[], docIds: string[]) {
  const previewKeys = new Set(
    previewEntities.map((entity) => `${entity.docId}:${entity.originalValue}`)
  );
  const previewDocIds = new Set(docIds);
  const manualEntities = currentEntities.filter((entity) => {
    if (entity.source !== "manual" || !previewDocIds.has(entity.docId)) return false;
    return !previewKeys.has(`${entity.docId}:${entity.originalValue}`);
  });

  return [...previewEntities, ...manualEntities];
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function sanitizeResultKey(result: SanitizeResultItem) {
  return `${result.docId}-${result.outputs.sanitizedFile || result.outputs.mappingFile || result.sourceLabel}`;
}

function requiresImageAcknowledgement(preview: PreviewResult | null) {
  return Boolean(preview?.files.some((file) =>
    file.warnings.some((warning) => warning.includes(IMAGE_WARNING_MARKER))
  ));
}

function formatApiError(error: ApiResponse<unknown>["error"]) {
  if (!error) return "操作失败";
  if (!error.details) return error.message;

  let details = "";
  try {
    details = typeof error.details === "string" ? error.details : JSON.stringify(error.details, null, 2);
  } catch {
    details = String(error.details);
  }
  return `${error.message}\n${details}`;
}

function errorStatus(error: unknown): StatusMessage {
  return {
    tone: "error",
    title: "操作失败",
    body: error instanceof Error ? error.message : String(error)
  };
}
