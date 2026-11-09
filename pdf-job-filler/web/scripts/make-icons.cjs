// Renders public/favicon.svg to the PNG icons the PWA manifest needs.
// Needs Playwright + Chromium (npx playwright install chromium) — only to regenerate the icons.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const pub = path.resolve(__dirname, '../public');
  const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size, pad] of [['pwa-192.png', 192, 0], ['pwa-512.png', 512, 0], ['apple-touch-icon.png', 180, 0]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:#1e3a5f"><div style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg.replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `)}</div></body>`,
    );
    await page.screenshot({ path: path.join(pub, file) });
  }
  await browser.close();
  console.log('icons written');
})();
