"""amaster97/poker_solver を 1 Spot だけ解き、Root の戦略を JSON で stdout に出す（#81。Solver Adapter の子プロセス）。

入力は stdin の JSON 1 つ（Adapter が検証済みの値だけを送る。形は src/solver/amaster97-adapter.ts の Amaster97Request）。
出力は stdout の JSON 1 行。失敗は exit 1 と stderr のメッセージで返す（Adapter が process_failed として扱う）。
Range は具体的な Combo で渡す（Range Model が絞った Combo を Hand Class に丸めない）。
exploitability は Turn で数分かかるため計算しない（#76 の実測。収束の目安は Iteration 数で持つ）。
"""

import json
import sys

PROTOCOL = 1


def main() -> None:
    req = json.load(sys.stdin)
    if req.get("protocol") != PROTOCOL:
        raise ValueError(f"unknown protocol: {req.get('protocol')!r}")

    # import は入力を読んでから（入力の誤りを先に返す）。
    import poker_solver
    from poker_solver import Card, HUNLConfig, Street
    from poker_solver.range import Range
    from poker_solver.range_aggregator import solve_range_vs_range_nash

    street = {"turn": Street.TURN, "river": Street.RIVER}[req["street"]]
    board = tuple(Card.from_str(c) for c in req["board"])
    pot = int(req["pot"])
    stack = int(req["effective_stack"])
    half = pot // 2
    tree = req["bet_tree"]
    cfg = HUNLConfig(
        # Street 開始時の Pot を両者が半分ずつ出した形にし、残りの Stack を effective_stack にする。
        starting_stack=half + stack,
        starting_street=street,
        initial_board=board,
        initial_pot=pot,
        initial_contributions=(half, pot - half),
        bet_size_fractions=tuple(float(x) for x in tree["bet_pot_fractions"]),
        raise_size_xs=tuple(float(x) for x in tree["raise_multipliers"]),
        include_all_in=bool(tree["all_in"]),
        postflop_raise_cap=int(tree["raise_cap"]),
    )

    def to_range(combos: list[str]) -> Range:
        r = Range()
        for c in combos:
            r.add((Card.from_str(c[:2]), Card.from_str(c[2:])), 1.0)
        return r

    # hero_player=1 は postflop の OOP（先に行動する側）。Root の戦略 = OOP の最初の判断。
    res = solve_range_vs_range_nash(
        cfg,
        hero_range=to_range(req["ranges"]["oop"]),
        villain_range=to_range(req["ranges"]["ip"]),
        iterations=int(req["iterations"]),
        hero_player=1,
        compute_exploitability_at_end=False,
    )

    out = {
        "protocol": PROTOCOL,
        "solver_version": getattr(poker_solver, "__version__", None),
        "iterations": res.iterations,
        "decision_nodes": res.decision_node_count,
        "hand_counts": list(res.hand_count_per_player),
        "root_actor": "oop",
        "range_aggregate": res.range_aggregate,
        "per_class": res.per_class_strategy,
        "solve_wall_s": res.wall_clock_s,
        "warnings": list(res.warnings),
    }
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - 失敗の種類によらず exit 1 + メッセージで返す
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)
