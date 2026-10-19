import { useEffect, useId, useRef } from 'react';
import { ArrowRight, CheckCircle2, Target } from 'lucide-react';
import { formatEvaluation, type RoundResult, type RoundType } from '../lib/game';
import './RoundFeedback.css';

interface RoundFeedbackProps {
  roundIndex: number;
  roundType: RoundType;
  result: RoundResult;
  isReview: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}

export default function RoundFeedback({ roundIndex, roundType, result, isReview, onContinue, onDismiss }: RoundFeedbackProps) {
  const scoreId = useId();
  const continueButton = useRef<HTMLButtonElement>(null);
  const perfect = result.penalty === 0;
  const lastRound = roundIndex === 6;
  const score = `+${result.penalty.toFixed(2)} points`;

  // Moving focus from the submitted form announces the result without a second
  // live-region announcement or a modal that prevents inspecting the board.
  useEffect(() => { continueButton.current?.focus({ preventScroll: true }); }, []);

  return <section className={`board-feedback ${perfect ? 'board-feedback-perfect' : ''}`} aria-label={`Round ${roundIndex + 1} result`}>
    <div className="board-feedback-tint" aria-hidden="true" />
    <div className="board-feedback-card">
      <div className="board-feedback-score-row">
        {perfect ? <CheckCircle2 className="board-feedback-icon" aria-hidden="true" /> : <Target className="board-feedback-icon" aria-hidden="true" />}
        <h2 id={scoreId} className="board-feedback-score" aria-label={perfect ? `Perfect. ${score}` : undefined}>{score}</h2>
      </div>

      <div className="board-feedback-comparison">
        <div><span>You</span><strong>{result.guess}</strong></div>
        <ArrowRight size={15} aria-hidden="true" />
        <div>
          <span>{roundType === 'move' ? 'Best' : 'Answer'}</span><strong>{result.answer}</strong>
          {roundType === 'winner' && <small className="board-feedback-evaluation" title="Evaluation in pawns, from White’s perspective">{formatEvaluation(result.evaluation)}</small>}
        </div>
      </div>

      <button ref={continueButton} type="button" className="primary-button board-feedback-continue"
        aria-label={isReview ? 'Back to results' : lastRound ? 'See my results' : 'Next position'}
        aria-describedby={scoreId} onClick={onContinue}>
        {isReview ? 'Back to results' : lastRound ? 'Results' : 'Next'}<ArrowRight size={18} aria-hidden="true" />
      </button>
      <button type="button" className="text-button board-feedback-dismiss" onClick={onDismiss}>View position</button>
    </div>
  </section>;
}
