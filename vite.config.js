import { defineConfig } from 'vite'
import fs from 'fs'

const httpsConfig = fs.existsSync('./localhost-key.pem')
  ? { key: fs.readFileSync('./localhost-key.pem'), cert: fs.readFileSync('./localhost.pem') }
  : undefined

export default defineConfig({
  server: { port: 3001, https: httpsConfig },
  build: { outDir: 'dist' }
})
