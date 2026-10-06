// Business orchestration. No odds math here — the Go engine is the only
// calculation layer. Services compose validation, engine calls and reads.
import { getMatchRow, getHotState, getHotOdds, getLatestOddsRow, listEvents, listFairness } from '../repositories/store.js';

export function createMatchService(engine) {
  return {
    create: (input) => engine.createMatch(input),
  };
}

export function createEventService(engine) {
  return {
    submit: (matchId, event) => engine.processEvent(matchId, event),
  };
}

export function createQueryService() {
  return {
    // Hot state first, durable row on miss; odds likewise.
    async matchDetail(matchId) {
      const match = (await getHotState(matchId)) ?? (await getMatchRow(matchId));
      const odds = (await getHotOdds(matchId)) ?? (await getLatestOddsRow(matchId));
      return { match, odds, sequence: match.sequence };
    },
    async odds(matchId) {
      await getMatchRow(matchId); // 404 when unknown
      return (await getHotOdds(matchId)) ?? (await getLatestOddsRow(matchId));
    },
    events: (matchId, limit) => listEvents(matchId, limit),
    fairness: (matchId) => listFairness(matchId),
  };
}

export function createFairnessService(engine) {
  return {
    verify: (matchId, input) => engine.verify({ match_id: matchId, ...input }),
    reveal: (matchId) => engine.reveal(matchId),
  };
}
