import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_SCRIPT = resolve(__dirname, '..', 'generate-pdf.mjs');

export function renderPDF(htmlPath, pdfPath, format = 'a4') {
  execFileSync(process.execPath, [PDF_SCRIPT, resolve(htmlPath), resolve(pdfPath), `--format=${format}`], {
    stdio: 'inherit',
    timeout: 60000,
  });
  return resolve(pdfPath);
}
