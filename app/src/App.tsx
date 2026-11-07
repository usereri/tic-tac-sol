import { useEffect, useState } from 'react'
import { Home } from './screens/Home'
import { Play } from './screens/Play'
import { GameScreen } from './screens/Game'
import { parseStake } from './lib/stakes'

// Hash routing, so deep links work on GitHub Pages without a 404 fallback.
function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return hash.replace(/^#\/?/, '')
}

export default function App() {
  const route = useHash()
  if (route === 'play' || route.startsWith('play/')) return <Play key={route} stake={parseStake(route.split('/')[1])} />
  if (route.startsWith('game/')) return <GameScreen key={route} id={route.slice(5)} />
  return <Home />
}
