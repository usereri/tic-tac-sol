import { COORDS } from '../lib/format'

export function Mark({ player }: { player: number }) {
  if (player === 1) {
    return (
      <svg className="mark-x" viewBox="0 0 100 100" aria-hidden>
        <path d="M14 14 L86 86 M86 14 L14 86" stroke="currentColor" strokeWidth="16" strokeLinecap="square" fill="none" />
      </svg>
    )
  }
  return (
    <svg className="mark-o" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="35" stroke="currentColor" strokeWidth="16" fill="none" />
    </svg>
  )
}

function lineEnds(line: number[]) {
  const center = (c: number) => [(c % 3) * 100 + 50, Math.floor(c / 3) * 100 + 50]
  const [x1, y1] = center(line[0])
  const [x2, y2] = center(line[2])
  const len = Math.hypot(x2 - x1, y2 - y1)
  const [dx, dy] = [((x2 - x1) / len) * 38, ((y2 - y1) / len) * 38]
  return { x1: x1 - dx, y1: y1 - dy, x2: x2 + dx, y2: y2 + dy }
}

type BoardProps = {
  board: ArrayLike<number>
  /** Cell whose mark disappears on that player's next move. */
  fading?: number | null
  leaving?: number | null
  win?: number[] | null
  banner?: string
  /** Optimistic mark while the move confirms. */
  pending?: { cell: number; player: number } | null
  coords?: boolean
  canPlay?: (cell: number) => boolean
  onPlay?: (cell: number) => void
  className?: string
}

export function Board({ board, fading, leaving, win, banner, pending, coords = true, canPlay, onPlay, className = '' }: BoardProps) {
  return (
    <div className={`board ${className}`} role="grid" aria-label="Board">
      {COORDS.map((coord, i) => {
        const player = pending?.cell === i ? pending.player : board[i]
        const playable = !!onPlay && !!canPlay?.(i)
        const classes = [
          'cell',
          playable && 'playable',
          fading === i && 'fading',
          leaving === i && 'leaving',
          win?.includes(i) && 'win',
          pending?.cell === i && 'pending',
        ].filter(Boolean).join(' ')
        const label = `${coord}: ${player === 1 ? 'X' : player === 2 ? 'O' : 'empty'}${fading === i ? ', fades next' : ''}`
        return (
          <button key={coord} type="button" className={classes} aria-label={label} disabled={!playable} onClick={() => onPlay?.(i)}>
            {coords && <span className="coord">{coord}</span>}
            {player ? <Mark player={player} /> : null}
            {fading === i && coords && <span className="fade-tag">fades next</span>}
          </button>
        )
      })}
      {win && (
        <svg className="winline" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden>
          <line {...lineEnds(win)} />
        </svg>
      )}
      {win && banner && <div className="banner">{banner}</div>}
    </div>
  )
}
