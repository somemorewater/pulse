// Predefined scenarios. Each step is a real backend event executed in order;
// the runner aborts on the first failure and never claims success it did
// not observe. Fresh match by default (deterministic start), existing match
// selectable when the caller wants continuity.
export const SCENARIOS = [
  {
    id: 'early-goal',
    name: 'Early home goal',
    blurb: 'Start, advance to 10′, home scores. Watch the market collapse.',
    steps: [
      { type: 'match_start' },
      { type: 'minute_update', minute: 10 },
      { type: 'goal_home', minute: 10 },
    ],
  },
  {
    id: 'late-equalizer',
    name: 'Late equalizer',
    blurb: 'Home lead at 20′, away reply at 85′. Watch the draw price swing.',
    steps: [
      { type: 'match_start' },
      { type: 'minute_update', minute: 20 },
      { type: 'goal_home', minute: 20 },
      { type: 'minute_update', minute: 85 },
      { type: 'goal_away', minute: 85 },
    ],
  },
  {
    id: 'red-while-leading',
    name: 'Red card while leading',
    blurb: 'Home lead at 30′, home red at 60′. Watch the lead get discounted.',
    steps: [
      { type: 'match_start' },
      { type: 'minute_update', minute: 30 },
      { type: 'goal_home', minute: 30 },
      { type: 'minute_update', minute: 60 },
      { type: 'red_card_home', minute: 60 },
    ],
  },
];

const STEP_PAUSE_MS = 700;

function eventId() {
  return `scn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// runScenario executes steps sequentially against matchId starting at
// startSeq+1. onStep({ i, total, step, ok, message }) reports progress.
// Resolves { ok, matchId, lastSequence } — ok false on first failure.
export async function runScenario(api, store, matchId, startSeq, scenario, onStep) {
  let seq = startSeq;
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    seq += 1;
    const event = { id: eventId(), type: step.type, sequence: seq };
    if (step.minute !== undefined) event.payload = { minute: step.minute };
    else if (step.type !== 'match_start' && step.type !== 'match_end') {
      const m = store.state.match;
      if (m) event.payload = { minute: m.minute };
    }
    try {
      const res = await api.submitEvent(matchId, event);
      store.recordRestLatency(res.processing_latency_us);
      store.submit({ matchId, event: `${step.type} #${seq}`, outcome: `accepted (seq ${res.sequence})` });
      onStep({ i, total: scenario.steps.length, step, seq, ok: true, message: `seq ${res.sequence} accepted` });
    } catch (err) {
      const msg = err?.message ?? 'request failed';
      store.submit({ matchId, event: `${step.type} #${seq}`, outcome: `failed: ${err?.code ?? err?.status ?? msg}` });
      onStep({ i, total: scenario.steps.length, step, seq, ok: false, message: msg });
      return { ok: false, matchId, lastSequence: seq - 1, failedStep: i };
    }
    if (i < scenario.steps.length - 1) {
      await new Promise((r) => setTimeout(r, STEP_PAUSE_MS));
    }
  }
  return { ok: true, matchId, lastSequence: seq };
}
