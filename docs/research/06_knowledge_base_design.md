# Knowledge Base Design

## Runtime KB structure

Suggested topics:

```text
knowledge/
├── rules/
│   ├── holdem-core
│   ├── betting-rulings
│   ├── live-cash
│   ├── tournament
│   └── etiquette
├── math/
│   ├── pot-odds
│   ├── outs-equity
│   ├── ev
│   ├── implied-odds
│   └── spr-effective-stack
├── preflop/
│   ├── position
│   ├── open-raise
│   ├── 3bet-4bet
│   └── blind-defense
├── postflop/
│   ├── range-thinking
│   ├── range-nut-advantage
│   ├── cbet
│   ├── value-betting
│   ├── bluffing
│   └── bet-sizing
├── exploit/
│   ├── player-types
│   ├── evidence-and-sample
│   └── common-leaks
├── tournament/
│   ├── stack-depth
│   ├── icm
│   └── bubble
└── glossary/
```

## Metadata

Each knowledge unit should preserve context such as:

```yaml
id: pot_odds_basic
type: FACT
game: NLHE
formats: [cash, tournament]
players: [2,3,4,5,6,7,8]
streets: [flop, turn, river]
source_quality: high
sources: [...]
reviewed_at: 2026-10-04
```

Strategy heuristics should also include:
- conditions
- caveats
- rake context
- player count
- stack assumptions

## Source hierarchy

### Tier 1
- Poker TDA
- formal operator/venue rules
- peer-reviewed/game-theory research
- solver official documentation

### Tier 2
- established poker education sources
- PokerStars Learn
- Upswing Poker
- GTO Wizard technical/educational material

### Tier 3
- community discussions/forums

Tier 3 is useful for:
- discovering terminology
- common user confusion
- practical experience

It should not be the sole primary evidence for important scoring rules.

## Retrieval

MVP does not require a vector DB.

Start with:
1. metadata filtering
2. topic/keyword index
3. small full-text retrieval
4. pass only relevant chunks to Review AI

Add embeddings/vector search only if KB growth justifies it.

## Web fallback gate

```text
Local KB
 -> Math / Solver
 -> Evidence Sufficiency
      -> enough: answer
      -> insufficient: Web Search
```

Use web for:
- unknown terms
- house-specific/current rule
- current solver/tool behavior
- source conflicts
- genuine KB coverage gaps

Preserve:
- source
- publication/update date when available
- scope
- confidence

## Conflict handling

Do not assume two sources conflict merely because:
- one is a general heuristic
- one is a specific solver result

Priority concepts:
- formal rule > generic explanation
- specific calculation > rough heuristic
- supported solver spot > generic GTO heuristic
- strong observed evidence > population-level exploit heuristic

Solver results are still conditional on input ranges and assumptions.

## Vocabulary UX

Default:
- Japanese explanation
- standard poker term

Detail:
- definition
- current-hand example
- related concepts
- advanced explanation

The product should help the user transition into real poker vocabulary rather than hide it.
