/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import * as esbuild from "esbuild";
import AdmZip from "adm-zip";
import dotenv from "dotenv";

dotenv.config();

// Inizializzazione pigra (lazy initialization) del client Gemini per evitare crash all'avvio se manca la chiave
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // --- METADATI PWA (MANIFEST.JSON & SERVICE WORKER) ---
  app.get("/manifest.json", (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send({
      "name": "Flora — Botanical Archive",
      "short_name": "Flora",
      "start_url": "/",
      "display": "standalone",
      "background_color": "#fbfbf9",
      "theme_color": "#2d3a27",
      "orientation": "portrait-primary",
      "icons": [
        {
          "src": "https://img.icons8.com/plant-green/512/empty-bed.png",
          "sizes": "512x512",
          "type": "image/png",
          "purpose": "any maskable"
        },
        {
          "src": "https://img.icons8.com/plant-green/192/empty-bed.png",
          "sizes": "192x192",
          "type": "image/png",
          "purpose": "any"
        }
      ]
    });
  });

  app.get("/sw.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.send(`
      const CACHE_NAME = 'flora-cache-v3';
      self.addEventListener('install', (event) => {
        self.skipWaiting();
      });
      self.addEventListener('activate', (event) => {
        event.waitUntil(clients.claim());
      });
      self.addEventListener('fetch', (event) => {
        event.respondWith(
          fetch(event.request).catch(() => {
            return caches.match(event.request);
          })
        );
      });
    `);
  });

  // Middleware CORS per consentire l'accesso sicuro sia da Google AI Studio che da istanze Vercel
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  const SHARES_DIR = path.join(process.cwd(), "shares");
  if (!fs.existsSync(SHARES_DIR)) {
    fs.mkdirSync(SHARES_DIR, { recursive: true });
  }

  // API: Salva o aggiorna una condivisione sul server / cloud
  app.post("/api/shares", async (req, res) => {
    try {
      const stateData = req.body;
      if (!stateData) {
        return res.status(400).json({ error: "Dati non validi" });
      }

      let shareId = stateData.id || "";

      // Se non abbiamo un ID, proviamo a generarne uno nuovo tramite KVDB.io o locale
      if (!shareId) {
        // Tentativo 1: Salva nel cloud persistente e veloce di KVDB.io per supportare Vercel
        try {
          const bucketRes = await fetch("https://kvdb.io", { method: "POST" });
          if (bucketRes.ok) {
            const bucketId = (await bucketRes.text()).trim();
            if (bucketId && bucketId.length > 5) {
              const saveRes = await fetch(`https://kvdb.io/${bucketId}/state`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(stateData)
              });
              if (saveRes.ok) {
                shareId = bucketId;
              }
            }
          }
        } catch (cloudErr) {
          console.warn("Errore KVDB cloud, fallback su filesystem locale:", cloudErr);
        }

        // Fallback: Genera un ID corto locale se il cloud non è utilizzabile ed è la prima volta
        if (!shareId) {
          const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          for (let i = 0; i < 8; i++) {
            shareId += chars.charAt(Math.floor(Math.random() * chars.length));
          }
        }
      } else {
        // Se abbiamo già l'ID, proviamo ad aggiornare KVDB.io se è un ID cloud lungo
        if (shareId.length > 15) {
          try {
            await fetch(`https://kvdb.io/${shareId}/state`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(stateData)
            });
          } catch (cloudErr) {
            console.warn("Errore aggiornamento KVDB:", cloudErr);
          }
        }
      }

      // Salva/sovrascrivi sempre anche localmente per sicurezza e coerenza
      const filePath = path.join(SHARES_DIR, `${shareId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(stateData, null, 2), "utf-8");

      res.json({ id: shareId });
    } catch (error: any) {
      console.error("Errore salvataggio condivisione:", error);
      res.status(500).json({ error: "Errore durante il salvataggio: " + error.message });
    }
  });

  // API: Recupera una condivisione tramite ID corto
  app.get("/api/shares/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: "ID non valido" });
      }

      // Se l'ID è lungo (~20 caratteri), proviamo KVDB cloud
      if (id.length > 15) {
        try {
          const cloudRes = await fetch(`https://kvdb.io/${id}/state`);
          if (cloudRes.ok) {
            const data = await cloudRes.json();
            return res.json(data);
          }
        } catch (cloudErr) {
          console.warn("Errore lettura KVDB cloud:", cloudErr);
        }
      }

      // Fallback o ID corto locale: Leggi dal filesystem locale
      const filePath = path.join(SHARES_DIR, `${id}.json`);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        return res.json(JSON.parse(data));
      }

      // Se non trovato localmente ed era corto, proviamo comunque KVDB per sicurezza
      try {
        const cloudRes = await fetch(`https://kvdb.io/${id}/state`);
        if (cloudRes.ok) {
          const data = await cloudRes.json();
          return res.json(data);
        }
      } catch (e) {}

      res.status(404).json({ error: "Condivisione non trovata" });
    } catch (error: any) {
      console.error("Errore lettura condivisione:", error);
      res.status(500).json({ error: "Errore durante il recupero dei dati: " + error.message });
    }
  });

  // API 1: Curatore Botanico AI (Gemini Assistant)
  app.post("/api/gemini/curator", async (req, res) => {
    try {
      const { plant, currentNotes, recentActivities } = req.body;
      if (!plant) {
        return res.status(400).json({ error: "Dati pianta mancanti" });
      }

      const client = getGeminiClient();
      if (!client) {
        // Fallback poetico offline o simulato se non c'è la chiave configurata
        const simulatedResponses = [
          `🌿 *Analisi del Curatore* per **${plant.nickname}** (${plant.name}):\n\nQuesta creatura mostra una resilienza eccezionale. Data la sua origine (${plant.origin}) e lo stato attuale (*${plant.status}*), ti consiglio di mantenere un ritmo di cura meditativo. Attenzione alle correnti d'aria fredda. Una nuova foglia è sempre un rito di luce.`,
          `🌱 *Osservazione curatoriale* per **${plant.nickname}**:\n\nLe sue foglie raccontano storie di luce e pazienza. Mantieni il terreno umido ma mai asfittico. Ricorda che la crescita più vigorosa avviene nel silenzio delle radici. Dedica 5 minuti a pulire le superfici fogliari per agevolare il respiro della linfa.`,
          `🍃 *Rapporto di crescita* per **${plant.nickname}**:\n\nPresenta uno stato di salute pari al ${plant.health}%. Un valore splendido che riflette la tua cura. Suggerisco di assecondare il ciclo stagionale fornendo un'esposizione indiretta luminosa e concentrando l'attenzione sul ritmo lento e organico della turgidità cellulare.`
        ];
        const randomSim = simulatedResponses[Math.floor(Math.random() * simulatedResponses.length)];
        return res.json({
          text: `[Modalità Offline / Chiave non impostata - Risposta Simulata Cura]\n\n${randomSim}`
        });
      }

      // Prompt dettagliato ed editoriale
      const prompt = `Sei un Curatore Botanico di alto livello, esperto, appassionato e dal tono poetico, raffinato, intimo e profondamente scientifico ma affettivo.
Sei responsabile di scrivere una pagina di diario o un commento curatoriale sulla crescita di questa pianta del nostro giardino botanico domestico.

Dettagli della pianta:
- Nome Scientifico: ${plant.name}
- Soprannome: ${plant.nickname}
- Origine: ${plant.origin} (data d'inizio: ${plant.startDate})
- Descrizione: ${plant.description}
- Stato attuale: ${plant.status}
- Salute generale stimata: ${plant.health}%
- Note personali: ${plant.notes || "Nessuna nota aggiuntiva"}
- Caratteristiche/Tag: ${plant.tags ? plant.tags.join(", ") : "Nessuno"}

Attività recenti intraprese:
${recentActivities || "Nessuna registrata recentemente"}

Note addizionali scritte adesso dall'utente:
"${currentNotes || "Nessuna"}"

Scrivi un paragrafo magnifico, evocativo ed elegante (in italiano fluido e caldo, stile editoriale di rivista di giardinaggio d'arte tipo 'Cabana' o 'The Kinfolk Home'). Fornisci consigli pratici sofisticati, osserva i dettagli affettivi (come l'età calcolata o la forza del suo soprannome) e trasmetti pace, stimolando la cura e l'osservazione. Non elencare noiosamente i dati ricevuti ma incorporali nel flusso naturale di una prosa poetica.`;

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          temperature: 0.85,
        }
      });

      return res.json({ text: response.text });
    } catch (error: any) {
      console.error("Errore chiamata Gemini:", error);
      res.status(500).json({ error: "Errore durante la generazione dei consigli botanici: " + error.message });
    }
  });

  // API: Scarica archivio ZIP con i dati della serra
  app.post("/api/backup/zip", (req, res) => {
    try {
      const stateData = req.body;
      const zip = new AdmZip();
      zip.addFile("flora_journal_backup.json", Buffer.from(JSON.stringify(stateData, null, 2), "utf-8"));
      const zipBuffer = zip.toBuffer();

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="flora_journal_backup.zip"',
        'Content-Length': zipBuffer.length,
      });
      res.end(zipBuffer);
    } catch (error) {
      console.error("Errore esportazione ZIP:", error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end("Errore durante la generazione dell'archivio ZIP.");
    }
  });

  // API: Ripristina archivio ZIP con i dati della serra
  app.post("/api/backup/unzip", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const zipBuffer = Buffer.concat(chunks);
        if (zipBuffer.length === 0) {
          return res.status(400).json({ error: "Nessun file ZIP ricevuto" });
        }

        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        const backupEntry = zipEntries.find(entry => entry.entryName.endsWith(".json"));
        if (!backupEntry) {
          return res.status(400).json({ error: "Nessun file JSON di backup trovato all'interno dello ZIP" });
        }

        const jsonDataString = backupEntry.getData().toString("utf-8");
        const stateObj = JSON.parse(jsonDataString);
        res.json(stateObj);
      } catch (error: any) {
        console.error("Errore decrittazione ZIP:", error);
        res.status(500).json({ error: "Errore durante l'elaborazione del file ZIP: " + error.message });
      }
    });
    req.on("error", (err) => {
      console.error("Errore ricezione stream:", err);
      res.status(550).json({ error: "Errore nella ricezione dei dati." });
    });
  });

  // API 2: Compilatore Universal Offline App (per la build di produzione montato su Express)
  app.post("/api/download-app", async (req, res) => {
    try {
      const type = req.query.type || 'html';
      const clientData = req.body;

      // 1. Forza la build di produzione di Vite per estrarre il CSS ottimizzato
      const { build: viteBuild } = await import("vite");
      await viteBuild({
        configFile: false,
        plugins: [
          (await import("@vitejs/plugin-react")).default(),
          (await import("@tailwindcss/vite")).default()
        ],
        resolve: { alias: { '@': path.resolve(process.cwd(), '.') } },
        build: { outDir: 'dist', emptyOutDir: true }
      });

      const distPath = path.resolve(process.cwd(), 'dist');

      if (type === 'html') {
        const assetsDir = path.join(distPath, 'assets');
        let compiledCss = '';
        if (fs.existsSync(assetsDir)) {
          const files = fs.readdirSync(assetsDir);
          const cssFile = files.find(f => f.endsWith('.css'));
          if (cssFile) {
            compiledCss = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');
          }
        }

        // Compila istantaneamente il JS in formato non-modulo (IIFE)
        const esbuildResult = await esbuild.build({
          entryPoints: ['src/main.tsx'],
          bundle: true,
          minify: true,
          format: 'iife',
          platform: 'browser',
          write: false,
          loader: {
            '.css': 'empty',
            '.png': 'dataurl',
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

        const standaloneHtml = `<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Diario Botanico Digitale - Archivio Standalone Offline</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
    <style>
        ${compiledCss}
    </style>
</head>
<body class="bg-[#fbfbf9] text-[#2d3a2e] antialiased">
    <div id="root"></div>
    <script>
        // Dati reali catturati in tempo reale dal client!
        window.__MY_APP_INITIAL_DATA__ = ${dataInjection};
    </script>
    <script>
        ${compiledJs}
    </script>
</body>
</html>`;

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="diario_botanico_offline.html"',
        });
        res.end(standaloneHtml);
      } else {
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
      console.error("Errore del generatore offline server:", error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Errore: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Gestione di Vite Middleware: dev vs produzione
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Flora Server] running on http://localhost:${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
}

startServer();
