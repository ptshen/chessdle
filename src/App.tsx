import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, BarChart3, Check, CircleHelp, Copy, LoaderCircle, RotateCcw, Trophy } from 'lucide-react';
import { Chess } from 'chess.js';
import ChessBoard from './components/ChessBoard';
import AnalysisBoard from './components/AnalysisBoard';
import RoundFeedback from './components/RoundFeedback';
import { ChessPiece } from './components/ChessPiece';
import Modal from './components/Modal';
import { DailyRanking, useDailyRanking } from './components/DailyRanking';
import { evaluatePosition } from './lib/engine';
import { winnerPenalty, numericPenalty, movePenalty, matePenalty } from './lib/scoring';
import { ROUND_PLAN, puzzles, loadGame, createGame, saveGame, storageKey, totalScore, formatEvaluation, completedGames, localDate, millisecondsUntilLocalMidnight, type Mode, type GameState, type RoundResult } from './lib/game';

export default function App() {
  const [game, setGame] = useState<GameState>(() => loadGame('daily'));
  const dailyRanking = useDailyRanking(game);
  const [choice, setChoice] = useState<'w' | 'b' | null>(null);
  const [number, setNumber] = useState('');
  const [move, setMove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'help' | 'stats' | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyText, setCopyText] = useState('');
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const [finalFeedback, setFinalFeedback] = useState(false);
  const submitLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const analysisArea = useRef<HTMLDivElement>(null);
  const roundIndex = reviewIndex ?? game.index;
  const round = ROUND_PLAN[roundIndex];
  const puzzle = puzzles.find(p => p.id === game.puzzleIds[roundIndex])!;
  const result = game.results[roundIndex];
  const submitted = Boolean(result);
  const isReview = reviewIndex !== null;
  const showOverlay = submitted && !isReview && !feedbackDismissed;
  const side = puzzle.fen.split(' ')[1] === 'w' ? 'w' : 'b';
  const score = totalScore(game.results);
  const selectedMove = isReview ? result?.move : move ?? result?.move;
  let boardFen = puzzle.fen;
  let moveSan = '';
  if (selectedMove) { try { const chess = new Chess(puzzle.fen); const m = chess.move({ from: selectedMove.slice(0, 2), to: selectedMove.slice(2, 4), promotion: selectedMove[4] }); boardFen = chess.fen(); moveSan = m.san; } catch { /* A persisted invalid move leaves the original board visible. */ } }
  const validNumber = number.trim() !== '' && Number.isFinite(Number(number)) && (round.type === 'mate' ? Number.isInteger(Number(number)) && Number(number) >= 1 && Number(number) <= 20 : Math.abs(Number(number)) <= 20);
  const canSubmit = round.type === 'winner' ? choice !== null : round.type === 'move' ? move !== null : validNumber;

  useEffect(() => {
    const persisted = saveGame(game);
    setStorageAvailable(persisted.saved);
    if (persisted.game !== game) {
      setGame(persisted.game);
      setReviewIndex(null);
      setFinalFeedback(false);
      setMove(null);
    }
  }, [game]);
  useEffect(() => { setChoice(null); setNumber(''); setMove(null); setError(''); setCopied(false); setFeedbackDismissed(false); }, [game.id, game.index, reviewIndex]);

  useEffect(() => {
    if (game.mode !== 'daily' || busy) return;
    function refreshDaily() {
      if (document.visibilityState === 'hidden') return;
      const restored = loadGame('daily');
      if (restored.id === game.id && (restored.results.length < game.results.length || restored.index < game.index)) return;
      if (JSON.stringify(restored) === JSON.stringify(game)) return;
      setGame(restored);
      setReviewIndex(null);
      setFinalFeedback(false);
      setMove(null);
      setCopyText('');
    }
    function syncStorage(event: StorageEvent) {
      if (event.key === storageKey('daily') || event.key === null) refreshDaily();
    }
    // Mobile tabs may sleep through midnight; focus/visibility catches them up.
    if (game.date !== localDate()) refreshDaily();
    let timer: number;
    function scheduleRefresh() {
      // Recheck the device clock periodically in case its timezone or time changes.
      // Calendar midnight also handles the shorter/longer daylight-saving days.
      timer = window.setTimeout(() => {
        refreshDaily();
        scheduleRefresh();
      }, Math.min(60_000, millisecondsUntilLocalMidnight() + 50));
    }
    scheduleRefresh();
    window.addEventListener('storage', syncStorage);
    window.addEventListener('focus', refreshDaily);
    window.addEventListener('pageshow', refreshDaily);
    document.addEventListener('visibilitychange', refreshDaily);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener('focus', refreshDaily);
      window.removeEventListener('pageshow', refreshDaily);
      document.removeEventListener('visibilitychange', refreshDaily);
    };
  }, [game, busy]);

  function changeMode(mode: Mode, fresh = false) {
    if (busy) return;
    setMove(null);
    setFinalFeedback(false);
    setFeedbackDismissed(false);
    setGame(fresh ? createGame(mode) : loadGame(mode)); setReviewIndex(null); setCopyText('');
  }
  async function submit() {
    if (!canSubmit || submitted || submitLock.current) return;
    submitLock.current = true; setBusy(true); setError('');
    try {
      let next: RoundResult;
      const evaluation = puzzle.evaluation;
      if (round.type === 'winner') {
        next = { puzzleId: puzzle.id, guess: choice === 'w' ? 'White' : 'Black', answer: (evaluation.cp ?? 0) > 0 ? 'White' : 'Black', penalty: winnerPenalty(choice!, evaluation.cp!), evaluation };
      } else if (round.type === 'evaluation') {
        next = { puzzleId: puzzle.id, guess: `${Number(number) > 0 ? '+' : ''}${Number(number).toFixed(2)}`, answer: formatEvaluation(evaluation), penalty: numericPenalty(Number(number), evaluation.cp!), evaluation };
      } else if (round.type === 'mate') {
        next = { puzzleId: puzzle.id, guess: `Mate in ${number}`, answer: `Mate in ${Math.abs(evaluation.mate!)}`, penalty: matePenalty(Number(number), Math.abs(evaluation.mate!)), evaluation };
      } else {
        const baseline = await evaluatePosition(puzzle.fen, { depth: evaluation.depth });
        const played = move === baseline.bestMove ? baseline : await evaluatePosition(puzzle.fen, { depth: evaluation.depth, searchMoves: [move!] });
        const bestBoard = new Chess(puzzle.fen);
        const best = bestBoard.move({ from: baseline.bestMove.slice(0, 2), to: baseline.bestMove.slice(2, 4), promotion: baseline.bestMove[4] });
        next = { puzzleId: puzzle.id, guess: moveSan, answer: best.san, penalty: movePenalty(baseline, played, side, move!), evaluation: baseline, move: move! };
      }
      if (game.index === ROUND_PLAN.length - 1) setFinalFeedback(true);
      setGame(current => {
        if (current.id !== game.id || current.index !== game.index || current.results[current.index]) return current;
        const results = [...current.results, next];
        return { ...current, results, finished: results.length === ROUND_PLAN.length };
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Analysis could not finish. Please try again.'); }
    finally { submitLock.current = false; setBusy(false); }
  }
  function nextRound() {
    setMove(null);
    setFinalFeedback(false);
    setGame(current => {
      if (!current.results[current.index] || current.finished) return current;
      return current.index === 6 ? { ...current, finished: true } : { ...current, index: current.index + 1 };
    });
    requestAnimationFrame(() => heading.current?.focus());
  }
  async function share() {
    const squares = game.results.map(r => r.penalty < 0.25 ? '🟩' : r.penalty < 4 ? '🟨' : '⬜').join('');
    const text = `Chessdle ${game.mode === 'daily' ? game.date : 'Practice'}\n${squares}\n${score.toFixed(2)} points · 7/7\nLower is better.`;
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopyText(text); }
  }
  const showGame = !game.finished || isReview || finalFeedback;
  const displayedBoard = new Chess(boardFen);
  const displayedSide = selectedMove ? side : displayedBoard.turn();

  function toggleSign() {
    setNumber(current => current.startsWith('-') ? current.slice(1) : `-${current.replace(/^\+/, '') || '0.0'}`);
  }

  function dismissFeedback() {
    setFeedbackDismissed(true);
    requestAnimationFrame(() => analysisArea.current?.querySelector<HTMLElement>('[aria-label="Position analysis"]')?.focus({ preventScroll: true }));
  }

  return <>
    <header className="site-header">
      <a className="brand" href="./" aria-label="Chessdle home">
        <span className="brand-mark"><ChessPiece type="p" color="w" /></span>chessdle<span className="brand-dot">.</span>
      </a>
      <div className="header-actions">
        <button className="icon-button" aria-label="Your statistics" onClick={() => setModal('stats')}><BarChart3 size={21} /></button>
        <button className="icon-button" aria-label="How to play" onClick={() => setModal('help')}><CircleHelp size={21} /></button>
      </div>
    </header>
    <main className="main-shell">
      <div className="game-toolbar">
        <nav className="mode-nav" aria-label="Game mode">
          <button aria-label="Daily challenge" aria-pressed={game.mode === 'daily'} onClick={() => changeMode('daily')} disabled={busy}>Daily</button>
          <button aria-pressed={game.mode === 'practice'} onClick={() => changeMode('practice')} disabled={busy}>Practice</button>
        </nav>
        {showGame && <button className="score-button" aria-label={`Score: ${score.toFixed(2)} points. Lower is better. Scoring rules.`} onClick={() => setModal('help')}>
          <strong>{score.toFixed(2)}</strong><span>pts</span>
        </button>}
      </div>
      <ol className="round-tracker" aria-label="Round progress">
        {ROUND_PLAN.map((_, index) => <li key={index} className={`${game.results[index] ? 'completed' : ''} ${index === roundIndex && showGame ? 'current' : ''}`} aria-current={index === roundIndex && showGame ? 'step' : undefined} aria-label={`Round ${index + 1}${game.results[index] ? ', completed' : ''}`} />)}
      </ol>

      {showGame ? <section className="game" aria-labelledby="round-title">
        <div className="round-heading"><h1 id="round-title" ref={heading} tabIndex={-1}>{round.title}</h1><span>{roundIndex + 1} / 7</span></div>
        {submitted && !showOverlay ? <div ref={analysisArea}>
          <AnalysisBoard key={`${game.id}-${roundIndex}`} initialFen={puzzle.fen} initialEvaluation={result.evaluation} playedMove={result.move} />
        </div> : <><div className="board-meta">
          <span className="side-to-move"><span className={`side-dot ${displayedSide}`} />{displayedSide === 'w' ? 'White' : 'Black'}{selectedMove ? ` played ${moveSan}` : ' to move'}{displayedBoard.isCheck() && <span className="check-tag">Check</span>}</span>
          <span>{round.type === 'mate' ? `${puzzle.evaluation.mate! > 0 ? 'White' : 'Black'} to mate` : round.difficulty}</span>
        </div>
        <div className="board-stage">
          <div inert={showOverlay} aria-hidden={showOverlay || undefined}>
            <ChessBoard fen={boardFen} flipped={round.type === 'move' ? side === 'b' : undefined} interactive={round.type === 'move' && !submitted && !busy && !move} selectedMove={selectedMove} onMove={setMove} />
          </div>
          {showOverlay && <RoundFeedback key={`${game.id}-${roundIndex}`} roundIndex={roundIndex} roundType={round.type} result={result} isReview={isReview} onContinue={nextRound} onDismiss={dismissFeedback} />}
        </div></>}

        <div className="answer-controls">
          {!submitted ? <form onSubmit={event => { event.preventDefault(); void submit(); }}>
            {round.type === 'winner' && <div className="winner-options">
              {(['w', 'b'] as const).map(color => <button type="button" key={color} className={`winner-option ${choice === color ? 'selected' : ''}`} aria-label={`${color === 'w' ? 'White' : 'Black'} is winning`} aria-pressed={choice === color} onClick={() => setChoice(color)}>
                <ChessPiece type="k" color={color} /><span>{color === 'w' ? 'White' : 'Black'}</span>{choice === color && <Check size={17} />}
              </button>)}
            </div>}
            {round.type === 'evaluation' && <>
              <div className="evaluation-input">
                <button className="sign-button" type="button" aria-label="Toggle evaluation sign" title="Change + / −" onClick={toggleSign}><span aria-hidden="true">±</span></button>
                <input aria-label="Evaluation" aria-describedby="evaluation-hint" type="number" min="-20" max="20" step="0.01" placeholder="0.0" value={number} onChange={e => setNumber(e.target.value)} inputMode="decimal" required autoComplete="off" />
              </div>
              <p id="evaluation-hint" className="input-hint">+ White <span>·</span> − Black</p>
            </>}
            {round.type === 'move' && <div className="move-choice">
              {move ? <><strong>{moveSan}</strong><button type="button" className="text-button" aria-label="Choose another move" disabled={busy} onClick={() => setMove(null)}><RotateCcw size={16} />Undo</button></> : <p>Drag a piece, or tap to move.</p>}
            </div>}
            {round.type === 'mate' && <div className="mate-input">
              <label htmlFor="mate-count">Mate in</label><input id="mate-count" aria-label="Mate in how many moves" type="number" min="1" max="20" step="1" placeholder="?" inputMode="numeric" value={number} onChange={e => setNumber(e.target.value)} required /><span>moves</span>
            </div>}
            {error && <p role="alert" className="error-message">{error}</p>}
            <button className="primary-button" type="submit" aria-label={busy ? 'Analyzing move' : `Submit ${round.type === 'move' ? 'move' : 'answer'}`} disabled={!canSubmit || busy}>
              {busy ? <><LoaderCircle className="spin" size={18} />Analyzing…</> : <>Submit<ArrowRight size={18} /></>}
            </button>
          </form> : <div className="round-feedback">
            {!showOverlay && <><div className="answer-comparison">
              <div><span>You</span><strong>{result.guess}</strong></div>
              <ArrowRight size={16} aria-hidden="true" />
              <div>
                <span>{round.type === 'move' ? 'Best' : 'Answer'}</span><strong>{result.answer}</strong>
                {round.type === 'winner' && <small className="answer-evaluation" title="Evaluation in pawns, from White’s perspective">{formatEvaluation(result.evaluation)}</small>}
              </div>
              <span className={`round-penalty ${result.penalty === 0 ? 'perfect' : ''}`}>+{result.penalty.toFixed(2)} points</span>
            </div>
            <button className="primary-button" aria-label={isReview ? 'Back to results' : game.index === 6 ? 'See my results' : 'Next position'} onClick={isReview ? () => setReviewIndex(null) : nextRound}>
              {isReview ? 'Back to results' : game.index === 6 ? 'Results' : 'Next'}<ArrowRight size={18} />
            </button></>}
            {!showOverlay && <a className="text-button" href={puzzle.phase === 'before' && puzzle.gameUrl ? puzzle.gameUrl : puzzle.sourceUrl} target="_blank" rel="noreferrer">View on Lichess<ArrowUpRight size={15} /></a>}
          </div>}
        </div>
      </section> : <section className="results" aria-labelledby="results-title">
        <Trophy className="results-icon" size={30} /><h1 id="results-title" ref={heading} tabIndex={-1}>Complete</h1>
        <div className="final-score">{score.toFixed(2)}<span>points · lower is better</span></div>
        <DailyRanking {...dailyRanking} />
        <div className="results-list">{game.results.map((item, index) => <button key={index} className="result-row" aria-label={`Review round ${index + 1}`} onClick={() => setReviewIndex(index)}>
          <span className={`result-number ${item.penalty === 0 ? 'perfect' : ''}`}>{index + 1}</span><span>{ROUND_PLAN[index].label}</span><strong>+{item.penalty.toFixed(2)}</strong><ArrowUpRight size={16} />
        </button>)}</div>
        <div className="results-actions">
          <button className="primary-button" aria-label={copied ? 'Copied to clipboard' : 'Share my results'} onClick={() => void share()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Share results'}</button>
          <button className="secondary-button" aria-label="Keep practicing" onClick={() => changeMode('practice', true)}>Practice again<ArrowRight size={17} /></button>
        </div>
        {copyText && <label className="share-fallback">Copy your results<textarea readOnly value={copyText} onFocus={e => e.target.select()} /></label>}
        {game.mode === 'daily' && <p className="input-hint">Next daily at midnight, your time.</p>}
      </section>}
      {!storageAvailable && <p className="storage-notice" role="status">Progress isn’t saving. Keep this tab open.</p>}
    </main>
    {modal && <Modal title={modal === 'help' ? 'How to play' : 'Statistics'} onClose={() => setModal(null)}>
      {modal === 'help' ? <div className="help-content">
        <p>Seven rounds. Lower scores are better.</p>
        <dl className="rules">
          <div><dt>1–2 · Winning side</dt><dd>Correct: 0. Wrong: the absolute evaluation in pawns. A −2.3 position adds 2.3 points.</dd></div>
          <div><dt>3–4 · Evaluation</dt><dd>Guess in pawns. + favors White, − favors Black, regardless of board orientation. Points = |guess − engine score|.</dd></div>
          <div><dt>5–6 · Best move</dt><dd>Points = evaluation lost. Best move: 0. Scores are capped at ±20 pawns; forced mates use ±20.</dd></div>
          <div><dt>7 · Mate in N</dt><dd>Count the mating side’s moves against best defense. Points = |guess − actual moves|.</dd></div>
        </dl>
        <p className="help-note">The side to move starts at the bottom. Move rounds keep that perspective. Daily resets at midnight, your time. Progress saves on this device.</p>
        <div className="credits"><a href="https://database.lichess.org/#puzzles" target="_blank" rel="noreferrer">Lichess positions<ArrowUpRight size={13} /></a><span>Stockfish 16</span></div>
        <button className="primary-button" onClick={() => setModal(null)}>Got it</button>
      </div> : <Statistics />}
    </Modal>}
  </>;
}

function Statistics() {
  const history = completedGames();
  const daily = history.filter(game => game.mode === 'daily');
  return <div className="stats-content">
    <p className="input-hint">Current scoring · this device</p>
    <div className="stats-grid"><div><strong>{history.length}</strong><span>Games</span></div><div><strong>{history.length ? Math.min(...history.map(game => game.score)).toFixed(2) : '—'}</strong><span>Best</span></div><div><strong>{daily.length}</strong><span>Dailies</span></div></div>
    {history.length ? <div className="history-list">{[...history].reverse().slice(0, 7).map(game => <div key={game.id}><span>{game.mode === 'daily' ? game.date : 'Practice'}</span><strong>{game.score.toFixed(2)}<small>pts</small></strong></div>)}</div> : <p className="empty-stats">No completed games yet.</p>}
  </div>;
}
