import { useEffect, useState } from 'react'
import { DemoBoard } from '../components/DemoBoard'
import { Nav, Ticker } from '../components/Chrome'
import { sol } from '../lib/format'
import { useConfig, useJackpot } from '../lib/game'
import { matchmaker, type Peer } from '../lib/matchmaking'
import { allowedStakes, playHref, savedStake, saveStake } from '../lib/stakes'
import { useWallet } from '../lib/wallet'

/**
 * Sized to fit one screen: the headline, demo board and panels scale with the viewport
 * height as well as the width, so a laptop or a phone sees everything without scrolling.
 */
export function Home() {
  const { config, error } = useConfig()
  const jackpot = useJackpot()
  const { wallet } = useWallet()
  const [queue, setQueue] = useState<Peer[]>([])
  const [stake, setStake] = useState(savedStake)
  const [demo, setDemo] = useState({ note: '#00 · new game', fees: '0.000000 SOL' })

  useEffect(() => matchmaker.onQueue(setQueue), [])

  const choices = allowedStakes(config)
  const waiting = queue.filter((p) => p.stake === stake.toString()).length
  const pick = (s: bigint) => {
    setStake(s)
    saveStake(s)
  }
  const gas = config?.gasDeposit ?? 1_000_000n

  return (
    <div className="flex min-h-svh flex-col lg:h-svh">
      <Nav />
      <main className="grid min-h-0 flex-1 grid-cols-1 content-start gap-[clamp(12px,2.2svh,28px)] px-4 py-[clamp(10px,2.2svh,24px)] md:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:content-center lg:gap-12">
        <section className="flex min-w-0 flex-col gap-[clamp(10px,2svh,22px)]">
          <span className="label hidden sm:block">Infinite tic-tac-toe · on-chain · v0.1</span>
          <h1 className="mega text-[clamp(26px,min(8vw,5.2svh),96px)] lg:text-[clamp(44px,min(5.4vw,9svh),96px)]">
            Three marks.<br /><mark>No draws.</mark>
          </h1>
          <p className="hidden max-w-[640px] text-[clamp(13px,1.8svh,16px)] text-ink-2 sm:block">
            Pick your stake. Each player keeps three marks; place a fourth and your oldest disappears.
            Five seconds per move. The winner takes the pot.
          </p>

          <div className="flex min-w-0 items-start gap-[clamp(12px,2svh,28px)]">
            <div className="shrink-0" style={{ width: 'clamp(124px, min(36vw, 30svh), 340px)' }}>
              <DemoBoard className="w-full" onUpdate={(note, fees) => setDemo({ note, fees })} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="panel">
                <header><span className="label">Demo · auto-play</span><span className="code blink hidden sm:inline">● rec</span></header>
                <div className="body gap-1 py-2.5">
                  <span className="label">Last move</span>
                  <b className="text-[12px] sm:text-[16px]">{demo.note}</b>
                </div>
              </div>
              <div className="panel">
                <header><span className="label">Fees burned</span><span className="code hidden xl:inline">5,000 lam / move</span></header>
                <div className="body gap-1 py-2.5">
                  <div className="num text-[16px] sm:text-[clamp(18px,3svh,28px)]">{demo.fees}</div>
                  <span className="label hidden xl:block">The whole demo game costs less than 0.0001 SOL</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-[clamp(10px,2svh,20px)]">
          <div className="panel">
            <header><span className="label">Matchmaking · FIFO</span><span className="code">{waiting} waiting · pot {sol(stake * 2n, 2)}</span></header>
            <div className="body gap-3 py-3">
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="label mb-2">Stake per player</legend>
                <div className="grid grid-cols-4 gap-2">
                  {choices.map((s) => {
                    const count = queue.filter((p) => p.stake === s.toString()).length
                    return (
                      <button key={String(s)} type="button" aria-pressed={s === stake} onClick={() => pick(s)}
                        className={`flex min-w-0 flex-col items-center border-[3px] border-ink px-1 py-1.5 font-bold ${s === stake ? 'bg-ink text-signal' : 'bg-panel hover:bg-signal'}`}>
                        <span>{sol(s, 2)}</span>
                        <span className="text-[10px] font-medium uppercase tracking-[0.08em] opacity-80">{count ? `${count} wait` : 'SOL'}</span>
                      </button>
                    )
                  })}
                </div>
              </fieldset>
              <div className="kv hidden text-[13px] sm:grid">
                <span>Pot</span><span>{sol(stake * 2n, 2)} SOL</span>
                <span>Gas deposit (refunded)</span><span>{sol(gas, 3)} SOL</span>
              </div>
            </div>
          </div>
          <a className="btn min-h-[clamp(50px,7svh,68px)] text-[16px] sm:text-[20px]" href={playHref(stake)} aria-disabled={!wallet}>
            <span>{wallet ? 'Enter queue' : 'Connect to play'}</span>
            <span className="tag">{sol(stake, 2)} SOL</span>
          </a>
          {error && <p className="chip chip-ink m-0 normal-case">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="panel">
              <header><span className="label">Jackpot</span><span className="code">{jackpot?.drained ?? 0}/{config?.jackpotEvery ?? 10}</span></header>
              <div className="body py-2"><div className="num text-[clamp(16px,2.6svh,26px)]">{sol(jackpot?.balance ?? 0n, 3)} SOL</div></div>
            </div>
            <a className="ghost h-full" href="#/leaderboard">Leaderboard ↗</a>
          </div>
        </aside>
      </main>
      <Ticker />
    </div>
  )
}
