import { useEffect, useRef, useState } from 'react'
import { Board } from './Board'
import { COORDS, sol } from '../lib/format'

// Real rules: 3 marks each, the oldest disappears. The final win only works because O's
// mark at B2 rotated out. X0 O3 X1 O4 X8 O7 X2 O5 X6 O3 X4 -> X wins A3·B2·C1.
const SCRIPT = [0, 3, 1, 4, 8, 7, 2, 5, 6, 3, 4]
const WIN = [2, 4, 6]
const FEE = 5_000n
const STEP_MS = 950
const OPENING = 5

type DemoState = {
  board: number[]
  queues: Record<number, number[]>
  step: number
  leaving: number | null
  note: string
}

function advance(s: DemoState): DemoState {
  const cell = SCRIPT[s.step]
  const player = s.step % 2 === 0 ? 1 : 2
  const board = [...s.board]
  const queue = [...s.queues[player]]
  let leaving: number | null = null
  let note = ''
  if (queue.length === 3) {
    leaving = queue.shift()!
    board[leaving] = 0
    note = ` · ${COORDS[leaving]} fades`
  }
  board[cell] = player
  queue.push(cell)
  const step = s.step + 1
  return {
    board,
    queues: { ...s.queues, [player]: queue },
    step,
    leaving,
    note: `#${String(step).padStart(2, '0')} · ${player === 1 ? 'X' : 'O'} → ${COORDS[cell]}${note}`,
  }
}

const EMPTY: DemoState = { board: Array(9).fill(0), queues: { 1: [], 2: [] }, step: 0, leaving: null, note: '#00 · new game' }

function opening(): DemoState {
  let s = EMPTY
  for (let i = 0; i < OPENING; i++) s = advance(s)
  return s
}

/** Self-playing infinite tic-tac-toe for the home page. */
export function DemoBoard({ className = '', onUpdate }: { className?: string; onUpdate?: (note: string, fees: string) => void }) {
  const [state, setState] = useState(opening)
  const [ghost, setGhost] = useState<number | null>(null)
  const won = state.step === SCRIPT.length
  const update = useRef(onUpdate)
  update.current = onUpdate

  useEffect(() => {
    const t = setTimeout(
      () => setState((s) => (s.step === SCRIPT.length ? EMPTY : advance(s))),
      won ? 4200 : STEP_MS,
    )
    return () => clearTimeout(t)
  }, [state, won])

  // Keep the vanishing mark on screen for its exit animation.
  useEffect(() => {
    if (state.leaving === null) return
    setGhost(state.leaving)
    const t = setTimeout(() => setGhost(null), 340)
    return () => clearTimeout(t)
  }, [state])

  useEffect(() => {
    update.current?.(won ? `#${state.step} · X wins A3·B2·C1` : state.note || '#00 · new game', `${sol(BigInt(state.step) * FEE)} SOL`)
  }, [state, won])

  const nextPlayer = state.step % 2 === 0 ? 1 : 2
  const nextQueue = state.queues[nextPlayer]
  const fading = !won && nextQueue.length === 3 ? nextQueue[0] : null
  const board = ghost !== null ? state.board.map((v, i) => (i === ghost ? (state.step % 2 === 1 ? 1 : 2) : v)) : state.board

  return (
    <Board
      className={className}
      board={board}
      fading={fading}
      leaving={ghost}
      win={won ? WIN : null}
      banner="X takes the pot"
      coords
    />
  )
}
