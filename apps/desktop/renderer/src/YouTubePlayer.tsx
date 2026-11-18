import { useEffect, useRef, useState } from 'react'

export type YoutubePlayerStatus =
  | 'idle'
  | 'loading-api'
  | 'loading-video'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'unavailable'
  | 'error'

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement | string, options: Record<string, unknown>) => YtPlayer
      PlayerState: { ENDED: number, PLAYING: number, PAUSED: number, BUFFERING: number, CUED: number }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YtPlayer {
  destroy(): void
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
}

let apiLoading: Promise<void> | null = null

function loadYoutubeApi(): Promise<void> {
  if (window.YT?.Player != null)
    return Promise.resolve()
  if (apiLoading != null)
    return apiLoading
  apiLoading = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    const timer = window.setTimeout(() => {
      reject(new Error('Timed out loading the YouTube IFrame Player API.'))
    }, 20000)
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer)
      previous?.()
      resolve()
    }
    const existing = document.querySelector('script[data-youtube-api="1"]')
    if (existing != null)
      return
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.dataset.youtubeApi = '1'
    script.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('Could not load the YouTube IFrame Player API.'))
    }
    document.head.appendChild(script)
  })
  return apiLoading
}

export function describeYoutubePlayerError(code: number): { status: YoutubePlayerStatus, detail: string } {
  // Official IFrame API codes + observed embedder/referrer failures (153).
  if (code === 100 || code === 101 || code === 150)
    return { status: 'unavailable', detail: `This video is unavailable or embedding is disabled by the owner (YouTube error ${code}).` }
  if (code === 2)
    return { status: 'error', detail: 'Invalid YouTube video id (YouTube error 2).' }
  if (code === 5)
    return { status: 'error', detail: 'The HTML5 player could not play this video (YouTube error 5).' }
  if (code === 153)
    return {
      status: 'unavailable',
      detail: 'YouTube rejected the embed (error 153 — missing/invalid embedder identity). Use an http(s) app origin, or open the video externally.'
    }
  return { status: 'error', detail: `YouTube player error (${code}).` }
}

export function YouTubePlayer(props: {
  videoId: string | null
  onStatus: (status: YoutubePlayerStatus, detail?: string) => void
  onTime?: (seconds: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YtPlayer | null>(null)
  const [status, setStatus] = useState<YoutubePlayerStatus>('idle')
  const pollRef = useRef<number | null>(null)

  function report(next: YoutubePlayerStatus, detail?: string): void {
    setStatus(next)
    props.onStatus(next, detail)
  }

  useEffect(() => {
    if (props.videoId == null || hostRef.current == null) {
      if (playerRef.current != null) {
        try { playerRef.current.destroy() } catch { /* ignore */ }
        playerRef.current = null
      }
      if (hostRef.current != null)
        hostRef.current.innerHTML = ''
      report('idle')
      return
    }

    let cancelled = false
    const origin = window.location.origin
    if (window.location.protocol === 'file:') {
      report(
        'unavailable',
        'YouTube embeds require an http(s) application origin. This build should load from http://127.0.0.1 — open the video externally if playback is still blocked.'
      )
      return () => { cancelled = true }
    }

    report('loading-api')
    void loadYoutubeApi().then(() => {
      if (cancelled || hostRef.current == null || window.YT == null || props.videoId == null)
        return
      report('loading-video')
      if (playerRef.current != null) {
        try { playerRef.current.destroy() } catch { /* ignore */ }
        playerRef.current = null
      }
      hostRef.current.innerHTML = ''
      // Build the iframe ourselves so referrerpolicy is set before the first YouTube navigation.
      const iframe = document.createElement('iframe')
      iframe.id = `msp-yt-${props.videoId}-${Date.now()}`
      iframe.title = 'YouTube video player'
      iframe.width = '100%'
      iframe.height = '100%'
      iframe.allowFullscreen = true
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share')
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
      iframe.setAttribute('loading', 'eager')
      const params = new URLSearchParams({
        enablejsapi: '1',
        origin,
        widget_referrer: origin,
        rel: '0',
        modestbranding: '1',
        playsinline: '1'
      })
      iframe.src = `https://www.youtube.com/embed/${props.videoId}?${params.toString()}`
      hostRef.current.appendChild(iframe)
      playerRef.current = new window.YT.Player(iframe, {
        events: {
          onReady: () => {
            if (!cancelled)
              report('ready', `Player ready (origin ${origin}).`)
          },
          onStateChange: (event: { data: number }) => {
            if (cancelled || window.YT == null)
              return
            const state = event.data
            if (state === window.YT.PlayerState.PLAYING)
              report('playing')
            else if (state === window.YT.PlayerState.PAUSED)
              report('paused')
            else if (state === window.YT.PlayerState.ENDED)
              report('ended')
          },
          onError: (event: { data: number }) => {
            if (cancelled)
              return
            const mapped = describeYoutubePlayerError(event.data)
            report(mapped.status, mapped.detail)
          }
        }
      })
    }).catch((error: Error) => {
      if (!cancelled)
        report('error', error.message)
    })

    return () => {
      cancelled = true
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (playerRef.current != null) {
        try { playerRef.current.destroy() } catch { /* ignore */ }
        playerRef.current = null
      }
      if (hostRef.current != null)
        hostRef.current.innerHTML = ''
    }
  }, [props.videoId])

  useEffect(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (props.onTime == null)
      return
    pollRef.current = window.setInterval(() => {
      try {
        const seconds = playerRef.current?.getCurrentTime()
        if (typeof seconds === 'number' && Number.isFinite(seconds))
          props.onTime?.(seconds)
      } catch {
        // Player may be destroyed during teardown.
      }
    }, 250)
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [props.videoId, props.onTime])

  function play(): void {
    try { playerRef.current?.playVideo() } catch { /* ignore */ }
  }

  function pause(): void {
    try { playerRef.current?.pauseVideo() } catch { /* ignore */ }
  }

  return (
    <div className="youtube-player" data-player-status={status} data-app-origin={typeof window !== 'undefined' ? window.location.origin : ''}>
      <div className="youtube-frame" ref={hostRef} data-youtube-host="1" />
      <div className="youtube-controls">
        <button type="button" data-action="karaoke-play" disabled={props.videoId == null || status === 'unavailable' || status === 'error' || status === 'loading-api' || status === 'loading-video'} onClick={play}>Play video</button>
        <button type="button" data-action="karaoke-pause" disabled={props.videoId == null} onClick={pause}>Pause video</button>
      </div>
    </div>
  )
}

export function youtubeStatusLabel(status: YoutubePlayerStatus): string {
  switch (status) {
    case 'idle': return 'No video loaded'
    case 'loading-api': return 'Loading YouTube player…'
    case 'loading-video': return 'Loading video…'
    case 'ready': return 'Video ready'
    case 'playing': return 'Playing'
    case 'paused': return 'Paused'
    case 'ended': return 'Ended'
    case 'unavailable': return 'Embedding unavailable'
    case 'error': return 'Player error'
  }
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}
