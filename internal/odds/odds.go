// Package odds implements a small deterministic 1X2 model.
//
// Model (deliberately simple, explainable, NOT a sportsbook model):
//
//  1. Each team gets a strength multiplier from cards plus a fixed
//     home advantage:
//     homeMult = 1.15 - 0.30*homeReds + 0.25*awayReds - 0.02*homeYellows
//     awayMult = 1.00 - 0.30*awayReds + 0.25*homeReds - 0.02*awayYellows
//     clamped to [0.2, 2.0].
//  2. Expected remaining goals = baseRate * minutesRemaining * mult,
//     with baseRate = 0.015 goals/min (~1.35 goals per team per 90).
//  3. Future goals are independent Poisson(homeExp), Poisson(awayExp).
//     1X2 probabilities enumerate P(x,y) for x,y in 0..10 added to the
//     current score.
//  4. Fair probabilities are converted to decimal odds with overround:
//     odds_i = 1 / (p_i * (1 + margin)), margin default 0.05.
//
// Properties: pure function (same state + margin = same output),
// reacts to score, time remaining, reds and yellows, no hardcoded odds.
package odds

import (
	"math"

	"pulse/internal/state"
)

const (
	// BaseRate is the expected goals per minute for an average team.
	BaseRate = 0.015
	// HomeEdge is the fixed home advantage multiplier.
	HomeEdge = 1.15
	// MaxGoals enumerates Poisson outcomes 0..MaxGoals.
	MaxGoals = 10
)

// JitterEpsilon bounds the fairness perturbation: each probability is
// shifted by at most +/-Epsilon (0.002 = 0.2pp) before renormalisation,
// so fairness stays auditable without dominating the Poisson model.
const JitterEpsilon = 0.002

// Outcome is the 1X2 result for one match state.
type Outcome struct {
	HomeProb float64
	DrawProb float64
	AwayProb float64

	HomeOdds float64
	DrawOdds float64
	AwayOdds float64
}

// Overround returns sum(1/odds) - 1, ~margin for live markets.
func (o Outcome) Overround() float64 {
	s := 0.0
	if o.HomeOdds > 0 {
		s += 1 / o.HomeOdds
	}
	if o.DrawOdds > 0 {
		s += 1 / o.DrawOdds
	}
	if o.AwayOdds > 0 {
		s += 1 / o.AwayOdds
	}
	return s - 1
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func factorial(n int) float64 {
	f := 1.0
	for i := 2; i <= n; i++ {
		f *= float64(i)
	}
	return f
}

func poissonPMF(k int, lambda float64) float64 {
	if lambda <= 0 {
		if k == 0 {
			return 1
		}
		return 0
	}
	return math.Exp(-lambda) * math.Pow(lambda, float64(k)) / factorial(k)
}

// ExpectedGoals exposes the intermediate intensities for debugging/demo.
func ExpectedGoals(s state.MatchState) (homeExp, awayExp float64) {
	remaining := 90 - s.Minute
	if remaining < 0 {
		remaining = 0
	}
	homeMult := clamp(HomeEdge-0.30*float64(s.HomeReds)+0.25*float64(s.AwayReds)-0.02*float64(s.HomeYellows), 0.2, 2.0)
	awayMult := clamp(1.0-0.30*float64(s.AwayReds)+0.25*float64(s.HomeReds)-0.02*float64(s.AwayYellows), 0.2, 2.0)
	homeExp = BaseRate * float64(remaining) * homeMult
	awayExp = BaseRate * float64(remaining) * awayMult
	return homeExp, awayExp
}

// Calculate returns deterministic 1X2 odds for a match state.
// margin is the bookmaker overround (e.g. 0.05); margin <= 0 defaults to 0.05.
// Preserved unchanged for backwards compatibility; no fairness input.
func Calculate(s state.MatchState, margin float64) Outcome {
	return calculate(s, margin, 0, 0, 0, false)
}

// CalculateWithFairness behaves like Calculate but applies a small auditable
// perturbation from pre-derived draws in [0,1) keyed by market ("1","X","2").
//
// Each probability is shifted by (draw-0.5)*2*JitterEpsilon (at most
// +/-0.2pp), then renormalised before conversion to odds. The Poisson model
// dominates; fairness never decides the market. Finished matches ignore the
// draws because the result is decided.
func CalculateWithFairness(s state.MatchState, margin float64, homeDraw, drawDraw, awayDraw float64) Outcome {
	return calculate(s, margin, homeDraw, drawDraw, awayDraw, true)
}

func calculate(s state.MatchState, margin float64, homeDraw, drawDraw, awayDraw float64, useFair bool) Outcome {
	if margin <= 0 {
		margin = 0.05
	}

	// Finished matches are decided: winner pays ~1.01, losers are closed (0).
	if s.Status == state.StatusFinished {
		switch {
		case s.HomeScore > s.AwayScore:
			return Outcome{HomeProb: 1, DrawProb: 0, AwayProb: 0, HomeOdds: 1.01}
		case s.AwayScore > s.HomeScore:
			return Outcome{HomeProb: 0, DrawProb: 0, AwayProb: 1, AwayOdds: 1.01}
		default:
			return Outcome{HomeProb: 0, DrawProb: 1, AwayProb: 0, DrawOdds: 1.01}
		}
	}

	homeExp, awayExp := ExpectedGoals(s)

	homePMF := make([]float64, MaxGoals+1)
	awayPMF := make([]float64, MaxGoals+1)
	for k := 0; k <= MaxGoals; k++ {
		homePMF[k] = poissonPMF(k, homeExp)
		awayPMF[k] = poissonPMF(k, awayExp)
	}

	var hp, dp, ap float64
	for x := 0; x <= MaxGoals; x++ {
		for y := 0; y <= MaxGoals; y++ {
			p := homePMF[x] * awayPMF[y]
			switch {
			case s.HomeScore+x > s.AwayScore+y:
				hp += p
			case s.HomeScore+x == s.AwayScore+y:
				dp += p
			default:
				ap += p
			}
		}
	}

	// Renormalise the truncated 0..10 tail so probs sum to 1.
	total := hp + dp + ap
	if total > 0 {
		hp /= total
		dp /= total
		ap /= total
	}

	// Fairness jitter: tiny zero-mean shift, then renormalise.
	// Keeps the model explainable; max move is JitterEpsilon per side.
	if useFair && s.Status != state.StatusFinished {
		hp += (homeDraw - 0.5) * 2 * JitterEpsilon
		dp += (drawDraw - 0.5) * 2 * JitterEpsilon
		ap += (awayDraw - 0.5) * 2 * JitterEpsilon
		if hp < 0.0006 {
			hp = 0.0006
		}
		if dp < 0.0006 {
			dp = 0.0006
		}
		if ap < 0.0006 {
			ap = 0.0006
		}
		sum := hp + dp + ap
		hp /= sum
		dp /= sum
		ap /= sum
	}

	toOdds := func(p float64) float64 {
		if p <= 0.0005 {
			return 0 // closed
		}
		if p >= 0.9995 {
			return 1.01
		}
		o := 1 / (p * (1 + margin))
		if o < 1.01 {
			o = 1.01
		}
		return o
	}

	return Outcome{
		HomeProb: hp,
		DrawProb: dp,
		AwayProb: ap,
		HomeOdds: toOdds(hp),
		DrawOdds: toOdds(dp),
		AwayOdds: toOdds(ap),
	}
}
