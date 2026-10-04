# Strategy and Poker Math

## Decision context

A poker decision cannot be evaluated from Hero's two cards alone.

Relevant context includes:
- Hero holding/range
- opponent range(s)
- position
- action history
- board
- pot
- amount to call
- effective stack
- SPR
- bet sizing
- player observations
- rake or payout context

## Pot odds

If calling costs `C` and the final pot after calling would be `F`, break-even required equity is:

```text
Required Equity = C / F
```

Example:
- pot before bet = 100
- Villain bets 50
- Hero calls 50
- final pot = 200
- required equity = 25%

The UI should show the components, not just the answer.

## Outs and drawing odds

Outs are unseen cards that can improve a hand enough to win.

Cautions:
- dirty outs
- duplicate outs
- domination
- opponent range

### Rule of 4 and 2
Useful live-table HEURISTIC:
- Flop to River approximation: outs × 4%
- one street approximation: outs × 2%

The app can calculate exact values but should still teach the mental shortcut.

## Equity

Distinguish:
- hand vs hand equity
- hand vs range equity
- range vs range equity

Decision evaluation should prioritize the range that was reasonable at the time, not the opponent's actual hidden hand.

## Expected Value

For a simplified zero-equity river bluff:

- current pot = P
- bet = B
- opponent fold probability = F

```text
EV = F*P - (1-F)*B
Break-even F = B / (P+B)
```

Example:
- P = 100
- B = 50
- required fold frequency = 33.3%

Important distinction:
- required fold frequency = math
- actual opponent fold frequency = inference

Do not present both with equal certainty.

## Implied / reverse implied odds

Current pot odds do not capture all future betting.

Review should consider:
- future value if a draw hits
- domination / reverse implied odds
- remaining stack

## Effective stack / SPR

Effective stack is the amount that can actually be wagered between Hero and the relevant opponent.

```text
SPR = Effective Stack / Pot
```

Multiway spots can have different effective stacks per opponent.

## Position

Position affects information and equity realization.

General baseline:
- earlier positions require tighter ranges
- later positions can enter more pots
- Button gains postflop information advantage

Exact ranges are not RULES; they depend on format, stack, rake, sizing and population.

## Range thinking

Use ranges, not exact-hand guessing.

```text
Prior range
 -> preflop action
 -> updated range
 -> flop board/action
 -> updated range
 -> turn
 -> river
```

Do not score Hero poorly simply because the actual hidden hand happened to be one particular combo.

## Preflop topics

KB should cover:
- RFI/open
- limp
- iso raise
- cold call
- 3-bet
- 4-bet
- squeeze
- blind defense
- push/fold

Always contextualize by:
- position
- players
- sizing
- effective stack
- rake
- ante
- opponent tendencies

## Rake

Cash rake can change marginal decisions, especially calls/defenses.

Rake must therefore be explicit analysis context.

## Postflop concepts

Include:
- range advantage
- nut advantage
- positional advantage
- c-bet
- value betting
- bluff/semi-bluff
- blockers/unblockers
- bet sizing

Do not turn generic teaching frequencies into universal rules.

## Exploit

Flow:

```text
baseline
 -> observed evidence
 -> opponent hypothesis
 -> confidence
 -> adjustment
```

Examples:
- overcalling evidence -> value wider / bluff less
- overfolding evidence -> bluff more
- unusually tight aggression -> adjust opening/defense

Never use secret CPU persona parameters as Hero-facing evidence.

## Multiway

Multiway is not just heads-up with another player added.

Expect:
- lower bluff success
- more complex ranges
- different equity realization
- multiple effective stacks
- much harder solver requirements

Player count must be a first-class analysis parameter.

## Tilt / human errors

CPU irrationality should be state-conditioned.

Possible triggers:
- large pot loss
- repeated bad outcomes
- failed bluff
- overconfidence

Possible temporary effects:
- wider participation
- excessive aggression
- chasing
- overcalling
- scared overfolding

This should not degrade into unconditional random bad play.
