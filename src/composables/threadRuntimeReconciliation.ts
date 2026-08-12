export type ListedTurnReconciliation = {
  acceptListedTurnId: boolean
  inProgress: boolean
}

export function reconcileListedActiveTurn(input: {
  listedInProgress: boolean
  listedActiveTurnId: string
  cachedActiveTurnId: string
  terminalTurnId: string
  requestGeneration: number | null
  currentGeneration: number
}): ListedTurnReconciliation {
  if (!input.listedInProgress) {
    return { acceptListedTurnId: false, inProgress: false }
  }

  const listedTurnId = input.listedActiveTurnId.trim()
  const cachedTurnId = input.cachedActiveTurnId.trim()
  const terminalTurnId = input.terminalTurnId.trim()
  if (terminalTurnId && (!listedTurnId || terminalTurnId === listedTurnId)) {
    return { acceptListedTurnId: false, inProgress: false }
  }

  if (!listedTurnId || listedTurnId === cachedTurnId) {
    return { acceptListedTurnId: false, inProgress: true }
  }

  const noLiveTurnIsKnown = !cachedTurnId
  const noLiveUpdateSinceRequest = input.requestGeneration !== null
    && input.requestGeneration === input.currentGeneration
  return {
    acceptListedTurnId: noLiveTurnIsKnown || noLiveUpdateSinceRequest,
    inProgress: true,
  }
}
