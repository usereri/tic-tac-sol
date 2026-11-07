import { useEffect, useState } from 'react'
import { DemoBoard } from '../components/DemoBoard'
import { Nav, Ticker } from '../components/Chrome'
import { sol } from '../lib/format'
import { useConfig, useJackpot } from '../lib/game'
import { matchmaker, type Peer } from '../lib/matchmaking'
import { allowedStakes, playHref, savedStake, saveStake } from '../lib/stakes'
import { useWallet } from '../lib/wallet'

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
    <div className="flex min-h-svh flex-col">
      <Nav />
      <main className="grid flex-1 gap-8 px-4 py-6 md:px-12 lg:grid-cols-[1fr_420px] lg:gap-12">
        <section className="flex min-w-0 flex-col gap-5">
          <span className="label">Infinite tic-tac-toe · on-chain · v0.1</span>
          <h1 className="mega text-[clamp(44px,6.2vw,92px)]">
            Three marks.<br /><mark>No draws.</mark>
          </h1>
          <p className="max-w-[640px] text-[14px] text-ink-2 md:text-[16px]">
            Pick your stake. Each player keeps three marks; place a fourth and your oldest disappears.
            Five seconds per move. The winner takes the pot.
          </p>

          <div className="grid grid-cols-[minmax(0,190px)_1fr] items-start gap-4 sm:grid-cols-[minmax(0,340px)_1fr] sm:gap-7">
            <DemoBoard className="w-full" onUpdate={(note, fees) => setDemo({ note, fees })} />
            <div className="flex min-w-0 flex-col gap-3.5">
              <div className="panel">
                <header><span className="label">Demo · auto-play</span><span className="code blink">● rec</span></header>
                <div className="body">
                  <span className="label">Last move</span>
                  <b className="text-[13px] sm:text-[18px]">{demo.note}</b>
                </div>
              </div>
              <div className="panel">
                <header><span className="label">Fees burned</span><span className="code hidden sm:inline">5,000 lam / move</span></header>
                <div className="body">
                  <div className="num text-[18px] sm:text-[30px]">{demo.fees}</div>
                  <span className="label hidden sm:block">The whole demo game costs less than 0.0001 SOL</span>
                </div>
              </div>
              <p className="hidden text-[13px] sm:block">
                <span className="label mr-2">Marks</span>Striped = disappears on that player's next move.
              </p>
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-5">
          <div className="panel">
            <header><span className="label">Matchmaking</span><span className="code">FIFO</span></header>
            <div className="body">
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="label mb-2">Stake per player</legend>
                <div className="grid grid-cols-4 gap-2">
                  {choices.map((s) => {
                    const count = queue.filter((p) => p.stake === s.toString()).length
                    return (
                      <button key={String(s)} type="button" aria-pressed={s === stake} onClick={() => pick(s)}
                        className={`flex flex-col items-center border-[3px] border-ink px-1 py-2 font-bold ${s === stake ? 'bg-ink text-signal' : 'bg-panel hover:bg-signal'}`}>
                        <span>{sol(s, 2)}</span>
                        <span className="text-[10px] font-medium uppercase tracking-[0.08em] opacity-80">{count ? `${count} waiting` : 'SOL'}</span>
                      </button>
                    )
                  })}
                </div>
              </fieldset>
              <div><span className="label">Waiting at {sol(stake, 2)} SOL</span><div className="num text-[56px]">{String(waiting).padStart(2, '0')}</div></div>
              <div className="kv">
                <span>Stake</span><span>{sol(stake, 2)} SOL</span>
                <span>Pot</span><span>{sol(stake * 2n, 2)} SOL</span>
                <span>Gas deposit (refunded)</span><span>{sol(gas, 3)} SOL</span>
              </div>
            </div>
          </div>
          <a className="btn" href={playHref(stake)} aria-disabled={!wallet}>
            <span>{wallet ? 'Enter queue' : 'Connect to play'}</span>
            <span className="tag">{sol(stake, 2)} SOL</span>
          </a>
          {error && <p className="chip chip-ink normal-case">Program not reachable: {error}</p>}
          <div className="panel">
            <header><span className="label">Jackpot</span><span className="code">{jackpot?.drained ?? 0} / {config?.jackpotEvery ?? 10} drained</span></header>
            <div className="body"><div className="num text-[34px]">{sol(jackpot?.balance ?? 0n, 3)} SOL</div></div>
          </div>
          <a className="ghost" href="#/leaderboard">Leaderboard ↗</a>
        </aside>
      </main>
      <Ticker />
    </div>
  )
}
