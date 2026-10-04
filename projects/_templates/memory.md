# {{Area}} PM — memory

Append-only log the PM keeps across runs. Newest entry first. Each run ends
by writing one entry here (and refreshing `queue.md`, plus `features.md`
after a full sweep), committed to the hub branch `pm/{{name}}/{{area}}` — see
`docs/README.md` for why the branch, not `main`.

Format for an entry:

```
## <date> — daily — run <id>
Walk: ...            (light: which surfaces | full sweep)
Filed: ...           (Linear ids with tier; sharpened ids)
Verified: ...        (PR number → pass n/n)
Failed: ...          (PR number, which criterion, retry or needs-human)
Waiting on owner: ...(tier C ids)
Learned: ...         (facts about the product/users/code that change future judgment)
Next: ...            (what the next run should look at first)
```

## Decisions (standing — edit in place, cite the run)

- {{date}} (seed, owner): the PM files tickets and tests what ships; the
  dispatcher merges tier A/B into `pm-staging`, the owner merges tier C and
  every promotion PR. Rank by impact on the metric, not impact ÷ effort.

## Log

## {{date}} — seed — created by add-project

Walk: none
Filed: none
Verified: none
Failed: none
Waiting on owner: none
Learned: nothing yet — the mandate is the only input.
Next: first daily run — the queue is empty, so it is a full sweep: walk
every surface in `features.md` at 390 px and desktop, fill the inventory,
seed the queue.
