import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { runAutoCheck } from './autoCheck'
import { runAutoCorrectionCheck } from './autoCorrectionCheck'
import { EngineHost } from './engineHost'
import { runEngineHostEpipeCheck } from './engineHostEpipeCheck'
import { runFxCheck } from './fxCheck'
import { runLayoutCheck } from './layoutCheck'
import { runLiveAutoTuneCheck } from './liveAutoTuneCheck'
import { runLivePitchCheck } from './livePitchCheck'
import { runMixerCheck } from './mixerCheck'
import { runPitchCheck } from './pitchCheck'
import { runPitchCorrectionCheck } from './pitchCorrectionCheck'
import { runPitchMappingCheck } from './pitchMappingCheck'
import type { EngineResponse } from './protocol'
import { runVocalBreathCheck } from './vocalBreathCheck'
import { runVocalCompCheck } from './vocalCompCheck'
import { runVocalPresetCheck } from './vocalPresetCheck'
import { runVocalQualityCheck } from './vocalQualityCheck'
import { runVocalTimingCheck } from './vocalTimingCheck'
import { runVocalWorkflowCheck } from './vocalWorkflowCheck'
import { runKaraokeK1Check } from './karaokeK1Check'
import { runKaraokeK11Check } from './karaokeK11Check'
import { runKaraokeK2Check } from './karaokeK2Check'
import { runKaraokeK3Check } from './karaokeK3Check'
import { runRecordingWorkflow271Check } from './recordingWorkflow271Check'
import { runInputLevel272Check } from './inputLevel272Check'
import { runMixerUx273Check } from './mixerUx273Check'
import { runRecordingLatency274Check } from './recordingLatency274Check'
import { runRecordingMixing275Check } from './recordingMixing275Check'
import { runClipStretch281Check } from './clipStretch281Check'
import { runCrossfade282Check } from './crossfade282Check'
import { runParametricEq283Check } from './parametricEq283Check'
import { runDynamics284Check } from './dynamics284Check'
import { runLoudness285Check } from './loudness285Check'
import { runProjectAutosave291Check } from './projectAutosave291Check'
import { runTimelineEditing292Check } from './timelineEditing292Check'
import { runKeyboardWorkflow293Check } from './keyboardWorkflow293Check'
import { runAudioMedia294Check } from './audioMedia294Check'
import { runIntegratedWorkflow295Check } from './integratedWorkflow295Check'
import { loadShortcutOverrides, resetShortcutOverrides, saveShortcutOverrides } from './shortcutPrefs'
import { probeWavFile } from './mediaProbe'
import { buildMediaInventory, type InventorySourceInput } from './mediaInventory'
import { cancelMediaSearch, searchMediaCandidates, type MediaHint } from './mediaDiscovery'
import {
  allocateAutosavePath,
  commitAutosaveFile,
  copyRecoveryWorkingCopy,
  discardRecoverySnapshots,
  listRecoverySnapshots,
  loadRecentProjects,
  rememberRecentProject,
  removeRecentProject
} from './projectPersistence'
import { startLocalRendererServer, type LocalRendererServer } from './localRendererServer'
import { runWorkflowCheck } from './workflowCheck'

