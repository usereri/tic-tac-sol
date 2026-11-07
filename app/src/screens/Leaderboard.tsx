import { useEffect, useState } from 'react'
import { Alert, Nav } from '../components/Chrome'
import { short, sol } from '../lib/format'
import { fetchLeaderboard, type LeaderRow } from '../lib/game'
import { describeError } from '../lib/solana'
import { useWallet } from '../lib/wallet'

/** Ranked by net SOL (paid out minus staked), then wins. Read from the on-chain top-50 board. */
export function Leaderboard() {
  const { wallet } = useWallet()
  const [rows, setRows] = useState<LeaderRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchLeaderboard()
      .then((r) => setRows(r.sort((a, b) => Number(b.paid - b.staked - (a.paid - a.staked)) || b.won - a.won)))
      .catch((e) => setError(describeError(e)))
  }, [])

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<a href="#/" className="text-ink-2">Home</a>} />
      <main className="flex flex-1 flex-col gap-6 px-4 py-6 md:px-12 md:py-8">
        <span className="label">On-chain · top 50 wallets by net SOL</span>
        <h1 className="mega text-[clamp(40px,7vw,96px)]">Leader<mark>board.</mark></h1>
        <div className="panel">
          <header><span className="label">Players</span><span className="code">{rows ? `${rows.length} wallets` : '…'}</span></header>
          <div className="body overflow-x-auto">
            {error && <Alert>{error}</Alert>}
            {rows && rows.length === 0 && <span className="text-ink-2">No games played yet.</span>}
            {rows && rows.length > 0 && (
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="label">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Wallet</th>
                    <th className="py-2 pr-3 text-right font-medium">Wins</th>
                    <th className="py-2 pr-3 text-right font-medium">Games</th>
                    <th className="py-2 pr-3 text-right font-medium">SOL won</th>
                    <th className="py-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const net = r.paid - r.staked
                    const me = r.wallet === wallet?.address
                    return (
                      <tr key={r.wallet} className={`border-t border-ink ${me ? 'bg-signal' : ''}`}>
                        <td className="py-2 pr-3 font-bold">{String(i + 1).padStart(2, '0')}</td>
                        <td className="py-2 pr-3">{short(r.wallet)}{me && <span className="chip chip-ink ml-2">you</span>}</td>
                        <td className="py-2 pr-3 text-right">{r.won}</td>
                        <td className="py-2 pr-3 text-right">{r.played}</td>
                        <td className="py-2 pr-3 text-right">{sol(r.paid, 4)}</td>
                        <td className="py-2 text-right font-bold">{net >= 0n ? '+' : ''}{sol(net, 4)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <a className="ghost max-w-[320px]" href="#/">Back</a>
      </main>
    </div>
  )
}
