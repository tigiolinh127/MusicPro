import { contextBridge, ipcRenderer } from 'electron'
import type { EngineEvent, EngineResponse } from './protocol'

const studio = {
  request(op: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<EngineResponse> {
    return ipcRenderer.invoke('engine:request', op, payload ?? {}, timeoutMs ?? 10000)
  },
  onEvent(callback: (event: EngineEvent) => void): () => void {
    const listener = (_event: unknown, data: EngineEvent) => callback(data)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  },
  pickWav(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:wav')
  },
  pickSaveProject(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:saveProject')
  },
  pickOpenProject(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:openProject')
  },
  pickExportWav(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:export')
  },
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:folder')
  },
  /** Copy a recorded vocal WAV (and optional karaoke metadata) to a user-chosen path. */
  exportKaraokeVocal(sourcePath: string, meta?: Record<string, unknown>): Promise<string | null> {
    return ipcRenderer.invoke('karaoke:exportVocal', sourcePath, meta ?? null)
  },
  /** Open an https YouTube watch/share URL in the system browser (validated in main). */
  openYoutubeExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke('karaoke:openExternal', url)
  },
  listRecentProjects(): Promise<import('./projectPersistence').RecentProjectEntry[]> {
    return ipcRenderer.invoke('project:listRecent')
  },
  rememberRecentProject(entry: { path: string, name: string, projectId: string }): Promise<import('./projectPersistence').RecentProjectEntry[]> {
    return ipcRenderer.invoke('project:rememberRecent', entry)
  },
  removeRecentProject(targetPath: string): Promise<import('./projectPersistence').RecentProjectEntry[]> {
    return ipcRenderer.invoke('project:removeRecent', targetPath)
  },
  listRecoverySnapshots(): Promise<import('./projectPersistence').RecoverySnapshot[]> {
    return ipcRenderer.invoke('project:listRecovery')
  },
  prepareAutosave(projectId: string): Promise<{ snapshotPath: string, savedAt: string }> {
    return ipcRenderer.invoke('project:prepareAutosave', projectId)
  },
  commitAutosave(payload: {
    projectId: string
    projectName: string
    originalPath: string | null
    snapshotPath: string
    savedAt?: string
  }): Promise<{ ok: boolean, snapshotPath?: string, savedAt?: string, error?: string }> {
    return ipcRenderer.invoke('project:commitAutosave', payload)
  },
  discardRecovery(projectId: string): Promise<boolean> {
    return ipcRenderer.invoke('project:discardRecovery', projectId)
  },
  copyRecoveryWorkingCopy(snapshotPath: string, destPath: string): Promise<{ ok: boolean, error?: string }> {
    return ipcRenderer.invoke('project:copyRecovery', snapshotPath, destPath)
  },
  pickSaveRecoveryCopy(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:saveRecoveryCopy')
  },
  onCloseRequest(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('project:closeRequest', listener)
    return () => ipcRenderer.removeListener('project:closeRequest', listener)
  },
  replyCloseRequest(allow: boolean): void {
    ipcRenderer.send('project:closeReply', allow)
  },
  getAutosaveSettings(): Promise<{ enabled: boolean, intervalMs: number }> {
    return ipcRenderer.invoke('project:getAutosaveSettings')
  },
  setAutosaveSettings(settings: { enabled?: boolean, intervalMs?: number }): Promise<{ enabled: boolean, intervalMs: number }> {
    return ipcRenderer.invoke('project:setAutosaveSettings', settings)
  },
  getShortcutOverrides(): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>> {
    return ipcRenderer.invoke('shortcuts:get')
  },
  setShortcutOverrides(overrides: Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>> {
    return ipcRenderer.invoke('shortcuts:set', overrides)
  },
  resetShortcutOverrides(): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>> {
    return ipcRenderer.invoke('shortcuts:reset')
  },
  probeMedia(filePath: string): Promise<import('./mediaProbe').WavProbeResult> {
    return ipcRenderer.invoke('media:probe', filePath)
  },
  buildMediaInventory(sources: import('./mediaInventory').InventorySourceInput[], projectFilePath: string | null): Promise<import('./mediaInventory').MediaAssetRow[]> {
    return ipcRenderer.invoke('media:inventory', sources, projectFilePath)
  },
  searchMedia(hint: import('./mediaDiscovery').MediaHint, options?: {
    projectFilePath?: string | null
    folders?: string[]
    rememberFolder?: boolean
    maxDepth?: number
  }): Promise<{ candidates: import('./mediaDiscovery').MediaCandidate[], cancelled: boolean, scanned: number }> {
    return ipcRenderer.invoke('media:search', hint, options ?? {})
  },
  cancelMediaSearch(): Promise<boolean> {
    return ipcRenderer.invoke('media:cancelSearch')
  },
  onMediaSearchProgress(callback: (progress: import('./mediaDiscovery').SearchProgress) => void): () => void {
    const listener = (_event: unknown, data: import('./mediaDiscovery').SearchProgress) => callback(data)
    ipcRenderer.on('media:searchProgress', listener)
    return () => ipcRenderer.removeListener('media:searchProgress', listener)
  }
}

contextBridge.exposeInMainWorld('studio', studio)
