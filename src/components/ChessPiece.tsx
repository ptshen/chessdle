import type { Color, PieceSymbol } from 'chess.js'

type ChessPieceProps = {
  type: PieceSymbol
  color: Color
  className?: string
}

/** Small, self-contained Staunton pieces: consistent on every platform. */
export function ChessPiece({ type, color, className }: ChessPieceProps) {
  const ink = color === 'w' ? '#344237' : '#182d24'
  const fill = color === 'w' ? '#fffcf1' : '#293f34'
  const detail = color === 'w' ? '#667364' : '#a4b29b'

  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill={fill}
      stroke={ink}
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {type === 'p' && (
        <>
          <circle cx="32" cy="18" r="8.2" />
          <path d="M26 25h12l-2 7c0 8 3 12 8 16H20c5-4 8-8 8-16z" />
          <path d="M21 46h22l3 7H18z" />
          <path d="M19 53h26v4H19z" />
          <path d="M26 29h12M23 49h18" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
      {type === 'r' && (
        <>
          <path d="M17 12h7v7h5v-7h6v7h5v-7h7v14l-6 6 1 15H22l1-15-6-6z" />
          <path d="M23 32h18M20 26h24" fill="none" stroke={detail} strokeWidth="1.5" />
          <path d="M20 46h24l3 7H17zM18 53h28v4H18z" />
          <path d="M23 49h18" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
      {type === 'n' && (
        <>
          <path d="M21 46c0-10 6-14 12-19-6 2-9 5-13 6l-6-5 5-8 7-6 1-7 7 5c15 0 20 15 17 34H21z" />
          <path d="m29 15 4 6-5 4M19 27l5 1M37 18c8 4 10 14 8 24" fill="none" stroke={detail} strokeWidth="1.8" />
          <circle cx="26.5" cy="21" r="1.65" fill={ink} stroke="none" />
          <path d="M21 45h26l3 8H18zM18 53h32v4H18z" />
          <path d="M23 49h22" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
      {type === 'b' && (
        <>
          <circle cx="32" cy="9" r="3" />
          <path d="M32 12c-4 5-13 10-12 17 0 6 6 9 12 9s12-3 12-9c1-7-8-12-12-17z" />
          <path d="m34 19-7 10" fill="none" stroke={detail} strokeWidth="2.2" />
          <path d="M27 37h10l3 10H24zM21 46h22l4 7H17zM18 53h28v4H18z" />
          <path d="M26 40h12M23 49h18" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
      {type === 'q' && (
        <>
          <path d="m16 20 6 17h20l6-17-10 9-6-15-6 15z" />
          <circle cx="15.5" cy="17" r="3.3" />
          <circle cx="32" cy="11" r="3.3" />
          <circle cx="48.5" cy="17" r="3.3" />
          <path d="M22 37h20l-3 6 5 6H20l5-6zM20 49h24l4 5H16zM18 54h28v3H18z" />
          <path d="M25 40h14M24 46h16" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
      {type === 'k' && (
        <>
          <path d="M32 7v12M27 11h10" fill="none" strokeWidth="3" />
          <path d="M32 22c-5-9-16-7-16 2 0 5 7 11 9 15h14c2-4 9-10 9-15 0-9-11-11-16-2z" />
          <path d="M32 23v13" fill="none" stroke={detail} strokeWidth="1.5" />
          <path d="M24 38h16l-2 6 6 5H20l6-5zM20 49h24l4 5H16zM18 54h28v3H18z" />
          <path d="M27 41h10M25 46h14" fill="none" stroke={detail} strokeWidth="1.5" />
        </>
      )}
    </svg>
  )
}

export default ChessPiece
