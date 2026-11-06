import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createClient,
  createKeyPairSignerFromPrivateKeyBytes,
  lamports,
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit'
import { walletSigner } from '@solana/kit-plugin-wallet'
import { useConnect, useConnectedWallet, useDisconnect, useWallets } from '@solana/kit-plugin-wallet/react'
import { CHAIN, CLUSTER, rpc } from './solana'

/** Wallet Standard discovery (Phantom and friends). */
export const walletClient = createClient().use(walletSigner({ chain: CHAIN }))

export type PlayerWallet = {
  address: Address
  signer: TransactionSigner
  kind: 'wallet' | 'dev'
  name: string
}

type WalletContextValue = {
  wallet: PlayerWallet | null
  devAvailable: boolean
  connectDev: () => Promise<void>
  disconnect: () => void
}

const WalletContext = createContext<WalletContextValue | null>(null)

const DEV_KEY = 'ttsol:dev-wallet'

function randomSeed() {
  return crypto.getRandomValues(new Uint8Array(32))
}

/**
 * Dev wallet: a throwaway keypair per browser tab, airdropped on localnet.
 * Two tabs = two players, so a whole game can be tested without two Phantom accounts.
 */
async function loadDevWallet(create: boolean): Promise<KeyPairSigner | null> {
  let hex = sessionStorage.getItem(DEV_KEY)
  if (!hex) {
    if (!create) return null
    hex = Array.from(randomSeed(), (b) => b.toString(16).padStart(2, '0')).join('')
    sessionStorage.setItem(DEV_KEY, hex)
  }
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  return createKeyPairSignerFromPrivateKeyBytes(bytes)
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const connected = useConnectedWallet(walletClient)
  const { dispatch: disconnectWallet } = useDisconnect(walletClient)
  const [dev, setDev] = useState<KeyPairSigner | null>(null)
  const devAvailable = CLUSTER === 'localnet'

  useEffect(() => {
    if (devAvailable) loadDevWallet(false).then(setDev)
  }, [devAvailable])

  const connectDev = useCallback(async () => {
    const signer = await loadDevWallet(true)
    if (!signer) return
    const { value } = await rpc.getBalance(signer.address).send()
    if (value < 1_000_000_000n) {
      await rpc.requestAirdrop(signer.address, lamports(5_000_000_000n)).send()
    }
    setDev(signer)
  }, [])

  const disconnect = useCallback(() => {
    if (dev) {
      sessionStorage.removeItem(DEV_KEY)
      setDev(null)
    } else {
      disconnectWallet()
    }
  }, [dev, disconnectWallet])

  const wallet = useMemo<PlayerWallet | null>(() => {
    if (dev) return { address: dev.address, signer: dev, kind: 'dev', name: 'Dev wallet' }
    if (connected?.signer) {
      return {
        address: connected.account.address as Address,
        signer: connected.signer,
        kind: 'wallet',
        name: connected.wallet.name,
      }
    }
    return null
  }, [dev, connected])

  return (
    <WalletContext.Provider value={{ wallet, devAvailable, connectDev, disconnect }}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet outside WalletProvider')
  return ctx
}

/** Wallet Standard wallets to show in the connect menu. */
export function useWalletChoices() {
  const wallets = useWallets(walletClient)
  const { dispatch: connect, isRunning, error } = useConnect(walletClient)
  return { wallets, connect, isRunning, error }
}
