export interface RecentProjectEntry {
  path: string
  name: string
  projectId: string
  lastOpenedAt: string
  available: boolean
}

export interface RecoverySnapshot {
  projectId: string
  projectName: string
  originalPath: string | null
  snapshotPath: string
  timestamp: string
  available: boolean
  error?: string
}

/**
 * Engine ops that mutate durable project content (not transport / metering / analysis).
 * Names must match the IPC ops the renderer actually sends (Phase 2.9.5 audit).
 */
export const PROJECT_MUTATING_OPS = new Set([
  // Tracks
  'addTrack', 'removeTrack', 'renameTrack', 'duplicateTrack', 'setTrack', 'setTrackName',
  'setTrackOutput', 'setTrackRecord',
  // Media / clips
  'importTrack', 'importFile', 'importClip', 'importTake', 'replaceClipSource',
  'deleteClip', 'moveClip', 'trimClip', 'splitClip', 'duplicateClip', 'setClipGain',
  'setClipFades', 'setFadeIn', 'setFadeOut',
  'setCrossfade', 'clearCrossfade', 'applyCrossfade', 'revertCrossfade', 'setAutoCrossfade',
  'previewClipStretch', 'applyStretch', 'applyClipStretch', 'revertStretch', 'revertClipStretch',
  // Mixer / sends / buses
  'setGain', 'setPan', 'setMute', 'setSolo', 'setMaster', 'setMasterGain',
  'addSend', 'removeSend', 'setSend', 'setSendLevel', 'setSendPre',
  'addBus', 'removeBus', 'renameBus', 'setBus', 'setBusGain', 'setBusMute', 'setBusSolo', 'setBusOutput',
  // Effects
  'addEffect', 'removeEffect', 'moveEffect', 'setEffect', 'setEffectEnabled', 'setEffectParam', 'setEffectParams',
  // Automation
  'setAutomation', 'removeAutomation', 'addAutomationPoint', 'moveAutomationPoint',
  'deleteAutomationPoint', 'removeAutomationPoint', 'clearAutomation', 'setAutomationInterpolation',
  // Vocal / pitch / timing / breath
  'setRenderTail', 'setPitchMapping', 'applyPitch', 'revertPitch', 'applyNoteTargets',
  'setNoteTarget', 'resetNoteTarget', 'clearNoteTargets',
  'applyTiming', 'applyTimingAlign', 'revertTiming', 'revertTimingAlign', 'addTimingMarker',
  'applyBreath', 'revertBreath', 'setBreathRegion', 'addBreathRegion', 'removeBreathRegion', 'ignoreBreathRegion',
  // Recording / takes
  'armTrack', 'setRecordInput', 'setRecordMode', 'setMonitorInput', 'setTakesExpanded',
  'setCompCrossfade', 'setCompRegion', 'compTakes', 'muteTake', 'setTakeMuted', 'deleteTake', 'removeTake', 'renameTake',
  'applyVocalPreset', 'revertVocalPreset', 'bypassVocalPreset',
  'saveVocalPreset', 'deleteVocalPreset', 'saveCustomVocalPreset', 'deleteCustomVocalPreset', 'restoreFactoryVocalPresets',
  'setInputGainDb', 'setInputGain', 'toggleMonitor', 'setMonitor',
  'stopRecord', 'placeTake',
  // Media recovery (2.9.4)
  'relinkMedia',
  // History
  'undo', 'redo', 'undoEffect', 'redoEffect'
])

/** Ops that look like edits but are previews / analysis only — never mark dirty. */
export const PROJECT_NON_MUTATING_OPS = new Set([
  'previewBreath', 'cancelBreathPreview', 'previewClipStretch', 'cancelClipStretchPreview', 'endClipStretchPreview',
  'cancelCrossfadePreview', 'previewCrossfade',
  'previewVocalPreset', 'cancelVocalPresetPreview',
  'analyzeOnsets', 'analyzeBreath', 'analyzeLoudness', 'cancelLoudnessAnalysis',
  'analyzePitch', 'cancelPitchProcess', 'getLivePitch', 'getLiveCorrection', 'setLivePitch',
  'waveform', 'getState', 'listDevices', 'ping', 'transport', 'getMeters',
  'configure', 'exportWav', 'probeWav', 'setRecordFolder', 'setVirtualInput',
  'setSpectrumTap', 'getEqResponse', 'getDynamicsCurve',
  'estimateRecordingLatency', 'getRecordingLatency', 'setRecordingOffset', 'resetRecordingOffset',
  'applyRecordingLatencyEstimate'
])

export const PROJECT_RESET_OPS = new Set(['newProject', 'loadProject'])

/** True when an engine op should bump dirty generation (Phase 2.9.5). */
export function isProjectMutatingOp(op: string, payload?: Record<string, unknown>): boolean {
  if (PROJECT_RESET_OPS.has(op) || PROJECT_NON_MUTATING_OPS.has(op))
    return false
  if (op === 'record')
    return payload?.action === 'stop'
  if (PROJECT_MUTATING_OPS.has(op))
    return true
  // Conservative: unknown mutating-looking names still dirtied if listed historically.
  return false
}
