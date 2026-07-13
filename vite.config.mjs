import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SERVER_PORT = Number(process.env.PORT || 5780)

export default defineConfig({
  root: 'web',
  // .env lives at the repo root, not in web/ (Vite defaults envDir to `root`).
  envDir: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5781,
    proxy: {
      '/api': `http://localhost:${SERVER_PORT}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
