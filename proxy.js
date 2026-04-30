const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^([^=\s#][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    });
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVEN_KEY) {
  console.error('Error: ELEVENLABS_API_KEY is not set.');
  process.exit(1);
}

const NEWS_KEY = process.env.THE_NEWS_API_KEY;
if (!NEWS_KEY) {
  console.warn('Warning: THE_NEWS_API_KEY is not set. /news endpoint will not work.');
}

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.warn('Warning: FAL_KEY is not set. /image endpoint will not work.');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /news ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/news')) {
    if (!NEWS_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'THE_NEWS_API_KEY not configured in .env' }));
      return;
    }

    const urlObj = new URL(req.url, 'http://localhost');
    const categories = urlObj.searchParams.get('categories') || 'general';
    const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '20', 10), 50);

    const newsPath = `/v1/news/top?api_token=${NEWS_KEY}&language=en&categories=${encodeURIComponent(categories)}&limit=${limit}`;

    const options = {
      hostname: 'api.thenewsapi.com',
      path: newsPath,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };

    const proxyReq = https.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      console.error('TheNewsAPI error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.end();
    return;
  }

  // ── POST /api  (Anthropic Claude) ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const bodyBuf = Buffer.from(body);
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': bodyBuf.length,
        },
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
        console.error('Anthropic error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });

      proxyReq.write(bodyBuf);
      proxyReq.end();
    });
    return;
  }

  // ── POST /tts  (ElevenLabs) ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { text, voiceId, languageCode, speed = 1.0 } = parsed;
      const payload = JSON.stringify({
        model_id: 'eleven_multilingual_v2',
        text,
        language_code: languageCode,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      });
      const payloadBuf = Buffer.from(payload);

      const options = {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVEN_KEY,
          'Content-Length': payloadBuf.length,
        },
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'audio/mpeg' });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
        console.error('ElevenLabs error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });

      proxyReq.write(payloadBuf);
      proxyReq.end();
    });
    return;
  }

  // ── POST /image  (fal.ai FLUX) ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/image') {
    if (!FAL_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'FAL_KEY not configured in .env' }));
      return;
    }

    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const falBody = {
        prompt: parsed.prompt,
        image_size: 'landscape_4_3',
        num_inference_steps: 4,
        num_images: 1,
      };
      if (parsed.seed != null) falBody.seed = parsed.seed;

      const payload    = JSON.stringify(falBody);
      const payloadBuf = Buffer.from(payload);

      const options = {
        hostname: 'fal.run',
        path: '/fal-ai/flux/schnell',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${FAL_KEY}`,
          'Content-Length': payloadBuf.length,
        },
      };

      const proxyReq = https.request(options, proxyRes => {
        if (proxyRes.statusCode !== 200) {
          let errBody = '';
          proxyRes.on('data', c => (errBody += c));
          proxyRes.on('end', () => {
            console.error(`fal.ai ${proxyRes.statusCode}:`, errBody);
            if (!res.headersSent) res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(errBody);
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
        console.error('fal.ai error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });

      proxyReq.write(payloadBuf);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3737, () => {
  console.log('Listening Trainer proxy → http://localhost:3737');
  console.log('Open index.html in your browser to start.');
});
