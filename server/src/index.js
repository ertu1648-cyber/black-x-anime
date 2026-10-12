
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import authRoutes from './routes/auth.js';
import animeRoutes from './routes/anime.js';
import streamingRoutes from './routes/streaming.js';
import libraryRoutes from './routes/library.js';
import devRoutes from './routes/dev.js';
import communityRoutes from './routes/community.js';
import contentRoutes from './routes/content.routes.js';
import communitySpecRoutes from './routes/community.routes.js';
import profileRoutes from './routes/profile.routes.js';
import gamificationRoutes from './routes/gamification.routes.js';
import supportRoutes from './routes/support.routes.js';
import mangaNovelRoutes from './routes/mangaNovel.routes.js';
import { animeScraperRouter } from './routes/animeScraper.routes.js';

import { optionalAuth } from './auth.js';
import { db } from './db.js';
import { main as seedAll, enrichLibrary } from './seed.js';

// =====================================================
// BLACK X — Production Server
// =====================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const clientDist = join(__dirname, '..', '..', 'client', 'dist');

// =====================================================
// Error handling
// =====================================================

process.on('unhandledRejection', (error) => {
  console.error('[Unhandled Rejection]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]', error);

  // A synchronous exception can leave process state unsafe.
  process.exitCode = 1;
  server?.close(() => process.exit(1));
});

// =====================================================
// Middleware
// =====================================================

app.disable('x-powered-by');

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb',
}));
app.use(cookieParser());
app.use(optionalAuth);

// =====================================================
// Health check
// =====================================================

app.get('/api/health', (req, res) => {
  res.status(200).json({
    ok: true,
    name: 'BLACK X API',
    status: 'online',
    environment: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// =====================================================
// Image proxy
// =====================================================

const ALLOWED_IMAGE_HOSTS = [
  's4.anilist.co',
  'images.witanime.site',
  'anime3rb.com',
  'animeify.net',
  'mangalik.net',
];

function isAllowedImageHost(hostname) {
  return ALLOWED_IMAGE_HOSTS.some((allowed) =>
    hostname === allowed || hostname.endsWith(`.${allowed}`)
  );
}

app.get('/api/proxy-image', async (req, res) => {
  try {
    const rawUrl = req.query.url;

    if (typeof rawUrl !== 'string') {
      return res.status(400).json({
        error: 'missing_url',
      });
    }

    const url = new URL(rawUrl);

    if (
      url.protocol !== 'https:' ||
      !isAllowedImageHost(url.hostname)
    ) {
      return res.status(400).json({
        error: 'bad_host',
        message: 'Host not allowed',
      });
    }

    const response = await fetch(url.href, {
      redirect: 'error',
      headers: {
        'User-Agent': 'BLACK-X/1.0',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return res.status(response.status).end();
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(502).json({
        error: 'invalid_image',
      });
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

    if (contentLength > MAX_IMAGE_SIZE) {
      return res.status(413).json({
        error: 'image_too_large',
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_IMAGE_SIZE) {
      return res.status(413).json({
        error: 'image_too_large',
      });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    return res.send(buffer);
  } catch (error) {
    console.error('[Image Proxy]', error?.message);

    return res.status(502).json({
      error: 'upstream',
      message: 'Image fetch failed',
    });
  }
});

// =====================================================
// Authentication / Anime / Streaming
// =====================================================

app.use('/api/auth', authRoutes);
app.use('/api/anime', animeRoutes);
app.use('/api/stream', streamingRoutes);
app.use('/api/library', libraryRoutes);

// =====================================================
// Developer / Settings
// =====================================================

app.use('/api/dev', devRoutes);
app.use('/api/settings', devRoutes);

// =====================================================
// Community / Social
// =====================================================

app.use('/api/community', communityRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/community', communitySpecRoutes);
app.use('/api/profile', profileRoutes);

// =====================================================
// Gamification / Creator / Support
// =====================================================

app.use('/api/gamification', gamificationRoutes);
app.use('/api/creator', gamificationRoutes);
app.use('/api/support', supportRoutes);

// =====================================================
// Manga / Manhwa / Novel
// =====================================================

app.use('/api', mangaNovelRoutes);

// =====================================================
// Anime Scraper
// =====================================================

app.use('/api/anime-scraper', animeScraperRouter);
app.use('/', animeScraperRouter);

// =====================================================
// Service worker compatibility
// =====================================================

const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', () => {});
`;

app.get(/_service-worker\.js$/, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(SW_JS);
});

// =====================================================
// Frontend — serve prebuilt Vite files
// No build during startup!
// =====================================================

const frontendExists = fs.existsSync(
  join(clientDist, 'index.html')
);

if (frontendExists) {
  console.log('[BLACK X] Frontend build found.');

  app.use(express.static(clientDist, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));

  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    return res.sendFile(join(clientDist, 'index.html'));
  });
} else {
  console.error(
    '[BLACK X] Frontend build missing! Run npm run build.'
  );
}

// =====================================================
// API 404
// =====================================================

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'API endpoint not found',
  });
});

// =====================================================
// Global error handler
// =====================================================

app.use((error, req, res, next) => {
  console.error('[BLACK X Server Error]', error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'server_error',
    message: 'Something went wrong',
  });
});

// =====================================================
// Start server immediately
// =====================================================

let server;

server = app.listen(PORT, HOST, () => {
  console.log('====================================');
  console.log('       BLACK X — ONLINE');
  console.log('====================================');
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Frontend: ${frontendExists ? 'READY' : 'MISSING'}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log('====================================');
});

// =====================================================
// Automatic database seed
// Run after server begins listening
// =====================================================

async function initializeDemoData() {
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM users'
    ).get();

    if (row?.c !== 0) {
      console.log('[BLACK X] Existing database detected.');
      return;
    }

    console.log('[BLACK X] Empty database — seeding...');

    await seedAll({ quick: true });

    console.log('[BLACK X] Quick seed completed.');

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await enrichLibrary();

        console.log('[BLACK X] Metadata enrichment complete.');
        break;
      } catch (error) {
        console.error(
          `[BLACK X] Enrichment attempt ${attempt} failed:`,
          error?.message
        );

        if (attempt < 5) {
          await new Promise((resolve) =>
            setTimeout(resolve, 180000)
          );
        }
      }
    }
  } catch (error) {
    console.error('[BLACK X] Database initialization failed:', error);
  }
}

if (process.env.AUTO_SEED !== 'false') {
  setImmediate(() => {
    initializeDemoData().catch(console.error);
  });
}

// =====================================================
// Graceful shutdown
// =====================================================

function shutdown(signal) {
  console.log(`[BLACK X] Received ${signal}. Shutting down...`);

  server.close(() => {
    try {
      db.close();
    } catch (error) {
      console.error('[BLACK X] Database close error:', error);
    }

    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
