// Builds a stand-alone copy of the web app (no monorepo) in ./lovable-export,
// ready to push to the GitHub repo of a Lovable project. See LOVABLE.md.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'lovable-export');
const skip = new Set(['node_modules', 'dist', 'dev-dist', 'pdfjs']);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'web'), out, {
  recursive: true,
  filter: (src) => !skip.has(path.basename(src)),
});
// the shared logic goes inside the app: vite.config.ts picks up src/shared automatically
fs.cpSync(path.join(root, 'shared', 'src'), path.join(out, 'src', 'shared'), {
  recursive: true,
  filter: (src) => path.basename(src) !== 'node.ts', // Node-only helper, not for the browser
});

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
pkg.name = 'pdf-job-filler';
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

const ts = JSON.parse(fs.readFileSync(path.join(out, 'tsconfig.json'), 'utf8'));
ts.compilerOptions.paths = { '@/*': ['./src/*'], '@shared': ['./src/shared/index.ts'], '@shared/*': ['./src/shared/*'] };
ts.include = ['src', 'vite.config.ts'];
fs.writeFileSync(path.join(out, 'tsconfig.json'), JSON.stringify(ts, null, 2) + '\n');

fs.writeFileSync(
  path.join(out, '.gitignore'),
  ['node_modules', 'dist', 'dev-dist', 'public/pdfjs', '.env', '*.local', ''].join('\n'),
);
fs.writeFileSync(
  path.join(out, 'README.md'),
  `# PDF Job Filler (web app)

Stand-alone copy of the web app from the PDF Job Filler repo, for Lovable or any static host.

\`\`\`
npm install
npm run dev      # http://localhost:8080
npm run build    # static files in dist/
\`\`\`

The extraction/fill logic is in \`src/shared\` (same code the Telegram bot uses).
`,
);
console.log('Lovable-ready app written to', out);
