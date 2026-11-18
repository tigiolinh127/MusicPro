/** Electron-side copy of YouTube URL helpers (tsc rootDir is electron/). Keep in sync with packages/shared/src/youtubeUrl.ts. */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export type YoutubeParseResult =
  | { ok: true, videoId: string }
  | { ok: false, error: string }

export function isYoutubeVideoId(value: string): boolean {
  return VIDEO_ID.test(value)
}

export function parseYoutubeVideoId(input: string): YoutubeParseResult {
  const raw = input.trim()
  if (raw.length === 0)
    return { ok: false, error: 'Paste a YouTube URL or 11-character video id.' }
  if (isYoutubeVideoId(raw))
    return { ok: true, videoId: raw }

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'That is not a valid YouTube URL.' }
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return isYoutubeVideoId(id)
      ? { ok: true, videoId: id }
      : { ok: false, error: 'Could not find a YouTube video id in that short link.' }
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com'
      || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v')
    if (v != null && isYoutubeVideoId(v))
      return { ok: true, videoId: v }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') {
      const id = parts[1] ?? ''
      if (isYoutubeVideoId(id))
        return { ok: true, videoId: id }
    }
    return { ok: false, error: 'Could not find a YouTube video id in that URL.' }
  }

  return { ok: false, error: 'Only YouTube watch, share, embed, or shorts URLs are supported.' }
}

export function youtubeEmbedUrl(videoId: string, origin = 'http://127.0.0.1'): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin,
    rel: '0',
    modestbranding: '1',
    playsinline: '1'
  })
  // Prefer standard embed host. file:// origins lack a Referer and trigger YouTube error 153.
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`
}
