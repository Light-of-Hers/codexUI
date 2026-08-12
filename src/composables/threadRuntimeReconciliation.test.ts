import { describe, expect, it } from 'vitest'
import { reconcileListedActiveTurn } from './threadRuntimeReconciliation'

describe('reconcileListedActiveTurn', () => {
  it.each([
    {
      name: 'accepts the first active turn observed during cold startup',
      input: { listedInProgress: true, listedActiveTurnId: 'turn-1', cachedActiveTurnId: '', terminalTurnId: '', requestGeneration: 0, currentGeneration: 0 },
      expected: { acceptListedTurnId: true, inProgress: true },
    },
    {
      name: 'accepts a replacement when no live event arrived during the list request',
      input: { listedInProgress: true, listedActiveTurnId: 'turn-new', cachedActiveTurnId: 'turn-old', terminalTurnId: '', requestGeneration: 3, currentGeneration: 3 },
      expected: { acceptListedTurnId: true, inProgress: true },
    },
    {
      name: 'preserves a newer live turn when an older list request returns late',
      input: { listedInProgress: true, listedActiveTurnId: 'turn-stale', cachedActiveTurnId: 'turn-live', terminalTurnId: '', requestGeneration: 3, currentGeneration: 4 },
      expected: { acceptListedTurnId: false, inProgress: true },
    },
    {
      name: 'ignores a list replay of an already completed turn',
      input: { listedInProgress: true, listedActiveTurnId: 'turn-done', cachedActiveTurnId: '', terminalTurnId: 'turn-done', requestGeneration: 4, currentGeneration: 4 },
      expected: { acceptListedTurnId: false, inProgress: false },
    },
    {
      name: 'does not let an id-less running snapshot override terminal evidence',
      input: { listedInProgress: true, listedActiveTurnId: '', cachedActiveTurnId: '', terminalTurnId: 'turn-done', requestGeneration: 4, currentGeneration: 4 },
      expected: { acceptListedTurnId: false, inProgress: false },
    },
  ])('$name', ({ input, expected }) => {
    expect(reconcileListedActiveTurn(input)).toEqual(expected)
  })
})
