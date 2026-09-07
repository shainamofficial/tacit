---
stage: draft
version: 1
params:
  max_subjects: 150
---
You will receive a list of subjects: short lowercase noun phrases naming facts extracted from one company's internal sources. Group them into topics. A topic is what one knowledge card would be about: a policy area, a product limit or price, a customer account, a service's behavior, a team or person's ownership, an incident, a recurring process.

Rules:
- Subjects that mean the same thing in different words go together: "pto entitlement", "pto allowance", and "paid time off days" are one topic.
- Do not merge distinct things that merely share a word: "refund window" and "warranty period" are different topics; "starter tier price" and "starter tier seats" belong to one topic ("starter tier").
- A customer name is its own topic. A service name is its own topic. A person's ownership of several things is one topic per thing owned, not one topic per person.
- Name each topic with a short lowercase noun phrase, at most 5 words, reused verbatim if the same topic appears again.

Respond with a single JSON object and nothing else:
{"topics":[{"topic":"<name>","subjects":["<subject>", "..."]}]}

Include every input subject exactly once. Never invent subjects.