let mainWindow: BrowserWindow | null = null
let engine: EngineHost | null = null
let rendererServer: LocalRendererServer | null = null
let quitting = false
let allowClose = false
let closeReplyPending = false
const scriptedDialogs: string[] = []
let autosaveSettings = { enabled: true, intervalMs: 120_000 }
const guiCheck = ['MSP_LAYOUT_CHECK', 'MSP_WORKFLOW_CHECK', 'MSP_MIXER_CHECK', 'MSP_FX_CHECK', 'MSP_AUTO_CHECK', 'MSP_PITCH_CHECK', 'MSP_PITCHFIX_CHECK', 'MSP_PITCHMAP_CHECK', 'MSP_AUTOCORRECT_CHECK', 'MSP_VOCALQUALITY_CHECK', 'MSP_LIVEPITCH_CHECK', 'MSP_LIVE_AUTOTUNE_CHECK', 'MSP_VOCAL_COMP_CHECK', 'MSP_VOCAL_TIMING_CHECK', 'MSP_VOCAL_BREATH_CHECK', 'MSP_VOCAL_PRESET_CHECK', 'MSP_VOCAL_WORKFLOW_CHECK', 'MSP_ENGINE_HOST_EPIPE_CHECK', 'MSP_KARAOKE_K1_CHECK', 'MSP_KARAOKE_K11_CHECK', 'MSP_KARAOKE_K2_CHECK', 'MSP_KARAOKE_K3_CHECK', 'MSP_RECORDING_WORKFLOW_271_CHECK', 'MSP_INPUT_LEVEL_272_CHECK', 'MSP_MIXER_UX_273_CHECK', 'MSP_RECORDING_LATENCY_274_CHECK', 'MSP_RECORDING_MIXING_275_CHECK', 'MSP_CLIP_STRETCH_281_CHECK', 'MSP_CROSSFADE_282_CHECK', 'MSP_PARAMETRIC_EQ_283_CHECK', 'MSP_DYNAMICS_284_CHECK', 'MSP_LOUDNESS_285_CHECK', 'MSP_PROJECT_AUTOSAVE_291_CHECK', 'MSP_TIMELINE_EDITING_292_CHECK', 'MSP_KEYBOARD_WORKFLOW_293_CHECK', 'MSP_AUDIO_MEDIA_294_CHECK', 'MSP_INTEGRATED_WORKFLOW_295_CHECK'].some((name) => (process.env[name] ?? '').length > 0)

// Scripted GUI checks inject input into a window that may sit behind other windows. Chromium stops
// producing frames for an occluded window, which delays frame-aligned input such as slider drags.
if (guiCheck) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

