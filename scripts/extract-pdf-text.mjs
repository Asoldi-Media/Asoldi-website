#!/usr/bin/env node
import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: extract-pdf-text.mjs <pdf-path>');
  process.exit(2);
}

const buffer = fs.readFileSync(filePath);
const parser = new PDFParse({ data: buffer });
try {
  const parsed = await parser.getText();
  process.stdout.write(String(parsed?.text || ''));
} finally {
  await parser.destroy().catch(() => {});
}
