import { useState, type ReactNode } from 'react'
import { short } from '../lib/format'
import { useWallet, useWalletChoices } from '../lib/wallet'
import { CLUSTER } from '../lib/solana'

const TICKER = [
  'Fee per move 5,000 lamports',
  'Turns speed up every 30 s',
  '1 signature per player',
  'Escrow pays every fee',
  'Oldest mark fades',
  'No draws',
  '100% on-chain',
]

export function Ticker() {
  const items = [...TICKER, ...TICKER]
  return (
    <div className="ticker" aria-label="Protocol facts">
      <div>{items.map((t, i) => <span key={i}>{t}</span>)}</div>
    </div>
  )
}

/** A clearly visible error. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <b aria-hidden>!</b>
      <span>{children}</span>
    </div>
  )
}

export function Nav({ meta }: { meta?: ReactNode }) {
  return (
    <nav className="flex items-stretch justify-between border-b-[3px] border-ink bg-panel">
      <a href="#/" className="flex min-h-[60px] items-center border-r-[3px] border-ink px-4 font-display text-[20px] font-black uppercase tracking-tight no-underline [font-stretch:125%] text-ink">
        TIC/TAC<i className="ml-1 bg-ink px-1.5 not-italic text-signal">SOL</i>
      </a>
      <div className="hidden items-center gap-5 px-4 text-xs uppercase tracking-[0.08em] text-ink-2 md:flex">
        {meta ?? <><span>{CLUSTER}</span><a href="#/leaderboard" className="text-ink-2 hover:text-ink">Leaderboard</a></>}
      </div>
      <WalletButton />
    </nav>
  )
}

function WalletButton() {
  const { wallet, devAvailable, connectDev, disconnect } = useWallet()
  const { wallets, connect, isRunning } = useWalletChoices()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (wallet) {
    return (
      <button type="button" onClick={disconnect} title="Disconnect" className="flex items-center gap-2.5 border-l-[3px] border-ink px-4 font-medium hover:bg-ink hover:text-signal">
        <span className="size-2.5 border-2 border-ink bg-signal" />
        {short(wallet.address)}
        {wallet.kind === 'dev' && <span className="chip chip-line hidden sm:inline-block">dev</span>}
      </button>
    )
  }

  return (
    <div className="relative flex border-l-[3px] border-ink">
      <button type="button" onClick={() => setOpen((o) => !o)} className="px-4 font-bold uppercase tracking-[0.08em] hover:bg-ink hover:text-signal" aria-expanded={open}>
        {isRunning || busy ? 'Connecting…' : 'Connect'}
      </button>
      {open && (
        <div className="panel absolute right-0 top-full z-20 mt-2 w-64">
          <header><span className="label">Choose wallet</span></header>
          <div className="body gap-2">
            {wallets.map((w) => (
              <button key={w.name} type="button" className="ghost justify-start px-3" onClick={() => { connect(w); setOpen(false) }}>
                {w.icon && <img src={w.icon} alt="" className="size-5" />}
                {w.name}
              </button>
            ))}
            {wallets.length === 0 && <span className="text-xs text-ink-2">No Solana wallet found. Install Phantom.</span>}
            {devAvailable && (
              <button type="button" className="ghost justify-start px-3" onClick={async () => { setBusy(true); setOpen(false); try { await connectDev() } finally { setBusy(false) } }}>
                Dev wallet (localnet)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
