# AI Opponents and Review

## 1. Opponent contract

Opponent AI decides **strategy**, not rules.

Input:
- own hole cards
- public board
- pot/stacks
- position
- legal actions and legal amount ranges
- personally available observations
- persona/state
- selected deterministic math

Forbidden:
- hidden opponent cards
- deck future
- learning reveal
- Hero weakness database
- another CPU's private observations
- another CPU's secret persona

Output:
- action
- amount if needed
- optional compact rationale/debug metadata

## 2. Persona model

Recommended dimensions:
- skill
- preflop looseness
- aggression
- bluff tendency
- risk tolerance
- discipline
- adaptability
- trap tendency
- opponent-reading quality
- tilt susceptibility
- recovery speed

Do not reduce opponent variety to a single `difficulty` value.

## 3. Weak opponents

Model weakness as coherent poker leaks:
- call too wide
- under-3-bet
- overfold rivers
- overcall
- chase poor draws
- positional insensitivity
- underbluff
- overbluff

Do not use random illegal/absurd actions merely to make a CPU weak.

## 4. Tilt / irrationality

Transient state may react to:
- large pot loss
- repeated losses
- failed bluff
- overconfidence after a large win

Effects are persona-dependent and probabilistic.

Only when such conditions hold may strategically poor actions receive low probability mass.

## 5. Opponent models

Each CPU stores:
1. observations
2. hypotheses
3. confidence

Skill affects modeling quality:
- stronger CPUs wait for evidence
- weaker CPUs may overgeneralize from small samples

CPU secret hypotheses are never presented to Hero as facts.

## 6. Review evidence

Review AI consumes normalized evidence:

- Decision Context
- Math Evidence
- Range Evidence
- Opponent Observation Evidence
- Solver Evidence when supported
- Knowledge Evidence
- User Read/Intent when available

AI prose is generated after evidence assembly.

## 7. Two-pass review

### Pass A — Decision Review
Use only information available at the time.

### Pass B — Reveal Review
Show actual hole cards and compare reality with the user's read.

Pass B must not silently change Pass A.

## 8. Assessment style

Prefer categorical evaluation:
- strong
- reasonable
- mixed/marginal
- improvement suggested
- major leak
- insufficient evidence

Include:
- confidence
- assumptions
- what would change the answer

Avoid fake precision on single decisions.

## 9. Practical / GTO / exploit ordering

Default explanation:
1. practical baseline
2. theoretical/GTO background when relevant
3. exploit adjustment when observation evidence supports it

Never teach "GTO says X, therefore X is always correct."

## 10. Solver use

MVP requires real solver integration.

Rules:
- capability-match before use
- unsupported is normal
- range assumptions are visible
- multiway must not be silently converted to HU "truth"
- solver output is evidence, not the sole oracle

Long-session/deep analysis may use more expensive solving.

## 11. Web fallback

Do not web-search every hand.

Use only after:
`KB -> Math/Solver -> Evidence sufficiency`

If web evidence materially changes a recommendation, preserve provenance.

## 12. Review Interview

When assessment depends on Hero's contemporaneous read/intent:
- ask a compact question
- allow options/free text
- store the answer
- continue evaluation

Do not interrupt every hand.

## 13. Model routing

Initial roles:
- `opponent_fast`: Haiku-class
- `review_standard`: Sonnet-class+
- `review_deep`: strongest cost-acceptable review model

Concrete models remain configuration.
