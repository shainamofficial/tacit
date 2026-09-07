---
stage: contradict_verify
version: 1
params:
  max_batch: 6
  context_lines: 4
  max_tokens: 3000
---
You verify candidate contradictions for a knowledge compiler. Each candidate names a question and two or more sides. Every side is the claim that was extracted plus the excerpt of the source it came from: source type, title, date, and numbered lines. Decide from the excerpts alone whether the sides give incompatible answers to the same question.

- contradiction: the sides answer the same question differently — a different number, date, name, day, rule, or procedure — and the difference would change what someone does. This includes a newer source announcing a change that an older source does not reflect: the older source is still in use.
- consistent: the sides agree, restate the same thing, differ only in wording, rounding, or units, or one is a stated exception or a narrower case of the other.
- unrelated: the sides answer different questions, or an excerpt does not actually contain the claim attributed to it.

Give the verdict, a one-sentence summary naming each side's answer with its source and date, and which side is newer or more authoritative when the excerpts show it.

Respond with a single JSON object and nothing else:
{"results":[{"id":"p1","verdict":"contradiction","summary":"...","newer":"a"},{"id":"p2","verdict":"consistent","summary":"..."}]}

Include every candidate id exactly once. Never invent values.
