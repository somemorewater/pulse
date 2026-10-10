// HTTP handlers: parse input, validate at the boundary, delegate, shape output.
import { validateCreateMatch, validateEvent, validateMatchId, validateVerify } from '../schemas/index.js';

export function createMatchController(matchService) {
  return {
    create: async (req, reply) => {
      const input = validateCreateMatch(req.body);
      const created = await matchService.create(input);
      return reply.code(201).send(created);
    },
  };
}

export function createQueryController(queryService) {
  return {
    detail: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      return reply.send(await queryService.matchDetail(id));
    },
    odds: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const odds = await queryService.odds(id);
      return reply.send({ match_id: id, odds });
    },
    events: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const events = await queryService.events(id, req.query?.limit);
      return reply.send({ match_id: id, events });
    },
    fairness: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const records = await queryService.fairness(id);
      return reply.send({ match_id: id, fairness: records });
    },
    list: async (req, reply) => {
      const matches = await queryService.matches(req.query?.limit);
      return reply.send({ matches });
    },
    oddsHistory: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const history = await queryService.oddsHistory(id, req.query?.limit);
      return reply.send({ match_id: id, history });
    },
  };
}

export function createEventController(eventService) {
  return {
    submit: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const event = validateEvent(req.body);
      const res = await eventService.submit(id, event);
      // Authoritative result straight from the Go engine.
      return reply.send({
        state: res.state,
        odds: res.odds,
        fairness: res.fairness,
        sequence: res.state.sequence,
        processing_latency_us: res.processing_latency_us,
      });
    },
  };
}

export function createFairnessController(fairnessService) {
  return {
    verify: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      const input = validateVerify(req.body);
      const res = await fairnessService.verify(id, input);
      return reply.send({
        valid: res.valid,
        algorithm: res.algorithm,
        algorithm_version: res.algorithm_version,
      });
    },
    reveal: async (req, reply) => {
      const id = validateMatchId(req.params.id);
      return reply.send(await fairnessService.reveal(id));
    },
  };
}
