import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const desktopRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(desktopRoot, 'renderer'),
  plugins: [react()],
  base: './',
  build: {
    outDir: path.join(desktopRoot, 'dist', 'renderer'),
    emptyOutDir: true
  }
})
