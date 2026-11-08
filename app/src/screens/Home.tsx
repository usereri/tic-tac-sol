import { useEffect, useState } from 'react'
import { DemoBoard } from '../components/DemoBoard'
import { Alert, Nav, Ticker } from '../components/Chrome'
import { short, sol } from '../lib/format'
import { activeGameOf, useConfig, useJackpot } from '../lib/game'
import { lineOf, matchmaker, type Peer } from '../lib/matchmaking'
import { allowedStakes, MODE_LABEL, playHref, savedMode, saveMode, savedStake, saveStake, type Mode } from '../lib/stakes'
import type { Address } from '@solana/kit'
import { useWallet } from '../lib/wallet'

const RULES = [
  ['3 marks each', 'Place a 4th and your oldest one disappears.'],
  ['Timed', '12 s per move, faster every 10 s, down to 5 s.'],
  ['Relaxed', 'No turn clock. 3 min for the whole game.'],
  ['Winner takes all', 'The pot minus fees; 2% of it feeds the jackpot.'],
] as const

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
  const [mode, setMode] = useState<Mode>(savedMode)
  const [unfinished, setUnfinished] = useState<Address | null>(null)
  const [demo, setDemo] = useState({ note: '#00 · new game', fees: '0.000000 SOL' })

  useEffect(() => matchmaker.onQueue(setQueue), [])

  // A game this wallet left (closed tab, both players gone) keeps its stakes until someone opens
  // it, which settles it. Point the player back to it.
  useEffect(() => {
    setUnfinished(null)
    if (wallet) activeGameOf(wallet.address).then(setUnfinished, () => {})
  }, [wallet])

  const choices = allowedStakes(config)
  const lineFor = (s: bigint) => queue.filter((p) => lineOf(p) === lineOf({ stake: s.toString(), mode })).length
  const waiting = lineFor(stake)
  const queuedElsewhere = wallet ? queue.find((p) => p.wallet === wallet.address) : undefined
  const pick = (s: bigint) => {
    setStake(s)
    saveStake(s)
  }
  const pickMode = (m: Mode) => {
    setMode(m)
    saveMode(m)
  }
  const drawAt = config?.drawThreshold ?? 500_000_000n
  const drawGames = config?.drawGames ?? 10
  const gas = config?.gasDeposit ?? 1_000_000n

  return (
    <div className="flex min-h-svh flex-col lg:h-svh">
      <Nav />
      {/*
        On desktop a 2×2 grid: the rule tiles end where the matchmaking panel ends, and the demo
        panels end where the jackpot row ends. On phones one column: intro, demo, matchmaking, play.
      */}
      <main className="grid min-h-0 flex-1 grid-cols-1 content-start gap-[clamp(12px,2.2svh,28px)] px-4 py-[clamp(10px,2.2svh,24px)] md:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:content-center lg:gap-x-12 lg:gap-y-[clamp(14px,2.4svh,28px)]">
        <section className="order-1 flex min-w-0 flex-col justify-end gap-[clamp(10px,2svh,22px)] lg:order-none">
          <span className="label hidden sm:block">Infinite tic-tac-toe · on-chain · v0.1</span>
          <h1 className="mega text-[clamp(26px,min(8vw,5.2svh),96px)] lg:text-[clamp(44px,min(5.4vw,9svh),96px)]">
            Three marks.<br /><mark>No draws.</mark>
          </h1>
          <ul className="m-0 hidden max-w-[760px] list-none grid-cols-2 gap-3 p-0 sm:grid xl:grid-cols-4">
            {RULES.map(([title, text]) => (
              <li key={title} className="flex flex-col gap-1 border-[3px] border-ink bg-panel px-3 py-[clamp(6px,1.2svh,12px)] shadow-hard-sm [container-type:inline-size]">
                {/* One line in every tile, so the descriptions start at the same height. */}
                <b className="whitespace-nowrap font-display text-[min(16px,8cqi)] font-black uppercase [font-stretch:125%]">{title}</b>
                <span className="text-[12px] leading-snug text-ink-2">{text}</span>
              </li>
            ))}
          </ul>
        </section>

        {/*
          The two demo panels stretch to the board's height, so their bottoms and shadows line up.
          On desktop the board instead takes the row's height, which the right column sets (an
          alert there makes it taller), so the board grows with it rather than leaving a gap.
        */}
        <section className="order-2 flex min-w-0 lg:order-none lg:row-start-2">
          <div className="flex min-w-0 flex-1 items-stretch gap-[clamp(12px,2svh,28px)]">
            <div className="w-[clamp(124px,min(36vw,30svh),340px)] shrink-0 lg:aspect-square lg:h-full lg:w-auto lg:max-w-[50%]">
              <DemoBoard className="w-full lg:h-full" onUpdate={(note, fees) => setDemo({ note, fees })} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="panel flex-1">
                <header><span className="label">Demo · auto-play</span><span className="code blink hidden sm:inline">● rec</span></header>
                <div className="body flex-1 justify-center gap-1 py-2.5">
                  <span className="label">Last move</span>
                  <b className="text-[12px] sm:text-[16px]">{demo.note}</b>
                </div>
              </div>
              <div className="panel flex-1">
                <header><span className="label">Fees burned</span><span className="code hidden xl:inline">5,000 lam / move</span></header>
                <div className="body flex-1 justify-center gap-1 py-2.5">
                  <div className="num text-[16px] sm:text-[clamp(18px,3svh,28px)]">{demo.fees}</div>
                  <span className="label hidden xl:block">The whole demo game costs less than 0.0001 SOL</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="panel order-3 lg:order-none lg:col-start-2 lg:row-start-1">
          <header><span className="label">Matchmaking · FIFO</span><span className="code">{waiting} waiting · pot {sol(stake * 2n, 2)}</span></header>
          <div className="body flex-1 justify-between gap-3 py-3">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Game mode">
              {(['timed', 'relaxed'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={m === mode} onClick={() => pickMode(m)}
                  className={`border-[3px] border-ink px-1 py-1.5 text-[13px] font-bold uppercase tracking-[0.06em] ${m === mode ? 'bg-ink text-signal' : 'bg-panel hover:bg-signal'}`}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="label mb-2">Stake per player</legend>
              <div className="grid grid-cols-4 gap-2">
                {choices.map((s) => {
                  const count = lineFor(s)
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

        <aside className="order-4 flex min-w-0 flex-col gap-[clamp(10px,2svh,20px)] lg:order-none lg:col-start-2 lg:row-start-2">
          {unfinished ? (
            <a className="btn min-h-[clamp(50px,7svh,68px)] text-[16px] sm:text-[20px]" href={`#/game/${unfinished}`}>
              <span>Resume your game</span>
              <span className="tag">{short(unfinished)}</span>
            </a>
          ) : (
            <a className="btn min-h-[clamp(50px,7svh,68px)] text-[16px] sm:text-[20px]" href={playHref(stake, mode)} aria-disabled={!wallet}>
              <span>{wallet ? 'Enter queue' : 'Connect to play'}</span>
              <span className="tag">{sol(stake, 2)} SOL</span>
            </a>
          )}
          {unfinished && <Alert>This wallet still has a game in progress, and its stakes stay locked until it's settled. Open it: if time ran out, it settles right away.</Alert>}
          {!unfinished && queuedElsewhere && (
            <Alert>This wallet is already in the queue at {sol(BigInt(queuedElsewhere.stake), 2)} SOL ({MODE_LABEL[queuedElsewhere.mode ?? 'timed']}) in another tab or device. One queue at a time.</Alert>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="grid flex-1 grid-cols-2 gap-3">
            <div className="panel">
              <header><span className="label">Jackpot</span><span className="code">{jackpot?.drawLeft ? 'draw on' : '2% / game'}</span></header>
              <div className="body gap-1 py-2">
                <div className="num text-[clamp(16px,2.6svh,26px)]">{sol(jackpot?.balance ?? 0n, 3)} SOL</div>
                <span className="label normal-case tracking-normal">
                  {jackpot?.drawLeft
                    ? `One of the next ${jackpot.drawLeft} games wins it`
                    : `Draw starts at ${sol(drawAt, drawAt < 10_000_000n ? 3 : 2)} SOL: one of the next ${drawGames} games wins it`}
                </span>
              </div>
            </div>
            <a className="ghost h-full shadow-hard" href="#/leaderboard">Leaderboard ↗</a>
          </div>
        </aside>
      </main>
      <Ticker />
    </div>
  )
}
