import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Copy,
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
  XCircle,
  type LucideIcon
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import type {
  ApiResponse,
  Credential,
  CredentialMethod,
  DesktopApi,
  DocumentSummary,
  EntityItem,
  EntitySet,
  EntitySetItem,
  InputSourceKind,
  NavigationView,
  PreviewBlockedFile,
  PreviewResult,
  RestoreResult,
  RestoreSource,
  SanitizeMode,
  SanitizeSource,
  SanitizeResultItem,
  EntitySetExportResult
} from "./types";

type StatusTone = "info" | "success" | "warning" | "error";
type DroppedFilesHandler = (files: File[]) => void | Promise<void>;

const IMAGE_WARNING_MARKER = "图片内内容无法修改";

interface StatusMessage {
  tone: StatusTone;
  title: string;
  body?: string;
  details?: string[];
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
  preview: PreviewResult | null;
  entities: EntityItem[];
  results: SanitizeResultItem[];
  running: boolean;
  previewing: boolean;
  imageContentAcknowledged: boolean;
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
  preview: null,
  entities: [],
  results: [],
  running: false,
  previewing: false,
  imageContentAcknowledged: false
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

const EMPTY_MANUAL_ENTITY = {
  originalValue: "",
  maskedValue: ""
};

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function App() {
  const [activeView, setActiveView] = useState<NavigationView>("dashboard");
  const [version, setVersion] = useState("...");
  const [status, setStatus] = useState<StatusMessage | null>(null);
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
  }, []);

  const sanitizeStep = useMemo(() => {
    const hasInput = sanitize.inputKind === "word"
      ? sanitize.files.length > 0
      : sanitize.pastedText.trim().length > 0;
    if (sanitize.results.length) return 4;
    if (sanitize.entities.length || sanitize.preview) return 3;
    if (hasInput || sanitize.outputDir || sanitize.mode) return 2;
    return 1;
  }, [
    sanitize.entities.length,
    sanitize.files.length,
    sanitize.inputKind,
    sanitize.mode,
    sanitize.outputDir,
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

  async function loadEntitySets() {
    try {
      const sets = await callDesktop((api) => api.listEntitySets());
      setEntitySets(sets);
      setSelectedEntitySetId((current) => current || sets[0]?.id || "");
    } catch (error) {
      setStatus(errorStatus(error));
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

  function currentSanitizeDocId(state = sanitize) {
    return state.preview?.files[0]?.docId || (state.inputKind === "word" ? state.files[0]?.docId || "" : "");
  }

  function currentSanitizeSource(includeDocId: boolean): SanitizeSource | null {
    if (sanitize.inputKind === "word") {
      const file = sanitize.files[0];
      if (!file) return null;
      const docId = currentSanitizeDocId();
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
    await importSanitizeFiles((api) => api.importDocuments({ purpose: "sanitize", multi: false }));
  }

  async function dropSanitizeFiles(files: File[]) {
    if (!validateDroppedDocxFiles(files)) return;
    await importSanitizeFiles((api) => api.importDroppedDocuments({ purpose: "sanitize", files }));
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
        imageContentAcknowledged: false
      }));
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
      imageContentAcknowledged: false
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
      imageContentAcknowledged: false
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
      imageContentAcknowledged: false
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
      setSanitize((current) => ({ ...current, previewing: true, results: [] }));
      const preview = await callDesktop((api) =>
        api.previewSanitize({
          source
        })
      );

      setSanitize((current) => {
        const docId = preview.files[0]?.docId || currentSanitizeDocId(current);
        return {
          ...current,
          files: current.inputKind === "word" && current.files[0] && preview.files[0]
            ? [{ ...current.files[0], docId: preview.files[0].docId }]
            : current.files,
          preview,
          entities: mergePreviewEntities(preview.entities, current.entities, docId),
          previewing: false,
          imageContentAcknowledged: false
        };
      });

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
      filePath: sanitize.inputKind === "word" ? sanitize.files[0]?.path || "" : "pasted-text",
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
    setManualEntity(EMPTY_MANUAL_ENTITY);
    setStatus({
      tone: "success",
      title: "已添加手动实体",
      body: `${originalValue} -> ${maskedValue}`
    });
  }

  async function runSanitize() {
    const source = currentSanitizeSource(true);
    if (!source) {
      setStatus({ tone: "error", title: "请先输入待脱敏内容" });
      return;
    }
    if (!sanitize.outputDir) {
      setStatus({ tone: "error", title: "请选择输出目录" });
      return;
    }
    if (requiresImageAcknowledgement(sanitize.preview) && !sanitize.imageContentAcknowledged) {
      setStatus({
        tone: "warning",
        title: "请先确认图片风险",
        body: "图片内内容不会被修改，请确认图片中不包含需要脱敏的敏感信息后继续。"
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
      setSanitize((current) => ({ ...current, running: true, results: [] }));
      const result = await callDesktop((api) =>
        api.runSanitize({
          source,
          mode: sanitize.mode,
          entities: enabledEntities,
          outputDir: sanitize.outputDir,
          credential,
          acknowledgements: {
            imageContentUnmodified: sanitize.imageContentAcknowledged
          }
        })
      );

      setSanitize((current) => ({
        ...current,
        running: false,
        results: result.results
      }));
      setStatus({
        tone: "success",
        title: "脱敏导出完成",
        body: `已生成 ${result.results.length} 组输出文件。`
      });
    } catch (error) {
      setSanitize((current) => ({ ...current, running: false }));
      setStatus(errorStatus(error));
    }
  }

  async function selectRestoreFile() {
    await importRestoreFile((api) => api.importDocuments({ purpose: "restore", multi: false }));
  }

  async function dropRestoreFile(files: File[]) {
    if (!validateDroppedDocxFiles(files)) return;
    await importRestoreFile((api) => api.importDroppedDocuments({ purpose: "restore", files }));
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

  function validateDroppedDocxFiles(files: File[]) {
    if (files.length !== 1) {
      setStatus({ tone: "error", title: "每次只能拖入一个 DOCX 文件" });
      return false;
    }

    const fileName = files[0]?.name || "";
    if (!fileName.toLowerCase().endsWith(".docx")) {
      setStatus({ tone: "error", title: "仅支持拖入 DOCX 文件", body: "旧版 DOC 请另存为 DOCX 后处理。" });
      return false;
    }

    return true;
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
            />
          )}

          {activeView === "sanitize" && (
            <SanitizeWorkflow
              state={sanitize}
              step={sanitizeStep}
              manualEntity={manualEntity}
              onManualEntityChange={setManualEntity}
              onBack={() => openView("dashboard")}
              onInputKindChange={changeSanitizeInputKind}
              onTextChange={changeSanitizeText}
              onClearText={clearSanitizeText}
              onSelectFiles={selectSanitizeFiles}
              onDropFiles={dropSanitizeFiles}
              onPreview={previewEntities}
              onSelectOutput={selectSanitizeOutput}
              onSelectKeyFile={selectSanitizeKeyFile}
              onRun={runSanitize}
              onModeChange={(mode) => setSanitize((current) => ({ ...current, mode }))}
              onCredentialMethodChange={(credentialMethod) =>
                setSanitize((current) => ({ ...current, credentialMethod }))
              }
              onPasswordChange={(password) => setSanitize((current) => ({ ...current, password }))}
              onAddManualEntity={addManualEntity}
              onEntityChange={updateEntity}
              onRemoveEntity={removeEntity}
              onImageAckChange={(imageContentAcknowledged) =>
                setSanitize((current) => ({ ...current, imageContentAcknowledged }))
              }
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
              onDropFile={dropRestoreFile}
              onSelectMappingFile={selectMappingFile}
              onSelectOutput={selectRestoreOutput}
              onSelectKeyFile={selectRestoreKeyFile}
              onRun={runRestore}
              onCredentialMethodChange={(credentialMethod) =>
                setRestore((current) => ({ ...current, credentialMethod }))
              }
              onPasswordChange={(password) => setRestore((current) => ({ ...current, password }))}
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
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white">
          <ShieldCheck size={22} strokeWidth={2.3} />
        </div>
        <div>
          <h1 className="text-base font-bold leading-tight text-primary">SecureMask Pro</h1>
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
            <p className="text-xs font-semibold text-on-surface">本地安全桥接</p>
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
  restoreResult
}: {
  onStartSanitize: () => void;
  onStartRestore: () => void;
  sanitizeResults: SanitizeResultItem[];
  restoreResult: RestoreResult | null;
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
                <OutputGroup key={`${result.docId}-${result.outputs.sanitizedFile}`} result={result} />
              ))}
              {restoreResult && (
                <PathList
                  rows={[
                    ["还原文件", restoreResult.outputPath]
                  ]}
                />
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
  onManualEntityChange,
  onBack,
  onInputKindChange,
  onTextChange,
  onClearText,
  onSelectFiles,
  onDropFiles,
  onPreview,
  onSelectOutput,
  onSelectKeyFile,
  onRun,
  onModeChange,
  onCredentialMethodChange,
  onPasswordChange,
  onAddManualEntity,
  onEntityChange,
  onRemoveEntity,
  onImageAckChange
}: {
  state: SanitizeState;
  step: number;
  manualEntity: typeof EMPTY_MANUAL_ENTITY;
  onManualEntityChange: (value: typeof EMPTY_MANUAL_ENTITY) => void;
  onBack: () => void;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFiles: () => void;
  onDropFiles: DroppedFilesHandler;
  onPreview: () => void;
  onSelectOutput: () => void;
  onSelectKeyFile: () => void;
  onRun: () => void;
  onModeChange: (mode: SanitizeMode) => void;
  onCredentialMethodChange: (method: CredentialMethod) => void;
  onPasswordChange: (password: string) => void;
  onAddManualEntity: () => void;
  onEntityChange: (index: number, patch: Partial<EntityItem>) => void;
  onRemoveEntity: (index: number) => void;
  onImageAckChange: (checked: boolean) => void;
}) {
  const enabledCount = state.entities.filter((entity) => entity.enabled).length;
  const hasInput = state.inputKind === "word" ? state.files.length > 0 : state.pastedText.trim().length > 0;
  const canAddManualEntity = Boolean(
    state.preview?.files[0]?.docId ||
    (state.inputKind === "word" && state.files[0]?.docId)
  );
  const imageAckRequired = requiresImageAcknowledgement(state.preview);

  return (
    <div className="space-y-6">
      <PageHeader
        title="文档脱敏"
        description="导入、识别、复核并导出脱敏文件"
        aside={<BackButton onClick={onBack} />}
      />
      <Stepper
        current={step}
        steps={["输入内容", "选择模式", "确认实体", "导出结果"]}
      />

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
              onDropFiles={onDropFiles}
            />
          </Panel>

          <Panel
            title="实体确认"
            icon={FileCheck2}
            right={
              <Button icon={RefreshCw} variant="secondary" onClick={onPreview} disabled={state.previewing || !hasInput}>
                {state.previewing ? "识别中" : "预览识别"}
              </Button>
            }
          >
            <ManualEntityForm
              value={manualEntity}
              onChange={onManualEntityChange}
              onAdd={onAddManualEntity}
              disabled={!canAddManualEntity}
            />
            <EntityTable
              entities={state.entities}
              onChange={onEntityChange}
              onRemove={onRemoveEntity}
            />
          </Panel>
        </div>

        <div className="col-span-12 space-y-5 xl:col-span-4">
          <Panel title="模式与输出" icon={ShieldCheck}>
            <div className="space-y-4">
              <ModeSelector mode={state.mode} onChange={onModeChange} />

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

              <OutputSelector outputDir={state.outputDir} onSelect={onSelectOutput} />

              {imageAckRequired ? (
                <ImageAcknowledgement
                  checked={state.imageContentAcknowledged}
                  onChange={onImageAckChange}
                />
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
              </div>

              <Button icon={FileCheck2} block onClick={onRun} disabled={state.running || (imageAckRequired && !state.imageContentAcknowledged)}>
                {state.running ? "处理中" : "执行脱敏"}
              </Button>
            </div>
          </Panel>

          <Panel title="导出结果" icon={FolderOpen}>
            {state.results.length ? (
              <div className="space-y-4">
                {state.results.map((result) => (
                  <OutputGroup key={`${result.docId}-${result.outputs.sanitizedFile}`} result={result} />
                ))}
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
  onDropFile,
  onSelectMappingFile,
  onSelectOutput,
  onSelectKeyFile,
  onRun,
  onCredentialMethodChange,
  onPasswordChange
}: {
  state: RestoreState;
  onBack: () => void;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFile: () => void;
  onDropFile: DroppedFilesHandler;
  onSelectMappingFile: () => void;
  onSelectOutput: () => void;
  onSelectKeyFile: () => void;
  onRun: () => void;
  onCredentialMethodChange: (method: CredentialMethod) => void;
  onPasswordChange: (password: string) => void;
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
              onDropFile={onDropFile}
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
        </div>

        <div className="col-span-12 space-y-5 xl:col-span-4">
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
  variant?: "primary" | "secondary";
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
  onSelectFiles,
  onDropFiles
}: {
  inputKind: InputSourceKind;
  files: DocumentSummary[];
  pastedText: string;
  preview: PreviewResult | null;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFiles: () => void;
  onDropFiles: DroppedFilesHandler;
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
            title="拖拽 DOCX 到此处，或点击上传"
            description="支持 Word DOCX。旧版 DOC 请另存为 DOCX 后处理。"
            onSelect={onSelectFiles}
            onDropFiles={onDropFiles}
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
  onSelectFile,
  onDropFile
}: {
  inputKind: InputSourceKind;
  file: DocumentSummary | null;
  pastedText: string;
  onInputKindChange: (kind: InputSourceKind) => void;
  onTextChange: (text: string) => void;
  onClearText: () => void;
  onSelectFile: () => void;
  onDropFile: DroppedFilesHandler;
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
            title="拖拽 DOCX 到此处，或点击上传"
            description="选择需要按映射还原的 DOCX 文件。"
            onSelect={onSelectFile}
            onDropFiles={onDropFile}
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
  onSelect,
  onDropFiles
}: {
  title: string;
  description: string;
  onSelect: () => void;
  onDropFiles: DroppedFilesHandler;
}) {
  const [dragging, setDragging] = useState(false);

  function handleDrag(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (event.type === "dragenter" || event.type === "dragover") {
      setDragging(true);
    }
    if (event.type === "dragleave") {
      setDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      void onDropFiles(files);
    }
  }

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
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
      className={cn(
        "flex min-h-[148px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center transition",
        dragging
          ? "border-primary bg-primary-muted text-primary"
          : "border-border-strong bg-surface-muted text-on-surface-muted hover:border-primary hover:bg-primary-muted/45"
      )}
    >
      <UploadCloud size={28} className={dragging ? "text-primary" : "text-on-surface-muted"} />
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
    return <EmptyState icon={UploadCloud} title="尚未上传文件" body="拖拽 DOCX 到上传窗口，或点击上传。" />;
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

function ImageAcknowledgement({
  checked,
  onChange
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning-muted px-3 py-3 text-sm text-warning">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-warning"
      />
      <span>我已知晓图片内内容不会被修改，并确认可继续导出。</span>
    </label>
  );
}

function FileList({ files, preview }: { files: DocumentSummary[]; preview: PreviewResult | null }) {
  if (!files.length) {
    return <EmptyState icon={UploadCloud} title="尚未上传文件" body="拖拽 DOCX 到上传窗口，或点击上传。" />;
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
  onChange,
  onAdd,
  disabled
}: {
  value: typeof EMPTY_MANUAL_ENTITY;
  onChange: (value: typeof EMPTY_MANUAL_ENTITY) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted p-3 md:grid-cols-[1fr_1fr_auto]">
      <input
        value={value.originalValue}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, originalValue: event.target.value })}
        placeholder="原文值"
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
      />
      <input
        value={value.maskedValue}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, maskedValue: event.target.value })}
        placeholder="脱敏值，留空自动生成"
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
      />
      <Button icon={Plus} variant="secondary" disabled={disabled} onClick={onAdd}>
        添加
      </Button>
    </div>
  );
}

function EntityTable({
  entities,
  onChange,
  onRemove
}: {
  entities: EntityItem[];
  onChange: (index: number, patch: Partial<EntityItem>) => void;
  onRemove: (index: number) => void;
}) {
  if (!entities.length) {
    return <EmptyState icon={FileCheck2} title="暂无实体" body="预览识别或手动添加后显示实体表。" />;
  }

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
            {entities.map((entity, index) => (
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
            ))}
          </tbody>
        </table>
      </div>
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
  tone: "primary" | "success";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-left transition",
        selected
          ? tone === "success"
            ? "border-success bg-success-muted"
            : "border-primary bg-primary-muted"
          : "border-border bg-surface hover:bg-surface-muted"
      )}
    >
      <span
        className={cn(
          "mt-0.5 h-4 w-4 rounded-full border",
          selected ? (tone === "success" ? "border-success bg-success" : "border-primary bg-primary") : "border-border-strong"
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

function OutputGroup({ result }: { result: SanitizeResultItem }) {
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
          ["脱敏文件", result.outputs.sanitizedFile],
          result.outputs.mappingFile ? ["映射文件", result.outputs.mappingFile] : null
        ].filter((row): row is [string, string] => Boolean(row))}
      />
      {result.sanitizedText ? <div className="mt-4"><TextResult title="脱敏文本" value={result.sanitizedText} /></div> : null}
      {result.warnings.length > 0 && <WarningList warnings={result.warnings} />}
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

function alphabeticLabel(index: number) {
  let value = Math.max(1, Number(index) || 1);
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function stableIdNumber(stableId: string) {
  const match = /_(\d+)$/.exec(stableId);
  return match ? Number(match[1]) : 1;
}

function organizationMaskSuffix(originalValue: string) {
  const value = originalValue.trim();
  if (!/[\u4e00-\u9fff]/.test(value)) return "";
  if (/(?:\u516c\u53f8|\u6709\u9650\u516c\u53f8|\u6709\u9650\u8d23\u4efb\u516c\u53f8|\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u5206\u516c\u53f8|\u5b50\u516c\u53f8)$/.test(value)) {
    return "\u516c\u53f8";
  }
  if (/\u96c6\u56e2$/.test(value)) return "\u96c6\u56e2";
  if (/\u9879\u76ee\u90e8$/.test(value)) return "\u9879\u76ee\u90e8";
  if (/\u4e2d\u5fc3$/.test(value)) return "\u4e2d\u5fc3";
  if (/\u7814\u7a76\u9662$/.test(value)) return "\u7814\u7a76\u9662";
  if (/\u8bbe\u8ba1\u9662$/.test(value)) return "\u8bbe\u8ba1\u9662";
  if (/\u5b66\u9662$/.test(value)) return "\u5b66\u9662";
  if (/\u533b\u9662$/.test(value)) return "\u533b\u9662";
  if (/\u5c40$/.test(value)) return "\u5c40";
  if (/(?:\u8def\u6865|\u8def\u822a|\u8700\u9053|\u5efa\u8bbe|\u5de5\u7a0b|\u6295\u8d44|\u4ea4\u901a|\u9ad8\u901f|\u94c1\u8def|\u7269\u6d41|\u8fd0\u8425|\u7ba1\u7406)/.test(value)) {
    return "\u516c\u53f8";
  }
  return "";
}

function placeholderMaskedValue(stableId: string, occupiedValues: Set<string>, usedMaskedValues: Set<string>) {
  const primary = `<${stableId}>`;
  if (!occupiedValues.has(primary) && !usedMaskedValues.has(primary)) return primary;
  const fallback = `<${stableId}_MASKED>`;
  if (!occupiedValues.has(fallback) && !usedMaskedValues.has(fallback)) return fallback;
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
  const suffix = organizationMaskSuffix(originalValue);
  if (suffix) {
    const startIndex = stableIdNumber(stableId);
    for (let offset = 0; offset < 1000; offset += 1) {
      const candidate = `${alphabeticLabel(startIndex + offset)}${suffix}`;
      if (candidate !== originalValue && !occupiedValues.has(candidate) && !usedMaskedValues.has(candidate)) {
        return candidate;
      }
    }
  }
  return placeholderMaskedValue(stableId, occupiedValues, usedMaskedValues);
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

function mergePreviewEntities(previewEntities: EntityItem[], currentEntities: EntityItem[], docId: string) {
  const previewKeys = new Set(
    previewEntities.map((entity) => `${entity.docId}:${entity.originalValue}`)
  );
  const manualEntities = currentEntities.filter((entity) => {
    if (entity.source !== "manual" || entity.docId !== docId) return false;
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
