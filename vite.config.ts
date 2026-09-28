import path from 'path';
import { existsSync, rmSync } from 'fs';
import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

function stripLeftoverDistMedia() {
  return {
    name: 'strip-leftover-dist-media',
    apply: 'build',
    buildStart() {
      for (const name of ['media', 'myphoner-audio', 'myphoner-recordings']) {
        const target = path.resolve(__dirname, 'dist', name);
        if (!existsSync(target)) continue;
        console.log(`Removing leftover dist/${name} (public/ originals stay)`);
        rmSync(target, { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    root: 'app',
    // Dev serves /media from public/. Production Vite must not copy that
    // folder into dist (that filled the disk and produced 31k-line logs).
    publicDir: command === 'serve' ? path.resolve(__dirname, 'public') : false,
    plugins: [react(), tailwindcss(), stripLeftoverDistMedia()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    optimizeDeps: {
      include: ['grapesjs', 'grapesjs-preset-newsletter', 'pdfjs-dist'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'app'),
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('react-dom') || id.includes('/react/')) return 'react-vendor';
              if (id.includes('motion')) return 'motion';
              if (id.includes('react-router')) return 'router';
              if (id.includes('lucide-react')) return 'icons';
              if (id.includes('grapesjs')) return 'email-editor';
              if (id.includes('pdfjs-dist')) return 'pdf-preview';
            }
          },
          chunkFileNames: 'assets/[name]-[hash].js',
        },
      },
      chunkSizeWarningLimit: 400,
    },
    server: {
      host: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      // In Docker LAN preview, API runs in a sibling container (api:3001).
      // Locally without Docker, keep the default localhost:3001.
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
        '/sales-preview': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
        '/live-preview': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
        '/email': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
        '/client-media': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
