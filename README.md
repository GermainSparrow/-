# 文档脱敏还原软件

这是一个基于 Electron 的本地文档脱敏与还原工具，当前包含：

- Electron 主进程窗口创建
- 安全的 preload 桥接
- 不可恢复脱敏
- 可恢复实体脱敏
- 加密映射文件导出
- 口令或密钥文件还原
- DOCX、XLSX、PDF、TXT、MD 入口处理

## 本地运行

```powershell
npm.cmd install
npm.cmd start
```

## 测试

```powershell
npm.cmd test
```

如果当前 PowerShell 环境中的 `npm.ps1` 报 `$LASTEXITCODE` 相关错误，请使用 `npm.cmd`。
如果本机 Node/NPM 包装器输出异常，也可以在依赖已安装后直接运行：

```powershell
.\node_modules\electron\dist\electron.exe .
```

## 目录结构

```text
DOC/
  README.md
  版本记录.md
  开发文档.md
src/
  main/
    main.js
    preload.js
    services/
  renderer/
    index.html
    styles.css
    renderer.js
```

## 项目文档

- [DOC/版本记录.md](./DOC/版本记录.md)：记录当前版本能力、已知限制和后续计划。
- [DOC/开发文档.md](./DOC/开发文档.md)：说明工程结构、模块职责、运行方式和开发约定。
