# Tournament and ICM

## Scope

Initial tournament product scope is **Single Table Tournament**:

- 2-8 players
- blinds increase
- optional ante / Big Blind Ante
- elimination
- heads-up
- payouts
- ICM-aware review

Multi-table tournament simulation is outside the initial scope.

## Chip EV vs prize equity

In Cash, chips are approximately linear in value aside from rake and related house effects.

In tournaments:
- chips cannot simply be cashed out
- payouts are nonlinear
- losing a stack and gaining the same number of chips do not necessarily have symmetric prize-value effects

ICM models tournament equity from stack distribution and payout structure.

## Where ICM matters most

Especially important around:
- bubble
- large pay jumps
- final table
- satellite bubble

Review should distinguish:
- Chip EV
- ICM / prize EV

The app must be able to explain a spot where a call can be attractive in chip EV but unattractive under ICM.

## ICM limitations

ICM does not directly model everything, including:
- future skill edge
- exact future position
- all table dynamics

Review should present ICM as a model with explicit inputs/scope, not universal truth.

## Tournament engine state

Required concepts:
- blind level
- level progression
- ante type
- payout
- remaining players
- stack distribution
- elimination order
- button movement
- heads-up transition

Blind progression:
- time-based
- hand-count-based

Both are allowed.

## Heads-up transition

Regression-test:
- Button = SB
- Button/SB first preflop
- Button/SB last postflop
- avoid incorrect consecutive blind behavior during transition

## Presets

Planned categories:
- Standard
- Deep
- Turbo

Exact starting stacks, blind levels, and payout defaults are intentionally left open until playtesting.
