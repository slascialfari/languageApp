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
  console.error('Error: ANTHROPIC_API_KEY is not set. Add it to .env or your environment.');
  process.exit(1);
}

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVEN_KEY) {
  console.error('Error: ELEVENLABS_API_KEY is not set. Add it to .env or your environment.');
  process.exit(1);
}

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('Error: FAL_KEY is not set. Add it to .env or your environment.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

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
        console.error('Upstream error:', err.message);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });

      proxyReq.write(bodyBuf);
      proxyReq.end();
    });
    return;
  }

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

  if (req.method === 'POST' && req.url === '/image') {
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
      const payload = JSON.stringify(falBody);
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
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
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
  console.log('Listening Trainer proxy running → http://localhost:3737');
  console.log('Open index.html in your browser to start.');
});
