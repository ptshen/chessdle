// The upstream Stockfish 16 single-threaded Node CLI routes commands through
// postMessage. This adapter uses its documented single-threaded input queue.
const readline = require('node:readline')
const factory = require('./src/stockfish-nnue-16-single.js')
const commands = []
let engine

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line === 'quit') process.exit(0)
  if (engine) engine.onCustomMessage(line)
  else commands.push(line)
})

factory()().then((instance) => {
  engine = instance
  engine.addMessageListener((line) => process.stdout.write(`${line}\n`))
  engine.onCustomMessage('setoption name Use NNUE value false')
  for (const command of commands) engine.onCustomMessage(command)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
