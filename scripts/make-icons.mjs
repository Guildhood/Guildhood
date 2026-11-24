#!/usr/bin/env node
// Renders apps/client/assets-src/icon.svg to the PNG sizes iPadOS and the web manifest need.
// Usage: node scripts/make-icons.mjs   (uses the Playwright Chromium installed for tests)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'apps/client/assets-src/icon.svg'), 'utf8');
const out = path.join(root, 'apps/client/public/icons');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', name);
}
await browser.close();
