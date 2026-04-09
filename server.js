// Local development server
// For production, Vercel uses api/index.js directly

const path = require('path');
const express = require('express');
const app = require('./api/index.js');

const PORT = process.env.PORT || 3000;

// Serve static files for local dev
app.use(express.static(path.join(__dirname, 'public')));

// Only start if not already listening (api/index.js may start it)
if (!app._localStarted) {
  app._localStarted = true;
  app.listen(PORT, async () => {
    console.log(`Local server: http://localhost:${PORT}`);

    // Optional: localtunnel for sharing
    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: PORT, subdomain: 'mindmap-aakash-rc' });
      console.log(`Public URL: ${tunnel.url}`);
      // Update the public-url endpoint
      app.get('/api/public-url', (req, res) => {
        res.json({ url: tunnel.url });
      });
    } catch (e) {
      console.log('Tunnel not available (install localtunnel for sharing)');
    }
  });
}
