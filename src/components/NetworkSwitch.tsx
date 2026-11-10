import type { NetworkId } from '../config/networks'
import { useNear } from '../wallet/context'

const OPTIONS: NetworkId[] = ['testnet', 'mainnet']

export function NetworkSwitch() {
  const { networkId, setNetwork, status } = useNear()
  return (
    <div className="segmented" role="radiogroup" aria-label="Network">
      {OPTIONS.map((id) => (
        <button
          key={id}
          role="radio"
          aria-checked={networkId === id}
          className={networkId === id ? `active net-${id}` : ''}
          disabled={status === 'loading' && networkId !== id}
          onClick={() => networkId !== id && setNetwork(id)}
        >
          {id === 'testnet' ? 'Testnet' : 'Mainnet'}
        </button>
      ))}
    </div>
  )
}
