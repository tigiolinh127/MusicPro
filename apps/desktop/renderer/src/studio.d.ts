import type { EngineEvent, EngineResponse } from '../../../../packages/shared/src/protocol'
import type { RecentProjectEntry, RecoverySnapshot } from './projectTypes'

export {}

declare global {
  interface Window {
    studio: {
      request(op: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<EngineResponse>
      onEvent(callback: (event: EngineEvent) => void): () => void
      pickWav(): Promise<string | null>
      pickSaveProject(): Promise<string | null>
      pickOpenProject(): Promise<string | null>
      pickExportWav(): Promise<string | null>
      pickFolder(): Promise<string | null>
      exportKaraokeVocal(sourcePath: string, meta?: Record<string, unknown>): Promise<string | null>
      openYoutubeExternal(url: string): Promise<boolean>
      listRecentProjects(): Promise<RecentProjectEntry[]>
      rememberRecentProject(entry: { path: string, name: string, projectId: string }): Promise<RecentProjectEntry[]>
      removeRecentProject(targetPath: string): Promise<RecentProjectEntry[]>
      listRecoverySnapshots(): Promise<RecoverySnapshot[]>
      prepareAutosave(projectId: string): Promise<{ snapshotPath: string, savedAt: string }>
      commitAutosave(payload: {
        projectId: string
        projectName: string
        originalPath: string | null
        snapshotPath: string
        savedAt?: string
      }): Promise<{ ok: boolean, snapshotPath?: string, savedAt?: string, error?: string }>
      discardRecovery(projectId: string): Promise<boolean>
      copyRecoveryWorkingCopy(snapshotPath: string, destPath: string): Promise<{ ok: boolean, error?: string }>
      pickSaveRecoveryCopy(): Promise<string | null>
      onCloseRequest(callback: () => void): () => void
      replyCloseRequest(allow: boolean): void
      getAutosaveSettings(): Promise<{ enabled: boolean, intervalMs: number }>
      setAutosaveSettings(settings: { enabled?: boolean, intervalMs?: number }): Promise<{ enabled: boolean, intervalMs: number }>
      getShortcutOverrides(): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>>
      setShortcutOverrides(overrides: Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>>
      resetShortcutOverrides(): Promise<Record<string, { code?: string, key?: string, ctrlOrMeta?: boolean, shift?: boolean, alt?: boolean }>>
      probeMedia(filePath: string): Promise<{
        path: string
        ok: boolean
        exists: boolean
        fileBytes: number
        format: string
        sampleRate: number
        channels: number
        bitsPerSample: number
        frames: number
        durationSeconds: number
        availability: 'available' | 'missing' | 'offline' | 'invalid' | 'unverified'
        error?: string
        fingerprint?: string
      }>
      buildMediaInventory(sources: Array<{
        trackId: string
        trackName: string
        sourceFileId: string
        kind: string
        path: string
        missing?: boolean
        error?: string
        sampleRate?: number
        channels?: number
        duration?: number
        clipCount: number
        takeCount: number
      }>, projectFilePath: string | null): Promise<Array<Record<string, unknown>>>
      searchMedia(hint: {
        originalPath: string
        fileName: string
        durationSeconds?: number
        sampleRate?: number
        channels?: number
        fileBytes?: number
        fingerprint?: string
      }, options?: {
        projectFilePath?: string | null
        folders?: string[]
        rememberFolder?: boolean
        maxDepth?: number
      }): Promise<{
        candidates: Array<{
          path: string
          score: number
          rank: string
          ambiguous: boolean
          probe: Record<string, unknown>
        }>
        cancelled: boolean
        scanned: number
      }>
      cancelMediaSearch(): Promise<boolean>
      onMediaSearchProgress(callback: (progress: {
        searching: boolean
        scanned: number
        folder: string | null
        cancelled: boolean
        error?: string
      }) => void): () => void
    }
  }
}
