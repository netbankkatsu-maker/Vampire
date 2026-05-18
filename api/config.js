// Returns server configuration to the browser.
// Set MP_SERVER_URL in Vercel Environment Variables dashboard.
// Example: wss://dark-survivor-server.onrender.com
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ mpServerUrl: process.env.MP_SERVER_URL || null });
};
