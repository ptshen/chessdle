import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
let packageRoot
try {
  packageRoot = dirname(require.resolve('stockfish/package.json'))
} catch {
  packageRoot = join(root, 'vendor/stockfish')
}
const destination = join(root, 'public/engine')
let engineDirectory
let engineFile

for (const directory of ['bin', 'src']) {
  const path = join(packageRoot, directory)
  const files = await readdir(path).catch(() => [])
  const match = files.find((file) => /^stockfish-.*-lite-single(?:-[a-f0-9]+)?\.js$/.test(file))
    ?? files.find((file) => file === 'stockfish-nnue-16-single.js')
  if (match) {
    engineDirectory = path
    engineFile = match
    break
  }
}

if (!engineDirectory || !engineFile) {
  throw new Error('Could not find the single-threaded lite Stockfish engine in node_modules/stockfish.')
}

const wasmFile = engineFile.replace(/\.js$/, '.wasm')
await mkdir(destination, { recursive: true })
// Preserve the WASM basename referenced inside the generated Emscripten code.
await copyFile(join(engineDirectory, engineFile), join(destination, 'stockfish.js'))
await copyFile(join(engineDirectory, wasmFile), join(destination, wasmFile))
await copyFile(join(packageRoot, 'Copying.txt'), join(destination, 'COPYING.txt'))
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
await writeFile(join(destination, 'SOURCE.txt'), [
  `Stockfish.js ${metadata.version} — single-threaded build`,
  'License: GNU General Public License version 3 (see COPYING.txt).',
  `Corresponding source and build instructions: ${metadata.source ?? 'https://github.com/nmrugg/stockfish.js'}`,
  metadata.source ? 'This bundled Stockfish 16 build uses classical evaluation (Use NNUE=false).' : `Published package and source: https://www.npmjs.com/package/stockfish/v/${metadata.version}`,
  '',
].join('\n'))
console.log(`Prepared Stockfish ${metadata.version} browser engine (${wasmFile}).`)
