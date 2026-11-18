import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type MediaAvailability = 'available' | 'missing' | 'offline' | 'invalid' | 'unverified'

export interface WavProbeResult {
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
  availability: MediaAvailability
  error?: string
  /** Lightweight fingerprint (size + partial content hash). Not a full-file hash. */
  fingerprint?: string
}

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset)
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

/** Parse RIFF/WAVE headers without loading sample data into memory. */
export function probeWavFile(filePath: string, options?: { fingerprint?: boolean }): WavProbeResult {
  const resolved = path.resolve(filePath)
  const base: WavProbeResult = {
    path: resolved,
    ok: false,
    exists: false,
    fileBytes: 0,
    format: 'wav',
    sampleRate: 0,
    channels: 0,
    bitsPerSample: 0,
    frames: 0,
    durationSeconds: 0,
    availability: 'missing'
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    return { ...base, error: `Audio file not found: ${resolved}`, availability: 'missing' }
  }
  if (!stat.isFile()) {
    return { ...base, exists: false, error: `Not a file: ${resolved}`, availability: 'missing' }
  }
  base.exists = true
  base.fileBytes = stat.size
  if (stat.size <= 0) {
    return { ...base, error: 'The audio file is empty.', availability: 'invalid' }
  }
  if (path.extname(resolved).toLowerCase() !== '.wav') {
    return {
      ...base,
      format: path.extname(resolved).replace(/^\./, '').toLowerCase() || 'unknown',
      error: 'Only WAV files are supported.',
      availability: 'invalid'
    }
  }

  let fd: number | null = null
  try {
    fd = fs.openSync(resolved, 'r')
    const header = Buffer.alloc(12)
    if (fs.readSync(fd, header, 0, 12, 0) < 12) {
      return { ...base, error: 'Could not read WAV header.', availability: 'invalid' }
    }
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return { ...base, error: 'Not a valid RIFF/WAVE file.', availability: 'invalid' }
    }

    let offset = 12
    let fmtFound = false
    let dataFound = false
    let audioFormat = 0
    let channels = 0
    let sampleRate = 0
    let bitsPerSample = 0
    let blockAlign = 0
    let dataSize = 0

    while (offset + 8 <= stat.size) {
      const chunkHeader = Buffer.alloc(8)
      if (fs.readSync(fd, chunkHeader, 0, 8, offset) < 8)
        break
      const id = chunkHeader.toString('ascii', 0, 4)
      const size = readUInt32LE(chunkHeader, 4)
      const dataOffset = offset + 8
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 40))
        fs.readSync(fd, fmt, 0, fmt.length, dataOffset)
        if (fmt.length < 16) {
          return { ...base, error: 'WAV fmt chunk is truncated.', availability: 'invalid' }
        }
        audioFormat = readUInt16LE(fmt, 0)
        channels = readUInt16LE(fmt, 2)
        sampleRate = readUInt32LE(fmt, 4)
        blockAlign = readUInt16LE(fmt, 12)
        bitsPerSample = readUInt16LE(fmt, 14)
        fmtFound = true
      } else if (id === 'data') {
        dataSize = size
        dataFound = true
      }
      offset = dataOffset + size + (size % 2)
      if (fmtFound && dataFound)
        break
    }

    if (!fmtFound || !dataFound) {
      return { ...base, error: 'WAV file is missing fmt or data chunk.', availability: 'invalid' }
    }
    if (audioFormat !== 1 && audioFormat !== 3) {
      return { ...base, error: 'Unsupported WAV encoding (PCM or IEEE float required).', availability: 'invalid' }
    }
    if (sampleRate <= 0 || channels < 1 || bitsPerSample <= 0 || blockAlign <= 0) {
      return { ...base, error: 'WAV metadata is unusable.', availability: 'invalid' }
    }
    const bytesPerFrame = blockAlign > 0 ? blockAlign : channels * Math.ceil(bitsPerSample / 8)
    const frames = Math.floor(dataSize / Math.max(1, bytesPerFrame))
    if (frames <= 0) {
      return { ...base, error: 'The WAV file contains no audio samples.', availability: 'invalid' }
    }

    let fingerprint: string | undefined
    if (options?.fingerprint !== false) {
      fingerprint = computeLightFingerprint(fd, resolved, stat.size)
    }

    return {
      path: resolved,
      ok: true,
      exists: true,
      fileBytes: stat.size,
      format: 'wav',
      sampleRate,
      channels,
      bitsPerSample,
      frames,
      durationSeconds: frames / sampleRate,
      availability: 'available',
      fingerprint
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      error: `Unreadable audio file: ${message}`,
      availability: message.toLowerCase().includes('ebusy') || message.toLowerCase().includes('locked')
        ? 'offline'
        : 'invalid'
    }
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function computeLightFingerprint(fd: number, filePath: string, size: number): string {
  const chunk = 64 * 1024
  const head = Buffer.alloc(Math.min(chunk, size))
  fs.readSync(fd, head, 0, head.length, 0)
  const tailLen = Math.min(chunk, Math.max(0, size - head.length))
  const tail = Buffer.alloc(tailLen)
  if (tailLen > 0)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
  const hash = crypto.createHash('sha1')
  hash.update(path.basename(filePath).toLowerCase())
  hash.update('|')
  hash.update(String(size))
  hash.update('|')
  hash.update(head)
  hash.update('|')
  hash.update(tail)
  return hash.digest('hex')
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(path.resolve(filePath)).isFile()
  } catch {
    return false
  }
}
