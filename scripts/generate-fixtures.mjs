import fs from 'fs'
import path from 'path'

const outDir = path.resolve('D:/MusicStudioPro/fixtures')
fs.mkdirSync(outDir, { recursive: true })

function writeWav(filePath, sampleRate, channels, frames, sampleAt) {
  const dataBytes = frames * channels * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, sampleAt(i, channel)))
      buffer.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), offset)
      offset += 2
    }
  }
  fs.writeFileSync(filePath, buffer)
}

function tone(freq, amp) {
  return (index, _channel, rate) => amp * Math.sin((2 * Math.PI * freq * index) / rate)
}

const files = [
  ['sine_440_stereo_44100.wav', 44100, 2, 44100 * 2, tone(440, 0.4)],
  ['sine_880_stereo_48000.wav', 48000, 2, 48000 * 2, tone(880, 0.35)],
  ['silence_stereo_44100.wav', 44100, 2, 44100, () => 0],
  ['sine_440_mono_22050.wav', 22050, 1, 22050, tone(440, 0.45)],
  ['sine_440_stereo_96000.wav', 96000, 2, 96000, tone(440, 0.3)]
]

for (const [name, rate, channels, frames, fn] of files) {
  const target = path.join(outDir, name)
  writeWav(target, rate, channels, frames, (index, channel) => fn(index, channel, rate))
  console.log(target)
}
