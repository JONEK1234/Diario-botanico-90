import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, build } from 'vite';
import fs from 'fs';
import * as esbuild from 'esbuild';
import AdmZip from 'adm-zip';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'universal-download-api',
        configureServer(server) {
          // Aggiungiamo un middleware al server di sviluppo locale di Vite
          server.middlewares.use(async (req, res, next) => {
            const reqUrl = req.url || '';
            
            // Intercettiamo l'endpoint di download
            if (reqUrl.startsWith('/api/download-app')) {
              try {
                const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
                const type = parsedUrl.searchParams.get('type') || 'html';

                // Leggiamo i dati inviati dal client (se presenti via POST)
                let clientData: any = null;
                if (req.method === 'POST') {
                  const body = await new Promise<string>((resolve) => {
                    let data = '';
                    req.on('data', chunk => { data += chunk; });
                    req.on('end', () => resolve(data));
                  });
                  if (body) {
                    try { clientData = JSON.parse(body); } catch (e) { console.error(e); }
                  }
                }

                // 1. Forza la build di produzione di Vite per estrarre il CSS ottimizzato
                await build({
                  configFile: false,
                  plugins: [react(), tailwindcss()],
                  resolve: { alias: { '@': path.resolve(process.cwd(), '.') } },
                  build: { outDir: 'dist', emptyOutDir: true }
                });

                const distPath = path.resolve(process.cwd(), 'dist');

                if (type === 'html') {
                  // 2A. Estrai il CSS compilato generato da Vite
                  const assetsDir = path.join(distPath, 'assets');
                  let compiledCss = '';
                  if (fs.existsSync(assetsDir)) {
                    const files = fs.readdirSync(assetsDir);
                    const cssFile = files.find(f => f.endsWith('.css'));
                    if (cssFile) {
                      compiledCss = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');
                    }
                  }

                  // 2B. Compila istantaneamente il JS in formato non-modulo (IIFE)
                  // Questo rende il file HTML libero da vincoli CORS e avviabile offline ovunque!
                  const esbuildResult = await esbuild.build({
                    entryPoints: ['src/main.tsx'], // Punto di ingresso principale della tua app
                    bundle: true,
                    minify: true,
                    format: 'iife',
                    platform: 'browser',
                    write: false,
                    loader: {
                      '.css': 'empty', // Ignoriamo gli import CSS statici, li compila già Vite
                      '.png': 'dataurl', // Converte le immagini in stringhe Base64 incorporate
                      '.svg': 'dataurl',
                      '.woff2': 'dataurl',
                    },
                    define: {
                      'process.env.NODE_ENV': '"production"'
                    }
                  });

                  if (!esbuildResult.outputFiles || esbuildResult.outputFiles.length === 0) {
                    throw new Error("L'assemblaggio tramite Esbuild è fallito.");
                  }

                  const compiledJs = esbuildResult.outputFiles[0].text;
                  const dataInjection = clientData ? JSON.stringify(clientData) : 'null';

                  // 2C. Costruisci il file HTML Standalone Unificato
                  const standaloneHtml = `<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Diario Botanico Digitale - Archivio Standalone Offline</title>
    <!-- Fonts globali opzionali caricati via CDN -->
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
    <style>
        ${compiledCss}
    </style>
</head>
<body class="bg-[#fbfbf9] text-[#2d3a2e]">
    <div id="root"></div>
    <script>
        // Iniettiamo i dati reali catturati in tempo reale dal client!
        window.__MY_APP_INITIAL_DATA__ = ${dataInjection};
    </script>
    <script>
        ${compiledJs}
    </script>
</body>
</html>`;

                  // Rispondi con l'HTML scaricabile
                  res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="diario_botanico_offline.html"',
                  });
                  res.end(standaloneHtml);
                } 
                else if (type === 'zip') {
                  // Pacchetto ZIP statico di tutta la cartella 'dist' pronta all'uso
                  const zip = new AdmZip();
                  if (fs.existsSync(distPath)) {
                    zip.addLocalFolder(distPath);
                  } else {
                    throw new Error("Esegui prima la build della cartella dist.");
                  }

                  const zipBuffer = zip.toBuffer();
                  res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': 'attachment; filename="diario_botanico_build.zip"',
                    'Content-Length': zipBuffer.length,
                  });
                  res.end(zipBuffer);
                }
              } catch (error) {
                console.error("Errore del generatore offline:", error);
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Errore: ${error instanceof Error ? error.message : String(error)}`);
              }
            } else {
              next();
            }
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
