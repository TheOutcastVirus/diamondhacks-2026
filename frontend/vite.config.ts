import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'vite-client-path-rewrite',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/node_modules/vite/dist/client/env.mjs') {
            req.url = '/@vite/env'
          } else if (req.url === '/node_modules/vite/dist/client/client.mjs') {
            req.url = '/@vite/client'
          }

          next()
        })
      },
    },
  ],
})