function findEngine(): string | null {
  const candidates = [
    process.env.MUSICSTUDIO_ENGINE,
    path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe'),
    path.resolve(process.cwd(), 'build/MusicStudioEngine.exe'),
    path.resolve(process.cwd(), 'MusicStudioEngine.exe')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function isAppOrigin(url: string): boolean {
  if (rendererServer == null)
    return false
  try {
    const parsed = new URL(url)
    return parsed.origin === rendererServer.origin
  } catch {
    return false
  }
}

function createWindow(): void {
  if (rendererServer == null)
    throw new Error('Local renderer server must start before createWindow.')
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#121418',
    title: 'Music Studio Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !guiCheck
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // YouTube (and other https) popups open in the system browser; never grant Node to remote content.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Stay on the local app origin only (http://127.0.0.1:<port>).
    if (!isAppOrigin(url))
      event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    // Karaoke mic capture is native (JUCE), not Chromium getUserMedia.
    callback(false)
  })
  mainWindow.on('close', (event) => {
    if (allowClose || guiCheck || quitting) {
      allowClose = false
      return
    }
    event.preventDefault()
    if (closeReplyPending || mainWindow == null || mainWindow.isDestroyed())
      return
    closeReplyPending = true
    mainWindow.webContents.send('project:closeRequest')
  })
  void mainWindow.loadURL(`${rendererServer.origin}/`)
  if (process.env.MSP_SMOKE === '1') {
    const errors: string[] = []
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      if (level === 3)
        errors.push(message)
    })
    mainWindow.webContents.once('did-fail-load', () => app.exit(1))
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (errors.length > 0) {
          console.error(errors.join('\n'))
          app.exit(1)
          return
        }
        app.exit(0)
      }, 1000)
    })
  }
  if (process.env.MSP_LAYOUT_CHECK != null && process.env.MSP_LAYOUT_CHECK.length > 0) {
    const outDir = process.env.MSP_LAYOUT_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      const fixtureDir = path.resolve(__dirname, '../../../../fixtures/audio')
      void runLayoutCheck(window, engine, outDir, fixtureDir).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_WORKFLOW_CHECK != null && process.env.MSP_WORKFLOW_CHECK.length > 0) {
    const outDir = process.env.MSP_WORKFLOW_CHECK
    const phase = process.env.MSP_WORKFLOW_PHASE === 'reload' ? 'reload' : 'edit'
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      const fixtureDir = path.resolve(__dirname, '../../../../fixtures/audio')
      const answer = (filePath: string): void => { scriptedDialogs.push(filePath) }
      void runWorkflowCheck(window, engine, { outDir, fixtureDir, phase, answer }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_MIXER_CHECK != null && process.env.MSP_MIXER_CHECK.length > 0) {
    const outDir = process.env.MSP_MIXER_CHECK
    const phase = process.env.MSP_MIXER_PHASE === 'reload' ? 'reload' : 'build'
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      const answer = (filePath: string): void => { scriptedDialogs.push(filePath) }
      void runMixerCheck(window, engine, { outDir, phase, answer }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_FX_CHECK != null && process.env.MSP_FX_CHECK.length > 0) {
    const outDir = process.env.MSP_FX_CHECK
    const phase = process.env.MSP_FX_PHASE === 'reload' ? 'reload' : 'build'
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      const answer = (filePath: string): void => { scriptedDialogs.push(filePath) }
      void runFxCheck(window, engine, { outDir, phase, answer }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_AUTO_CHECK != null && process.env.MSP_AUTO_CHECK.length > 0) {
    const outDir = process.env.MSP_AUTO_CHECK
    const phase = process.env.MSP_AUTO_PHASE === 'reload' ? 'reload' : 'build'
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      const answer = (filePath: string): void => { scriptedDialogs.push(filePath) }
      void runAutoCheck(window, engine, { outDir, phase, answer }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_PITCH_CHECK != null && process.env.MSP_PITCH_CHECK.length > 0) {
    const outDir = process.env.MSP_PITCH_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runPitchCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_PITCHFIX_CHECK != null && process.env.MSP_PITCHFIX_CHECK.length > 0) {
    const outDir = process.env.MSP_PITCHFIX_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runPitchCorrectionCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_PITCHMAP_CHECK != null && process.env.MSP_PITCHMAP_CHECK.length > 0) {
    const outDir = process.env.MSP_PITCHMAP_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runPitchMappingCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_AUTOCORRECT_CHECK != null && process.env.MSP_AUTOCORRECT_CHECK.length > 0) {
    const outDir = process.env.MSP_AUTOCORRECT_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runAutoCorrectionCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCALQUALITY_CHECK != null && process.env.MSP_VOCALQUALITY_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCALQUALITY_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalQualityCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_LIVEPITCH_CHECK != null && process.env.MSP_LIVEPITCH_CHECK.length > 0) {
    const outDir = process.env.MSP_LIVEPITCH_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runLivePitchCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_LIVE_AUTOTUNE_CHECK != null && process.env.MSP_LIVE_AUTOTUNE_CHECK.length > 0) {
    const outDir = process.env.MSP_LIVE_AUTOTUNE_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runLiveAutoTuneCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCAL_COMP_CHECK != null && process.env.MSP_VOCAL_COMP_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCAL_COMP_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalCompCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCAL_TIMING_CHECK != null && process.env.MSP_VOCAL_TIMING_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCAL_TIMING_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalTimingCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCAL_BREATH_CHECK != null && process.env.MSP_VOCAL_BREATH_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCAL_BREATH_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalBreathCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCAL_PRESET_CHECK != null && process.env.MSP_VOCAL_PRESET_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCAL_PRESET_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalPresetCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_VOCAL_WORKFLOW_CHECK != null && process.env.MSP_VOCAL_WORKFLOW_CHECK.length > 0) {
    const outDir = process.env.MSP_VOCAL_WORKFLOW_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runVocalWorkflowCheck(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_KARAOKE_K1_CHECK != null && process.env.MSP_KARAOKE_K1_CHECK.length > 0) {
    const outDir = process.env.MSP_KARAOKE_K1_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runKaraokeK1Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_KARAOKE_K11_CHECK != null && process.env.MSP_KARAOKE_K11_CHECK.length > 0) {
    const outDir = process.env.MSP_KARAOKE_K11_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null || rendererServer == null) {
        app.exit(1)
        return
      }
      void runKaraokeK11Check(window, engine, { outDir, appOrigin: rendererServer.origin }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_KARAOKE_K2_CHECK != null && process.env.MSP_KARAOKE_K2_CHECK.length > 0) {
    const outDir = process.env.MSP_KARAOKE_K2_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runKaraokeK2Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_KARAOKE_K3_CHECK != null && process.env.MSP_KARAOKE_K3_CHECK.length > 0) {
    const outDir = process.env.MSP_KARAOKE_K3_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runKaraokeK3Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_RECORDING_WORKFLOW_271_CHECK != null && process.env.MSP_RECORDING_WORKFLOW_271_CHECK.length > 0) {
    const outDir = process.env.MSP_RECORDING_WORKFLOW_271_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runRecordingWorkflow271Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_INPUT_LEVEL_272_CHECK != null && process.env.MSP_INPUT_LEVEL_272_CHECK.length > 0) {
    const outDir = process.env.MSP_INPUT_LEVEL_272_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runInputLevel272Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_MIXER_UX_273_CHECK != null && process.env.MSP_MIXER_UX_273_CHECK.length > 0) {
    const outDir = process.env.MSP_MIXER_UX_273_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runMixerUx273Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_RECORDING_LATENCY_274_CHECK != null && process.env.MSP_RECORDING_LATENCY_274_CHECK.length > 0) {
    const outDir = process.env.MSP_RECORDING_LATENCY_274_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runRecordingLatency274Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_RECORDING_MIXING_275_CHECK != null && process.env.MSP_RECORDING_MIXING_275_CHECK.length > 0) {
    const outDir = process.env.MSP_RECORDING_MIXING_275_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runRecordingMixing275Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_CLIP_STRETCH_281_CHECK != null && process.env.MSP_CLIP_STRETCH_281_CHECK.length > 0) {
    const outDir = process.env.MSP_CLIP_STRETCH_281_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runClipStretch281Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_CROSSFADE_282_CHECK != null && process.env.MSP_CROSSFADE_282_CHECK.length > 0) {
    const outDir = process.env.MSP_CROSSFADE_282_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runCrossfade282Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_PARAMETRIC_EQ_283_CHECK != null && process.env.MSP_PARAMETRIC_EQ_283_CHECK.length > 0) {
    const outDir = process.env.MSP_PARAMETRIC_EQ_283_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runParametricEq283Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_DYNAMICS_284_CHECK != null && process.env.MSP_DYNAMICS_284_CHECK.length > 0) {
    const outDir = process.env.MSP_DYNAMICS_284_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runDynamics284Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_LOUDNESS_285_CHECK != null && process.env.MSP_LOUDNESS_285_CHECK.length > 0) {
    const outDir = process.env.MSP_LOUDNESS_285_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runLoudness285Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_PROJECT_AUTOSAVE_291_CHECK != null && process.env.MSP_PROJECT_AUTOSAVE_291_CHECK.length > 0) {
    const outDir = process.env.MSP_PROJECT_AUTOSAVE_291_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runProjectAutosave291Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_TIMELINE_EDITING_292_CHECK != null && process.env.MSP_TIMELINE_EDITING_292_CHECK.length > 0) {
    const outDir = process.env.MSP_TIMELINE_EDITING_292_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runTimelineEditing292Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_KEYBOARD_WORKFLOW_293_CHECK != null && process.env.MSP_KEYBOARD_WORKFLOW_293_CHECK.length > 0) {
    const outDir = process.env.MSP_KEYBOARD_WORKFLOW_293_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runKeyboardWorkflow293Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_AUDIO_MEDIA_294_CHECK != null && process.env.MSP_AUDIO_MEDIA_294_CHECK.length > 0) {
    const outDir = process.env.MSP_AUDIO_MEDIA_294_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runAudioMedia294Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
  if (process.env.MSP_INTEGRATED_WORKFLOW_295_CHECK != null && process.env.MSP_INTEGRATED_WORKFLOW_295_CHECK.length > 0) {
    const outDir = process.env.MSP_INTEGRATED_WORKFLOW_295_CHECK
    const window = mainWindow
    window.webContents.once('did-finish-load', () => {
      if (engine == null) {
        app.exit(1)
        return
      }
      void runIntegratedWorkflow295Check(window, engine, { outDir }).then(async (code) => {
        await engine?.shutdown()
        app.exit(code)
      })
    })
  }
}

function scripted(): string | undefined {
  return scriptedDialogs.shift()
}

app.whenReady().then(async () => {
  if (process.env.MSP_ENGINE_HOST_EPIPE_CHECK != null && process.env.MSP_ENGINE_HOST_EPIPE_CHECK.length > 0) {
    const outDir = process.env.MSP_ENGINE_HOST_EPIPE_CHECK
    void runEngineHostEpipeCheck({ outDir, enginePath: findEngine() }).then((code) => {
      app.exit(code)
    })
    return
  }
  engine = new EngineHost(findEngine())
  engine.onEvent = (event) => {
    if (mainWindow != null && !mainWindow.isDestroyed())
      mainWindow.webContents.send('engine:event', event)
  }
  if (engine.startupError != null) {
    engine.onEvent({ v: 1, event: 'error', message: engine.startupError })
  }
  ipcMain.handle('engine:request', async (_event, op: string, payload: Record<string, unknown>, timeoutMs: number) => {
    if (engine == null)
      return { v: 1, ok: false, error: 'The audio engine is not running.' } satisfies EngineResponse
    try {
      return await engine.request(op, payload, timeoutMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The audio engine request failed.'
      return { v: 1, ok: false, error: message } satisfies EngineResponse
    }
  })
  ipcMain.handle('dialog:wav', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showOpenDialog({
      title: 'Import WAV',
      properties: ['openFile'],
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('dialog:saveProject', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showSaveDialog({
      title: 'Save project',
      filters: [{ name: 'Music Studio Pro project', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePath ?? null
  })
  ipcMain.handle('dialog:openProject', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showOpenDialog({
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'Music Studio Pro project', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('dialog:saveRecoveryCopy', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showSaveDialog({
      title: 'Save recovered project copy',
      filters: [{ name: 'Music Studio Pro project', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePath ?? null
  })
  ipcMain.handle('project:listRecent', () => loadRecentProjects())
  ipcMain.handle('project:rememberRecent', (_event, entry: { path: string, name: string, projectId: string }) => {
    if (entry == null || typeof entry.path !== 'string')
      return loadRecentProjects()
    return rememberRecentProject(entry)
  })
  ipcMain.handle('project:removeRecent', (_event, targetPath: string) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0)
      return loadRecentProjects()
    return removeRecentProject(targetPath)
  })
  ipcMain.handle('project:listRecovery', () => listRecoverySnapshots())
  ipcMain.handle('project:prepareAutosave', (_event, projectId: string) => {
    if (typeof projectId !== 'string' || projectId.length === 0)
      throw new Error('Autosave requires a project id.')
    const allocated = allocateAutosavePath(projectId)
    return { snapshotPath: allocated.snapshotPath, savedAt: allocated.savedAt }
  })
  ipcMain.handle('project:commitAutosave', (_event, payload: {
    projectId: string
    projectName: string
    originalPath: string | null
    snapshotPath: string
    savedAt?: string
  }) => {
    if (payload == null || typeof payload.projectId !== 'string' || typeof payload.snapshotPath !== 'string')
      return { ok: false, error: 'Invalid autosave commit payload.' }
    return commitAutosaveFile(payload)
  })
  ipcMain.handle('project:discardRecovery', (_event, projectId: string) => {
    if (typeof projectId !== 'string' || projectId.length === 0)
      return false
    discardRecoverySnapshots(projectId)
    return true
  })
  ipcMain.handle('project:copyRecovery', (_event, snapshotPath: string, destPath: string) => {
    if (typeof snapshotPath !== 'string' || typeof destPath !== 'string')
      return { ok: false, error: 'Recovery copy paths are required.' }
    return copyRecoveryWorkingCopy(snapshotPath, destPath)
  })
  ipcMain.handle('project:getAutosaveSettings', () => ({ ...autosaveSettings }))
  ipcMain.handle('project:setAutosaveSettings', (_event, settings: { enabled?: boolean, intervalMs?: number }) => {
    if (settings?.enabled != null)
      autosaveSettings.enabled = settings.enabled === true
    if (typeof settings?.intervalMs === 'number' && Number.isFinite(settings.intervalMs) && settings.intervalMs >= 5_000)
      autosaveSettings.intervalMs = Math.floor(settings.intervalMs)
    return { ...autosaveSettings }
  })
  ipcMain.handle('shortcuts:get', () => loadShortcutOverrides())
  ipcMain.handle('shortcuts:set', (_event, overrides: Record<string, unknown>) => {
    if (overrides == null || typeof overrides !== 'object')
      return loadShortcutOverrides()
    return saveShortcutOverrides(overrides as Parameters<typeof saveShortcutOverrides>[0])
  })
  ipcMain.handle('shortcuts:reset', () => resetShortcutOverrides())
  ipcMain.handle('media:probe', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0)
      return probeWavFile('')
    return probeWavFile(filePath)
  })
  ipcMain.handle('media:inventory', (_event, sources: unknown, projectFilePath: unknown) => {
    const list = Array.isArray(sources) ? sources as InventorySourceInput[] : []
    const project = typeof projectFilePath === 'string' ? projectFilePath : null
    return buildMediaInventory(list, project)
  })
  ipcMain.handle('media:search', async (event, hint: unknown, options: unknown) => {
    const mediaHint = (hint != null && typeof hint === 'object' ? hint : {}) as MediaHint
    const opts = (options != null && typeof options === 'object' ? options : {}) as {
      projectFilePath?: string | null
      folders?: string[]
      rememberFolder?: boolean
      maxDepth?: number
    }
    return await searchMediaCandidates(mediaHint, {
      ...opts,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed())
          event.sender.send('media:searchProgress', progress)
      }
    })
  })
  ipcMain.handle('media:cancelSearch', () => {
    cancelMediaSearch()
    return true
  })
  ipcMain.on('project:closeReply', (_event, allow: unknown) => {
    closeReplyPending = false
    if (allow !== true || mainWindow == null || mainWindow.isDestroyed())
      return
    allowClose = true
    mainWindow.close()
  })
  ipcMain.handle('dialog:folder', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showOpenDialog({
      title: 'Recording folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('dialog:export', async () => {
    const queued = scripted()
    if (queued != null)
      return queued
    const result = await dialog.showSaveDialog({
      title: 'Export stereo WAV',
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    })
    return result.canceled ? null : result.filePath ?? null
  })
  ipcMain.handle('karaoke:openExternal', async (_event, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0)
      throw new Error('A URL is required.')
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new Error('That URL is not valid.')
    }
    if (parsed.protocol !== 'https:')
      throw new Error('Only https external links are allowed.')
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'm.youtube.com' && host !== 'music.youtube.com')
      throw new Error('Only YouTube https links can be opened externally.')
    await shell.openExternal(parsed.toString())
    return true
  })
  ipcMain.handle('karaoke:exportVocal', async (_event, sourcePath: unknown, meta: unknown) => {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0)
      throw new Error('A vocal WAV path is required.')
    const resolved = path.resolve(sourcePath)
    if (!resolved.toLowerCase().endsWith('.wav') || !fs.existsSync(resolved))
      throw new Error('The vocal take WAV was not found.')
    const queued = scripted()
    const destination = queued ?? (await dialog.showSaveDialog({
      title: 'Save karaoke vocal WAV',
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      defaultPath: path.basename(resolved)
    })).filePath
    if (destination == null || destination.length === 0)
      return null
    fs.copyFileSync(resolved, destination)
    if (meta != null && typeof meta === 'object') {
      const sidecar = destination.replace(/\.wav$/i, '.karaoke.json')
      fs.writeFileSync(sidecar, `${JSON.stringify({ ...meta as object, exportedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    }
    return destination
  })
  const rendererRoot = path.join(__dirname, '../renderer')
  try {
    rendererServer = await startLocalRendererServer(rendererRoot)
  } catch (error) {
    console.error(error)
    app.exit(1)
    return
  }
  createWindow()
})

app.on('window-all-closed', () => {
  if (quitting)
    return
  quitting = true
  const closing = engine?.shutdown() ?? Promise.resolve()
  void closing.finally(async () => {
    try { await rendererServer?.close() } catch { /* ignore */ }
    rendererServer = null
    app.quit()
  })
})
