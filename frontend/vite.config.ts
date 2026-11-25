import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/** Inject a high-priority <link rel="preload"> for the hashed landing hero WebP image. */
function preloadHeroImage(): Plugin {
  return {
    name: 'preload-hero-image',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return []
        const hero = Object.keys(bundle).find((k) => /^assets\/paper-latex-[^/]+\.webp$/.test(k))
        if (!hero) return []
        return [
          {
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'image',
              href: `/${hero}`,
              type: 'image/webp',
              fetchpriority: 'high',
            },
            injectTo: 'head',
          },
        ]
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), preloadHeroImage()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    host: true,
    port: 5173,
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-codemirror', test: /[\\/]node_modules[\\/](@codemirror|@lezer|style-mod|crelt|@marijn[\\/]find-cluster-break)[\\/]/ },
            { name: 'vendor-katex', test: /[\\/]node_modules[\\/]katex[\\/]/ },
            { name: 'vendor-prosemirror', test: /[\\/]node_modules[\\/]prosemirror-[^\\/]+[\\/]/ },
          ],
        },
      },
    },
  },
})
